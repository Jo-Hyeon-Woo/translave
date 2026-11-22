import { describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_BATCH_BUDGET,
  DEFAULT_IMAGE_SETTINGS,
  MAX_PLAN_PAGES,
  TRANSLATION_VERSION,
  validBatchBudget,
} from '../../src/shared/contracts'
import type { BatchBudget } from '../../src/shared/contracts'
import { estimateBatch, estimatePageOutput, fits, planBatches } from '../../src/main/batching'
import { TranslationService } from '../../src/main/translation'
import { TranslationQueue } from '../../src/main/queue'
import { TranslationStore } from '../../src/main/store'
import { answer, content, envelope, fakeRender, imagePage, sources } from './fakes'

const oldBudget = { inputTokens: 12000, outputTokens: 8192 }
const doc = 'b'.repeat(64)
function provider(budget = DEFAULT_BATCH_BUDGET) {
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => answer(sources(options)))
  const service = new TranslationService(fetcher, fakeRender)
  service.configureBudget(budget)
  service.configure({ apiKey: 'fake-budget-key' })
  return { service, fetcher }
}

describe('larger default image batches', () => {
  it('shares new defaults across the service and retains the exact allowed ranges and image estimates', () => {
    expect(DEFAULT_BATCH_BUDGET).toEqual({ inputTokens: 16000, outputTokens: 16384 })
    expect(new TranslationService().settings().budget).toEqual(DEFAULT_BATCH_BUDGET)
    expect(new TranslationService().settings().images).toEqual(DEFAULT_IMAGE_SETTINGS)
    expect(MAX_PLAN_PAGES).toBe(16)
    expect(estimatePageOutput('')).toBe(2048)
    for (const budget of [
      { inputTokens: 4096, outputTokens: 2048 },
      { inputTokens: 32000, outputTokens: 16384 },
      oldBudget,
    ])
      expect(validBatchBudget(budget)).toBe(true)
    for (const budget of [
      { inputTokens: 4095, outputTokens: 2048 },
      { inputTokens: 32001, outputTokens: 16384 },
      { inputTokens: 16000, outputTokens: 2047 },
      { inputTokens: 16000, outputTokens: 16385 },
      { inputTokens: 16000.5, outputTokens: 8192 },
    ])
      expect(validBatchBudget(budget)).toBe(false)
  })
  it('fits seven intact minimum-output pages, rejects eight by output budget and packs in document order', () => {
    const pages = Array.from({ length: 8 }, (_, i) => imagePage(i + 1))
    const parts = planBatches(pages, DEFAULT_BATCH_BUDGET).flat()
    expect(estimateBatch(parts.slice(0, 7)).output).toBe(15296)
    expect(estimateBatch(parts).output).toBe(17408)
    expect(estimateBatch(parts).input).toBeLessThanOrEqual(16000)
    expect(fits(parts.slice(0, 7), DEFAULT_BATCH_BUDGET)).toBe(true)
    expect(fits(parts, DEFAULT_BATCH_BUDGET)).toBe(false)
    const batches = planBatches([...pages].reverse(), DEFAULT_BATCH_BUDGET)
    expect(batches.map((b) => b.map((p) => p.page))).toEqual([[1, 2, 3, 4, 5, 6, 7], [8]])
    expect(
      batches.flat().every((p) => p.part === 1 && p.region.width === 1 && p.region.height === 1),
    ).toBe(true)
    expect(planBatches(pages, oldBudget).map((b) => b.length)).toEqual([3, 3, 2])
  })
  it('uses smaller batches for higher output estimates without reducing their allowance', () => {
    const pages = Array.from({ length: 8 }, (_, i) => imagePage(i + 1, 4000))
    const batches = planBatches(pages, DEFAULT_BATCH_BUDGET)
    expect(batches.map((b) => b.length)).toEqual([3, 3, 2])
    expect(batches.flat().every((p) => p.outputTokens === 4000 && p.part === 1)).toBe(true)
    expect(batches.every((b) => fits(b, DEFAULT_BATCH_BUDGET))).toBe(true)
  })
  it('sends fewer fake requests for the same 14 pages and stores every reversed response on its original page', async () => {
    const calls = []
    for (const budget of [oldBudget, DEFAULT_BATCH_BUDGET]) {
      const store = new TranslationStore(':memory:', TRANSLATION_VERSION)
      const { service, fetcher } = provider(budget)
      try {
        const queue = new TranslationQueue(store, service),
          opened = queue.activate(doc, 'fake.pdf', 14)
        const job = queue.claim()!
        expect(job.pages).toHaveLength(14)
        await queue.submit(
          job.session,
          job.token,
          job.pages.map((p) => imagePage(p)),
        )
        expect(queue.snapshot(opened.session, 1)).toMatchObject({ done: 14, failed: 0 })
        for (let page = 1; page <= 14; page++)
          expect(store.load(doc).get(page)).toEqual({
            status: 'done',
            text: `번역 ${page}/1`,
            content: content(`번역 ${page}/1`),
          })
        expect(queue.claim()).toBeNull()
        const payload = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
        expect(payload.generationConfig.maxOutputTokens).toBe(budget.outputTokens)
        expect(payload.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH')
        expect(service.settings().images).toEqual(DEFAULT_IMAGE_SETTINGS)
        calls.push(fetcher.mock.calls.map((c) => sources(c[1]).map((p) => p.page)))
      } finally {
        store.close()
      }
    }
    expect(calls[0].map((b) => b.length)).toEqual([3, 3, 3, 3, 2])
    expect(calls[1].map((b) => b.length)).toEqual([7, 7])
  })
  it('retains current-page priority and bounded shrinking when a seven-page response is truncated', async () => {
    const { service, fetcher } = provider()
    fetcher.mockImplementationOnce(async () => envelope('partial', 'MAX_TOKENS'))
    const store = new TranslationStore(':memory:', TRANSLATION_VERSION)
    try {
      const queue = new TranslationQueue(store, service),
        opened = queue.activate(doc, 'fake.pdf', 8)
      queue.focus(opened.session, 6)
      const job = queue.claim()!
      await queue.submit(
        job.session,
        job.token,
        job.pages.map((p) => imagePage(p)),
      )
      const requested = fetcher.mock.calls.map((c) => sources(c[1]).map((p) => p.page))
      expect(requested).toEqual([[1, 2, 3, 4, 5, 6, 7], [5, 6, 7], [1, 2, 3, 4], [8]])
      expect(queue.snapshot(opened.session, 6)).toMatchObject({ done: 8, failed: 0 })
      expect([...store.load(doc).values()].every((r) => r.status === 'done')).toBe(true)
      fetcher.mockClear()
      fetcher.mockImplementation(async () => envelope('partial', 'MAX_TOKENS'))
      await service.translate(
        {
          id: 'bounded',
          documentId: doc,
          pages: Array.from({ length: 7 }, (_, i) => imagePage(i + 1)),
        },
        () => {},
        () => 1,
        () => {},
      )
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(7)
    } finally {
      store.close()
    }
  })
})

function seed(file: string, budget: BatchBudget) {
  const db = new DatabaseSync(file)
  try {
    db.exec(
      'CREATE TABLE budget_settings (id INTEGER PRIMARY KEY CHECK(id=1),input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL)',
    )
    db.prepare('INSERT INTO budget_settings VALUES(1,?,?)').run(
      budget.inputTokens,
      budget.outputTokens,
    )
  } finally {
    db.close()
  }
}

describe('budget persistence and one-time defaults migration', () => {
  it.each([
    [oldBudget, DEFAULT_BATCH_BUDGET],
    [
      { inputTokens: 9000, outputTokens: 12000 },
      { inputTokens: 9000, outputTokens: 12000 },
    ],
    [
      { inputTokens: 12000, outputTokens: 16384 },
      { inputTokens: 12000, outputTokens: 16384 },
    ],
    [
      { inputTokens: 16000, outputTokens: 8192 },
      { inputTokens: 16000, outputTokens: 8192 },
    ],
  ])(
    'migrates only the exact old pair and restores saved budgets on restart %#',
    (initial, expected) => {
      const folder = mkdtempSync(join(tmpdir(), 'translave-budget-')),
        file = join(folder, 'cache.sqlite')
      seed(file, initial)
      let store = new TranslationStore(file, TRANSLATION_VERSION)
      try {
        expect(store.budgetSettings()).toEqual(expected)
        store.saveBudgetSettings({ inputTokens: 14000, outputTokens: 16000 })
        store.close()
        store = new TranslationStore(file, TRANSLATION_VERSION)
        expect(store.budgetSettings()).toEqual({ inputTokens: 14000, outputTokens: 16000 })
        store.saveBudgetSettings(oldBudget)
        store.close()
        store = new TranslationStore(file, TRANSLATION_VERSION)
        expect(store.budgetSettings()).toEqual(oldBudget)
      } finally {
        store.close()
        rmSync(folder, { recursive: true, force: true })
      }
    },
  )
  it('persists initial defaults, rejects out-of-range saves and keeps completed cache across budget changes/restart', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-budget-cache-')),
      file = join(folder, 'cache.sqlite')
    let store = new TranslationStore(file, TRANSLATION_VERSION)
    try {
      expect(store.budgetSettings()).toEqual(DEFAULT_BATCH_BUDGET)
      store.register(doc, 'fake.pdf', 3)
      store.save(doc, 1, { status: 'done', text: '저장된 번역', content: content('저장된 번역') })
      expect(() => store.saveBudgetSettings({ inputTokens: 100, outputTokens: 8192 })).toThrow()
      expect(store.budgetSettings()).toEqual(DEFAULT_BATCH_BUDGET)
      store.saveBudgetSettings(oldBudget)
      store.close()
      store = new TranslationStore(file, TRANSLATION_VERSION)
      const { service, fetcher } = provider(store.budgetSettings())
      const queue = new TranslationQueue(store, service),
        opened = queue.activate(doc, 'fake.pdf', 3)
      service.configureBudget(DEFAULT_BATCH_BUDGET)
      store.saveBudgetSettings(service.settings().budget)
      queue.budgetChanged()
      expect(queue.snapshot(opened.session, 1)).toMatchObject({
        done: 1,
        result: { text: '저장된 번역' },
      })
      const job = queue.claim()!
      expect(job.pages).toEqual([2, 3])
      await queue.submit(
        job.session,
        job.token,
        job.pages.map((p) => imagePage(p)),
      )
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(sources(fetcher.mock.calls[0][1]).map((p) => p.page)).toEqual([2, 3])
      store.close()
      store = new TranslationStore(file, TRANSLATION_VERSION)
      expect(store.budgetSettings()).toEqual(DEFAULT_BATCH_BUDGET)
      const restored = provider(store.budgetSettings()),
        restoredQueue = new TranslationQueue(store, restored.service)
      const document = restoredQueue.activate(doc, 'fake.pdf', 3)
      expect(restoredQueue.snapshot(document.session, 1).done).toBe(3)
      expect(restoredQueue.claim()).toBeNull()
      expect(restored.fetcher).not.toHaveBeenCalled()
    } finally {
      store.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('preserves an invalid stored pair but uses safe runtime defaults', () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-budget-invalid-')),
      file = join(folder, 'cache.sqlite')
    seed(file, { inputTokens: 100, outputTokens: 8192 })
    const store = new TranslationStore(file, TRANSLATION_VERSION)
    try {
      expect(store.budgetSettings()).toEqual(DEFAULT_BATCH_BUDGET)
      const db = new DatabaseSync(file, { readOnly: true })
      try {
        expect(
          db.prepare('SELECT input_tokens,output_tokens FROM budget_settings').get(),
        ).toMatchObject({ input_tokens: 100, output_tokens: 8192 })
      } finally {
        db.close()
      }
    } finally {
      store.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
