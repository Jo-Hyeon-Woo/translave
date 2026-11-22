import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { mkdir, writeFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'

const pdf = await PDFDocument.create()
pdf.setTitle('Reading across languages')
pdf.setAuthor('Translave — original test fixture')
pdf.setCreationDate(new Date('2026-10-08T00:00:00Z'))
pdf.setModificationDate(new Date('2026-10-08T00:00:00Z'))
const regular = await pdf.embedFont(StandardFonts.Helvetica)
const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
const serif = await pdf.embedFont(StandardFonts.TimesRoman)
const ink = rgb(0.16, 0.25, 0.21)
const muted = rgb(0.45, 0.51, 0.46)
const green = rgb(0.2, 0.45, 0.33)
const text = (page, value, x, y, size = 11, font = regular, color = ink) =>
  page.drawText(value, { x, y, size, font, color })
const header = (page, section) => {
  text(page, 'TRANSLAVE     /     READING NOTES', 56, 745, 8, bold, green)
  text(page, section, 56, 695, 10, regular, muted)
  page.drawLine({
    start: { x: 56, y: 728 },
    end: { x: 556, y: 728 },
    thickness: 0.5,
    color: rgb(0.8, 0.85, 0.8),
  })
}
const lines = (page, values, x, y, size = 11, leading = 19) =>
  values.forEach((value, index) => text(page, value, x, y - index * leading, size))

let page = pdf.addPage([612, 792])
header(page, '01   /   A QUIETER WAY TO READ')
text(page, 'Reading across', 56, 636, 37, serif)
text(page, 'languages.', 56, 591, 37, serif)
page.drawRectangle({ x: 56, y: 555, width: 37, height: 3, color: green })
lines(
  page,
  [
    'Good writing deserves our full attention. When we read in an',
    'unfamiliar language, we move between the original document,',
    'a dictionary, and a translation tool. Each switch interrupts',
    'the flow of an idea.',
  ],
  56,
  518,
  12,
  21,
)
lines(
  page,
  [
    'Translave keeps the original and its translation in one space.',
    'The structure and context stay on the left. A little help with',
    'understanding sits on the right. Turn a page, and the reading',
    'companion moves with you.',
  ],
  56,
  399,
  12,
  21,
)
page.drawRectangle({ x: 56, y: 188, width: 500, height: 86, color: rgb(0.95, 0.97, 0.94) })
text(page, 'EXPLORE THIS DOCUMENT', 73, 250, 8, bold, green)
lines(
  page,
  [
    'Four pages. Plain text, two columns, a table with an equation,',
    'and an image-only page. A small tour of how PDFs are read.',
  ],
  73,
  229,
  10,
  17,
)
text(page, 'Original sample document. No external content or API calls.', 56, 58, 8, regular, muted)
text(page, '01', 542, 58, 9, bold, green)

page = pdf.addPage([612, 792])
header(page, '02   /   LAYOUT AND MEANING')
text(page, 'Reading order matters.', 56, 633, 30, serif)
const left = [
  'LEFT COLUMN - START HERE',
  'One idea should lead to the next.',
  'Position is part of understanding',
  'the order of a written document.',
  'Simply joining a horizontal row',
  'can mix two unrelated sentences.',
  'Read this column to its ending.',
  'Only then move across the page.',
  'LEFT COLUMN - END',
]
const right = [
  'RIGHT COLUMN - CONTINUE HERE',
  'First read all of the left column.',
  'Then continue with this section.',
  'This sample checks whether text',
  'extraction respects two columns.',
  'Some complicated page layouts',
  'will still need a closer review.',
  'Always keep the original nearby.',
  'RIGHT COLUMN - END',
]
// Deliberately interleave content streams to test geometric reading order.
left.forEach((line, index) => {
  text(page, line, 56, 570 - index * 25, 10)
  text(page, right[index], 329, 570 - index * 25, 10)
})

page = pdf.addPage([612, 792])
header(page, '03   /   STRUCTURE AND DETAIL')
text(page, 'Keep the details intact.', 56, 633, 30, serif)
lines(
  page,
  [
    'Tables and equations are best checked beside the original.',
    'Plain text cannot preserve every visual relationship in a table.',
  ],
  56,
  584,
  11,
  20,
)
const table = [
  ['Document', 'Pages', 'Status'],
  ['Document A', '12', 'Done'],
  ['Document B', '28', 'Waiting'],
  ['Document C', '7', 'Done'],
]
table.forEach((row, index) => {
  const y = 487 - index * 42
  page.drawRectangle({
    x: 56,
    y: y - 14,
    width: 500,
    height: 42,
    color: index === 0 ? rgb(0.9, 0.94, 0.88) : index % 2 ? rgb(0.97, 0.98, 0.96) : rgb(1, 1, 1),
  })
  row.forEach((cell, column) =>
    text(page, cell, [70, 300, 422][column], y, 11, index === 0 ? bold : regular),
  )
})
text(page, 'Example equation', 56, 263, 10, bold, green)
text(page, 'E = mc', 56, 222, 25, serif)
text(page, '2', 133, 235, 14, serif)
text(page, 'Preserve numbers, symbols, and citations when translating.', 56, 171, 11)

// Original generated raster: no text layer, for the image-only-page behavior.
function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const name = Buffer.from(type)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([size, name, data, crc])
}
const width = 600,
  height = 740
const pixels = Buffer.alloc((width * 3 + 1) * height)
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const index = y * (width * 3 + 1) + 1 + x * 3
    let color = [237, 241, 229]
    if ((x - 300) ** 2 + (y - 300) ** 2 < 150 ** 2) color = [154, 184, 151]
    if (y > 470 + 50 * Math.sin(x / 120)) color = [105, 147, 118]
    if (y > 590 - x / 5) color = [53, 99, 76]
    pixels.set(color, index)
  }
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(width, 0)
ihdr.writeUInt32BE(height, 4)
ihdr[8] = 8
ihdr[9] = 2
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(pixels)),
  chunk('IEND', Buffer.alloc(0)),
])
const picture = await pdf.embedPng(png)
page = pdf.addPage([612, 792])
page.drawImage(picture, { x: 36, y: 63, width: 540, height: 666 })

await mkdir('resources', { recursive: true })
await mkdir('tests/fixtures', { recursive: true })
await writeFile('resources/reading-notes.pdf', await pdf.save())
await writeFile(
  'tests/fixtures/broken.pdf',
  '%PDF-1.7\nThis is an intentionally invalid test fixture.\n',
)
await writeFile('tests/fixtures/not-a-pdf.pdf', 'An intentionally invalid PDF signature.\n')

const other = await PDFDocument.create()
other
  .addPage()
  .drawText('OTHER DOCUMENT - an independent translation test.', { x: 40, y: 700, size: 14 })
await writeFile('tests/fixtures/other.pdf', await other.save())
