import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationService } from '../../src/main/translation'
import { hasEnglishProse, hasUntranslatedEnglish } from '../../src/main/translationLanguage'
import { TranslationStore } from '../../src/main/store'
import { TranslationQueue } from '../../src/main/queue'
import {
  DEFAULT_IMAGE_SETTINGS,
  TRANSLATION_VERSION,
  translationVersion,
} from '../../src/shared/contracts'
import type { TranslationResult } from '../../src/shared/contracts'
import { answer, content, envelope, fakeRender, imagePage, sources } from './fakes'

const doc = 'a'.repeat(64)
const english =
  '# Computer and Network Security Overview\n\nThe network protects information from unauthorized access.'
const request = { id: 'language-job', documentId: doc, pages: [imagePage(1)] }
const copied = (options?: RequestInit) =>
  envelope(
    JSON.stringify({
      pages: sources(options).map((p) => ({ page: p.page, part: p.part, ...content(english) })),
    }),
  )
function setup(fetcher: typeof fetch) {
  const service = new TranslationService(fetcher, fakeRender)
  service.configure({ apiKey: 'fake-language-key' })
  return service
}

describe('untranslated English safeguard', () => {
  it('detects copied prose/headings, including an English paragraph below a Korean heading', () => {
    expect(hasEnglishProse(english)).toBe(true)
    expect(
      hasEnglishProse(
        '# 컴퓨터 보안\n\nThe network protects information from unauthorized access.',
      ),
    ).toBe(true)
    expect(
      hasUntranslatedEnglish({
        ...content('번역 본문'),
        readingNotes: ['Read the diagram from left to right.'],
      }),
    ).toBe(true)
  })
  it.each([
    '```js\nconst message = "The network protects information from unauthorized access.";\n```',
    '~~~python\nprint("The network protects information from unauthorized access.")\n~~~',
    '`The network protects information from unauthorized access.`',
    '$$E = mc^2 + \\text{The network protects information}$$',
    '\\(E = mc^2 + \\text{The network protects information}\\)',
    '    const message = "The network protects information from unauthorized access.";',
    'TCP / IP / TLS / AES-256 / SHA-256 / 10 ms / 128 bit',
    'Alan Mathison Turing\n\nUniversity of Cambridge\n\nGoogle Gemini',
    'requestId document_id MEDIA_RESOLUTION_HIGH x-goog-api-key',
    '컴퓨터와 네트워크 보안(Computer and Network Security)은 정보를 보호합니다.',
    'https://example.invalid/the/network/protects/information',
    '<script>window.unsafe = true</script>\n<img src="https://evil.invalid/raw">\n\n![remote](https://evil.invalid/image) [link](javascript:alert(1))',
  ])('preserves Korean explanations and exempt code/math/identifiers %#', (markdown) => {
    expect(hasEnglishProse(markdown)).toBe(false)
  })
  it('rejects a schema-valid English transcription, retries the same image with correction and publishes only Korean', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_u, o) => answer(sources(o)))
    fetcher.mockImplementationOnce(async (_u, o) => copied(o))
    const service = setup(fetcher),
      publish = vi.fn()
    await service.translate(
      request,
      publish,
      () => 1,
      () => {},
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sources(fetcher.mock.calls[0][1])).toEqual(sources(fetcher.mock.calls[1][1]))
    expect(
      JSON.parse(String(fetcher.mock.calls[1][1]?.body)).systemInstruction.parts[0].text,
    ).toContain('A previous response contained untranslated English prose')
    expect(publish.mock.calls).toEqual([
      [1, expect.objectContaining({ status: 'done', text: '번역 1/1' })],
    ])
  })
  it('bounds repeated English output to three requests, exposes an error, and continues other pages', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_u, o) => copied(o)),
      service = setup(fetcher)
    const results = new Map<number, TranslationResult>()
    await service.translate(
      request,
      (p, r) => results.set(p, r),
      () => 1,
      () => {},
    )
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(results.get(1)).toMatchObject({ status: 'error', code: 'language' })
    expect(results.get(1)).not.toHaveProperty('content')
    expect(sources(fetcher.mock.calls[2][1])[0]).toMatchObject({
      part: 1,
      region: { x: 0, y: 0, width: 1, height: 1 },
    })
    fetcher.mockClear()
    fetcher.mockImplementation(async (_u, o) =>
      sources(o).some((p) => p.page === 1) ? copied(o) : answer(sources(o)),
    )
    await service.translate(
      { ...request, pages: [imagePage(1), imagePage(2)] },
      (p, r) => results.set(p, r),
      () => 1,
      () => {},
    )
    expect(results.get(1)).toMatchObject({ status: 'error', code: 'language' })
    expect(results.get(2)).toMatchObject({ status: 'done', text: '번역 2/1' })
    expect(fetcher.mock.calls.map((c) => sources(c[1]).map((p) => p.page))).toEqual([
      [1, 2],
      [1],
      [1],
      [2],
    ])
  })
  it('retains language retry state across a priority yield without duplicate successful calls', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_u, o) => answer(sources(o)))
    fetcher.mockImplementationOnce(async (_u, o) => copied(o))
    const service = setup(fetcher),
      publish = vi.fn()
    const shouldYield = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    expect(
      await service.translate(
        request,
        publish,
        () => 1,
        () => {},
        shouldYield,
      ),
    ).toBe(true)
    expect(publish).not.toHaveBeenCalled()
    await service.translate(
      request,
      publish,
      () => 1,
      () => {},
    )
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(String(fetcher.mock.calls[1][1]?.body)).toContain(
      'A previous response contained untranslated English prose',
    )
  })
  it('accepts an English-only code/formula/acronym page without adding invented Korean text', async () => {
    const markdown =
      '```js\nconst message = "The network protects information.";\n```\n\n$E = mc^2$\n\nTCP / IP'
    const fetcher = vi.fn<typeof fetch>(async (_u, o) =>
      envelope(
        JSON.stringify({
          pages: sources(o).map((p) => ({ page: p.page, part: p.part, ...content(markdown) })),
        }),
      ),
    )
    const publish = vi.fn()
    await setup(fetcher).translate(
      request,
      publish,
      () => 1,
      () => {},
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ status: 'done', text: markdown }),
    )
  })
})

it('migrates valid completions once, requeues old English pages only, and preserves old records and explicit retry', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'translave-language-')),
    path = join(folder, 'cache.sqlite')
  const previous = TRANSLATION_VERSION.replace(':prompt4:', ':prompt3:')
  let store = new TranslationStore(path, previous)
  try {
    store.register(doc, 'fake.pdf', 4)
    store.position(doc, 2)
    const good = content('컴퓨터와 네트워크 보안'),
      code = content('```js\nconst message = "The network protects information.";\n```')
    store.save(doc, 1, { status: 'done', text: good.translationMarkdown, content: good })
    store.save(doc, 2, { status: 'done', text: english, content: content(english) })
    store.save(doc, 3, { status: 'done', text: code.translationMarkdown, content: code })
    const blank = { ...content(''), contentType: 'blank' as const }
    store.save(doc, 4, { status: 'done', text: '', content: blank })
    store.pauseAll(true)
    const higher = translationVersion({ ...DEFAULT_IMAGE_SETTINGS, dpi: 200 })
    store.version = higher.replace(':prompt4:', ':prompt3:')
    store.save(doc, 1, { status: 'done', text: good.translationMarkdown, content: good })
    store.close()
    store = new TranslationStore(path, TRANSLATION_VERSION)
    expect([...store.load(doc).keys()]).toEqual([1, 3, 4])
    const fetcher = vi.fn<typeof fetch>(async (_u, o) => answer(sources(o))),
      service = setup(fetcher)
    service.configure({ apiKey: '' })
    const queue = new TranslationQueue(store, service),
      opened = queue.activate(doc, 'fake.pdf', 4)
    expect(opened.page).toBe(2)
    expect(queue.snapshot(opened.session, 2).done).toBe(3)
    expect(queue.claim()).toBeNull()
    service.configure({ apiKey: 'fake-language-key' })
    queue.credentialsChanged()
    expect(queue.claim()).toBeNull()
    queue.pause(opened.session, false)
    const job = queue.claim()!
    expect(job.pages).toEqual([2])
    await queue.submit(job.session, job.token, [imagePage(2)])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(queue.claim()).toBeNull()
    store.version = previous
    expect(store.load(doc).get(2)).toMatchObject({ status: 'done', text: english })
    store.version = higher
    expect(store.load(doc).get(1)).toMatchObject({ status: 'done', content: good })
    store.version = TRANSLATION_VERSION
    queue.retry(opened.session, 1)
    store.close()
    store = new TranslationStore(path, TRANSLATION_VERSION)
    expect(store.load(doc).has(1)).toBe(false)
    expect(store.load(doc).get(2)).toMatchObject({ status: 'done', text: '번역 2/1' })
  } finally {
    store.close()
    rmSync(folder, { recursive: true, force: true })
  }
})
