import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'

type Segment = { text: string; x: number; right: number; y: number; height: number }

/** Layout heuristic for horizontal Latin/Korean text; not a general layout parser. */
export function extractPageText(content: Pick<TextContent, 'items'>): string {
  const items = content.items
    .filter((item): item is TextItem => 'str' in item && !!item.str.trim())
    .map((item) => ({
      text: item.str,
      x: item.transform[4],
      y: item.transform[5],
      right: item.transform[4] + item.width,
      height: Math.max(Math.abs(item.height), 1),
    }))
    .sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: Segment[][] = []
  for (const item of items) {
    const row = rows.find(
      (candidate) =>
        Math.abs(candidate[0].y - item.y) < Math.min(candidate[0].height, item.height) * 0.4,
    )
    if (row) row.push(item)
    else rows.push([item])
  }
  const lines = rows.map((row) => {
    const segments: Segment[] = []
    for (const item of row.sort((a, b) => a.x - b.x)) {
      const previous = segments.at(-1)
      if (previous && item.x - previous.right < Math.max(item.height * 2.5, 22)) {
        const separator =
          item.x - previous.right > item.height * 0.15 && !previous.text.endsWith(' ') ? ' ' : ''
        previous.text += separator + item.text
        previous.right = Math.max(previous.right, item.right)
      } else segments.push({ ...item })
    }
    return segments
  })
  // Require several long paired lines so small table cells don't look like prose columns.
  const gutters = lines
    .filter((line) => line.length === 2 && line.every((segment) => segment.text.length >= 20))
    .map((line) => [line[0].right, line[1].x])
  const leftEdge = Math.max(...gutters.map((gutter) => gutter[0]))
  const rightEdge = Math.min(...gutters.map((gutter) => gutter[1]))
  const split = gutters.length >= 3 && rightEdge - leftEdge > 22 ? (leftEdge + rightEdge) / 2 : null

  const format = (segments: Segment[]): string =>
    segments
      .map((segment, index) => {
        const previous = segments[index - 1]
        const gap =
          previous && previous.y - segment.y > Math.max(previous.height, segment.height) * 1.8
            ? '\n\n'
            : '\n'
        return (index ? gap : '') + segment.text.trim()
      })
      .join('')

  if (split === null)
    return format(lines.map((line) => ({ ...line[0], text: line.map((s) => s.text).join('   ') })))

  const output: string[] = []
  let left: Segment[] = []
  let right: Segment[] = []
  const flush = (): void => {
    if (left.length) output.push(format(left))
    if (right.length) output.push(format(right))
    left = []
    right = []
  }
  for (const line of lines) {
    if (line.some((segment) => segment.x < split && segment.right > split)) {
      flush()
      output.push(format(line))
    } else {
      for (const segment of line) (segment.x < split ? left : right).push(segment)
    }
  }
  flush()
  return output.join('\n\n')
}
