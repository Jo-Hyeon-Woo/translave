import { useEffect, useRef, useState } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { LoaderCircle } from 'lucide-react'
import { extractPageText } from './extract'

interface Props {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  onText: (text: string) => void
  onError: () => void
  onReady?: () => void
  onLayout?: () => void
}

export function PdfPage({ pdf, pageNumber, scale, onText, onError, onReady, onLayout }: Props) {
  const host = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let disposed = false
    let renderTask: RenderTask | undefined
    let textLayer: TextLayer | undefined
    const root = host.current!
    // Each render gets its own canvas; a canceled render never draws into the next page.
    const surface = document.createElement('div')
    surface.className = 'pdf-surface'
    root.replaceChildren(surface)
    root.style.marginTop = '24px'
    const viewer = root.closest<HTMLElement>('.viewer-scroll')
    const card = root.closest<HTMLElement>('.reader')
    const alignPage = () => {
      if (!viewer || !card || disposed) return
      const cardBounds = card.getBoundingClientRect()
      const pageHeight = surface.getBoundingClientRect().height
      if (!pageHeight) return
      const scrollOffset = viewer.getBoundingClientRect().top - cardBounds.top
      // Convert the whole-card center into scroll-content coordinates.
      const centeredTop = (cardBounds.height - pageHeight) / 2 - scrollOffset
      root.style.marginTop = `${centeredTop >= 0 ? centeredTop : 24}px`
    }
    const placement = new ResizeObserver(alignPage)
    if (viewer && card) {
      placement.observe(card)
      placement.observe(viewer)
      placement.observe(surface)
    }
    setStatus('loading')
    void (async () => {
      try {
        const page = await pdf.getPage(pageNumber)
        if (disposed) return
        const viewport = page.getViewport({ scale })
        const canvas = document.createElement('canvas')
        canvas.setAttribute('aria-label', `PDF ${pageNumber}페이지`)
        const layer = document.createElement('div')
        layer.className = 'textLayer'
        layer.setAttribute('aria-label', '선택 가능한 PDF 텍스트')
        surface.style.width = `${viewport.width}px`
        surface.style.height = `${viewport.height}px`
        surface.dataset.scale = String(scale)
        alignPage()
        onLayout?.()
        surface.style.setProperty('--scale-factor', String(scale))
        surface.style.setProperty('--user-unit', String(page.userUnit))
        surface.style.setProperty('--total-scale-factor', String(scale * page.userUnit))
        surface.style.setProperty('--min-font-size', '1')
        surface.style.setProperty('--text-scale-factor', String(scale * page.userUnit))
        const ratio = Math.min(window.devicePixelRatio || 1, 2)
        // Bound GPU/memory use for unusually large PDF media boxes.
        const outputScale = Math.min(
          ratio,
          Math.sqrt(16_000_000 / (viewport.width * viewport.height)),
        )
        canvas.width = Math.ceil(viewport.width * outputScale)
        canvas.height = Math.ceil(viewport.height * outputScale)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`
        surface.append(canvas, layer)
        renderTask = page.render({
          canvas,
          viewport,
          transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
        })
        // Cancellation can happen while text extraction is still pending.
        void renderTask.promise.catch(() => {})
        const content = await page.getTextContent()
        if (disposed) return
        onText(extractPageText(content))
        textLayer = new TextLayer({ textContentSource: content, container: layer, viewport })
        await Promise.all([renderTask.promise, textLayer.render()])
        if (!disposed) {
          setStatus('ready')
          onReady?.()
        }
      } catch (error) {
        if (
          !disposed &&
          !(error instanceof Error && error.name === 'RenderingCancelledException')
        ) {
          setStatus('error')
          onError()
        }
      }
    })()
    return () => {
      disposed = true
      placement.disconnect()
      renderTask?.cancel()
      textLayer?.cancel()
      surface.remove()
    }
  }, [pdf, pageNumber, scale, onText, onError, onReady, onLayout])

  return (
    <div className="page-stage" data-testid="page-stage" data-status={status}>
      {status === 'loading' && (
        <div className="page-loading" role="status">
          <LoaderCircle size={16} className="spin" />
          페이지를 불러오는 중
        </div>
      )}
      {status === 'error' && (
        <div className="page-failure" role="alert">
          이 페이지를 표시할 수 없어요. 다른 페이지로 이동해 주세요.
        </div>
      )}
      <div
        ref={host}
        className="pdf-host"
        style={{ visibility: status === 'error' ? 'hidden' : 'visible' }}
      />
    </div>
  )
}
