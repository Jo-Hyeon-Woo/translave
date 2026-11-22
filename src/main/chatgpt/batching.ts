import type { ImageSettings, SourcePage } from '../../shared/contracts'
import { responseSchema } from '../batching'
import { chatgptInstruction } from './instructions'
import { pageMetadata } from './request'

// Capability/context evidence: official model pages, checked 2026-10-19.
// Image multipliers below are LOCAL conservative planning heuristics, not published billing rules.
export const CHATGPT_MODEL_PROFILES = {
  'gpt-6.1-sol': { context: 1_050_000, output: 128_000, imagePlanningMultiplier: 2 },
  'gpt-6-sol': { context: 1_050_000, output: 128_000, imagePlanningMultiplier: 2 },
} as const
export interface ChatGPTBatchPolicy {
  inputTokens: number
  outputTokens: number
  reasoningReserve: number
  inputReserve: number
  outputReserve: number
  pageJSONReserve: number
  outputSafety: number
  maxPages: number
  maxPixelBytes: number
  maxCacheBytes: number
  maxRequestBytes: number
}
export const DEFAULT_CHATGPT_BATCH_POLICY: Readonly<ChatGPTBatchPolicy> = Object.freeze({
  inputTokens: 32_768,
  outputTokens: 24_576,
  reasoningReserve: 8_192,
  inputReserve: 2_048,
  outputReserve: 512,
  pageJSONReserve: 128,
  outputSafety: 1.25,
  maxPages: 16,
  maxPixelBytes: 96 * 1024 * 1024,
  maxCacheBytes: 32 * 1024 * 1024,
  maxRequestBytes: 16 * 1024 * 1024,
})
export function batchPolicy(value: ChatGPTBatchPolicy): ChatGPTBatchPolicy {
  const ranges: Record<Exclude<keyof ChatGPTBatchPolicy, 'outputSafety'>, [number, number]> = {
    inputTokens: [4096, 131072],
    outputTokens: [12288, 65536],
    reasoningReserve: [4096, 16384],
    inputReserve: [1024, 8192],
    outputReserve: [512, 4096],
    pageJSONReserve: [64, 1024],
    maxPages: [1, 16],
    maxPixelBytes: [16 * 1024 * 1024, 128 * 1024 * 1024],
    maxCacheBytes: [16 * 1024 * 1024, 32 * 1024 * 1024],
    maxRequestBytes: [1024, 16 * 1024 * 1024],
  }
  for (const [key, [min, max]] of Object.entries(ranges)) {
    const v = value[key as keyof ChatGPTBatchPolicy]
    if (!Number.isInteger(v) || v < min || v > max) throw new Error('invalid ChatGPT batch policy')
  }
  if (!Number.isFinite(value.outputSafety) || value.outputSafety < 1 || value.outputSafety > 2)
    throw new Error('invalid ChatGPT batch policy')
  return { ...value }
}
export function modelProfile(model: string) {
  return CHATGPT_MODEL_PROFILES[model as keyof typeof CHATGPT_MODEL_PROFILES]
}
export function imageSize(page: SourcePage, images: ImageSettings) {
  return {
    width: Math.ceil((page.width * images.dpi) / 72),
    height: Math.ceil((page.height * images.dpi) / 72),
  }
}
export function estimateChatGPTBatch(
  pages: SourcePage[],
  model: string,
  images: ImageSettings,
  policy = DEFAULT_CHATGPT_BATCH_POLICY,
) {
  const profile = modelProfile(model)
  if (!profile) return { input: Infinity, output: Infinity, pixelBytes: Infinity }
  const input =
    policy.inputReserve +
    Buffer.byteLength(chatgptInstruction + JSON.stringify(responseSchema)) +
    pages.reduce((n, p, i) => {
      const { width, height } = imageSize(p, images)
      return (
        n +
        Math.ceil(width / 32) * Math.ceil(height / 32) * profile.imagePlanningMultiplier +
        Buffer.byteLength(JSON.stringify(pageMetadata(p.page, i + 1)))
      )
    }, 0)
  const output =
    policy.reasoningReserve +
    policy.outputReserve +
    pages.reduce(
      (n, p) =>
        n +
        Math.ceil(Math.max(2048, p.outputTokens) * policy.outputSafety) +
        policy.pageJSONReserve,
      0,
    )
  const pixelBytes = pages.reduce((n, p) => {
    const s = imageSize(p, images)
    return n + s.width * s.height * 4
  }, 0)
  return { input, output, pixelBytes }
}
export function fitsChatGPT(
  pages: SourcePage[],
  model: string,
  images: ImageSettings,
  policy = DEFAULT_CHATGPT_BATCH_POLICY,
) {
  const profile = modelProfile(model),
    estimate = estimateChatGPTBatch(pages, model, images, policy)
  return (
    !!profile &&
    pages.length > 0 &&
    pages.length <= policy.maxPages &&
    estimate.input <= policy.inputTokens &&
    estimate.output <= Math.min(policy.outputTokens, profile.output) &&
    estimate.input + estimate.output <= profile.context &&
    estimate.pixelBytes <= policy.maxPixelBytes &&
    pages.every((p) => {
      const s = imageSize(p, images)
      return s.width * s.height <= 16_100_000
    })
  )
}
export function planChatGPTBatches(
  pages: SourcePage[],
  model: string,
  images: ImageSettings,
  policy = DEFAULT_CHATGPT_BATCH_POLICY,
) {
  const groups: SourcePage[][] = [],
    rejected: SourcePage[] = []
  let current: SourcePage[] = []
  for (const page of [...pages].sort((a, b) => a.page - b.page)) {
    if (!fitsChatGPT([page], model, images, policy)) {
      rejected.push(page)
      continue
    }
    if (current.length && !fitsChatGPT([...current, page], model, images, policy)) {
      groups.push(current)
      current = []
    }
    current.push(page)
  }
  if (current.length) groups.push(current)
  return { groups, rejected }
}
