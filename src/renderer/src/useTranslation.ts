import { useCallback, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { QueueSnapshot, TranslationSettings } from '../../shared/contracts'

type Document = { id: string; session: string; pdf: PDFDocumentProxy }
export function useTranslation(document: Document | null, page: number) {
  const [settings, setSettings] = useState<TranslationSettings | null>(null)
  const [snapshot, setSnapshot] = useState<QueueSnapshot | null>(null)
  const [error, setError] = useState('')
  const current = useRef({ document, page })
  current.current = { document, page }
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const refreshSettings = async () => {
      try {
        const next = await window.desktop.translationSettings()
        if (!disposed)
          setSettings((previous) => {
            if (previous && previous.revision > next.revision) return previous
            return previous &&
              previous.revision === next.revision &&
              previous.configured === next.configured &&
              !!previous.authenticationError === !!next.authenticationError
              ? previous
              : next
          })
      } catch {
        if (!disposed) setError('번역 설정을 읽지 못했어요.')
      } finally {
        if (!disposed) timer = setTimeout(refreshSettings, 600)
      }
    }
    void refreshSettings()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [])

  const refresh = useCallback(async () => {
    const { document, page } = current.current
    if (!document?.session) return
    const result = await window.desktop.queueSnapshot(document.session, page)
    if (current.current.document === document && current.current.page === page) setSnapshot(result)
  }, [])
  useEffect(() => {
    if (!document?.session) return
    let disposed = false
    setError('')
    void refresh().catch(() => setError('로컬 DB를 읽지 못했어요.'))
    const updates = window.setInterval(() => {
      void refresh().catch(() => {
        if (!disposed) setError('로컬 DB를 읽지 못했어요.')
      })
    }, 400)
    return () => {
      disposed = true
      window.clearInterval(updates)
    }
  }, [document, refresh])

  useEffect(() => {
    if (!document?.session) return
    let currentPage = true
    void window.desktop
      .focusPage(document.session, page)
      .then((result) => {
        if (currentPage) setSnapshot(result)
      })
      .catch(() => {
        if (currentPage) setError('읽던 위치를 저장하지 못했어요.')
      })
    return () => {
      currentPage = false
    }
  }, [document, page])

  const command = async (action: () => Promise<void>) => {
    try {
      await action()
      await refresh()
      setError('')
    } catch {
      setError('번역 작업을 변경하지 못했어요. 문서를 다시 열어 주세요.')
    }
  }
  const session = document?.session
  const visible = snapshot && snapshot.session === session ? snapshot : null
  return {
    settings,
    setSettings,
    snapshot: visible,
    error,
    paused: visible?.paused ?? false,
    result: visible?.page === page ? visible.result : null,
    setPaused: (paused: boolean) => {
      if (session) void command(() => window.desktop.pauseQueue(session, paused))
    },
    retry: () => {
      if (session) void command(() => window.desktop.retryQueue(session, page))
    },
    retryFailed: () => {
      if (session) void command(() => window.desktop.retryQueue(session))
    },
  }
}
