import { useLayoutEffect, useRef, useState, useEffect } from 'react'
import type { MemoTarget, MemoExportScope, MemoExportFormat } from '../../shared/memos'
import type { MemoDrafts } from './memoDrafts'

export function MemoExportPopover({
  target,
  drafts,
  onClose,
  onError,
}: {
  target: MemoTarget
  drafts: MemoDrafts
  onClose: () => void
  onError: (message: string) => void
}) {
  const [scope, setScope] = useState<MemoExportScope | null>(
    target.kind === 'page' ? null : 'single',
  )
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const pending = useRef(false),
    alive = useRef(true),
    panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useLayoutEffect(() => {
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus()
  }, [scope])
  const save = async (format: MemoExportFormat) => {
    if (pending.current || !scope) return
    pending.current = true
    setBusy(true)
    setError('')
    // Capture current drafts synchronously; exporting never flushes or edits a memo.
    const snapshot = [...drafts.entries.values()]
      .filter((entry) => {
        const memo = entry.memo
        return (
          memo &&
          !entry.deleted &&
          !entry.loading &&
          (target.kind === 'standalone'
            ? memo.id === target.id
            : memo.documentId === target.documentId &&
              (scope === 'document' || memo.page === target.page))
        )
      })
      .map((entry) => ({ id: entry.memo!.id, body: entry.body }))
    try {
      const result = await window.desktop.memoExport({
        target: { ...target },
        scope,
        format,
        drafts: snapshot,
      })
      if (result.status === 'error') {
        if (alive.current) setError(result.message)
        else onError(result.message)
      } else if (alive.current) onClose()
    } catch {
      const message = '메모를 내보내지 못했어요. 다시 시도해 주세요.'
      if (alive.current) setError(message)
      else onError(message)
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }
  return (
    <div ref={panel} className="memo-export-content">
      <p>{scope ? '형식을 선택하세요' : '합쳐서 내보낼까요?'}</p>
      <div className="chat-delete-actions">
        {scope ? (
          <>
            <button className="chat-delete-cancel" disabled={busy} onClick={() => void save('pdf')}>
              PDF
            </button>
            <button className="chat-delete-cancel" disabled={busy} onClick={() => void save('md')}>
              MD
            </button>
          </>
        ) : (
          <>
            <button className="chat-delete-cancel" onClick={() => setScope('single')}>
              이 페이지만
            </button>
            <button className="chat-delete-cancel" onClick={() => setScope('document')}>
              합쳐서
            </button>
          </>
        )}
      </div>
      {busy && <p role="status">내보내는 중…</p>}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
