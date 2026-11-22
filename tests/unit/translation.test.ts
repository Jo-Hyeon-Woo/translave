import { describe, expect, it, vi } from 'vitest'
import { TranslationService } from '../../src/main/translation'
import {
  estimatePageOutput,
  estimateBatch,
  fits,
  planBatches,
  splitSource,
  validateResponse,
} from '../../src/main/batching'
import type { SourcePart } from '../../src/main/batching'
import { DEFAULT_BATCH_BUDGET, GEMINI_MODEL } from '../../src/shared/contracts'
import type { SourcePage, TranslationResult } from '../../src/shared/contracts'

const key = 'test_key_for_mock_requests_only'
const doc = 'a'.repeat(64)
import { fakeRender, imagePage, content, sources as source, rows, envelope } from './fakes'
function setup() {
  const fetcher = vi.fn<typeof fetch>(async (_url, options) =>
    envelope(JSON.stringify({ pages: rows(source(options)).reverse() })),
  )
  const service = new TranslationService(fetcher, fakeRender)
  service.configure({ apiKey: key })
  return { service, fetcher }
}
async function run(service: TranslationService, pages: SourcePage[], priority = 1) {
  const results = new Map<number, TranslationResult>()
  await service.translate(
    { id: 'job', documentId: doc, pages },
    (page, result) => results.set(page, result),
    () => priority,
    () => {},
  )
  return results
}
const pages = [1, 2, 3].map((page) => imagePage(page))

describe('budget planner and structured Gemini translation', () => {
  it('packs by image and output budgets, leaves fitting pages intact, and retains empty extraction output allowance', () => {
    const budget = { inputTokens: 4096, outputTokens: 8192 }
    const batches = planBatches([imagePage(3), imagePage(1), imagePage(2)], budget)
    expect(batches.flat().map((p) => p.page)).toEqual([1, 2, 3])
    expect(batches).toHaveLength(3)
    expect(batches.every((batch) => fits(batch, budget))).toBe(true)
    expect(planBatches(pages, DEFAULT_BATCH_BUDGET)).toHaveLength(1)
    expect(planBatches(pages, DEFAULT_BATCH_BUDGET)[0].map((p) => p.part)).toEqual([1, 1, 1])
    expect(estimatePageOutput('')).toBe(2048)
  })
  it('uses either input or output limit independently', () => {
    for (const budget of [
      { inputTokens: 4096, outputTokens: 16384 },
      { inputTokens: 32000, outputTokens: 4096 },
    ]) {
      const batches = planBatches([imagePage(1), imagePage(2)], budget)
      expect(batches).toHaveLength(2)
      expect(batches.every((b) => b.length === 1 && b[0].part === 1 && fits(b, budget))).toBe(true)
    }
  })
  it('splits only an oversized page into ordered nonoverlapping regions without reducing DPI', () => {
    const budget = { inputTokens: 4096, outputTokens: 4096 }
    const parts = splitSource(imagePage(4, 18000), budget)
    expect(parts.length).toBeGreaterThan(2)
    expect(parts.every((p) => fits([p], budget))).toBe(true)
    expect(parts.reduce((n, p) => n + p.region.width * p.region.height, 0)).toBe(1)
    expect(parts[0].region.y).toBe(0)
    expect(new Set(parts.map((p) => p.part)).size).toBe(parts.length)
  })
  it('sends schema and page/part identifiers, protects the header key, maps reordered output by identity', async () => {
    const { service, fetcher } = setup()
    const result = await run(service, pages)
    expect([...result.entries()]).toEqual(
      pages.map((p) => [
        p.page,
        { status: 'done', text: `번역 ${p.page}/1`, content: content(`번역 ${p.page}/1`) },
      ]),
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, options] = fetcher.mock.calls[0]
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    )
    expect(String(url)).not.toContain(key)
    expect(options?.headers).toHaveProperty('x-goog-api-key', key)
    const body = JSON.parse(String(options?.body))
    expect(body.generationConfig.responseMimeType).toBe('application/json')
    expect(body.generationConfig.responseJsonSchema).toMatchObject({ required: ['pages'] })
    expect(body.generationConfig).not.toHaveProperty('responseFormat')
    expect(body.generationConfig.maxOutputTokens).toBe(DEFAULT_BATCH_BUDGET.outputTokens)
    expect(body.systemInstruction.parts[0].text).toContain('untrusted source')
    expect(body.systemInstruction.parts[0].text).toContain('Do not summarize, omit')
    expect(service.settings()).not.toHaveProperty('apiKey')
  })
  it('prioritizes the current-page batch then re-evaluates focus between requests', async () => {
    const { service, fetcher } = setup()
    service.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
    const sourcePages = [1, 2, 3, 4].map((page) => imagePage(page))
    let focus = 3
    const results = new Map()
    await service.translate(
      { id: 'job', documentId: doc, pages: sourcePages },
      (page, result) => {
        results.set(page, result)
        focus = 4
      },
      () => focus,
      () => {},
    )
    expect(fetcher.mock.calls.map((call) => source(call[1])[0].page)).toEqual([3, 4, 1, 2])
    expect(results.size).toBe(4)
  })
  it.each([
    'missing',
    'duplicate',
    'extra',
    'wrong-page',
    'wrong-part',
    'empty',
    'invalid-json',
    'truncated',
    'incomplete',
  ])(
    'rejects %s as a whole and retries smaller groups without committing invalid data',
    async (mode) => {
      const { service, fetcher } = setup()
      fetcher.mockImplementationOnce(async (_url, options) => {
        const output = rows(source(options))
        if (mode === 'missing') output.pop()
        if (mode === 'duplicate') output[1] = output[0]
        if (mode === 'extra') output.push({ ...output[0], page: 999 })
        if (mode === 'wrong-page') output[0].page = 999
        if (mode === 'wrong-part') output[0].part = 99999
        if (mode === 'empty') output[0].translationMarkdown = ' '
        return envelope(
          mode === 'invalid-json' ? '{broken' : JSON.stringify({ pages: output }),
          mode === 'truncated' ? 'MAX_TOKENS' : mode === 'incomplete' ? 'OTHER' : 'STOP',
        )
      })
      const result = await run(service, pages)
      expect([...result.values()].every((r) => r.status === 'done')).toBe(true)
      expect(fetcher).toHaveBeenCalledTimes(3)
      expect(fetcher.mock.calls.slice(1).every((call) => source(call[1]).length < 3)).toBe(true)
    },
  )
  it('bounds repeated malformed output and never publishes an incomplete split page', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementation(async () => envelope('{invalid'))
    const result = await run(service, pages)
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(7)
    expect([...result.values()].every((r) => r.status === 'error')).toBe(true)
    fetcher.mockClear()
    const long = [imagePage(1, 18000)]
    service.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
    fetcher.mockImplementationOnce(async (_url, options) =>
      envelope(JSON.stringify({ pages: rows(source(options)) })),
    )
    const failed = await run(service, long)
    expect(failed.get(1)?.status).toBe('error')
    // A new attempt must start from the first part; no partial-page cache exists.
    fetcher.mockClear()
    fetcher.mockImplementation(async (_url, options) =>
      envelope(JSON.stringify({ pages: rows(source(options)) })),
    )
    const restored = await run(service, long)
    expect(source(fetcher.mock.calls[0][1])[0].part).toBe(1)
    const parts = planBatches(long, service.settings().budget).flat()
    expect(restored.get(1)).toEqual({
      status: 'done',
      text: parts.map((p) => `번역 1/${p.part}`).join('\n\n'),
      content: content(parts.map((p) => `번역 1/${p.part}`).join('\n\n')),
    })
  })
  it('reduces a truncated single part using child identifiers and joins only after both succeed', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementationOnce(async () => envelope('partial', 'MAX_TOKENS'))
    const result = await run(service, [imagePage(7)], 7)
    expect(fetcher.mock.calls.slice(1).map((call) => source(call[1])[0].part)).toEqual([1001, 1002])
    expect(result.get(7)).toEqual({
      status: 'done',
      text: '번역 7/1001\n\n번역 7/1002',
      content: content('번역 7/1001\n\n번역 7/1002'),
    })
  })
  it('retains validated neighboring pages when one split page fails', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementation(async (_url, options) => {
      const parts = source(options)
      return parts.some((p) => p.page === 2)
        ? envelope('{}')
        : envelope(JSON.stringify({ pages: rows(parts) }))
    })
    const result = await run(service, pages)
    expect(result.get(1)?.status).toBe('done')
    expect(result.get(2)?.status).toBe('error')
    expect(result.get(3)?.status).toBe('done')
  })
  it('keeps pages with no extracted text eligible, rejects malformed numeric plans before an API call', async () => {
    const { service, fetcher } = setup()
    expect((await run(service, [imagePage(1)])).get(1)?.status).toBe('done')
    await expect(run(service, [imagePage(0)])).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([400, 401, 403, 404])(
    'never retries HTTP %i or exposes provider error text',
    async (status) => {
      const { service, fetcher } = setup()
      fetcher.mockImplementation(async () => new Response('secret provider details', { status }))
      const result = await run(service, pages)
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect([...result.values()].every((r) => r.status === 'error')).toBe(true)
      expect(JSON.stringify([...result.values()])).not.toContain('secret')
    },
  )
  it.each([
    {
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'Unknown name "responseFormat" at generation_config. private-secret',
        },
      },
      code: 'request',
      label: 'JSON 응답 설정',
    },
    {
      body: {
        error: {
          status: 'INVALID_ARGUMENT',
          message: 'private-secret',
          details: [{ reason: 'API_KEY_INVALID', metadata: { key: 'private-secret' } }],
        },
      },
      code: 'auth',
      label: 'API 키',
    },
    {
      body: { error: { message: 'API key not valid. private-secret' } },
      code: 'auth',
      label: 'API 키',
    },
    {
      body: { error: { status: 'FAILED_PRECONDITION', message: 'private-secret' } },
      code: 'request',
      label: '사용 조건',
    },
    {
      body: { error: { message: 'thinking_level is not supported. private-secret' } },
      code: 'request',
      label: 'thinking 설정',
    },
    { body: { error: { message: 'private-secret' } }, code: 'request', label: '요청 설정' },
  ])(
    'classifies HTTP 400 as $code/$label without exposing provider data',
    async ({ body, code, label }) => {
      const { service, fetcher } = setup()
      fetcher.mockImplementation(async () => new Response(JSON.stringify(body), { status: 400 }))
      const result = await run(service, pages)
      expect(result.get(1)).toMatchObject({
        status: 'error',
        code,
        message: expect.stringContaining(label),
      })
      expect(JSON.stringify([...result.values()])).not.toContain('private-secret')
      expect(fetcher).toHaveBeenCalledTimes(1)
    },
  )
  it('retries quota at most twice, honors long Retry-After, and never changes model', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementation(
      async () => new Response('', { status: 429, headers: { 'retry-after': '0' } }),
    )
    expect((await run(service, pages)).get(1)).toMatchObject({ status: 'error', code: 'quota' })
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(new Set(fetcher.mock.calls.map((call) => call[0])).size).toBe(1)
    const other = setup()
    other.fetcher.mockImplementation(
      async () => new Response('', { status: 429, headers: { 'retry-after': '90' } }),
    )
    await run(other.service, pages)
    expect(other.fetcher).toHaveBeenCalledTimes(1)
  })
  it('recovers from a transient network error', async () => {
    const { service, fetcher } = setup()
    fetcher.mockRejectedValueOnce(new Error('secret transport detail'))
    expect((await run(service, pages)).get(1)?.status).toBe('done')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it.each(['cancel', 'key', 'budget'])(
    'rejects late responses after %s even if transport ignores abort',
    async (action) => {
      const { service, fetcher } = setup()
      let resolve!: (response: Response) => void
      fetcher.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      const results = vi.fn()
      const work = service
        .translate(
          { id: 'old', documentId: doc, pages },
          results,
          () => 1,
          () => {},
        )
        .catch(() => {})
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
      if (action === 'key') service.configure({ apiKey: key + '_new' })
      else if (action === 'budget')
        service.configureBudget({ inputTokens: 4096, outputTokens: 4096 })
      else service.cancel()
      resolve(
        envelope(
          JSON.stringify({
            pages: rows(
              pages.map((p) => ({
                ...p,
                part: 1,
                region: { x: 0, y: 0, width: 1, height: 1 },
                order: [],
              })),
            ),
          }),
        ),
      )
      await work
      expect(results).not.toHaveBeenCalled()
      expect((fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true)
    },
  )
  it('does not retry blocked pages or swallow a DB callback error', async () => {
    const { service, fetcher } = setup()
    fetcher.mockImplementationOnce(
      async () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } })),
    )
    expect((await run(service, pages)).get(1)).toMatchObject({ status: 'error', code: 'blocked' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    const save = vi.fn(() => {
      throw new Error('DB failure')
    })
    await expect(
      service.translate(
        { id: 'job', documentId: doc, pages },
        save,
        () => 1,
        () => {},
      ),
    ).rejects.toThrow('DB failure')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })
  it('validates opaque keys and budget ranges without replacing valid settings', () => {
    const { service } = setup()
    const opaque = 'long.key~'.repeat(40)
    service.configure({ apiKey: ` ${opaque} ` })
    for (const apiKey of ['bad key', '\n', '한글', 'x'.repeat(4097)])
      expect(() => service.configure({ apiKey })).toThrow()
    expect(service.configure({ apiKey: 'test' }).configured).toBe(true)
    expect(service.settings()).not.toHaveProperty('freeTierConfirmed')
    for (const budget of [
      { inputTokens: 10, outputTokens: 8192 },
      { inputTokens: 12000, outputTokens: 999999 },
    ])
      expect(() => service.configureBudget(budget)).toThrow()
    expect(service.settings().configured).toBe(true)
    expect(service.settings().budget).toEqual(DEFAULT_BATCH_BUDGET)
    service.configure({ apiKey: '' })
    expect(service.settings().configured).toBe(false)
  })
  it('rejects unexpected JSON properties and mistyped IDs', () => {
    const parts = planBatches([imagePage(1)], DEFAULT_BATCH_BUDGET).flat()
    expect(() =>
      validateResponse(JSON.stringify({ pages: [{ page: '1', part: 1, ...content() }] }), parts),
    ).toThrow()
    expect(() =>
      validateResponse(JSON.stringify({ pages: rows(parts), extra: true }), parts),
    ).toThrow()
    expect(estimateBatch(parts).input).toBeGreaterThan(1024)
  })
})
