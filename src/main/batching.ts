import { DEFAULT_IMAGE_SETTINGS } from '../shared/contracts'
import type {
  BatchBudget,
  ImageSettings,
  PageTranslation,
  SourcePage,
  SourcePart,
} from '../shared/contracts'
export type { SourcePart } from '../shared/contracts'

export const INPUT_RESERVE = 2048
export const OUTPUT_RESERVE = 512
export const OUTPUT_RATIO = 1.8
export function estimateTokens(text: string): number {
  let count = 0
  for (const char of text) count += char.codePointAt(0)! < 128 ? 1 / 3 : 1.5
  return Math.ceil(count)
}
// Local extraction is an estimate only; its contents never leave the PDF worker.
export function estimatePageOutput(text: string): number {
  return Math.max(2048, Math.ceil(estimateTokens(text) * OUTPUT_RATIO) + 512)
}
export function metadata(part: SourcePart) {
  return { page: part.page, part: part.part, region: part.region, readingOrder: part.order }
}
export function estimateBatch(parts: SourcePart[], images = DEFAULT_IMAGE_SETTINGS) {
  const imageTokens = { low: 400, medium: 800, high: 1600 }[images.mediaResolution]
  return {
    input:
      INPUT_RESERVE +
      parts.reduce(
        (n, p) =>
          n +
          imageTokens +
          estimateTokens(JSON.stringify({ documentId: '0'.repeat(64), ...metadata(p) })),
        0,
      ),
    output: OUTPUT_RESERVE + parts.reduce((n, p) => n + p.outputTokens + 64, 0),
  }
}
export function fits(
  parts: SourcePart[],
  budget: BatchBudget,
  images = DEFAULT_IMAGE_SETTINGS,
): boolean {
  const estimate = estimateBatch(parts, images)
  return estimate.input <= budget.inputTokens && estimate.output <= budget.outputTokens
}
export function bisectRegion(part: SourcePart, ids: [number, number]): SourcePart[] {
  const horizontal = part.height * part.region.height >= part.width * part.region.width
  return ids.map((id, i) => ({
    ...part,
    part: id,
    order: [...part.order, i],
    outputTokens: Math.max(256, Math.ceil(part.outputTokens / 2)),
    region: horizontal
      ? {
          ...part.region,
          y: part.region.y + (i * part.region.height) / 2,
          height: part.region.height / 2,
        }
      : {
          ...part.region,
          x: part.region.x + (i * part.region.width) / 2,
          width: part.region.width / 2,
        },
  }))
}
export function splitSource(
  page: SourcePage,
  budget: BatchBudget,
  images = DEFAULT_IMAGE_SETTINGS,
): SourcePart[] {
  const root: SourcePart = {
    ...page,
    part: 1,
    order: [],
    region: { x: 0, y: 0, width: 1, height: 1 },
  }
  const visit = (part: SourcePart, depth: number): SourcePart[] => {
    // Prevent giant canvas allocation even when token estimates fit.
    const pixels =
      page.width * page.height * part.region.width * part.region.height * (images.dpi / 72) ** 2
    if (fits([part], budget, images) && pixels <= 16_000_000) return [part]
    if (depth === 6) throw new Error('budget')
    return bisectRegion(part, [1, 1]).flatMap((child) => visit(child, depth + 1))
  }
  return visit(root, 0).map((part, index) => ({ ...part, part: index + 1 }))
}
export function planBatches(
  pages: SourcePage[],
  budget: BatchBudget,
  images = DEFAULT_IMAGE_SETTINGS,
): SourcePart[][] {
  const batches: SourcePart[][] = []
  let batch: SourcePart[] = []
  for (const page of [...pages].sort((a, b) => a.page - b.page)) {
    for (const part of splitSource(page, budget, images)) {
      if (batch.length && !fits([...batch, part], budget, images)) {
        batches.push(batch)
        batch = []
      }
      batch.push(part)
    }
  }
  if (batch.length) batches.push(batch)
  return batches
}
export function partKey(part: Pick<SourcePart, 'page' | 'part'>): string {
  return `${part.page}:${part.part}`
}
const stringArray = { type: 'array', items: { type: 'string' } }
export const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['pages'],
  properties: {
    pages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'page',
          'part',
          'contentType',
          'translationMarkdown',
          'visualElements',
          'readingNotes',
          'unclearRegions',
        ],
        properties: {
          page: { type: 'integer', minimum: 1 },
          part: { type: 'integer', minimum: 1 },
          contentType: { type: 'string', enum: ['text', 'visual_only', 'blank', 'unreadable'] },
          translationMarkdown: { type: 'string' },
          visualElements: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'type', 'location', 'descriptionMarkdown'],
              properties: {
                id: { type: 'string' },
                type: { type: 'string' },
                location: { type: 'string' },
                descriptionMarkdown: { type: 'string' },
              },
            },
          },
          readingNotes: stringArray,
          unclearRegions: stringArray,
        },
      },
    },
  },
}
const exactKeys = (value: object, keys: string[]) =>
  Object.keys(value).sort().join() === [...keys].sort().join()
export function validateResponse(
  text: string,
  parts: Pick<SourcePart, 'page' | 'part'>[],
): Map<string, PageTranslation> {
  const data: unknown = JSON.parse(text)
  if (!data || typeof data !== 'object' || !exactKeys(data, ['pages'])) throw new Error('schema')
  const rows = (data as { pages: unknown }).pages
  if (!Array.isArray(rows) || rows.length !== parts.length) throw new Error('count')
  const expected = new Set(parts.map(partKey)),
    result = new Map<string, PageTranslation>()
  for (const row of rows) {
    if (
      !row ||
      typeof row !== 'object' ||
      !exactKeys(row, [
        'page',
        'part',
        'contentType',
        'translationMarkdown',
        'visualElements',
        'readingNotes',
        'unclearRegions',
      ]) ||
      !Number.isInteger(row.page) ||
      !Number.isInteger(row.part) ||
      typeof row.translationMarkdown !== 'string' ||
      !['text', 'visual_only', 'blank', 'unreadable'].includes(row.contentType) ||
      ![row.readingNotes, row.unclearRegions].every(
        (a) => Array.isArray(a) && a.every((s: unknown) => typeof s === 'string' && s.trim()),
      ) ||
      !Array.isArray(row.visualElements) ||
      !row.visualElements.every(
        (v: unknown) =>
          v &&
          typeof v === 'object' &&
          exactKeys(v, ['id', 'type', 'location', 'descriptionMarkdown']) &&
          Object.values(v).every((s) => typeof s === 'string' && s.trim()),
      )
    )
      throw new Error('schema')
    const key = partKey(row)
    if (!expected.has(key) || result.has(key)) throw new Error('identifier')
    if (
      new Set(row.visualElements.map((v: { id: string }) => v.id)).size !==
      row.visualElements.length
    )
      throw new Error('visual-identifier')
    const hasText = Boolean(row.translationMarkdown.trim())
    if (
      (row.contentType === 'text' && !hasText) ||
      (row.contentType === 'visual_only' && (hasText || !row.visualElements.length)) ||
      (row.contentType === 'blank' &&
        (hasText || row.visualElements.length || row.unclearRegions.length)) ||
      (row.contentType === 'unreadable' && !row.unclearRegions.length)
    )
      throw new Error('content-type')
    result.set(key, {
      contentType: row.contentType,
      translationMarkdown: row.translationMarkdown.trim(),
      visualElements: row.visualElements,
      readingNotes: row.readingNotes,
      unclearRegions: row.unclearRegions,
    })
  }
  return result
}
export function mergeTranslations(values: PageTranslation[]): PageTranslation {
  const translationMarkdown = values
    .map((v) => v.translationMarkdown)
    .filter(Boolean)
    .join('\n\n')
  const visualElements = values.flatMap((v, i) =>
    v.visualElements.map((e) => ({
      ...e,
      id: values.length === 1 ? e.id : `part-${i + 1}/${e.id}`,
    })),
  )
  return {
    contentType: values.some((v) => v.contentType === 'unreadable')
      ? 'unreadable'
      : translationMarkdown
        ? 'text'
        : visualElements.length
          ? 'visual_only'
          : 'blank',
    translationMarkdown,
    visualElements,
    readingNotes: [...new Set(values.flatMap((v) => v.readingNotes))],
    unclearRegions: [...new Set(values.flatMap((v) => v.unclearRegions))],
  }
}
export function validSourcePage(p: SourcePage): boolean {
  return Boolean(
    p &&
    Number.isInteger(p.page) &&
    p.page >= 1 &&
    p.page <= 100000 &&
    [p.width, p.height].every((n) => Number.isFinite(n) && n > 0 && n <= 100000) &&
    Number.isInteger(p.outputTokens) &&
    p.outputTokens >= 2048 &&
    p.outputTokens <= 1_000_000,
  )
}
export function validImage(image: unknown): image is import('../shared/contracts').PageImage {
  const p = image as import('../shared/contracts').PageImage | null
  return Boolean(
    p &&
    ['image/jpeg', 'image/png'].includes(p.mimeType) &&
    Number.isInteger(p.width) &&
    p.width > 0 &&
    Number.isInteger(p.height) &&
    p.height > 0 &&
    p.width * p.height <= 16_100_000 &&
    typeof p.data === 'string' &&
    p.data.length > 0 &&
    p.data.length <= 26 * 1024 * 1024 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(p.data),
  )
}
