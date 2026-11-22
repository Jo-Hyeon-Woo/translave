import { describe, it, expect } from 'vitest'
import {
  DEFAULT_CHATGPT_BATCH_POLICY as defaults,
  batchPolicy,
  estimateChatGPTBatch,
  fitsChatGPT,
  planChatGPTBatches,
} from '../../src/main/chatgpt/batching'
import { DEFAULT_IMAGE_SETTINGS } from '../../src/shared/contracts'
import { imagePage } from './fakes'
const model = 'gpt-6.1-sol',
  images = DEFAULT_IMAGE_SETTINGS
const pages = Array.from({ length: 16 }, (_, i) => imagePage(i + 1))
describe('ChatGPT local planning policy (no network token counting)', () => {
  it('has independent defaults, validates ranges, and never treats an unknown model as a supported estimate', () => {
    expect(batchPolicy({ ...defaults })).toEqual(defaults)
    expect(defaults.inputTokens).toBe(32768)
    expect(defaults.outputTokens).toBe(24576)
    expect(() => batchPolicy({ ...defaults, maxPages: 17 })).toThrow()
    expect(() => batchPolicy({ ...defaults, inputTokens: 2048 })).toThrow()
    expect(() => batchPolicy({ ...defaults, outputSafety: 0.5 })).toThrow()
    expect(fitsChatGPT(pages.slice(0, 1), 'unknown', images)).toBe(false)
  })
  it('groups multiple ordinary pages and constrains output without lowering the minimum output estimate', () => {
    const normal = planChatGPTBatches(pages, model, images)
    expect(normal.rejected).toHaveLength(0)
    expect(normal.groups[0]).toHaveLength(5)
    expect(fitsChatGPT(pages.slice(0, 5), model, images)).toBe(true)
    expect(fitsChatGPT(pages.slice(0, 6), model, images)).toBe(false)
    const dense = planChatGPTBatches(
      pages.map((p) => ({ ...p, outputTokens: 6000 })),
      model,
      images,
    )
    expect(dense.groups[0].length).toBeLessThan(normal.groups[0].length)
    expect(estimateChatGPTBatch([{ ...pages[0], outputTokens: 0 }], model, images).output).toBe(
      estimateChatGPTBatch([pages[0]], model, images).output,
    )
  })
  it('uses page pixel dimensions for image inputs, keeping output budget independent of input budget', () => {
    const group = pages.slice(0, 5)
    const total = estimateChatGPTBatch(group, model, images)
    const policy = { ...defaults, inputTokens: total.input - 1 }
    expect(fitsChatGPT(group, model, images, policy)).toBe(false)
    expect(fitsChatGPT(group, model, images, { ...policy, inputTokens: total.input })).toBe(true)
    expect(
      estimateChatGPTBatch([{ ...pages[0], width: 1800, height: 1800 }], model, images).input,
    ).toBeGreaterThan(estimateChatGPTBatch([pages[0]], model, images).input)
  })
  it('constrains planned RGBA memory and rejects a whole page over pixel/output capacity without area splitting', () => {
    const p = { ...defaults, maxPixelBytes: 16 * 1024 * 1024 }
    const limited = planChatGPTBatches(pages, model, images, p)
    expect(limited.groups.every((g) => g.length === 2)).toBe(true)
    const oversized = [
      { ...pages[0], width: 4000, height: 4000 },
      { ...pages[1], outputTokens: 30000 },
      pages[2],
    ]
    const result = planChatGPTBatches(oversized, model, images)
    expect(result.rejected.map((p) => p.page)).toEqual([1, 2])
    expect(result.groups.flat().map((p) => p.page)).toEqual([3])
  })
  it('retains sparse source ordering and respects a configurable plan cap without hardcoding the request size', () => {
    const p = { ...defaults, maxPages: 3 }
    const result = planChatGPTBatches([pages[7], pages[0], pages[4], pages[2]], model, images, p)
    expect(result.groups.map((g) => g.map((p) => p.page))).toEqual([[1, 3, 5], [8]])
  })
})
