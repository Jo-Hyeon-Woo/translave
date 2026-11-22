import { cp, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

for (const name of ['cmaps', 'standard_fonts', 'wasm']) {
  const destination = resolve('src/renderer/public/pdfjs', name)
  await mkdir(destination, { recursive: true })
  await cp(resolve('node_modules/pdfjs-dist', name), destination, { recursive: true })
}
