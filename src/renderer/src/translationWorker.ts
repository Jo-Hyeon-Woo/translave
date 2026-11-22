import type { PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { ImageSettings, PageImage, SourcePart, RenderResult } from '../../shared/contracts'
import { loadPdf } from './pdf'
import { extractPageText } from './extract'
import { estimatePageOutput } from '../../main/batching'

class RenderCapacityError extends Error {}
// Render just the requested region, in a rotated page coordinate system. No viewer state.
export async function renderTranslationImage(
  page: PDFPageProxy,
  part: SourcePart,
  settings: ImageSettings,
  track: (task: RenderTask | null) => void = () => {},
): Promise<PageImage> {
  const viewport = page.getViewport({ scale: settings.dpi / 72 })
  const { x, y, width, height } = part.region
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(viewport.width * width))
  canvas.height = Math.max(1, Math.ceil(viewport.height * height))
  try {
    if (canvas.width * canvas.height > 16_100_000) throw new RenderCapacityError()
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('canvas unavailable')
    const task = page.render({
      canvas,
      canvasContext: context,
      viewport,
      background: '#ffffff',
      transform: [1, 0, 0, 1, -viewport.width * x, -viewport.height * y],
    })
    track(task)
    await task.promise
    const mimeType = settings.format === 'png' ? 'image/png' : 'image/jpeg'
    const url = canvas.toDataURL(mimeType, settings.quality)
    if (url.length > settings.maxRequestBytes) throw new RenderCapacityError()
    return {
      mimeType,
      data: url.slice(url.indexOf(',') + 1),
      width: canvas.width,
      height: canvas.height,
    }
  } finally {
    track(null)
    canvas.width = 0
    canvas.height = 0
    page.cleanup()
  }
}

// One lifetime for the app window, independent of viewer, modal, and React effects.
let started = false
export function startTranslationWorker(): void {
  if (started) return
  started = true
  const trialCancels = new Map<string, () => void>()
  window.desktop.onChatGPTRenderCanceled((ticket) => trialCancels.get(ticket)?.())
  window.desktop.onPageChatImageCanceled((ticket) => trialCancels.get(ticket)?.())
  // Trials and page chat reuse the same color renderer with independent PDF lifetimes.
  window.desktop.onRenderRequested((request) => {
    if (!['chatgpt-trial', 'page-chat'].includes(request.session)) return
    void (async () => {
      let task: ReturnType<typeof loadPdf> | undefined
      let image: RenderResult = null
      let canceled = false,
        rendering: RenderTask | null = null
      trialCancels.set(request.token, () => {
        canceled = true
        rendering?.cancel()
        void task?.destroy().catch(() => {})
      })
      try {
        const result = await (request.session === 'page-chat'
          ? window.desktop.pageChatImageSource(request.token)
          : window.desktop.chatgptSource(request.token))
        if (result.status !== 'opened') throw new Error('source')
        if (canceled) return
        task = loadPdf(result.document.bytes)
        const pdf = await task.promise
        if (canceled) return
        const page = await pdf.getPage(request.source.page)
        if (canceled) return
        image = await renderTranslationImage(page, request.source, request.images, (current) => {
          rendering = current
        })
      } catch {
        /* Never forward PDF contents or raw renderer diagnostics. */
      } finally {
        trialCancels.delete(request.token)
        await task?.destroy().catch(() => {})
      }
      if (!canceled) await window.desktop.completeRender(request.requestId, image)
    })().catch(() => {})
  })
  const run = async () => {
    let task: ReturnType<typeof loadPdf> | undefined
    const rendering: { task: RenderTask | null } = { task: null }
    let unsubscribe: (() => void) | undefined
    const job = await window.desktop.claimPage()
    if (!job) return
    let canceled = false
    const unsubscribeDeletion = window.desktop.onLibraryDeleted(({ documentIds }) => {
      if (!documentIds.includes(job.documentId)) return
      canceled = true
      rendering.task?.cancel()
      void task?.destroy().catch(() => {})
    })
    try {
      const result = await window.desktop.readJobPdf(job.session, job.token)
      if (canceled) return
      if (result.status !== 'opened') {
        await window.desktop.failJobPdf(job.session, job.token)
        return
      }
      task = loadPdf(result.document.bytes)
      const pdf = await task.promise
      if (canceled) return
      const pages = []
      for (const number of job.pages) {
        const page = await pdf.getPage(number)
        if (canceled) return
        const viewport = page.getViewport({ scale: 1 })
        let text = ''
        try {
          text = extractPageText(await page.getTextContent())
        } catch {
          /* Scans and extraction failures are still image inputs. */
        }
        pages.push({
          page: number,
          width: viewport.width,
          height: viewport.height,
          outputTokens: estimatePageOutput(text),
        })
        page.cleanup()
      }
      if (canceled) return
      let live = true
      unsubscribe = window.desktop.onRenderRequested((request) => {
        if (
          request.session !== job.session ||
          request.token !== job.token ||
          !job.pages.includes(request.source.page)
        )
          return
        void (async () => {
          let image: RenderResult = null
          try {
            const page = await pdf.getPage(request.source.page)
            if (live && !canceled)
              image = await renderTranslationImage(page, request.source, request.images, (t) => {
                rendering.task = t
              })
          } catch (error) {
            image = {
              status: 'error',
              code: error instanceof RenderCapacityError ? 'capacity' : 'render',
            }
            /* Never send exception/source data over IPC. */
          }
          if (live && !canceled) await window.desktop.completeRender(request.requestId, image)
        })().catch(() => {})
      })
      try {
        await window.desktop.submitPage(job.session, job.token, pages)
      } finally {
        live = false
        unsubscribe()
        unsubscribe = undefined
      }
    } catch {
      await window.desktop.failJobPdf(job.session, job.token)
    } finally {
      unsubscribeDeletion()
      unsubscribe?.()
      rendering.task?.cancel()
      await task?.destroy()
    }
  }
  const tick = async () => {
    try {
      await run()
    } catch {
      /* DB errors are exposed by the viewer/library. */
    }
    window.setTimeout(() => void tick(), 400)
  }
  void tick()
}
