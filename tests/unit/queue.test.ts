import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationStore } from '../../src/main/store'
import { TranslationQueue } from '../../src/main/queue'
import { TranslationService } from '../../src/main/translation'
import type { SourcePart } from '../../src/main/batching'
import { DEFAULT_IMAGE_SETTINGS } from '../../src/shared/contracts'
import type { SourcePage } from '../../src/shared/contracts'

const doc = 'a'.repeat(64),
  other = 'b'.repeat(64)
const stores: TranslationStore[] = [],
  directories: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
import { fakeRender, imagePage, content, sources, answer } from './fakes'
function setup(path = ':memory:', version = 'v2') {
  const store = new TranslationStore(path, version)
  stores.push(store)
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => answer(sources(options)))
  const provider = new TranslationService(fetcher, fakeRender)
  provider.configure({ apiKey: 'fake-key' })
  const queue = new TranslationQueue(store, provider)
  return { store, fetcher, provider, queue }
}
async function finish(queue: TranslationQueue, session: string) {
  const job = queue.claim(session)!
  expect(job).toBeTruthy()
  await queue.submit(
    session,
    job.token,
    job.pages.map((page) => imagePage(page)),
  )
  return job.pages
}
function deferred(fetcher: ReturnType<typeof setup>['fetcher']) {
  let settle!: () => void
  fetcher.mockImplementationOnce(
    (_url, options) =>
      new Promise((resolve) => {
        settle = () => resolve(answer(sources(options)))
      }),
  )
  return () => settle()
}

it('claims document-ordered windows containing current page, deduplicates submissions, and saves mapped pages', async () => {
  const { queue, store, fetcher } = setup()
  const { session } = queue.activate(doc, 'test.pdf', 20)
  queue.focus(session, 19)
  const job = queue.claim(session)!
  expect(job.pages).toEqual([17, 18, 19, 20])
  expect(queue.claim(session)).toBeNull()
  const texts = job.pages.map((page) => imagePage(page))
  const work = queue.submit(session, job.token, texts)
  await queue.submit(session, job.token, texts)
  await work
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(sources(fetcher.mock.calls[0][1]).map((p) => p.page)).toEqual([17, 18, 19, 20])
  expect(store.load(doc).get(19)).toEqual({
    status: 'done',
    text: '번역 19/1',
    content: content('번역 19/1'),
  })
  expect(await finish(queue, session)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
  expect(queue.snapshot(session, 1)).toMatchObject({ done: 20, failed: 0 })
  expect(queue.claim(session)).toBeNull()
})
it('restores SQLite pages and position, reuses completion across budget/key changes, separates versions', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-batch-db-'))
  directories.push(directory)
  const path = join(directory, 'translations.sqlite')
  const first = setup(path)
  const opened = first.queue.activate(doc, 'first.pdf', 3)
  await finish(first.queue, opened.session)
  first.queue.focus(opened.session, 2)
  const second = setup(path)
  second.provider.configure({ apiKey: '' })
  const restored = second.queue.activate(doc, 'renamed.pdf', 3)
  expect(restored.page).toBe(2)
  expect(second.queue.snapshot(restored.session, 2).result).toEqual({
    status: 'done',
    text: '번역 2/1',
    content: content('번역 2/1'),
  })
  second.provider.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
  second.queue.budgetChanged()
  second.provider.configure({ apiKey: 'fake-new' })
  second.queue.credentialsChanged()
  expect(second.queue.claim(restored.session)).toBeNull()
  expect(second.fetcher).not.toHaveBeenCalled()
  for (const version of ['model2', 'prompt3', 'extract2']) {
    const changed = setup(path, version)
    const session = changed.queue.activate(doc, 'file.pdf', 3).session
    expect(changed.queue.snapshot(session, 2).result.status).toBe('queued')
    await finish(changed.queue, session)
    expect(changed.fetcher).toHaveBeenCalledTimes(1)
  }
})
it('keeps an in-flight request on navigation and prioritizes focus outside its planning window next', async () => {
  const { queue, fetcher, store, provider } = setup()
  provider.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
  const settle = deferred(fetcher)
  const { session } = queue.activate(doc, 'test.pdf', 20)
  const job = queue.claim(session)!
  const work = queue.submit(
    session,
    job.token,
    job.pages.map((page) => imagePage(page)),
  )
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  queue.focus(session, 20)
  expect(queue.claim(session)).toBeNull()
  settle()
  await work
  expect(store.load(doc).size).toBe(1)
  expect(queue.claim(session)?.pages).toContain(20)
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it.each(['pause', 'key', 'budget', 'images', 'retry'])(
  'discards all late batch replies after %s and serializes the next job',
  async (action) => {
    const { queue, fetcher, store, provider } = setup()
    const settle = deferred(fetcher)
    const opened = queue.activate(doc, 'test.pdf', 3)
    const job = queue.claim(opened.session)!
    const work = queue.submit(
      opened.session,
      job.token,
      job.pages.map((page) => imagePage(page)),
    )
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    let session = opened.session
    if (action === 'pause') queue.pause(session, true)
    if (action === 'key') {
      provider.configure({ apiKey: '' })
      queue.credentialsChanged()
    }
    if (action === 'budget') {
      provider.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
      queue.budgetChanged()
    }
    if (action === 'images') {
      provider.configureImages({ ...DEFAULT_IMAGE_SETTINGS, dpi: 200 })
      queue.imagesChanged()
    }
    if (action === 'retry') queue.retry(session, 2)
    expect(queue.claim(session)).toBeNull()
    settle()
    await work
    expect(store.load(doc).size).toBe(0)
    if (action === 'pause') queue.pause(session, false)
    if (action === 'key') {
      provider.configure({ apiKey: 'new-key' })
      queue.credentialsChanged()
    }
    await finish(queue, session)
    expect(store.load(doc).size).toBe(3)
    expect(fetcher).toHaveBeenCalledTimes(action === 'budget' ? 4 : 2)
  },
)
it('stops after a permanent API error and resumes only failed/unfinished pages', async () => {
  const { queue, fetcher, store } = setup()
  store.register(doc, 'test.pdf', 4)
  store.save(doc, 1, { status: 'done', text: 'saved' })
  const restored = queue.activate(doc, 'test.pdf', 4).session
  fetcher.mockImplementationOnce(async () => new Response('', { status: 401 }))
  await finish(queue, restored)
  expect(queue.snapshot(restored, 2)).toMatchObject({ paused: true, done: 1, failed: 3 })
  expect(queue.claim(restored)).toBeNull()
  queue.pause(restored, false)
  expect(await finish(queue, restored)).toEqual([2, 3, 4])
  expect(fetcher.mock.calls.every((call) => sources(call[1]).every((p) => p.page !== 1))).toBe(true)
  expect(queue.activate(doc, 'test.pdf', 4).session).toBe(restored)
})
it('translates image pages independent of extraction and stores content types per page', async () => {
  const { queue, fetcher } = setup()
  const { session } = queue.activate(doc, 'test.pdf', 3)
  await finish(queue, session)
  expect(queue.snapshot(session, 1)).toMatchObject({ done: 3, skipped: 0, failed: 0 })
  expect(sources(fetcher.mock.calls[0][1]).map((p) => p.page)).toEqual([1, 2, 3])
})
it('stores validated neighboring pages despite a failed split, then reuses those results', async () => {
  const { queue, fetcher, store } = setup()
  fetcher.mockImplementation(async (_url, options) => {
    const parts = sources(options)
    return parts.some((p) => p.page === 2)
      ? new Response(JSON.stringify({ candidates: [{ finishReason: 'MAX_TOKENS' }] }))
      : answer(parts)
  })
  const { session } = queue.activate(doc, 'test.pdf', 3)
  await finish(queue, session)
  expect(store.load(doc).get(1)?.status).toBe('done')
  expect(store.load(doc).get(2)?.status).toBe('error')
  expect(store.load(doc).get(3)?.status).toBe('done')
  fetcher.mockClear()
  fetcher.mockImplementation(async (_url, options) => answer(sources(options)))
  queue.retry(session)
  await finish(queue, session)
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(sources(fetcher.mock.calls[0][1]).map((p) => p.page)).toEqual([2])
})
it('does not mark unsaved pages complete when SQLite write fails mid-batch', async () => {
  const { queue, store, fetcher } = setup()
  const { session } = queue.activate(doc, 'test.pdf', 3)
  const save = store.save.bind(store)
  vi.spyOn(store, 'save').mockImplementation((id, page, result) => {
    if (page === 2) throw new Error('disk full')
    save(id, page, result)
  })
  await finish(queue, session)
  expect(store.load(doc).size).toBe(1)
  expect(queue.snapshot(session, 2)).toMatchObject({ done: 1, failed: 2, paused: true })
  expect(fetcher).toHaveBeenCalledTimes(1)
})
it('validates the full extraction mapping before issuing any request', async () => {
  const { queue, fetcher } = setup()
  const { session } = queue.activate(doc, 'test.pdf', 3)
  const job = queue.claim(session)!
  await expect(queue.submit(session, job.token, [imagePage(1)])).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

it('schedules B/C/D in order while A is viewed, preempts after a batch, preserves jobs and mappings', async () => {
  const { queue, provider, fetcher, store } = setup()
  provider.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
  store.register(doc, 'A.pdf', 1)
  store.save(doc, 1, { status: 'done', text: 'saved A' })
  const a = queue.activate(doc, 'A.pdf', 1)
  const b = queue.enqueue(other, 'B.pdf', 3)
  const cId = 'c'.repeat(64),
    dId = 'd'.repeat(64)
  const settle = deferred(fetcher)
  const job = queue.claim()!
  expect(job.documentId).toBe(other)
  const work = queue.submit(
    job.session,
    job.token,
    job.pages.map((page) => imagePage(page)),
  )
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  queue.enqueue(cId, 'C.pdf', 1)
  queue.enqueue(dId, 'D.pdf', 3)
  expect(queue.enqueue(other, 'B.pdf', 3)).toEqual(b)
  expect(queue.library().find((row) => row.id === cId)?.status).toBe('waiting')
  const d = queue.activate(dId, 'D.pdf', 3)
  queue.focus(d.session, 3)
  expect(queue.claim()).toBeNull()
  settle()
  await work
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(store.load(other).size).toBe(1)
  const next = queue.claim()!
  expect(next.documentId).toBe(dId)
  await queue.submit(
    next.session,
    next.token,
    next.pages.map((page) => imagePage(page)),
  )
  expect(sources(fetcher.mock.calls[1][1]).map((p) => p.page)).toEqual([3])
  const resumed = queue.claim()!
  expect(resumed.token).toBe(job.token)
  expect(resumed.documentId).toBe(other)
  await queue.submit(
    resumed.session,
    resumed.token,
    resumed.pages.map((page) => imagePage(page)),
  )
  expect(queue.snapshot(a.session, 1).result).toEqual({ status: 'done', text: 'saved A' })
  expect(store.load(other).size).toBe(3)
  expect(queue.claim()?.documentId).toBe(cId)
  expect(fetcher).toHaveBeenCalledTimes(6) // B1, D3/D1/D2, B2/B3; B1 is reused.
})

it('preserves successful parts of oversized pages across document preemption', async () => {
  const { queue, provider, fetcher, store } = setup()
  provider.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
  const b = queue.enqueue(other, 'B.pdf', 1)
  const settle = deferred(fetcher)
  const job = queue.claim()!
  const pages = [imagePage(1, 18000)]
  const work = queue.submit(b.session, job.token, pages)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  const a = queue.activate(doc, 'A.pdf', 1)
  settle()
  await work
  expect(store.load(other).size).toBe(0)
  await finish(queue, a.session)
  const resume = queue.claim()!
  await queue.submit(resume.session, resume.token, pages)
  const ids = fetcher.mock.calls
    .flatMap((call) => sources(call[1]))
    .filter((p) => (p as SourcePart & { documentId: string }).documentId === other)
    .map((p) => p.part)
  expect(ids.length).toBeGreaterThan(1)
  expect(new Set(ids).size).toBe(ids.length)
  expect(store.load(other).get(1)?.status).toBe('done')
})

it('keeps documents waiting without a key or during global pause and restores scheduling', async () => {
  const { queue, provider, store, fetcher } = setup()
  provider.configure({ apiKey: '' })
  const a = queue.enqueue(doc, 'A.pdf', 1)
  expect(queue.claim()).toBeNull()
  expect(queue.library()[0].status).toBe('waiting')
  queue.pause(a.session, true)
  const b = queue.enqueue(other, 'B.pdf', 1)
  provider.configure({ apiKey: 'fake' })
  queue.credentialsChanged()
  expect(queue.claim()).toBeNull()
  const restored = new TranslationQueue(store, provider)
  restored.restore()
  expect(restored.claim()).toBeNull()
  queue.pause(a.session, false)
  await finish(queue, a.session)
  await finish(queue, b.session)
  queue.enqueue(doc, 'A.pdf', 1)
  expect(queue.claim()).toBeNull()
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it('isolates API and source failures to one document and processes the next', async () => {
  const { queue, fetcher, store } = setup()
  const a = queue.enqueue(doc, 'A.pdf', 2)
  const b = queue.enqueue(other, 'B.pdf', 1)
  fetcher.mockImplementationOnce(async () => new Response('', { status: 403 }))
  await finish(queue, a.session)
  expect(queue.snapshot(a.session, 1).paused).toBe(true)
  await finish(queue, b.session)
  expect(store.load(other).get(1)?.status).toBe('done')
  queue.retry(a.session)
  const missing = queue.claim()!
  queue.failSource(missing.session, missing.token)
  expect(queue.snapshot(a.session, 1).reason).toContain('원본 PDF')
  expect(queue.claim()).toBeNull()
})

it('rejects a different document session paired with the active extraction token', async () => {
  const { queue, fetcher, store } = setup()
  queue.enqueue(doc, 'A.pdf', 1)
  const b = queue.enqueue(other, 'B.pdf', 1)
  const job = queue.claim()!
  await queue.submit(b.session, job.token, [imagePage(1)])
  expect(fetcher).not.toHaveBeenCalled()
  expect(store.load(other).size).toBe(0)
  await queue.submit(job.session, job.token, [imagePage(1)])
  expect(store.load(doc).size).toBe(1)
})

it('removes only deleted queued/extracting/running owners and ignores a late completed translation without recreating rows', async () => {
  const { queue, store, fetcher } = setup()
  const a = queue.activate(doc, 'A.pdf', 2)
  const b = queue.enqueue(other, 'B.pdf', 1)
  const release = deferred(fetcher),
    job = queue.claim()!
  const work = queue.submit(
    job.session,
    job.token,
    job.pages.map((p) => imagePage(p)),
  )
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  store.deleteLibrary({ kind: 'document', id: doc })
  queue.removeDocuments([doc])
  expect(() => queue.snapshot(a.session, 1)).toThrow()
  release()
  await work
  expect(store.source(doc)).toBeUndefined()
  expect(store.load(doc).size).toBe(0)
  expect(queue.library().map((d) => d.id)).toEqual([other])
  const extraction = queue.claim()!
  expect(extraction.session).toBe(b.session)
  store.deleteLibrary({ kind: 'document', id: other })
  queue.removeDocuments([other])
  await queue.submit(
    extraction.session,
    extraction.token,
    extraction.pages.map((p) => imagePage(p)),
  )
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(queue.claim()).toBeNull()
})
