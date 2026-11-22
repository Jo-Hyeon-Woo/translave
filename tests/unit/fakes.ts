import type {
  ImageRenderer,
  PageTranslation,
  SourcePage,
  SourcePart,
} from '../../src/shared/contracts'
export const fakeRender: ImageRenderer = async (part, settings) => ({
  mimeType: settings.format === 'png' ? 'image/png' : 'image/jpeg',
  data: '/9j/2Q==',
  width: 1200,
  height: 1600,
})
export const imagePage = (page: number, outputTokens = 2048): SourcePage => ({
  page,
  width: 612,
  height: 792,
  outputTokens,
})
export const content = (translationMarkdown = '가짜 번역'): PageTranslation => ({
  contentType: 'text',
  translationMarkdown,
  visualElements: [],
  readingNotes: [],
  unclearRegions: [],
})
export const sources = (options?: RequestInit): SourcePart[] =>
  JSON.parse(String(options?.body))
    .contents[0].parts.filter((p: { text?: string }) => typeof p.text === 'string')
    .map((p: { text: string }) => JSON.parse(p.text))
export const rows = (parts: Pick<SourcePart, 'page' | 'part'>[]) =>
  parts.map(({ page, part }) => ({ page, part, ...content(`번역 ${page}/${part}`) }))
export const envelope = (text: string, finishReason = 'STOP') =>
  new Response(
    JSON.stringify({
      candidates: [
        { finishReason, content: { parts: [{ text: 'not an answer', thought: true }, { text }] } },
      ],
    }),
  )
export const answer = (parts: Pick<SourcePart, 'page' | 'part'>[]) =>
  envelope(JSON.stringify({ pages: rows(parts).reverse() }))
