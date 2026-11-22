import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import type { OpenedDocument } from '../../shared/contracts'
import {
  closeReadingTab,
  emptyReadingWorkspace,
  moveReadingTab,
  cycleReadingTab,
  removeDocumentTabs,
} from '../../shared/readingTabs'
import type { ReadingTab, ReadingWorkspace } from '../../shared/readingTabs'
import { loadPdf } from './pdf'
import { saveLibraryDocument } from './library'
import { ChatDrafts } from './chatDrafts'

type ReadingDocument = Omit<OpenedDocument, 'bytes'> & {
  tabId: string
  pdf: PDFDocumentProxy
  session: string
  width: number
}
function pdfError(error: unknown) {
  return error instanceof Error && error.name === 'PasswordException'
    ? '암호로 보호된 PDF는 아직 지원하지 않아요. 암호가 해제된 파일을 열어 주세요.'
    : 'PDF를 열 수 없어요. 파일이 손상되었거나 지원하지 않는 형식일 수 있습니다.'
}

export function useDocumentTabs() {
  const [chatDrafts] = useState(() => new ChatDrafts())
  const [workspace, setWorkspace] = useState(emptyReadingWorkspace)
  const current = useRef(workspace)
  const [ready, setReady] = useState(false)
  const writable = useRef(false)
  const saves = useRef(Promise.resolve())
  const [saveError, setSaveError] = useState('')
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const [loaded, setLoaded] = useState<ReadingDocument | null>(null)
  const loadedRef = useRef(loaded)
  const request = useRef(0)
  const pending = useRef<PDFDocumentLoadingTask | null>(null)
  const openingDocument = useRef<string | null>(null)

  const commit = useCallback((next: ReadingWorkspace) => {
    chatDrafts.sync(next.tabs)
    current.current = next
    setWorkspace(next)
    if (!writable.current) return
    // Preserve event order even when scroll, selection and close happen together.
    saves.current = saves.current.then(async () => {
      try {
        const result = await window.desktop.saveReadingWorkspace(next)
        setSaveError(result.status === 'saved' ? '' : result.message)
      } catch {
        setSaveError('문서 탭과 읽던 위치를 저장하지 못했어요.')
      }
    })
  }, [])
  useEffect(
    () =>
      window.desktop.onLibraryDeleted(({ documentIds }) => {
        const next = removeDocumentTabs(current.current, documentIds)
        if (openingDocument.current && documentIds.includes(openingDocument.current)) {
          request.current++
          void pending.current?.destroy().catch(() => {})
          pending.current = null
          setOpening(false)
        }
        if (next !== current.current) {
          if (next.activeId !== current.current.activeId) request.current++
          commit(next)
        }
      }),
    [commit],
  )
  const updateActive = useCallback(
    (patch: Partial<Pick<ReadingTab, 'page' | 'zoom' | 'scrollTop' | 'scrollLeft'>>) => {
      const w = current.current
      const active = w.tabs.find((t) => t.id === w.activeId)
      if (!active || Object.entries(patch).every(([k, v]) => active[k as keyof ReadingTab] === v))
        return
      commit({ ...w, tabs: w.tabs.map((t) => (t.id === w.activeId ? { ...t, ...patch } : t)) })
    },
    [commit],
  )
  const publish = (document: ReadingDocument | null) => {
    loadedRef.current = document
    setLoaded(document)
  }
  const begin = () => {
    const token = ++request.current
    void pending.current?.destroy()
    pending.current = null
    setOpening(true)
    setError('')
    return token
  }
  const prepare = async (
    source: OpenedDocument,
    token: number,
    tabId: string,
    saved?: ReadingTab,
    register = false,
  ) => {
    const task = loadPdf(source.bytes)
    pending.current = task
    let retained = false
    try {
      const pdf = await task.promise
      if (token !== request.current) return null
      // Library opening never re-registers a document or enqueues another job.
      if (register) await saveLibraryDocument(source.id, pdf)
      if (token !== request.current) return null
      let session = { session: '', page: 1 }
      try {
        session = await window.desktop.activateDocument({
          documentId: source.id,
          name: source.name,
          total: pdf.numPages,
          ...(saved ? { page: Math.min(saved.page, pdf.numPages) } : {}),
        })
      } catch {
        if (token === request.current) setError('번역 DB를 열 수 없어 PDF 읽기만 사용할 수 있어요.')
      }
      if (token !== request.current) return null
      const page = Math.max(1, Math.min(pdf.numPages, saved?.page ?? session.page))
      const first = await pdf.getPage(page)
      if (token !== request.current) return null
      retained = true
      return {
        document: {
          id: source.id,
          name: source.name,
          sample: source.sample,
          pdf,
          session: session.session,
          tabId,
          width: first.getViewport({ scale: 1 }).width,
        },
        page,
      }
    } finally {
      if (pending.current === task) pending.current = null
      if (!retained || token !== request.current) await task.destroy()
    }
  }

  useEffect(() => {
    let alive = true
    void window.desktop
      .readingWorkspace()
      .then((result) => {
        if (!alive) return
        if (result.status === 'loaded') {
          writable.current = true
          current.current = result.workspace
          setWorkspace(result.workspace)
        } else setSaveError(result.message)
        setReady(true)
      })
      .catch(() => {
        if (alive) {
          setSaveError('문서 탭을 복원하지 못했어요. 기존 저장 정보는 유지됩니다.')
          setReady(true)
        }
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (!ready) return
    const saved = current.current.tabs.find((t) => t.id === current.current.activeId)
    if (!saved) {
      publish(null)
      setOpening(false)
      return
    }
    if (loadedRef.current?.tabId === saved.id) {
      setOpening(false)
      return
    }
    const token = begin()
    openingDocument.current = saved.documentId
    publish(null)
    void (async () => {
      try {
        // Restoration/tab switching never opens a native file picker by itself.
        const result = await window.desktop.openLibraryDocument(saved.documentId, false)
        if (token !== request.current) return
        if (result.status !== 'opened') {
          setError(result.status === 'error' ? result.message : 'PDF 열기가 취소되었어요.')
          return
        }
        const prepared = await prepare(result.document, token, saved.id, saved)
        if (!prepared || token !== request.current) return
        publish(prepared.document)
        if (prepared.page !== saved.page)
          updateActive({ page: prepared.page, scrollTop: 0, scrollLeft: 0 })
      } catch (cause) {
        if (token === request.current) setError(pdfError(cause))
      } finally {
        if (token === request.current) setOpening(false)
      }
    })()
    return () => {
      request.current++
      void pending.current?.destroy()
      pending.current = null
    }
  }, [workspace.activeId, ready, updateActive])
  useEffect(
    () => () => {
      void loaded?.pdf.loadingTask.destroy()
    },
    [loaded],
  )
  useEffect(
    () => () => {
      request.current++
      void pending.current?.destroy()
    },
    [],
  )

  const openDocument = async (sample = false, libraryId?: string, resume = false) => {
    if (!ready || opening) return false
    const token = begin()
    openingDocument.current = libraryId ?? null
    let prepared: Awaited<ReturnType<typeof prepare>> = null
    try {
      const result = await (sample
        ? window.desktop.openSample()
        : window.desktop.openLibraryDocument(libraryId!))
      if (token !== request.current || result.status === 'canceled') return false
      if (result.status === 'error') {
        setError(result.message)
        return false
      }
      const id = crypto.randomUUID()
      openingDocument.current = result.document.id
      prepared = await prepare(result.document, token, id, undefined, sample)
      if (!prepared || token !== request.current) return false
      if (resume && prepared.document.session)
        await window.desktop.retryQueue(prepared.document.session)
      if (token !== request.current) {
        await prepared.document.pdf.loadingTask.destroy()
        return false
      }
      const tab: ReadingTab = {
        id,
        documentId: result.document.id,
        name: result.document.name,
        page: prepared.page,
        zoom: 'fit',
        scrollTop: 0,
        scrollLeft: 0,
      }
      publish(prepared.document)
      commit({ tabs: [...current.current.tabs, tab], activeId: id })
      return true
    } catch (cause) {
      await prepared?.document.pdf.loadingTask.destroy()
      if (token === request.current) setError(pdfError(cause))
      return false
    } finally {
      if (token === request.current) setOpening(false)
    }
  }
  const select = (id: string) => {
    if (id === current.current.activeId || !current.current.tabs.some((t) => t.id === id)) return
    request.current++
    commit({ ...current.current, activeId: id })
  }
  const close = (id: string) => {
    const next = closeReadingTab(current.current, id)
    if (next === current.current) return
    if (next.activeId !== current.current.activeId) request.current++
    commit(next)
  }
  const reorder = useCallback(
    (id: string, beforeId: string | null) => {
      const next = moveReadingTab(current.current, id, beforeId)
      if (next !== current.current) commit(next)
    },
    [commit],
  )
  const cycle = useCallback(
    (direction: number) => {
      const next = cycleReadingTab(current.current, direction)
      if (next === current.current) return
      request.current++
      commit(next)
    },
    [commit],
  )
  const active = workspace.tabs.find((t) => t.id === workspace.activeId)
  return {
    chatDrafts,
    workspace,
    active,
    ready,
    opening,
    document: loaded?.tabId === workspace.activeId ? loaded : null,
    error: error || saveError,
    setError: (message: string) => {
      setError(message)
      if (!message && writable.current) setSaveError('')
    },
    openDocument,
    select,
    close,
    reorder,
    cycle,
    updateActive,
  }
}
