import { describe, expect, it } from 'vitest'
import type { TextItem } from 'pdfjs-dist/types/src/display/api'
import { extractPageText } from '../../src/renderer/src/extract'

const item = (str: string, x: number, y: number, width = str.length * 5): TextItem => ({
  str,
  dir: 'ltr',
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
  fontName: 'test',
  hasEOL: false,
})

describe('geometric text extraction', () => {
  it('reorders shuffled rows and joins nearby pieces without losing words', () => {
    expect(
      extractPageText({
        items: [item('Second line.', 50, 85), item('world', 79, 100), item('Hello', 50, 100)],
      }),
    ).toBe('Hello world\nSecond line.')
  })
  it('reads an interleaved two-column layout down the left before the right', () => {
    const items = [item('Title spanning the entire document', 50, 160, 480)]
    for (let row = 0; row < 4; row++) {
      items.push(item(`Left column paragraph ${row}`, 50, 130 - row * 15, 180))
      items.push(item(`Right column paragraph ${row}`, 330, 130 - row * 15, 180))
    }
    const text = extractPageText({ items })
    expect(text.indexOf('Left column paragraph 3')).toBeLessThan(
      text.indexOf('Right column paragraph 0'),
    )
    expect(text.startsWith('Title spanning')).toBe(true)
  })
  it('keeps short table cells on their own rows', () => {
    const items = [0, 1, 2].flatMap((row) => [
      item(`Doc ${row}`, 50, 100 - row * 20),
      item(`${row + 10}`, 200, 100 - row * 20),
    ])
    expect(extractPageText({ items })).toBe('Doc 0   10\n\nDoc 1   11\n\nDoc 2   12')
  })
  it('returns empty for image-only pages and whitespace', () => {
    expect(extractPageText({ items: [] })).toBe('')
    expect(extractPageText({ items: [item('   ', 50, 50)] })).toBe('')
  })
})
