import { describe, expect, it, vi } from 'vitest'
import { TranslationService } from '../../src/main/translation'
import { ImageBridge, ImageCapacityError } from '../../src/main/imageBridge'
import { TranslationStore } from '../../src/main/store'
import { TranslationQueue } from '../../src/main/queue'
import {
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_BATCH_BUDGET,
  TRANSLATION_VERSION,
  translationVersion,
} from '../../src/shared/contracts'
import type {
  PageImage,
  SourcePart,
  TranslationResult,
  ImageRenderer,
} from '../../src/shared/contracts'
import { planBatches, validateResponse } from '../../src/main/batching'
import { answer, content, envelope, fakeRender, imagePage, rows, sources } from './fakes'

const doc = 'a'.repeat(64)
function setup(render: ImageRenderer = fakeRender) {
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => answer(sources(options)))
  const service = new TranslationService(fetcher, render)
  service.configure({ apiKey: 'fake-key' })
  return { service, fetcher }
}
async function run(
  service: TranslationService,
  pages = [imagePage(1), imagePage(2), imagePage(3)],
) {
  const results = new Map<number, TranslationResult>()
  await service.translate(
    { id: 'job', documentId: doc, pages },
    (p, r) => results.set(p, r),
    () => 1,
    () => {},
  )
  return results
}

describe('image payload, capacity and atomic regions', () => {
  it('sends only images and identity/region mapping, never extraction text or output-estimate content', async () => {
    const render = vi.fn(fakeRender),
      { service, fetcher } = setup(render)
    await run(service)
    const payload = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
    expect(payload.contents[0].parts).toHaveLength(6)
    for (let i = 0; i < 6; i += 2) {
      expect(JSON.parse(payload.contents[0].parts[i].text)).toEqual({
        documentId: doc,
        page: i / 2 + 1,
        part: 1,
        region: { x: 0, y: 0, width: 1, height: 1 },
        readingOrder: [],
      })
      expect(payload.contents[0].parts[i + 1]).toEqual({
        inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' },
      })
    }
    expect(JSON.stringify(payload)).not.toContain('outputTokens')
    expect(payload.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH')
    expect(render).toHaveBeenCalledTimes(3)
  })
  it('shrinks using actual JSON bytes including base64 and stops rendering further pages when over cap', async () => {
    const render = vi.fn<ImageRenderer>(async () => ({
      mimeType: 'image/jpeg',
      data: 'A'.repeat(600000),
      width: 1000,
      height: 1000,
    }))
    const { service, fetcher } = setup(render)
    service.configureImages({ ...DEFAULT_IMAGE_SETTINGS, maxRequestBytes: 1048576 })
    const result = await run(service)
    expect([...result.values()].every((r) => r.status === 'done')).toBe(true)
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(fetcher.mock.calls.every((c) => Buffer.byteLength(String(c[1]?.body)) <= 1048576)).toBe(
      true,
    )
    expect(sources(fetcher.mock.calls[0][1])).toHaveLength(1)
    expect(render.mock.calls.slice(0, 2).map((c) => c[0].page)).toEqual([1, 2])
  })
  it('rerenders oversized single images in smaller regions and merges Markdown, visuals and notes in order', async () => {
    const render = vi.fn<ImageRenderer>(async (p) => ({
      mimeType: 'image/jpeg',
      data: 'A'.repeat(Math.ceil(1500000 * p.region.width * p.region.height)),
      width: 1000,
      height: 1000,
    }))
    const { service, fetcher } = setup(render)
    service.configureImages({ ...DEFAULT_IMAGE_SETTINGS, maxRequestBytes: 1048576 })
    fetcher.mockImplementation(async (_u, o) =>
      envelope(
        JSON.stringify({
          pages: rows(sources(o)).map((r) => ({
            ...r,
            visualElements: [
              {
                id: 'figure-1',
                type: 'diagram',
                location: '아래',
                descriptionMarkdown: '관계 설명',
              },
            ],
            readingNotes: ['배치'],
            unclearRegions: ['작은 글자'],
          })),
        }),
      ),
    )
    const result = (await run(service, [imagePage(1)])).get(1)
    expect(render).toHaveBeenCalledTimes(3)
    expect(render.mock.calls.slice(1).map((c) => c[0].region)).toEqual([
      { x: 0, y: 0, width: 1, height: 0.5 },
      { x: 0, y: 0.5, width: 1, height: 0.5 },
    ])
    expect(result).toMatchObject({
      status: 'done',
      content: {
        translationMarkdown: '번역 1/1001\n\n번역 1/1002',
        readingNotes: ['배치'],
        unclearRegions: ['작은 글자'],
      },
    })
    if (result?.status === 'done')
      expect(new Set(result.content?.visualElements.map((v) => v.id)).size).toBe(2)
  })
  it('does not commit partial region success and bounds repeated single-page invalid output', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementation(async (_u, o) => {
      const p = sources(o)[0]
      return p.part === 1001 ? answer([p]) : envelope('{broken')
    })
    const result = await run(service, [imagePage(1)])
    expect(fetcher).toHaveBeenCalledTimes(4)
    expect(result.get(1)).toMatchObject({ status: 'error', code: 'invalid' })
    expect(result.get(1)).not.toHaveProperty('content')
  })
  it('handles a real HTTP 413 by region splitting, but isolates renderer failures without HTTP calls', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementationOnce(async () => new Response('', { status: 413 }))
    expect((await run(service, [imagePage(1)])).get(1)?.status).toBe('done')
    expect(fetcher).toHaveBeenCalledTimes(3)
    const broken = setup(async () => {
      throw new Error('private source details')
    })
    expect((await run(broken.service)).get(1)).toMatchObject({ status: 'error', code: 'render' })
    expect(broken.fetcher).not.toHaveBeenCalled()
  })
})

describe('content classification and strict schema', () => {
  const base = content('')
  const visual = {
    ...base,
    contentType: 'visual_only' as const,
    visualElements: [
      { id: 'figure-1', type: 'diagram', location: '중앙', descriptionMarkdown: '화살표 흐름' },
    ],
  }
  const blank = { ...base, contentType: 'blank' as const }
  const unreadable = {
    ...content('읽힌 부분'),
    contentType: 'unreadable' as const,
    unclearRegions: ['아래 글자 판독 불가'],
  }
  it('stores visual-only and blank as done, retains unreadable content as a visible error', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementation(async (_u, o) =>
      envelope(
        JSON.stringify({
          pages: sources(o)
            .map((p) => ({
              page: p.page,
              part: p.part,
              ...[visual, blank, unreadable][p.page - 1],
            }))
            .reverse(),
        }),
      ),
    )
    const result = await run(service)
    expect(result.get(1)).toMatchObject({ status: 'done', content: visual })
    expect(result.get(2)).toMatchObject({ status: 'done', content: blank })
    expect(result.get(3)).toMatchObject({
      status: 'error',
      code: 'unreadable',
      content: unreadable,
    })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([
    { ...base, contentType: 'text' },
    { ...blank, translationMarkdown: 'not blank' },
    { ...visual, visualElements: [] },
    { ...unreadable, unclearRegions: [] },
    { ...content(), readingNotes: [23] },
    { ...content(), visualElements: [{ id: 'f', type: 'graph' }] },
    { ...content(), confidence: 0.99 },
    { ...content(), contentType: 'unknown' },
  ])('rejects invalid field types and contradictory classification %#', (value) => {
    expect(() =>
      validateResponse(JSON.stringify({ pages: [{ page: 1, part: 1, ...value }] }), [
        { page: 1, part: 1 },
      ]),
    ).toThrow()
  })
  it('does not publish typed bad output during bounded retries', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementation(async (_u, o) =>
      envelope(
        JSON.stringify({ pages: rows(sources(o)).map((r) => ({ ...r, readingNotes: [42] })) }),
      ),
    )
    expect((await run(service, [imagePage(1)])).get(1)?.status).toBe('error')
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(7)
  })
})

describe('cache settings and render lifecycle', () => {
  it('preserves legacy rows, stores structured results, separates image settings and reuses prior versions', async () => {
    const store = new TranslationStore(':memory:', 'en:ko:gemini:prompt2:extract1')
    try {
      store.register(doc, 'old.pdf', 1)
      store.save(doc, 1, { status: 'done', text: 'legacy text' })
      store.position(doc, 1)
      const { service, fetcher } = setup()
      const queue = new TranslationQueue(store, service)
      queue.imagesChanged()
      const opened = queue.activate(doc, 'old.pdf', 1)
      expect(queue.snapshot(opened.session, 1).done).toBe(0)
      const job = queue.claim()!
      await queue.submit(job.session, job.token, [imagePage(1)])
      expect(store.load(doc).get(1)).toMatchObject({
        status: 'done',
        content: { contentType: 'text' },
      })
      expect(queue.claim()).toBeNull()
      service.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
      queue.budgetChanged()
      expect(queue.claim()).toBeNull()
      service.configureImages({ ...DEFAULT_IMAGE_SETTINGS, dpi: 200 })
      queue.imagesChanged()
      expect(queue.snapshot(opened.session, 1).done).toBe(0)
      service.configureImages(DEFAULT_IMAGE_SETTINGS)
      queue.imagesChanged()
      expect(queue.claim()).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
      store.saveImageSettings(service.settings().images)
      expect(store.imageSettings()).toEqual(DEFAULT_IMAGE_SETTINGS)
      store.version = 'en:ko:gemini:prompt2:extract1'
      expect(store.load(doc).get(1)).toEqual({ status: 'done', text: 'legacy text' })
      expect(translationVersion({ ...DEFAULT_IMAGE_SETTINGS, maxRequestBytes: 1048576 })).toBe(
        TRANSLATION_VERSION,
      )
    } finally {
      store.close()
    }
  })
  it('releases pending render requests on abort/timeout and ignores late or unrelated image responses', async () => {
    let requestId = ''
    const bridge = new ImageBridge((r) => {
      requestId = r.requestId
    })
    const part = planBatches([imagePage(1)], DEFAULT_BATCH_BUDGET)[0][0]
    const controller = new AbortController()
    const pending = bridge
      .request(
        { session: 's', token: 't', source: part, images: DEFAULT_IMAGE_SETTINGS },
        controller.signal,
      )
      .catch(() => null)
    expect(bridge.size).toBe(1)
    bridge.complete('wrong', await fakeRender(part, DEFAULT_IMAGE_SETTINGS, controller.signal))
    expect(bridge.size).toBe(1)
    controller.abort()
    expect(await pending).toBeNull()
    expect(bridge.size).toBe(0)
    bridge.complete(
      requestId,
      await fakeRender(part, DEFAULT_IMAGE_SETTINGS, new AbortController().signal),
    )
    expect(bridge.size).toBe(0)
    vi.useFakeTimers()
    try {
      const timed = bridge
        .request(
          { session: 's', token: 't', source: part, images: DEFAULT_IMAGE_SETTINGS },
          new AbortController().signal,
        )
        .catch(() => null)
      await vi.advanceTimersByTimeAsync(60000)
      expect(await timed).toBeNull()
      expect(bridge.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('converts oversized renderer results into bounded region retries without transferring oversized base64', async () => {
    const { service, fetcher } = setup(async (p, config, signal) => {
      if (p.part === 1) throw new ImageCapacityError('capacity')
      return fakeRender(p, config, signal)
    })
    expect((await run(service, [imagePage(1)])).get(1)?.status).toBe('done')
    expect(fetcher).toHaveBeenCalledTimes(2)
    const bridge = new ImageBridge((request) =>
      bridge.complete(request.requestId, { status: 'error', code: 'capacity' }),
    )
    const source = planBatches([imagePage(1)], DEFAULT_BATCH_BUDGET)[0][0]
    await expect(
      bridge.request(
        { session: 's', token: 't', source, images: DEFAULT_IMAGE_SETTINGS },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ImageCapacityError)
    expect(bridge.size).toBe(0)
  })
  it('aborts during rendering without calling the API or publishing a late image', async () => {
    let finish!: (value: PageImage) => void
    const render = vi.fn<ImageRenderer>(
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    const { service, fetcher } = setup(render),
      publish = vi.fn()
    const work = service
      .translate(
        { id: 'job', documentId: doc, pages: [imagePage(1)] },
        publish,
        () => 1,
        () => {},
      )
      .catch(() => {})
    await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(1))
    service.cancel()
    finish(
      await fakeRender(
        planBatches([imagePage(1)], DEFAULT_BATCH_BUDGET)[0][0],
        DEFAULT_IMAGE_SETTINGS,
        new AbortController().signal,
      ),
    )
    await work
    expect(fetcher).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
  })
  it('rejects invalid image configuration without leaking any source data', () => {
    const { service } = setup()
    for (const override of [
      { dpi: 20 },
      { format: 'gif' },
      { quality: 2 },
      { maxRequestBytes: 20 * 1024 * 1024 },
      { mediaResolution: 'ultra' },
    ])
      expect(() => service.configureImages({ ...DEFAULT_IMAGE_SETTINGS, ...override })).toThrow()
    expect(service.settings().images).toEqual(DEFAULT_IMAGE_SETTINGS)
  })
})
