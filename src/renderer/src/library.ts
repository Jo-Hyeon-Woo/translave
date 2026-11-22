import type { PDFDocumentProxy } from 'pdfjs-dist'

export async function saveLibraryDocument(
  id: string,
  pdf: PDFDocumentProxy,
  folderId?: string | null,
): Promise<void> {
  let thumbnail = ''
  try {
    const page = await pdf.getPage(1)
    const original = page.getViewport({ scale: 1 })
    const viewport = page.getViewport({ scale: 160 / Math.max(original.width, original.height) })
    const canvas = document.createElement('canvas')
    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)
    await page.render({ canvas, viewport }).promise
    thumbnail = canvas.toDataURL('image/png')
  } catch {
    // A thumbnail failure must not prevent reading an otherwise usable PDF.
  }
  const result = await window.desktop.addDocument({ id, total: pdf.numPages, thumbnail, folderId })
  if (result?.status === 'error') {
    const error = new Error(result.message)
    error.name = 'LibrarySaveError'
    throw error
  }
}
