import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { MemoEditor } from './MemoEditor'
import { shortMemoTitle } from '../../shared/memos'
import type { useMemos } from './useMemos'
import type { EditingEntry } from './editingFocus'

type Memos = ReturnType<typeof useMemos>
export function MemoSelector({
  memos,
  page,
  documentId,
  onList,
}: {
  memos: Memos
  page: number
  documentId: string | null
  onList: () => void
}) {
  const menu = useRef<HTMLDetailsElement>(null),
    [open, setOpen] = useState(false)
  const standalone = memos.preferences.selection.kind === 'standalone'
  const full = standalone
    ? memos.entry?.memo?.title || '별도 메모'
    : documentId
      ? `${page}페이지 메모`
      : '페이지별 메모'
  const close = () => {
    if (menu.current) menu.current.open = false
    setOpen(false)
  }
  useEffect(() => {
    close()
  }, [documentId, page])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close()
    }
    window.addEventListener('pointerdown', outside)
    return () => window.removeEventListener('pointerdown', outside)
  }, [])
  return (
    <details
      className="memo-selector"
      ref={menu}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        role="button"
        tabIndex={-1}
        title={full}
        aria-label={`메모 선택: ${full}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            menu.current!.open = true
            requestAnimationFrame(() =>
              menu.current?.querySelector<HTMLButtonElement>('button')?.focus(),
            )
          }
        }}
      >
        <span>{standalone ? shortMemoTitle(full) : full}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </summary>
      {open && (
        <div
          role="menu"
          aria-label="메모 종류"
          className="memo-type-menu translation-menu-content"
          onKeyDown={(event) => {
            if (event.key === 'Escape' || event.key === 'Tab') {
              event.preventDefault()
              event.stopPropagation()
              close()
              menu.current?.querySelector<HTMLElement>('summary')?.focus()
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')],
                index = items.indexOf(document.activeElement as HTMLButtonElement)
              items[
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + 2) % 2
              ]?.focus()
            }
          }}
        >
          <button
            role="menuitem"
            disabled={!memos.ready}
            onClick={() => {
              close()
              void memos.change({ selection: { kind: 'page' } })
            }}
          >
            페이지별 메모
          </button>
          <button
            role="menuitem"
            disabled={!memos.ready}
            onClick={() => {
              close()
              onList()
            }}
          >
            별도 메모
          </button>
        </div>
      )}
    </details>
  )
}
export function MemoSaveStatus({ memos }: { memos: Memos }) {
  const { entry, target } = memos
  if (!memos.ready || !target || entry?.loading || entry?.deleted || !entry?.memo) return null
  return (
    <span className="memo-save-status" role="status">
      {entry.error ? '저장하지 못한 초안을 유지하고 있어요.' : entry.saving ? '저장 중…' : '저장됨'}
    </span>
  )
}
export function MemoPanel({
  memos,
  editingEntry,
  focusAllowed,
}: {
  memos: Memos
  editingEntry: EditingEntry
  focusAllowed: boolean
}) {
  const { entry, target } = memos
  return (
    <section className="memo-panel" id="side-content" role="tabpanel" aria-labelledby="memo-tab">
      {memos.error && (
        <div className="memo-save-error">
          <p className="chat-error" role="alert">
            {memos.error}
          </p>
          {!memos.ready && (
            <button
              className="button secondary-button"
              tabIndex={-1}
              onClick={() => void memos.reloadPreferences()}
            >
              다시 읽기
            </button>
          )}
        </div>
      )}
      {!memos.ready || entry?.loading ? (
        <p className="muted">메모를 읽는 중…</p>
      ) : !target || entry?.deleted ? (
        <p className="muted">
          {memos.preferences.selection.kind === 'page'
            ? 'PDF를 열면 페이지별 메모를 작성할 수 있어요.'
            : '별도 메모를 선택하거나 새로 만들어 보세요.'}
        </p>
      ) : entry?.memo ? (
        <MemoEditor
          owner={entry.memo.id}
          memory={memos.editorMemory}
          editingEntry={editingEntry}
          focusAllowed={focusAllowed}
          body={entry.body}
          mode={memos.preferences.mode}
          onChange={(body) => memos.session.edit(memos.key, body)}
        />
      ) : null}
      {entry?.error && (
        <div className="memo-save-error">
          <p className="chat-error" role="alert">
            {entry.error}
          </p>
          <button
            className="button secondary-button"
            tabIndex={-1}
            onClick={() => {
              if (target) void memos.session.retry(memos.key, target)
            }}
          >
            다시 저장
          </button>
        </div>
      )}
    </section>
  )
}
