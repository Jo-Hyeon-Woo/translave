import type { PageTranslation } from '../shared/contracts'

export const LANGUAGE_ERROR_MESSAGE = '한국어 번역 대신 영문 본문이 반환됐어요. 다시 번역해 주세요.'

const connectors = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'to',
  'in',
  'for',
  'with',
  'by',
  'from',
  'is',
  'are',
  'was',
  'were',
  'be',
  'this',
  'that',
  'these',
  'those',
  'as',
  'on',
])

// A narrow check for copied English prose, not a general language/quality detector.
// Never reject a result just because it has no Hangul: identifiers and code are valid.
export function hasEnglishProse(markdown: string): boolean {
  const prose = markdown
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*(?:\n|$)/gm, '')
    .replace(/^ {4,}\S.*$/gm, '')
    .replace(/(`+)[\s\S]*?\1/g, '')
    .replace(/\$\$[\s\S]*?\$\$|\$[^\n$]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/[^\s<>)]+|<[^>]*>/g, '')
  const blocks = prose.split(/\n\s*\n/)
  return blocks.some((block) =>
    [block, ...block.split('\n')].some((line) => {
      if (/[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(line)) return false
      // Ignore acronyms and identifier-shaped tokens (underscores, digits, camelCase).
      const words = (line.match(/[A-Za-z][A-Za-z0-9_'-]*/g) ?? []).filter((word) =>
        /^[A-Z]?[a-z]+(?:['-][a-z]+)*$/.test(word),
      )
      if (words.length < 3 || words.join('').replace(/[^a-z]/gi, '').length < 15) return false
      return (
        words.filter((w) => /^[a-z]/.test(w)).length >= 2 ||
        (words.length >= 4 && words.some((w) => connectors.has(w.toLowerCase())))
      )
    }),
  )
}

export function hasUntranslatedEnglish(content: PageTranslation): boolean {
  return [
    content.translationMarkdown,
    ...content.visualElements.map((v) => v.descriptionMarkdown),
    ...content.readingNotes,
    ...content.unclearRegions,
  ].some(hasEnglishProse)
}
