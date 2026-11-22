import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChatGPTProvider } from '../../src/main/chatgpt/provider'
import { ChatGPTService } from '../../src/main/chatgpt/service'
import { translateImages } from '../../src/main/chatgpt/inference'
import { TranslationStore } from '../../src/main/store'
import { TranslationQueue } from '../../src/main/queue'
import { DEFAULT_IMAGE_SETTINGS, TRANSLATION_VERSION } from '../../src/shared/contracts'
import type { ChatGPTSnapshot } from '../../src/shared/chatgpt'
import type { PageImage } from '../../src/shared/contracts'
import { DEFAULT_CHATGPT_BATCH_POLICY } from '../../src/main/chatgpt/batching'
import type { ChatGPTBatchPolicy } from '../../src/main/chatgpt/batching'
import type { SourcePage } from '../../src/shared/contracts'
import { content, imagePage } from './fakes'

function setup(
  path = ':memory:',
  policy: ChatGPTBatchPolicy = { ...DEFAULT_CHATGPT_BATCH_POLICY, maxPages: 1 },
) {
  const store = new TranslationStore(path, TRANSLATION_VERSION)
  store.useChatGPT()
  const state: ChatGPTSnapshot = {
    status: 'signed_in',
    activeId: 'connection-A',
    profiles: [],
    verified: true,
    planAllowed: true,
    busy: false,
    models: [
      { slug: 'gpt-6.1-sol', name: 'Fake', supported: true },
      { slug: 'gpt-6-sol', name: 'Other', supported: true },
    ],
  }
  let queue: TranslationQueue,
    active = 0,
    maximum = 0,
    release: (() => void) | undefined,
    hold = false,
    mode = 'normal',
    retryAfter = '2'
  const calls: { doc: string; page: number; pages: number[]; model: string; body: any }[] = []
  const renders: number[] = [],
    renderFail = new Set<number>(),
    padding = new Map<number, number>()
  let source = (n: number): SourcePage => imagePage(n)
  let behavior: ((pages: number[], call: number) => string) | undefined
  const fetcher: typeof fetch = async (url, options) => {
    expect(String(url)).toBe('https://api.openai.com/v1/responses')
    const body = JSON.parse(String(options?.body)),
      parts = body.input[0].content
    const metas = parts
      .filter((_: unknown, i: number) => i % 2 === 0)
      .map((v: { text: string }) => JSON.parse(v.text))
    const decoded = parts
      .filter((_: unknown, i: number) => i % 2 === 1)
      .map((v: { image_url: string }) =>
        JSON.parse(Buffer.from(v.image_url.split(',')[1], 'base64').toString()),
      )
    expect(new Set(decoded.map((v: any) => v.doc)).size).toBe(1)
    const meta = metas[0],
      image = decoded[0]
    calls.push({
      doc: image.doc,
      page: meta.page,
      pages: metas.map((m: any) => m.page),
      model: body.model,
      body,
    })
    if (hold) {
      hold = false
      await new Promise<void>((r) => {
        release = r
      })
    }
    const selected =
      behavior?.(
        metas.map((m: any) => m.page),
        calls.length,
      ) ?? mode
    if (selected === 'rate' || selected === 'quota')
      return Response.json(
        {
          error: {
            code:
              selected === 'quota'
                ? 'subscription_sharing_usage_limit_exceeded'
                : 'rate_limit_exceeded',
          },
        },
        { status: 429, headers: { 'retry-after': retryAfter } },
      )
    if (selected === 'auth')
      return Response.json({ error: { code: 'invalid_token' } }, { status: 401 })
    if (selected === 'permission')
      return Response.json({ error: { code: 'insufficient_scope' } }, { status: 403 })
    if (selected === 'model')
      return Response.json({ error: { code: 'model_not_found' } }, { status: 400 })
    if (selected === 'network') throw new Error('PRIVATE_NETWORK')
    if (selected === 'rate-stream' || selected === 'bad-request-stream')
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'error',
            error: {
              code: selected === 'rate-stream' ? 'rate_limit_exceeded' : 'invalid_request_error',
            },
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream', 'retry-after': retryAfter } },
      )
    if (selected === 'incomplete')
      return new Response(
        'data: ' +
          JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete' } }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    let values: any[] = metas.map((m: any) => ({
      page: m.page,
      part: 1,
      ...(selected === 'unreadable'
        ? { ...content(''), contentType: 'unreadable', unclearRegions: ['작은 글자'] }
        : content('교착 상태(Deadlock) ' + m.page)),
    }))
    if (selected === 'missing') values = values.slice(1)
    if (selected === 'duplicate') values = [...values.slice(1), values.at(-1)]
    if (selected === 'unexpected') values[0] = { ...values[0], page: 999 }
    if (selected === 'empty') values[0] = { ...values[0], translationMarkdown: '' }
    if (selected === 'fields') values[0] = { ...values[0], readingNotes: 0 }
    if (selected === 'blank')
      values = values.map((v) => ({ ...v, contentType: 'blank', translationMarkdown: '' }))
    if (selected === 'visual')
      values = values.map((v) => ({
        ...v,
        contentType: 'visual_only',
        translationMarkdown: '',
        visualElements: [
          { id: 'fig', type: 'diagram', location: '중앙', descriptionMarkdown: '관계' },
        ],
      }))
    if (selected === 'mixed')
      values = values.map((v: any, i: number) =>
        i === 1
          ? { ...v, ...content(''), contentType: 'unreadable', unclearRegions: ['작은 글자'] }
          : i === 2
            ? { ...v, ...content(''), contentType: 'blank' }
            : i === 3
              ? {
                  ...v,
                  ...content(''),
                  contentType: 'visual_only',
                  visualElements: [
                    { id: 'fig', type: 'diagram', location: '중앙', descriptionMarkdown: '관계' },
                  ],
                }
              : v,
      )
    if (selected === 'truncated')
      return new Response(
        'data: ' +
          JSON.stringify({
            type: 'response.incomplete',
            response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
          }) +
          '\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    const output = selected === 'invalid' ? '{bad' : JSON.stringify({ pages: values.reverse() })
    return new Response(
      'data: ' +
        JSON.stringify({
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [
              {
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'output_text', text: output }],
              },
            ],
          },
        }) +
        '\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }
  const auth = {
    snapshot: () => state,
    inferBatch: async (
      model: string,
      images: import('../../src/main/chatgpt/request').PageImageInput[],
      signal: AbortSignal,
      max: number,
    ) => {
      active++
      maximum = Math.max(maximum, active)
      try {
        const result = await translateImages(fetcher, 'FAKE_TOKEN', model, images, signal, max)
        signal.throwIfAborted()
        return result
      } finally {
        active--
      }
    },
  } as unknown as ChatGPTService
  const provider = new ChatGPTProvider(
    auth,
    store,
    async (part, images) => {
      renders.push(part.page)
      if (renderFail.has(part.page)) throw new Error('PRIVATE_RENDER')
      const job = queue.imageJob(part.page),
        doc = queue.sourceJob(job.session, job.token)!
      return {
        mimeType: 'image/jpeg',
        data: Buffer.from(
          JSON.stringify({ doc, page: part.page, pad: 'x'.repeat(padding.get(part.page) ?? 0) }),
        ).toString('base64'),
        width: Math.ceil((part.width * images.dpi) / 72),
        height: Math.ceil((part.height * images.dpi) / 72),
      }
    },
    policy,
  )
  provider.sync()
  store.version = provider.cacheVersion()
  queue = new TranslationQueue(store, provider)
  const run = async () => {
    const job = queue.claim()
    if (job) await queue.submit(job.session, job.token, job.pages.map(source))
    return job
  }
  const sync = () => {
    provider.sync()
    queue.credentialsChanged()
  }
  return {
    renders,
    renderFail,
    padding,
    set source(v: (n: number) => SourcePage) {
      source = v
    },
    set behavior(v: ((pages: number[], call: number) => string) | undefined) {
      behavior = v
    },
    store,
    queue,
    provider,
    state,
    calls,
    run,
    sync,
    set mode(v: string) {
      mode = v
    },
    set retryAfter(v: string) {
      retryAfter = v
    },
    hold: () => {
      hold = true
    },
    release: () => release?.(),
    get held() {
      return !!release
    },
    get maximum() {
      return maximum
    },
  }
}
describe('active ChatGPT single-page document queue and cache boundary', () => {
  it('preserves A while unopened B runs, C/D wait, D opens at page 2 after B finishes, with no duplicate or mixed saves', async () => {
    const h = setup()
    try {
      const a = h.queue.activate('A', 'A.pdf', 1)
      await h.run()
      expect(h.queue.snapshot(a.session, 1).done).toBe(1)
      h.queue.enqueue('B', 'B.pdf', 3)
      h.hold()
      const running = h.run()
      await vi.waitFor(() => expect(h.calls).toHaveLength(2))
      h.queue.enqueue('C', 'C.pdf', 1)
      h.queue.enqueue('D', 'D.pdf', 3)
      expect(h.queue.claim()).toBeNull()
      const d = h.queue.activate('D', 'D.pdf', 3)
      h.queue.focus(d.session, 2)
      h.release()
      await running
      for (let i = 0; i < 6; i++) await h.run()
      expect(h.calls.map((c) => c.doc + ':' + c.page)).toEqual([
        'A:1',
        'B:1',
        'D:2',
        'D:1',
        'D:3',
        'B:2',
        'B:3',
        'C:1',
      ])
      expect(h.maximum).toBe(1)
      expect(h.queue.claim()).toBeNull()
      for (const [id, total] of [
        ['A', 1],
        ['B', 3],
        ['C', 1],
        ['D', 3],
      ] as const)
        expect(h.store.load(id).size).toBe(total)
      for (const call of h.calls) {
        expect(call.body.input[0].content).toHaveLength(2)
        expect(call.body.instructions).toContain('Korean(original English)')
        expect(call.body).not.toHaveProperty('max_output_tokens')
        expect(call.body).not.toHaveProperty('media_resolution')
      }
    } finally {
      h.store.close()
    }
  })
  it('keeps jobs without auth/plan/verification, cancels on pause, rejects late responses and resumes without losing work', async () => {
    const h = setup()
    try {
      const session = h.queue.enqueue('A', 'a.pdf', 2)
      for (const change of [
        { status: 'disconnected' },
        { verified: false },
        { planAllowed: false },
      ] as const) {
        const before = { ...h.state }
        Object.assign(h.state, change)
        expect(h.queue.claim()).toBeNull()
        Object.assign(h.state, before)
      }
      h.hold()
      const running = h.run()
      await vi.waitFor(() => expect(h.calls).toHaveLength(1))
      h.queue.pause(session.session, true)
      expect(h.queue.claim()).toBeNull()
      h.release()
      await running
      expect(h.store.load('A').size).toBe(0)
      h.queue.pause(session.session, false)
      await h.run()
      await h.run()
      expect(h.store.load('A').size).toBe(2)
      expect(h.maximum).toBe(1)
    } finally {
      h.store.close()
    }
  })
  it('cancels account/model transitions, never saves an old response under a new key, and reuses only the same connection/model results', async () => {
    const h = setup()
    try {
      h.queue.enqueue('A', 'a.pdf', 1)
      h.hold()
      const pending = h.run()
      await vi.waitFor(() => expect(h.calls).toHaveLength(1))
      const previous = h.store.version
      h.queue.budgetChanged()
      h.state.activeId = 'connection-B'
      h.sync()
      h.release()
      await pending
      expect(h.store.load('A').size).toBe(0)
      await h.run()
      const b = h.store.version
      expect(b).not.toBe(previous)
      expect(h.calls).toHaveLength(2)
      h.state.activeId = 'connection-A'
      h.sync()
      await h.run()
      expect(h.calls).toHaveLength(3)
      h.state.activeId = 'connection-B'
      h.sync()
      expect(h.queue.claim()).toBeNull()
      h.provider.chooseModel('gpt-6-sol')
      h.queue.imagesChanged()
      await h.run()
      expect(h.calls.at(-1)?.model).toBe('gpt-6-sol')
      h.state.status = 'disconnected'
      h.state.verified = false
      expect(h.store.load('A').get(1)?.status).toBe('done')
      expect(h.queue.claim()).toBeNull()
    } finally {
      h.store.close()
    }
  })
  it.each(['invalid', 'incomplete', 'unreadable', 'network'])(
    'isolates %s page errors and continues other documents',
    async (mode) => {
      const h = setup()
      try {
        h.queue.enqueue('A', 'a.pdf', 1)
        h.queue.enqueue('B', 'b.pdf', 1)
        h.mode = mode
        await h.run()
        expect(h.store.load('A').get(1)?.status).toBe('error')
        h.mode = 'normal'
        await h.run()
        expect(h.store.load('B').get(1)?.status).toBe('done')
        expect(h.calls).toHaveLength(2)
      } finally {
        h.store.close()
      }
    },
  )
  it.each(['auth', 'permission', 'model', 'quota', 'bad-request-stream'])(
    'holds all work for global %s without automatic provider fallback',
    async (mode) => {
      const h = setup()
      try {
        h.queue.enqueue('A', 'a.pdf', 1)
        h.queue.enqueue('B', 'b.pdf', 1)
        h.mode = mode
        await h.run()
        expect(h.queue.claim()).toBeNull()
        expect(h.calls).toHaveLength(1)
        expect(h.store.load('A').size).toBe(0)
        expect(h.provider.waitingReason()).not.toBe('')
      } finally {
        h.store.close()
      }
    },
  )
  it.each(['rate', 'rate-stream'])(
    'honors Retry-After and caps %s retries at three total attempts',
    async (mode) => {
      vi.useFakeTimers()
      const h = setup()
      try {
        h.queue.enqueue('A', 'a.pdf', 1)
        h.mode = mode
        for (let i = 0; i < 3; i++) {
          await h.run()
          expect(h.queue.claim()).toBeNull()
          vi.advanceTimersByTime(2001)
        }
        expect(h.queue.claim()).toBeNull()
        expect(h.calls).toHaveLength(3)
        h.provider.resume()
        h.mode = 'normal'
        await h.run()
        expect(h.store.load('A').get(1)?.status).toBe('done')
      } finally {
        h.store.close()
        vi.useRealTimers()
      }
    },
  )
  it.each(['seconds', 'date', 'invalid'])(
    'uses Retry-After %s without starting early',
    async (kind) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-19T12:00:00Z'))
      const h = setup()
      try {
        const wait = kind === 'invalid' ? 30000 : 5000
        h.retryAfter =
          kind === 'seconds'
            ? '5'
            : kind === 'date'
              ? new Date(Date.now() + 5000).toUTCString()
              : 'invalid'
        h.mode = 'rate'
        h.queue.enqueue('A', 'a.pdf', 1)
        await h.run()
        vi.advanceTimersByTime(wait - 1)
        expect(h.queue.claim()).toBeNull()
        vi.advanceTimersByTime(2)
        h.mode = 'normal'
        await h.run()
        expect(h.calls).toHaveLength(2)
      } finally {
        h.store.close()
        vi.useRealTimers()
      }
    },
  )
  it('preserves Gemini rows/settings, uses their original provenance, persists explicit retranslation and ChatGPT history/restart', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-chatgpt-cache-')),
      path = join(folder, 'cache.sqlite')
    let h = setup(path)
    try {
      const legacy = new TranslationStore(path, TRANSLATION_VERSION)
      legacy.register('A', 'a.pdf', 2)
      legacy.save('A', 1, { status: 'done', text: '기존 번역', content: content('기존 번역') })
      legacy.saveBudgetSettings({ inputTokens: 12001, outputTokens: 9000 })
      legacy.saveImageSettings({ ...DEFAULT_IMAGE_SETTINGS, quality: 0.85 })
      legacy.close()
      const session = h.queue.activate('A', 'a.pdf', 2)
      expect(h.store.load('A').get(1)).toMatchObject({
        status: 'done',
        provenance: { provider: 'gemini', version: TRANSLATION_VERSION, legacy: true },
      })
      expect(h.store.list()[0]).toMatchObject({ done: 1, total: 2 })
      await h.run()
      expect(h.calls.map((c) => c.page)).toEqual([2])
      expect(h.queue.claim()).toBeNull()
      expect(h.store.list()[0]).toMatchObject({ done: 2, status: 'complete' })
      h.queue.retry(session.session, 1)
      expect(h.store.load('A').has(1)).toBe(false)
      await h.run()
      h.queue.retry(session.session, 1)
      await h.run()
      const db = new DatabaseSync(path)
      expect(db.prepare('SELECT COUNT(*) AS n FROM translation_history').get()?.n).toBe(1)
      expect(
        db
          .prepare("SELECT text FROM translations WHERE document_id='A' AND page=1 AND version=?")
          .get(TRANSLATION_VERSION)?.text,
      ).toBe('기존 번역')
      db.close()
      h.store.close()
      h = setup(path)
      h.queue.restore()
      expect(h.queue.claim()).toBeNull()
      expect(h.store.budgetSettings()).toEqual({ inputTokens: 12001, outputTokens: 9000 })
      expect(h.store.imageSettings()).toMatchObject({ quality: 0.85 })
      h.state.activeId = 'different'
      h.sync()
      expect(h.store.load('A').has(1)).toBe(false)
    } finally {
      h.store.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('ChatGPT variable page batches', () => {
  const policy = { ...DEFAULT_CHATGPT_BATCH_POLICY }
  async function drain(h: ReturnType<typeof setup>) {
    for (let i = 0; i < 100; i++) if (!(await h.run())) return
    throw new Error('queue did not finish')
  }
  it('uses fewer image-only requests than single pages, maps reverse JSON order and keeps the same cache identity', async () => {
    const single = setup(),
      multi = setup(':memory:', policy)
    try {
      for (const h of [single, multi]) {
        h.queue.enqueue('A', 'a.pdf', 9)
        await drain(h)
      }
      expect(single.calls).toHaveLength(9)
      expect(multi.calls.length).toBeLessThan(single.calls.length)
      expect(multi.calls.some((c) => c.pages.length > 1)).toBe(true)
      expect(multi.store.load('A')).toEqual(single.store.load('A'))
      expect(multi.store.version).toBe(single.store.version)
      expect(multi.renders).toHaveLength(9)
      expect(multi.maximum).toBe(1)
      for (const call of multi.calls) {
        const parts = call.body.input[0].content
        expect(parts.length).toBe(call.pages.length * 2)
        for (let i = 0; i < parts.length; i += 2) {
          expect(JSON.parse(parts[i].text)).toMatchObject({
            page: call.pages[i / 2],
            part: 1,
            image: i / 2 + 1,
          })
          expect(parts[i + 1].type).toBe('input_image')
          expect(parts[i].text).not.toContain('EXTRACTED_SECRET')
        }
        expect(call.body.instructions).toContain('Korean(original English)')
        expect(call.body).not.toHaveProperty('max_output_tokens')
        expect(call.body).not.toHaveProperty('media_resolution')
      }
    } finally {
      single.store.close()
      multi.store.close()
    }
  })
  it('prioritizes the current-page batch in document order and skips an already completed current page', async () => {
    const h = setup(':memory:', policy)
    try {
      const session = h.queue.activate('A', 'a.pdf', 8)
      h.queue.focus(session.session, 7)
      await drain(h)
      expect(h.calls[0].pages).toContain(7)
      expect(h.calls[0].pages).toEqual([...h.calls[0].pages].sort((a, b) => a - b))
      expect(h.calls.flatMap((c) => c.pages).sort((a, b) => a - b)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8,
      ])
      h.queue.focus(session.session, 7)
      expect(h.queue.claim()).toBeNull()
    } finally {
      h.store.close()
    }
  })
  it('caps actual serialized bytes, reuses overflow candidates, and does not reduce image settings', async () => {
    const h = setup(':memory:', { ...policy, maxRequestBytes: 12000 })
    try {
      for (let n = 1; n <= 3; n++) h.padding.set(n, 4000)
      h.queue.enqueue('A', 'a.pdf', 3)
      await drain(h)
      expect(h.calls.map((c) => c.pages)).toEqual([[1], [2], [3]])
      expect(h.renders).toEqual([1, 2, 3])
      for (const c of h.calls)
        expect(Buffer.byteLength(JSON.stringify(c.body))).toBeLessThanOrEqual(12000)
      expect(h.provider.settings().images).toEqual(DEFAULT_IMAGE_SETTINGS)
    } finally {
      h.store.close()
    }
  })
  it.each(['missing', 'duplicate', 'unexpected', 'empty', 'fields', 'invalid', 'truncated'])(
    'shrinks %s responses to single pages, validates whole responses and reuses images',
    async (mode) => {
      const h = setup(':memory:', policy)
      try {
        h.queue.enqueue('A', 'a.pdf', 4)
        h.behavior = (pages) => (pages.length > 1 ? mode : 'normal')
        await drain(h)
        expect(h.calls.map((c) => c.pages.length)).toEqual([4, 2, 1, 1, 2, 1, 1])
        expect(h.store.load('A').size).toBe(4)
        expect([...h.store.load('A').values()].every((r) => r.status === 'done')).toBe(true)
        expect(h.renders).toEqual([1, 2, 3, 4])
        expect(h.maximum).toBe(1)
      } finally {
        h.store.close()
      }
    },
  )
  it('bounds persistent invalid output by original job and per-page limits, saving no partial JSON', async () => {
    const h = setup(':memory:', { ...policy, inputTokens: 131072, outputTokens: 65536 })
    try {
      h.queue.enqueue('A', 'a.pdf', 16)
      h.mode = 'missing'
      await drain(h)
      expect(h.calls.length).toBeLessThanOrEqual(3 * (2 * 16 - 1))
      for (let n = 1; n <= 16; n++)
        expect(h.calls.filter((c) => c.pages.includes(n)).length).toBeLessThanOrEqual(5)
      expect([...h.store.load('A').values()].every((r) => r.status === 'error')).toBe(true)
      expect(h.store.list()[0].done).toBe(0)
    } finally {
      h.store.close()
    }
  })
  it('yields between shrink retries to a newly opened document and preserves the original work', async () => {
    const h = setup(':memory:', policy)
    try {
      h.queue.activate('A', 'a.pdf', 8)
      h.behavior = (_pages, n) => (n === 1 ? 'truncated' : 'normal')
      h.hold()
      const running = h.run()
      await vi.waitFor(() => expect(h.calls).toHaveLength(1))
      const b = h.queue.activate('B', 'b.pdf', 3)
      h.queue.focus(b.session, 2)
      h.release()
      await running
      expect(h.store.load('A').size).toBe(0)
      await drain(h)
      expect(h.calls[1]).toMatchObject({ doc: 'B', pages: [1, 2, 3] })
      expect(h.store.load('A').size).toBe(8)
      expect(h.store.load('B').size).toBe(3)
      expect(h.maximum).toBe(1)
    } finally {
      h.store.close()
    }
  })
  it('isolates a solo oversized image, oversized output and render failure while other pages/documents finish', async () => {
    const h = setup(':memory:', { ...policy, maxRequestBytes: 12000 })
    try {
      h.padding.set(1, 40000)
      h.renderFail.add(3)
      h.source = (n) => imagePage(n, n === 4 ? 30000 : 2048)
      h.queue.enqueue('A', 'a.pdf', 5)
      await drain(h)
      h.padding.clear()
      h.renderFail.clear()
      h.queue.enqueue('B', 'b.pdf', 1)
      await drain(h)
      expect(h.store.load('B').get(1)?.status).toBe('done')
      expect(h.store.load('A').get(1)?.status).toBe('error')
      expect(h.store.load('A').get(3)?.status).toBe('error')
      expect(h.store.load('A').get(4)?.status).toBe('error')
      expect(h.store.load('A').get(2)?.status).toBe('done')
      expect(h.store.load('A').get(5)?.status).toBe('done')
      expect(h.calls.some((c) => c.doc === 'A' && c.pages.some((p) => [1, 3, 4].includes(p)))).toBe(
        false,
      )
      expect(h.renders).not.toContain(4)
    } finally {
      h.store.close()
    }
  })
  it.each(['blank', 'visual', 'unreadable'])(
    'handles %s in a validated batch without format retries',
    async (mode) => {
      const h = setup(':memory:', policy)
      try {
        h.mode = mode
        h.queue.enqueue('A', 'a.pdf', 3)
        await drain(h)
        expect(h.calls).toHaveLength(1)
        expect(
          [...h.store.load('A').values()].every(
            (r) => r.status === (mode === 'unreadable' ? 'error' : 'done'),
          ),
        ).toBe(true)
      } finally {
        h.store.close()
      }
    },
  )
  it('never retries an API for a DB callback failure and does not repeat the successfully saved page on recovery', async () => {
    const h = setup(':memory:', policy),
      save = h.store.save.bind(h.store)
    try {
      const session = h.queue.activate('A', 'a.pdf', 4)
      h.store.save = (id, page, result) => {
        if (page === 2) throw new Error('PRIVATE_SQL')
        save(id, page, result)
      }
      await h.run()
      expect(h.calls).toHaveLength(1)
      expect(h.store.load('A').get(1)?.status).toBe('done')
      h.store.save = save
      h.queue.retry(session.session)
      await drain(h)
      expect(h.calls[1].pages).not.toContain(1)
      expect(h.store.load('A').size).toBe(4)
    } finally {
      h.store.close()
    }
  })
  it('keeps whole-batch cancellation and late-response guards across pause and account changes', async () => {
    const h = setup(':memory:', policy)
    try {
      const session = h.queue.activate('A', 'a.pdf', 4)
      h.hold()
      const pending = h.run()
      await vi.waitFor(() => expect(h.calls).toHaveLength(1))
      h.queue.pause(session.session, true)
      h.state.activeId = 'other'
      h.sync()
      h.release()
      await pending
      expect(h.store.load('A').size).toBe(0)
      expect(h.queue.claim()).toBeNull()
      h.queue.pause(session.session, false)
      await drain(h)
      expect(h.store.load('A').size).toBe(4)
      expect(h.maximum).toBe(1)
    } finally {
      h.store.close()
    }
  })
  it('preserves reduced retry groups and 429 counters across a cooldown instead of restarting a large batch', async () => {
    vi.useFakeTimers()
    const h = setup(':memory:', policy)
    try {
      h.queue.enqueue('A', 'a.pdf', 4)
      h.behavior = (pages, n) => (n === 1 ? 'truncated' : pages.includes(1) ? 'rate' : 'normal')
      await h.run()
      expect(h.calls.map((c) => c.pages)).toEqual([
        [1, 2, 3, 4],
        [1, 2],
      ])
      for (let n = 0; n < 2; n++) {
        vi.advanceTimersByTime(2001)
        await h.run()
      }
      vi.advanceTimersByTime(2001)
      expect(h.queue.claim()).toBeNull()
      expect(h.calls).toHaveLength(4)
      expect(h.calls.slice(1).every((c) => c.pages.length === 2)).toBe(true)
      h.behavior = undefined
      h.queue.pause(h.queue.activate('A', 'a.pdf', 4).session, false)
      await drain(h)
      expect(h.store.load('A').size).toBe(4)
    } finally {
      h.store.close()
      vi.useRealTimers()
    }
  })
})

describe('completed batch compatibility', () => {
  it('keeps normal/blank/visual pages complete while a mixed unreadable page remains an error', async () => {
    const h = setup(':memory:', { ...DEFAULT_CHATGPT_BATCH_POLICY })
    try {
      h.mode = 'mixed'
      const session = h.queue.activate('A', 'a.pdf', 4)
      await h.run()
      expect(h.calls).toHaveLength(1)
      expect(h.queue.snapshot(session.session, 2)).toMatchObject({
        done: 3,
        failed: 1,
        result: { status: 'error', code: 'unreadable' },
      })
      expect(h.store.load('A').get(3)).toMatchObject({
        status: 'done',
        content: { contentType: 'blank' },
      })
      expect(h.store.load('A').get(4)).toMatchObject({
        status: 'done',
        content: { contentType: 'visual_only' },
      })
    } finally {
      h.store.close()
    }
  })
  it('restarts under new batching budgets and reuses previously single-page ChatGPT and Gemini rows without a request', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'translave-batch-reuse-')),
      path = join(directory, 'cache.sqlite')
    let h = setup(path)
    try {
      h.queue.enqueue('A', 'a.pdf', 3)
      for (let i = 0; i < 3; i++) await h.run()
      expect(h.calls).toHaveLength(3)
      const version = h.store.version
      h.store.close()
      const legacy = new TranslationStore(path, TRANSLATION_VERSION)
      legacy.register('B', 'b.pdf', 1)
      legacy.save('B', 1, { status: 'done', text: '기존 Gemini', content: content('기존 Gemini') })
      legacy.close()
      h = setup(path, { ...DEFAULT_CHATGPT_BATCH_POLICY, inputTokens: 65536, outputTokens: 32768 })
      h.queue.restore()
      expect(h.store.version).toBe(version)
      expect(h.queue.claim()).toBeNull()
      expect(h.calls).toHaveLength(0)
      expect(h.store.load('A').size).toBe(3)
      expect(h.store.load('B').get(1)).toMatchObject({
        status: 'done',
        provenance: { provider: 'gemini', legacy: true },
      })
    } finally {
      h.store.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
