import { TranslationContent } from './TranslationContent'
import { PageChat } from './PageChat'
import type { PageChatHandle } from './PageChat'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import {
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Languages,
  Maximize,
  Minus,
  MoreHorizontal,
  Plus,
  MessageCircle,
  Settings2,
  ShieldCheck,
  Sparkles,
  X,
  LoaderCircle,
} from 'lucide-react'
import { PdfPage } from './PdfPage'
import { sampleTranslations } from './sample-translations'
import { TranslationSettings } from './TranslationSettings'
import { ChatGPTStatus } from './ChatGPTStatus'
import { ChatGPTDiagnostics } from './ChatGPTDiagnostics'
import { useTranslation } from './useTranslation'
import { FileLibrary } from './FileLibrary'
import type { ThemeId } from '../../shared/themes'
import { applyTheme } from './theme'
import { useChatSelection } from './chatSelection'

import { useDocumentTabs } from './useDocumentTabs'
import { DocumentTabs } from './DocumentTabs'
import { useMemos } from './useMemos'
import { MemoPanel, MemoSelector, MemoSaveStatus } from './MemoPanel'
import { MemoLibrary } from './MemoLibrary'
import { MemoExportPopover } from './MemoExportPopover'
import type { MemoTarget } from '../../shared/memos'
import { DeleteConfirmation } from './DeleteConfirmation'
import { NotebookPen, Check } from 'lucide-react'
import type { EditingEntry } from './editingFocus'

const sidebarTabs = ['translation', 'chat', 'memo'] as const

export function App({ initialTheme }: { initialTheme: ThemeId }) {
  const [theme, setTheme] = useState(initialTheme)
  const [fullscreen, setFullscreen] = useState(false)
  const documents = useDocumentTabs()
  const { document, opening, error, setError } = documents
  const activeTab = documents.active
  const page = activeTab?.page ?? 1
  const zoom = activeTab?.zoom ?? 'fit'
  const setPage = (page: number) => documents.updateActive({ page, scrollTop: 0, scrollLeft: 0 })
  const setZoom = (zoom: number | 'fit') => {
    zoomAnchor.current = null
    documents.updateActive({ zoom })
  }
  const [pageInput, setPageInput] = useState('1')
  const [pageWidth, setPageWidth] = useState(612)
  const [viewerWidth, setViewerWidth] = useState(850)
  const [panelWidth, setPanelWidth] = useState(35)
  const [tab, setTab] = useState<'translation' | 'chat' | 'memo'>('translation')
  const [editingEntry, setEditingEntry] = useState<EditingEntry>({ pending: false })
  const [memosOpen, setMemosOpen] = useState(false)
  const memos = useMemos(activeTab?.documentId ?? null, page, tab === 'memo')
  const editingScope = `${tab}:${activeTab?.id ?? ''}:${tab === 'memo' ? (memos.preferences.selection.kind === 'standalone' ? memos.preferences.selection.id : 'page') : ''}`
  useLayoutEffect(() => {
    setEditingEntry({ pending: true })
  }, [editingScope])
  const tabHeld = useRef(false)
  const commandHeld = useRef(new Set<string>())
  const composing = useRef(false)
  const [extracted, setExtracted] = useState<{
    key: string
    text: string
    failed?: boolean
  } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<'chatgpt' | null>(null)
  const openLibrary = () => {
    setError('')
    setLibraryOpen(true)
  }
  const openSettings = () => {
    setSettingsSection(null)
    setSettingsOpen(true)
  }
  const viewer = useRef<HTMLDivElement>(null)
  const workspace = useRef<HTMLDivElement>(null)
  const settings = useRef<HTMLDialogElement>(null)
  const translationMenu = useRef<HTMLDetailsElement>(null)
  const [translationMenuOpen, setTranslationMenuOpen] = useState(false)
  const [resetTarget, setResetTarget] = useState<string | null>(null)
  const [memoExportTarget, setMemoExportTarget] = useState<MemoTarget | null>(null)
  const memoExportOpen = useRef(false)
  memoExportOpen.current = memoExportTarget !== null
  const [resetPending, setResetPending] = useState(false)
  const resetting = useRef(false)
  const resetPanel = useRef<HTMLDivElement>(null)
  const chat = useRef<PageChatHandle>(null)
  const [canClearChat, setCanClearChat] = useState(false)
  const closeTranslationMenu = useCallback((focus = false) => {
    if (translationMenu.current) translationMenu.current.open = false
    setResetTarget(null)
    setMemoExportTarget(null)
    if (focus) translationMenu.current?.querySelector('summary')?.focus()
  }, [])
  const chooseTab = (next: 'translation' | 'chat' | 'memo') => {
    closeTranslationMenu()
    if (next === tab && next !== 'translation') setEditingEntry({ pending: true })
    setTab(next)
  }
  const key = activeTab ? `${activeTab.documentId}:${page}` : ''
  const menuOwner = `${activeTab?.id ?? ''}:${key}:${tab}`
  const currentMenuOwner = useRef(menuOwner)
  currentMenuOwner.current = menuOwner
  const confirmingReset = tab === 'chat' && resetTarget === menuOwner
  const confirmingPopup = confirmingReset || memoExportTarget !== null
  const confirmReset = async () => {
    if (
      !confirmingReset ||
      currentMenuOwner.current !== resetTarget ||
      resetting.current ||
      !canClearChat ||
      !chat.current
    )
      return
    const target = menuOwner
    resetting.current = true
    setResetPending(true)
    try {
      await chat.current.clear()
      if (currentMenuOwner.current === target) closeTranslationMenu(true)
    } finally {
      resetting.current = false
      setResetPending(false)
    }
  }
  const selection = useChatSelection(
    { documentId: activeTab?.documentId ?? null, documentName: activeTab?.name ?? '', page },
    settingsOpen || libraryOpen || memosOpen || translationMenuOpen,
    () => chooseTab('chat'),
  )
  const text = extracted?.key === key ? extracted.text : null
  const pageFailed = extracted?.key === key && extracted.failed
  const translation = useTranslation(document, page)
  const scale = zoom === 'fit' ? Math.max(0.25, Math.min(2, (viewerWidth - 88) / pageWidth)) : zoom

  useEffect(() => {
    let active = true
    let changed = false
    const unsubscribe = window.desktop.onWindowFullscreen((value) => {
      changed = true
      setFullscreen(value)
    })
    void window.desktop
      .windowFullscreen()
      .then((value) => {
        if (active && !changed) setFullscreen(value)
      })
      .catch(() => {
        /* Preserve the safe traffic-light inset when state is unavailable. */
      })
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const node = viewer.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setViewerWidth(entry.contentRect.width))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => setPageInput(String(page)), [page, activeTab?.id])
  useEffect(() => {
    if (document) setPageWidth(document.width)
  }, [document])
  useEffect(() => {
    let current = true
    void document?.pdf
      .getPage(page)
      .then((pdfPage) => {
        if (current) setPageWidth(pdfPage.getViewport({ scale: 1 }).width)
      })
      .catch(() => {
        /* The visible page reports its own render error. */
      })
    return () => {
      current = false
    }
  }, [document, page])

  const openDocument = async (sample = false, libraryId?: string, resume = false) => {
    const opened = await documents.openDocument(sample, libraryId, resume)
    if (opened) {
      setLibraryOpen(false)
      setExtracted(null)
      if (resume && !(await window.desktop.translationSettings()).configured) setSettingsOpen(true)
    }
  }

  useEffect(() => window.desktop.onOpenRequested(openLibrary), [openLibrary])

  const goToPage = useCallback(
    (next: number) => {
      if (!document) return
      const bounded = Math.max(1, Math.min(document.pdf.numPages, Math.trunc(next)))
      setPage(bounded)
      setPageInput(String(bounded))
      viewer.current?.scrollTo(0, 0)
      window.getSelection()?.removeAllRanges()
    },
    [document, documents.updateActive],
  )

  useEffect(() => {
    const menuOpen = (event: globalThis.KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      return (
        globalThis.document.querySelector(
          '.app-shell dialog[open], .app-shell .memo-selector[open], .app-shell [popover]:popover-open',
        ) ||
        target?.closest('select, [role="menu"], [role="listbox"]') ||
        [
          ...globalThis.document.querySelectorAll<HTMLElement>(
            '.app-shell [role="menu"], .app-shell [role="listbox"], .app-shell [aria-haspopup="listbox"][aria-expanded="true"]',
          ),
        ].some(
          (node) => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden',
        )
      )
    }
    // Capture only these commands before an editor's own Control key bindings.
    const commandHandler = (event: globalThis.KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (
        !event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey ||
        !['f', 's', 'w'].includes(key) ||
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        composing.current ||
        settingsOpen ||
        libraryOpen ||
        memosOpen ||
        translationMenu.current?.open ||
        menuOpen(event)
      )
        return
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat || commandHeld.current.has(key)) return
      commandHeld.current.add(key)
      if (key === 'f') openLibrary()
      else if (key === 's') openSettings()
      else if (activeTab) documents.close(activeTab.id)
    }
    const handler = (event: globalThis.KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        composing.current ||
        settingsOpen ||
        libraryOpen ||
        memosOpen ||
        translationMenu.current?.open ||
        event.altKey ||
        event.metaKey
      )
        return
      if (event.key === 'Tab') {
        if (menuOpen(event)) return
        event.preventDefault()
        if (tabHeld.current || event.repeat) return
        tabHeld.current = true
        const direction = event.shiftKey ? -1 : 1
        if (event.ctrlKey) {
          documents.cycle(direction)
          return
        }
        setTab(
          (current) =>
            sidebarTabs[
              (sidebarTabs.indexOf(current) + direction + sidebarTabs.length) % sidebarTabs.length
            ],
        )
        return
      }
      if (event.shiftKey || event.ctrlKey) return
      if (
        event.target instanceof HTMLElement &&
        (event.target.closest(
          'input, textarea, select, [role="textbox"], [role="menu"], [role="listbox"], dialog[open]',
        ) ||
          event.target.isContentEditable)
      )
        return
      if (['ArrowRight', 'PageDown'].includes(event.key)) {
        event.preventDefault()
        goToPage(page + 1)
      }
      if (['ArrowLeft', 'PageUp'].includes(event.key)) {
        event.preventDefault()
        goToPage(page - 1)
      }
    }
    const releaseTab = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Tab') tabHeld.current = false
      commandHeld.current.delete(event.key.toLowerCase())
    }
    const startComposition = () => {
      composing.current = true
    }
    const endComposition = () => {
      composing.current = false
    }
    const reset = () => {
      tabHeld.current = false
      commandHeld.current.clear()
      composing.current = false
    }
    window.addEventListener('keydown', handler)
    window.addEventListener('keydown', commandHandler, true)
    window.addEventListener('keyup', releaseTab)
    window.addEventListener('compositionstart', startComposition)
    window.addEventListener('compositionend', endComposition)
    window.addEventListener('focusout', endComposition)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('keydown', handler)
      window.removeEventListener('keydown', commandHandler, true)
      window.removeEventListener('keyup', releaseTab)
      window.removeEventListener('compositionstart', startComposition)
      window.removeEventListener('compositionend', endComposition)
      window.removeEventListener('focusout', endComposition)
      window.removeEventListener('blur', reset)
    }
  }, [
    page,
    goToPage,
    settingsOpen,
    libraryOpen,
    memosOpen,
    documents.cycle,
    documents.close,
    activeTab,
    openLibrary,
    openSettings,
  ])

  useEffect(() => {
    if (settingsOpen) settings.current?.showModal()
    else settings.current?.close()
  }, [settingsOpen])

  useEffect(() => {
    closeTranslationMenu()
  }, [menuOwner, settingsOpen, libraryOpen, memosOpen, closeTranslationMenu])
  useLayoutEffect(() => {
    const panel = resetPanel.current
    const menu = translationMenu.current
    if (!confirmingPopup || !panel || !menu) return
    const sidebar = menu.closest('.translation-panel')!
    const position = () => {
      const bounds = sidebar.getBoundingClientRect(),
        anchor = menu.getBoundingClientRect()
      panel.style.maxWidth = `${Math.max(0, anchor.right - Math.max(8, bounds.left + 8))}px`
    }
    position()
    panel.querySelector<HTMLButtonElement>('button')?.focus()
    const observer = new ResizeObserver(position)
    observer.observe(sidebar)
    observer.observe(panel)
    window.addEventListener('resize', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
    }
  }, [confirmingPopup])
  useEffect(() => {
    let blocked: number | null = null
    const consume = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const down = (event: globalThis.PointerEvent) => {
      blocked = null
      if (!memoExportOpen.current || translationMenu.current?.contains(event.target as Node)) return
      blocked = event.pointerId
      consume(event)
      closeTranslationMenu()
    }
    const up = (event: globalThis.PointerEvent) => {
      if (blocked === event.pointerId) consume(event)
    }
    const click = (event: MouseEvent) => {
      if (blocked === null) return
      blocked = null
      if (event.detail) consume(event)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('click', click, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('click', click, true)
    }
  }, [closeTranslationMenu])

  useEffect(() => {
    const dismiss = (event: globalThis.PointerEvent) => {
      if (translationMenu.current && !translationMenu.current.contains(event.target as Node))
        closeTranslationMenu()
    }
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && translationMenu.current?.open) {
        closeTranslationMenu(true)
      }
    }
    window.addEventListener('pointerdown', dismiss)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('keydown', escape)
    }
  }, [closeTranslationMenu])
  const menuAction = (action: () => void) => {
    closeTranslationMenu()
    action()
  }

  const activeReading = useRef(activeTab)
  activeReading.current = activeTab
  const readingKey = `${activeTab?.id}:${page}`
  const anchoredLayout = useRef('')
  const zoomAnchor = useRef<{
    owner: string
    scale: number
    x: number
    y: number
    clientX: number
    clientY: number
  } | null>(null)
  useLayoutEffect(() => {
    const node = viewer.current
    let frame = 0
    zoomAnchor.current = null
    anchoredLayout.current = ''
    if (!node || !document || settingsOpen || libraryOpen || memosOpen || translationMenuOpen)
      return
    const wheel = (event: WheelEvent) => {
      // Chromium delivers trackpad pinches as Ctrl+wheel too; use one event path.
      if (
        !event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.defaultPrevented ||
        !event.cancelable ||
        !Number.isFinite(event.deltaY) ||
        !event.deltaY ||
        (event.target instanceof Element &&
          event.target.closest('input, textarea, select, button, [contenteditable="true"]')) ||
        globalThis.document.querySelector(
          '.app-shell dialog[open], .app-shell .translation-menu[open], .app-shell .memo-selector[open], .app-shell [popover]:popover-open, .app-shell [role="menu"], .app-shell [role="listbox"]',
        )
      )
        return
      const surface = node.querySelector<HTMLElement>('.pdf-surface')
      if (!surface) return
      const bounds = surface.getBoundingClientRect()
      const renderedScale = Number(surface.dataset.scale)
      if (!bounds.width || !renderedScale) return
      event.preventDefault()
      const delta =
        event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? node.clientHeight : 1)
      const before = zoomAnchor.current?.scale ?? renderedScale
      const next = Math.max(
        0.25,
        Math.min(3, before * Math.exp(-Math.max(-30, Math.min(30, delta)) / 100)),
      )
      if (next === before) return
      const clientX = Math.max(bounds.left, Math.min(bounds.right, event.clientX))
      const clientY = Math.max(bounds.top, Math.min(bounds.bottom, event.clientY))
      zoomAnchor.current = {
        owner: readingKey,
        scale: next,
        clientX,
        clientY,
        x: (clientX - bounds.left) / renderedScale,
        y: (clientY - bounds.top) / renderedScale,
      }
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          if (zoomAnchor.current) documents.updateActive({ zoom: zoomAnchor.current.scale })
        })
    }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => {
      node.removeEventListener('wheel', wheel)
      cancelAnimationFrame(frame)
      zoomAnchor.current = null
    }
  }, [
    document,
    readingKey,
    settingsOpen,
    libraryOpen,
    memosOpen,
    translationMenuOpen,
    documents.updateActive,
  ])
  const scrollKey = `${activeTab?.id}:${page}:${scale}`
  const previousScrollKey = useRef('')
  const restoringScroll = useRef(true)
  if (previousScrollKey.current !== scrollKey) {
    previousScrollKey.current = scrollKey
    restoringScroll.current = true
  }
  const onPdfLayout = useCallback(() => {
    const anchor = zoomAnchor.current,
      node = viewer.current
    if (!node || !anchor || anchor.owner !== readingKey) return
    if (anchor.scale !== scale) return
    const bounds = node.querySelector('.pdf-surface')?.getBoundingClientRect()
    if (!bounds) return
    node.scrollLeft += bounds.left + anchor.x * scale - anchor.clientX
    node.scrollTop += bounds.top + anchor.y * scale - anchor.clientY
    zoomAnchor.current = null
    anchoredLayout.current = scrollKey
    restoringScroll.current = false
    documents.updateActive({ scrollLeft: node.scrollLeft, scrollTop: node.scrollTop })
  }, [readingKey, scale, documents.updateActive])
  const onPdfReady = useCallback(() => {
    const current = activeReading.current
    if (previousScrollKey.current !== scrollKey || !current) return
    if (anchoredLayout.current !== scrollKey)
      viewer.current?.scrollTo(current.scrollLeft, current.scrollTop)
    anchoredLayout.current = ''
    restoringScroll.current = false
  }, [scrollKey])

  const onText = useCallback((value: string) => setExtracted({ key, text: value }), [key])
  const onPageError = useCallback(() => setExtracted({ key, text: '', failed: true }), [key])
  const commitPage = (): void => {
    const value = Number(pageInput)
    if (/^\d+$/.test(pageInput) && Number.isFinite(value)) goToPage(value)
    else setPageInput(String(page))
  }
  const pageKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      commitPage()
      event.currentTarget.blur()
    }
    if (event.key === 'Escape') {
      setPageInput(String(page))
      event.currentTarget.blur()
    }
  }
  const moveDivider = (event: PointerEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const bounds = workspace.current!.getBoundingClientRect()
    const styles = getComputedStyle(workspace.current!)
    const inset = parseFloat(styles.paddingRight)
    const gap = event.currentTarget.getBoundingClientRect().width
    const available = bounds.width - parseFloat(styles.paddingLeft) - inset - gap
    setPanelWidth(
      Math.max(
        27,
        Math.min(48, ((bounds.right - inset - event.clientX - gap / 2) / available) * 100),
      ),
    )
  }
  const sampleTranslation = document?.sample ? sampleTranslations[page] : null
  const showSample =
    !!sampleTranslation &&
    !translation.settings?.configured &&
    translation.result?.status !== 'done'
  const translationError =
    translation.error ||
    (translation.result?.status === 'error' ? translation.result.message : '') ||
    (translation.snapshot?.paused ? translation.snapshot.reason : '')

  return (
    <div className="app-shell" data-fullscreen={fullscreen} data-tabs-ready={documents.ready}>
      {selection.popup}
      <header className="titlebar">
        <div className="brand">
          <span className="brand-mark">
            <BookOpen size={17} strokeWidth={2.3} />
          </span>
          <span className="brand-name">translave</span>
        </div>
        <span className="brand-divider" aria-hidden="true" />
        <div className="document-tabs-frame">
          <DocumentTabs
            workspace={documents.workspace}
            disabled={!documents.ready || opening}
            onSelect={documents.select}
            onClose={documents.close}
            onReorder={documents.reorder}
            onAdd={openLibrary}
          />
          <span className="document-tab-edge" data-side="left" aria-hidden="true" />
          <span className="document-tab-edge" data-side="right" aria-hidden="true" />
        </div>
        <div className="header-actions">
          <button
            tabIndex={-1}
            className="icon-button settings-trigger"
            aria-label="설정"
            onClick={openSettings}
          >
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      {error && !libraryOpen && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button
            tabIndex={-1}
            className="icon-button"
            aria-label="오류 닫기"
            onClick={() => setError('')}
          >
            <X size={16} />
          </button>
        </div>
      )}

      <main
        className="workspace"
        ref={workspace}
        style={{ '--panel-ratio': panelWidth / 100 } as CSSProperties}
      >
        <section
          id="pdf-reader"
          className={`reader ${!document ? 'reader-empty' : ''}`}
          aria-label="PDF 뷰어"
        >
          <div className="reader-controls">
            <div className="page-controls">
              <button
                tabIndex={-1}
                className="icon-button"
                aria-label="이전 페이지"
                disabled={!document || page === 1}
                onClick={() => goToPage(page - 1)}
              >
                <ChevronLeft size={17} />
              </button>
              <input
                tabIndex={-1}
                aria-label="현재 페이지"
                inputMode="numeric"
                value={activeTab ? pageInput : '—'}
                disabled={!activeTab}
                readOnly={!document}
                onChange={(event) => setPageInput(event.target.value)}
                onBlur={commitPage}
                onKeyDown={pageKeyDown}
              />
              <span className="page-total">/ {document?.pdf.numPages || '—'}</span>
              <button
                tabIndex={-1}
                className="icon-button"
                aria-label="다음 페이지"
                disabled={!document || page === document.pdf.numPages}
                onClick={() => goToPage(page + 1)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
            <div className="zoom-controls">
              <button
                tabIndex={-1}
                className="icon-button"
                aria-label="축소"
                disabled={!document || scale <= 0.25}
                onClick={() => setZoom(Math.max(0.25, Math.round((scale - 0.15) * 100) / 100))}
              >
                <Minus size={16} />
              </button>
              <span className="zoom-value" data-testid="zoom-value">
                {document ? `${Math.round(scale * 100)}%` : '—'}
              </span>
              <button
                tabIndex={-1}
                className="icon-button"
                aria-label="확대"
                disabled={!document || scale >= 3}
                onClick={() => setZoom(Math.min(3, Math.round((scale + 0.15) * 100) / 100))}
              >
                <Plus size={16} />
              </button>
              <button
                tabIndex={-1}
                className={`icon-button ${zoom === 'fit' && document ? 'is-active' : ''}`}
                title="너비에 맞추기"
                aria-label="너비에 맞추기"
                disabled={!document}
                onClick={() => setZoom('fit')}
              >
                <Maximize size={16} />
              </button>
            </div>
          </div>
          <div
            className="viewer-scroll"
            tabIndex={-1}
            ref={viewer}
            onScroll={(event) => {
              if (!restoringScroll.current && document)
                documents.updateActive({
                  scrollTop: event.currentTarget.scrollTop,
                  scrollLeft: event.currentTarget.scrollLeft,
                })
            }}
          >
            {opening && (
              <div className="opening-overlay" role="status">
                <LoaderCircle size={20} className="spin" />
                문서를 여는 중이에요
              </div>
            )}
            {document ? (
              <PdfPage
                key={`${document.tabId}:${page}`}
                pdf={document.pdf}
                pageNumber={page}
                scale={scale}
                onText={onText}
                onError={onPageError}
                onReady={onPdfReady}
                onLayout={onPdfLayout}
              />
            ) : activeTab ? (
              <div className="page-failure" role="status">
                {opening ? 'PDF를 불러오는 중이에요.' : '파일 목록에서 원본 PDF를 확인해 주세요.'}
              </div>
            ) : (
              <div className="welcome">
                <div className="document-art" aria-hidden="true">
                  <div className="art-page art-back" />
                  <div className="art-page art-front">
                    <span className="art-label">READ. UNDERSTAND.</span>
                    <div className="art-title">
                      A new
                      <br />
                      perspective.
                    </div>
                    <i />
                    <i />
                    <i className="short" />
                    <div className="art-stamp">
                      <Languages size={22} />
                    </div>
                  </div>
                  <span className="art-spark">
                    <Sparkles size={17} />
                  </span>
                </div>
                <span className="eyebrow">LESS SWITCHING. MORE READING.</span>
                <h1>
                  원문 곁에 번역,
                  <br />
                  읽기에만 집중하세요.
                </h1>
                <p>
                  읽고 싶은 PDF를 열어보세요.
                  <br />
                  원본의 맥락과 번역을 한눈에 살펴볼 수 있어요.
                </p>
                <button
                  tabIndex={-1}
                  className="button primary-button"
                  onClick={() => {
                    setError('')
                    setLibraryOpen(true)
                  }}
                  disabled={opening}
                >
                  <FolderOpen size={17} />
                  PDF 선택하기
                  <ArrowUpRight size={17} />
                </button>
                <button
                  tabIndex={-1}
                  className="sample-link"
                  onClick={() => void openDocument(true)}
                  disabled={opening}
                >
                  샘플 문서로 둘러보기
                  <ArrowRight size={15} />
                </button>
                <span className="local-note">
                  <ShieldCheck size={13} />
                  원본 파일은 내 기기에 그대로
                </span>
              </div>
            )}
          </div>
        </section>

        <div
          className="panel-divider"
          role="separator"
          aria-label="번역 패널 너비"
          aria-orientation="vertical"
          aria-valuemin={27}
          aria-valuemax={48}
          aria-valuenow={Math.round(panelWidth)}
          tabIndex={-1}
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={moveDivider}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        >
          <span />
        </div>

        <aside className="translation-panel" aria-label="페이지 번역">
          <div className="panel-header">
            <div className="panel-tabs" role="tablist" aria-label="사이드 패널">
              <button
                tabIndex={-1}
                role="tab"
                id="translation-tab"
                aria-controls="side-content"
                aria-selected={tab === 'translation'}
                onClick={() => chooseTab('translation')}
              >
                <Languages size={16} />
                번역
              </button>
              <button
                tabIndex={-1}
                role="tab"
                id="chat-tab"
                aria-controls="side-content"
                aria-selected={tab === 'chat'}
                onClick={() => chooseTab('chat')}
              >
                <MessageCircle size={16} />
                채팅
              </button>
              <button
                tabIndex={-1}
                role="tab"
                id="memo-tab"
                aria-controls="side-content"
                aria-selected={tab === 'memo'}
                onClick={() => chooseTab('memo')}
              >
                <NotebookPen size={16} />
                메모
              </button>
            </div>
            <details
              className="translation-menu"
              ref={translationMenu}
              onToggle={(event) => {
                setTranslationMenuOpen(event.currentTarget.open)
                if (!event.currentTarget.open) {
                  setResetTarget(null)
                  setMemoExportTarget(null)
                }
              }}
            >
              <summary
                tabIndex={translationMenuOpen ? 0 : -1}
                aria-label={
                  tab === 'memo' ? '메모 메뉴' : tab === 'chat' ? '채팅 메뉴' : '번역 메뉴'
                }
                title={tab === 'memo' ? '메모 메뉴' : tab === 'chat' ? '채팅 메뉴' : '번역 메뉴'}
              >
                <MoreHorizontal size={20} />
              </summary>
              <div
                ref={resetPanel}
                className={
                  confirmingPopup
                    ? 'chat-delete-popover chat-reset-confirm'
                    : 'translation-menu-content'
                }
                role={confirmingPopup ? 'menu' : undefined}
                aria-label={
                  memoExportTarget
                    ? '메모 내보내기'
                    : confirmingReset
                      ? '대화 초기화 확인'
                      : undefined
                }
                onKeyDown={(event) => {
                  if (!confirmingPopup) return
                  if (event.key === 'Escape' || event.key === 'Tab') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeTranslationMenu(true)
                  } else if (
                    ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                      event.key,
                    )
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                    const buttons = [
                      ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                        'button:not(:disabled)',
                      ),
                    ]
                    const index = buttons.indexOf(
                      window.document.activeElement as HTMLButtonElement,
                    )
                    const next =
                      event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? buttons.length - 1
                          : (index +
                              (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) +
                              buttons.length) %
                            buttons.length
                    buttons[next]?.focus()
                  }
                }}
              >
                {memoExportTarget ? (
                  <MemoExportPopover
                    target={memoExportTarget}
                    drafts={memos.session}
                    onClose={() => closeTranslationMenu(true)}
                    onError={setError}
                  />
                ) : confirmingReset ? (
                  <DeleteConfirmation
                    text="현재 페이지의 대화를 초기화하시겠습니까?"
                    confirmLabel="초기화"
                    pending={resetPending}
                    onCancel={() => closeTranslationMenu(true)}
                    onConfirm={() => void confirmReset()}
                  />
                ) : tab === 'memo' ? (
                  <>
                    <button
                      disabled={!memos.ready || !memos.target || !!memos.entry?.loading}
                      onClick={() => setMemoExportTarget({ ...memos.target! })}
                    >
                      메모 내보내기
                    </button>
                    <hr className="memo-menu-separator" />
                    <button
                      disabled={!memos.ready}
                      aria-pressed={memos.preferences.mode === 'preview'}
                      onClick={() =>
                        menuAction(() => {
                          void memos.change({ mode: 'preview' })
                        })
                      }
                    >
                      보기 모드
                      {memos.preferences.mode === 'preview' && (
                        <Check size={13} aria-label="현재 모드" />
                      )}
                    </button>
                    <button
                      disabled={!memos.ready}
                      aria-pressed={memos.preferences.mode === 'source'}
                      onClick={() =>
                        menuAction(() => {
                          void memos.change({ mode: 'source' })
                        })
                      }
                    >
                      수정 모드
                      {memos.preferences.mode === 'source' && (
                        <Check size={13} aria-label="현재 모드" />
                      )}
                    </button>
                  </>
                ) : tab === 'chat' ? (
                  <>
                    <button
                      onClick={() =>
                        menuAction(() => {
                          setSettingsSection('chatgpt')
                          setSettingsOpen(true)
                        })
                      }
                    >
                      ChatGPT 설정
                    </button>
                    <button
                      aria-label="현재 페이지 대화 초기화"
                      disabled={!document || !canClearChat || resetPending}
                      onClick={() => setResetTarget(menuOwner)}
                    >
                      대화 초기화
                    </button>
                  </>
                ) : (
                  <>
                    {document && (
                      <p className="menu-progress">
                        전체 {translation.snapshot?.done ?? 0} / {document.pdf.numPages}페이지 번역
                      </p>
                    )}
                    <button
                      disabled={!document?.session}
                      onClick={() => menuAction(translation.retry)}
                    >
                      다시 번역
                    </button>
                    <button
                      disabled={!document?.session}
                      onClick={() =>
                        menuAction(() =>
                          translation.setPaused(
                            !translation.paused && !!translation.settings?.configured,
                          ),
                        )
                      }
                    >
                      {translation.paused || !translation.settings?.configured
                        ? '자동 번역 재개'
                        : '자동 번역 일시정지'}
                    </button>
                    {!!translation.snapshot?.failed && (
                      <button
                        disabled={!document?.session}
                        onClick={() => menuAction(translation.retryFailed)}
                      >
                        실패한 페이지 재시도
                      </button>
                    )}
                    <button onClick={() => menuAction(() => setSettingsOpen(true))}>
                      ChatGPT 설정
                    </button>
                  </>
                )}
              </div>
            </details>
          </div>
          <div className="language-bar">
            {tab === 'memo' ? (
              <MemoSelector
                memos={memos}
                documentId={activeTab?.documentId ?? null}
                page={page}
                onList={() => setMemosOpen(true)}
              />
            ) : tab === 'chat' ? (
              <span className="chat-page-title">
                {document ? `${page}페이지 대화` : '페이지별 대화'}
              </span>
            ) : (
              <>
                <span>영어</span>
                <ArrowRight size={13} />
                <span className="target-language">한국어</span>
              </>
            )}
            {tab === 'memo' ? (
              <MemoSaveStatus memos={memos} />
            ) : (
              <ChatGPTStatus
                tabIndex={-1}
                settings={translation.settings}
                sample={showSample}
                onOpen={() => {
                  setSettingsSection('chatgpt')
                  setSettingsOpen(true)
                }}
              />
            )}
          </div>
          {tab === 'memo' ? (
            <MemoPanel
              memos={memos}
              editingEntry={editingEntry}
              focusAllowed={!settingsOpen && !libraryOpen && !memosOpen && !translationMenuOpen}
            />
          ) : tab === 'chat' ? (
            <PageChat
              ref={chat}
              onCanClearChange={setCanClearChat}
              key={`${activeTab?.id ?? ''}:${page}`}
              draft={documents.chatDrafts.forTab(activeTab?.id, page)}
              editingEntry={editingEntry}
              focusAllowed={!settingsOpen && !libraryOpen && !memosOpen && !translationMenuOpen}
              documentId={activeTab?.documentId ?? null}
              page={page}
              quotes={selection.quotes}
              quoteError={selection.error}
              onClearQuotes={selection.clearQuotes}
              onRemoveQuote={selection.removeQuote}
              onHoverQuote={selection.hoverQuote}
              settings={translation.settings}
              onSettings={() => {
                setSettingsSection('chatgpt')
                setSettingsOpen(true)
              }}
            />
          ) : (
            <div
              className="panel-scroll"
              tabIndex={-1}
              id="side-content"
              role="tabpanel"
              aria-labelledby="translation-tab"
              key={`${key}:${tab}`}
            >
              {!document ? (
                <div className="translation-state">
                  <p>PDF를 열면 이곳에 번역이 표시됩니다.</p>
                </div>
              ) : translation.result?.status === 'done' ||
                (translation.result?.status === 'error' && translation.result.content) ? (
                <TranslationContent result={translation.result} tabIndex={-1} />
              ) : showSample && sampleTranslation ? (
                <article className="translation-content" data-testid="sample-translation">
                  <h2>{sampleTranslation.title}</h2>
                  {sampleTranslation.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </article>
              ) : translationError ? (
                <div className="translation-state translation-error" role="alert">
                  <p>{translationError}</p>
                  {translation.result?.status === 'error' && translation.result.diagnostic && (
                    <ChatGPTDiagnostics diagnostic={translation.result.diagnostic} tabIndex={-1} />
                  )}
                </div>
              ) : pageFailed ? (
                <div className="translation-state translation-error" role="alert">
                  <p>이 페이지를 읽을 수 없어요.</p>
                </div>
              ) : translation.result?.status === 'skipped' ? (
                <div className="translation-state" role="status">
                  <p>이 페이지에는 추출할 텍스트가 없어요.</p>
                </div>
              ) : !translation.settings?.configured ? (
                <div className="translation-state" role="status">
                  <p>
                    {translation.settings?.connection?.reason ||
                      '설정에서 ChatGPT를 연결해 주세요.'}
                  </p>
                </div>
              ) : translation.paused ? (
                <div className="translation-state" role="status">
                  <p>번역을 일시정지했어요.</p>
                </div>
              ) : (
                <div className="translation-state" role="status">
                  <LoaderCircle className="spin" size={17} />
                  <p>
                    {translation.result?.status === 'translating'
                      ? '번역 중…'
                      : text === null || translation.result?.status === 'extracting'
                        ? '페이지 준비 중…'
                        : '번역 대기 중…'}
                  </p>
                </div>
              )}
            </div>
          )}
        </aside>
      </main>

      {libraryOpen && (
        <FileLibrary
          onClose={() => setLibraryOpen(false)}
          onOpen={(id, resume) => openDocument(false, id, resume)}
          error={error}
          onError={setError}
        />
      )}
      {memosOpen && (
        <MemoLibrary
          onExportError={setError}
          drafts={memos.session}
          sort={memos.preferences.sort}
          onSort={(sort) => memos.change({ sort })}
          onClose={() => setMemosOpen(false)}
          onOpen={async (id) => {
            if (!(await memos.change({ selection: { kind: 'standalone', id } }))) return false
            chooseTab('memo')
            return true
          }}
        />
      )}

      <dialog
        ref={settings}
        className="settings-dialog"
        aria-labelledby="settings-title"
        onCancel={() => setSettingsOpen(false)}
        onClose={() => {
          // A previous native close event can arrive after keyboard reopening.
          if (!settings.current?.open) setSettingsOpen(false)
        }}
      >
        <div className="dialog-header">
          <h2 id="settings-title" className="settings-title">
            settings
          </h2>
          <button
            className="icon-button"
            aria-label="설정 닫기"
            onClick={() => setSettingsOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        {settingsOpen && (
          <TranslationSettings
            initialSection={settingsSection}
            theme={theme}
            onThemeChange={(next) => {
              applyTheme(next)
              setTheme(next)
            }}
            settings={translation.settings}
            onChange={translation.setSettings}
          />
        )}
      </dialog>
    </div>
  )
}
