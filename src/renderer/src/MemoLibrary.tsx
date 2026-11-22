import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownWideNarrow, Check, MoreVertical, Plus, X } from 'lucide-react'
import type { MemoSort, MemoSummary } from '../../shared/memos'
import { sortMemos } from '../../shared/memos'
import { DeleteConfirmation } from './DeleteConfirmation'
import { MemoExportPopover } from './MemoExportPopover'
import type { MemoDrafts } from './memoDrafts'

const sorts: Record<MemoSort, string> = {
  modified: '최근 수정순',
  created: '생성일순',
  name: '이름순',
}
type Menu =
  | { kind: 'sort' }
  | { kind: 'memo' | 'export'; id: string }
  | { kind: 'delete'; id: string; revision: number }
export function MemoLibrary({
  onClose,
  onOpen,
  sort,
  onSort,
  drafts,
  onExportError,
}: {
  onClose: () => void
  onOpen: (id: string) => Promise<boolean>
  sort: MemoSort
  onSort: (sort: MemoSort) => Promise<boolean>
  drafts: MemoDrafts
  onExportError: (message: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    popup = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement | null>(null),
    input = useRef<HTMLInputElement>(null)
  const [entries, setEntries] = useState<MemoSummary[]>([]),
    [error, setError] = useState(''),
    [loaded, setLoaded] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null),
    [busy, setBusy] = useState(false)
  const [edit, setEdit] = useState<{ id: string | null; text: string } | null>(null)
  const committedEdit = useRef<typeof edit>(null)
  const composing = useRef(false),
    confirmingIME = useRef(false),
    imeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const saving = useRef(false),
    generation = useRef(0),
    alive = useRef(true)
  const closeMenu = (focus = false) => {
    popup.current?.hidePopover()
    setMenu(null)
    if (focus) trigger.current?.focus()
  }
  const refresh = async () => {
    const request = ++generation.current
    try {
      const result = await window.desktop.memoList()
      if (!alive.current || request !== generation.current) return
      if (result.status === 'ok') {
        setEntries(result.value)
        setLoaded(true)
      } else setError(result.message)
    } catch {
      if (alive.current) setError('메모 목록을 읽지 못했어요.')
    }
  }
  useEffect(() => {
    alive.current = true
    dialog.current?.showModal()
    void refresh()
    const unsubscribe = window.desktop.onMemoChanged((event) => {
      if (event.deleted)
        setMenu((current) =>
          current && 'id' in current && current.id === event.id ? null : current,
        )
      void refresh()
    })
    return () => {
      alive.current = false
      unsubscribe()
      clearTimeout(imeTimer.current)
    }
  }, [])
  useLayoutEffect(() => {
    if (edit) {
      input.current?.focus()
      input.current?.select()
    }
  }, [edit?.id, !!edit])
  const openMenu = (next: Menu, button: HTMLButtonElement) => {
    if (menu && JSON.stringify(next) === JSON.stringify(menu)) {
      closeMenu(true)
      return
    }
    trigger.current = button
    setError('')
    setMenu(next)
  }
  useLayoutEffect(() => {
    if (!menu) return
    const node = popup.current!
    node.showPopover()
    const position = () => {
      const anchor = trigger.current!.getBoundingClientRect(),
        bounds = dialog.current!.getBoundingClientRect(),
        box = node.getBoundingClientRect()
      node.style.left = `${Math.max(bounds.left + 8, anchor.right - box.width)}px`
      node.style.top = `${Math.max(bounds.top + 8, Math.min(anchor.bottom + 4, bounds.bottom - box.height - 8))}px`
    }
    position()
    node.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const observer = new ResizeObserver(position)
    observer.observe(node)
    observer.observe(dialog.current!)
    window.addEventListener('scroll', position, true)
    window.addEventListener('resize', position)
    return () => {
      if (node.matches(':popover-open')) node.hidePopover()
      observer.disconnect()
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('resize', position)
    }
  }, [menu?.kind, menu && 'id' in menu ? menu.id : null])
  // Keep the dismissing gesture guard alive through pointerdown -> click, even after the menu closes.
  useEffect(() => {
    let blocked: number | null = null
    const consume = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const down = (event: PointerEvent) => {
      blocked = null
      if (
        !popup.current?.matches(':popover-open') ||
        popup.current.contains(event.target as Node) ||
        trigger.current?.contains(event.target as Node)
      )
        return
      blocked = event.pointerId
      consume(event)
      closeMenu()
    }
    const up = (event: PointerEvent) => {
      if (blocked === event.pointerId) consume(event)
    }
    const click = (event: MouseEvent) => {
      if (blocked === null) return
      blocked = null
      if (event.detail) consume(event)
    }
    const reset = () => {
      blocked = null
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('click', click, true)
    window.addEventListener('pointercancel', reset, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('click', click, true)
      window.removeEventListener('pointercancel', reset, true)
      window.removeEventListener('blur', reset)
    }
  }, [])
  const commit = async (): Promise<boolean> => {
    if (!edit || edit === committedEdit.current || saving.current || composing.current) return false
    const title = input.current?.value ?? edit.text
    if (!title.trim()) {
      setError('제목을 입력해 주세요.')
      return false
    }
    saving.current = true
    setBusy(true)
    setError('')
    try {
      if (edit.id && !(await drafts.flush(edit.id))) {
        setError('본문 초안을 먼저 다시 저장해 주세요.')
        return false
      }
      const current = edit.id
        ? await window.desktop.memoLoad({ kind: 'standalone', id: edit.id })
        : null
      const result = !edit.id
        ? await window.desktop.memoCreate(title)
        : current?.status === 'ok'
          ? await window.desktop.memoRename({
              id: edit.id,
              revision: current.value.revision,
              title,
            })
          : current!
      if (!alive.current) return false
      if (result.status === 'error') {
        setError(result.message)
        return false
      }
      committedEdit.current = edit
      setEdit(null)
      await refresh()
      return true
    } catch {
      if (alive.current) setError('제목을 저장하지 못했어요. 입력을 유지하고 있어요.')
      return false
    } finally {
      saving.current = false
      if (alive.current) setBusy(false)
    }
  }
  const choose = async (id: string) => {
    if (edit || busy) {
      if (edit) void commit()
      return
    }
    setBusy(true)
    if (await onOpen(id)) onClose()
    else if (alive.current) {
      setBusy(false)
      setError('메모를 열지 못했어요. 다시 선택해 주세요.')
    }
  }
  const remove = async () => {
    if (menu?.kind !== 'delete' || saving.current) return
    const target = menu
    saving.current = true
    setBusy(true)
    setError('')
    try {
      const result = await window.desktop.memoDelete({ id: target.id, revision: target.revision })
      if (!alive.current) return
      if (result.status === 'error') setError(result.message)
      else {
        closeMenu()
        await refresh()
      }
    } catch {
      if (alive.current) setError('메모를 삭제하지 못했어요.')
    } finally {
      saving.current = false
      if (alive.current) setBusy(false)
    }
  }
  const keyboardMenu = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu(true)
    } else if (
      ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    ) {
      event.preventDefault()
      event.stopPropagation()
      const items = [
          ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
        ],
        index = items.indexOf(document.activeElement as HTMLButtonElement)
      items[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 1) + items.length) %
              items.length
      ]?.focus()
    }
  }
  return (
    <dialog
      ref={dialog}
      className="settings-dialog memo-dialog"
      aria-labelledby="memos-title"
      onCancel={onClose}
    >
      <div className="dialog-header">
        <h2 className="settings-title" id="memos-title">
          memos
        </h2>
        <button className="icon-button" aria-label="메모 목록 닫기" onClick={onClose}>
          <X size={19} />
        </button>
      </div>
      <div className="library-toolbar">
        <span className="muted" style={{ fontWeight: 400 }}>
          {loaded && !entries.length && !edit ? '+ 버튼으로 메모를 만들어 보세요.' : null}
        </span>
        <div className="library-toolbar-actions">
          <button
            className="button library-add library-sort"
            aria-label={`메모 정렬: ${sorts[sort]}`}
            title={`메모 정렬: ${sorts[sort]}`}
            aria-haspopup="menu"
            aria-expanded={menu?.kind === 'sort'}
            disabled={busy || !!edit}
            onClick={(e) => openMenu({ kind: 'sort' }, e.currentTarget)}
          >
            <ArrowDownWideNarrow size={16} />
          </button>
          <button
            className="button library-add"
            aria-label="새 메모"
            title="새 메모"
            disabled={busy}
            onClick={async () => {
              if (edit && !(await commit())) return
              closeMenu()
              setError('')
              setEdit({ id: null, text: '' })
            }}
          >
            <Plus size={17} />
          </button>
        </div>
      </div>
      {error && menu?.kind !== 'delete' && (
        <p className="memo-list-error" role="alert">
          {error}
        </p>
      )}
      <div className="memo-list">
        {!loaded && <p className="muted">메모를 읽는 중…</p>}
        {(edit?.id === null
          ? [
              {
                id: '',
                title: '',
                createdAt: 0,
                updatedAt: 0,
                revision: 0,
                documentId: null,
                page: null,
              },
              ...sortMemos(entries, sort),
            ]
          : sortMemos(entries, sort)
        ).map((entry) => (
          <article className="memo-row" key={entry.id} aria-label={entry.title || '새 메모'}>
            {edit && (edit.id ?? '') === entry.id ? (
              <span className="memo-title-editor">
                <input
                  ref={input}
                  className="memo-title-input"
                  aria-label="메모 제목"
                  value={edit.text}
                  disabled={busy}
                  maxLength={200}
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                  onCompositionStart={() => {
                    composing.current = true
                    confirmingIME.current = false
                    clearTimeout(imeTimer.current)
                  }}
                  onCompositionEnd={() => {
                    composing.current = false
                    confirmingIME.current = true
                    imeTimer.current = setTimeout(() => {
                      confirmingIME.current = false
                    }, 50)
                  }}
                  onKeyUp={(e) => {
                    if (e.key === 'Enter') {
                      confirmingIME.current = false
                      clearTimeout(imeTimer.current)
                    }
                  }}
                  onKeyDown={(e) => {
                    if (
                      e.nativeEvent.isComposing ||
                      e.nativeEvent.keyCode === 229 ||
                      composing.current ||
                      confirmingIME.current
                    )
                      return
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void commit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setEdit(null)
                      setError('')
                    }
                  }}
                  onBlur={() => {
                    if (!composing.current) void commit()
                  }}
                />
              </span>
            ) : (
              <button
                type="button"
                className="memo-row-open"
                title={entry.title}
                onClick={() => void choose(entry.id)}
                disabled={busy}
              >
                {entry.title}
              </button>
            )}
            {!!entry.updatedAt && (
              <time
                title={new Date(entry.updatedAt).toLocaleString('ko-KR')}
                dateTime={new Date(entry.updatedAt).toISOString()}
              >
                {new Date(entry.updatedAt).toLocaleDateString('ko-KR')}
              </time>
            )}
            {entry.id && (
              <button
                className="icon-button memo-row-menu"
                title="메모 메뉴"
                aria-label={`${entry.title} 메모 메뉴`}
                aria-haspopup="menu"
                disabled={busy || !!edit}
                onClick={(e) => openMenu({ kind: 'memo', id: entry.id }, e.currentTarget)}
              >
                <MoreVertical size={16} />
              </button>
            )}
          </article>
        ))}
      </div>
      {menu && (
        <div
          ref={popup}
          role="menu"
          aria-label={
            menu.kind === 'export'
              ? '메모 내보내기'
              : menu.kind === 'delete'
                ? '메모 삭제 확인'
                : '메모 목록 메뉴'
          }
          popover="manual"
          className={
            ['delete', 'export'].includes(menu.kind) ? 'chat-delete-popover' : 'library-popup'
          }
          onKeyDown={keyboardMenu}
        >
          {menu.kind === 'export' ? (
            <MemoExportPopover
              key={menu.id}
              target={{ kind: 'standalone', id: menu.id }}
              drafts={drafts}
              onClose={() => closeMenu(true)}
              onError={onExportError}
            />
          ) : menu.kind === 'sort' ? (
            (Object.keys(sorts) as MemoSort[]).map((value) => (
              <button
                key={value}
                role="menuitemradio"
                className="library-sort-option"
                aria-checked={sort === value}
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  if (await onSort(value)) closeMenu(true)
                  else setError('정렬 기준을 저장하지 못했어요.')
                  if (alive.current) setBusy(false)
                }}
              >
                <span>{sorts[value]}</span>
                {sort === value && <Check size={13} />}
              </button>
            ))
          ) : menu.kind === 'delete' ? (
            <DeleteConfirmation
              text="메모를 삭제하시겠습니까?"
              pending={busy}
              error={error}
              onCancel={() => closeMenu(true)}
              onConfirm={() => void remove()}
            />
          ) : (
            <>
              <button role="menuitem" onClick={() => setMenu({ kind: 'export', id: menu.id })}>
                메모 내보내기
              </button>
              <button
                role="menuitem"
                onClick={async () => {
                  const result = await window.desktop.memoLoad({ kind: 'standalone', id: menu.id })
                  if (!alive.current) return
                  if (result.status === 'ok') {
                    setMenu({ kind: 'delete', id: menu.id, revision: result.value.revision })
                    setError('')
                  } else setError(result.message)
                }}
              >
                메모 삭제
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  const entry = entries.find((e) => e.id === menu.id)
                  if (entry) {
                    closeMenu()
                    setEdit({ id: entry.id, text: entry.title })
                  }
                }}
              >
                메모 제목 변경
              </button>
            </>
          )}
        </div>
      )}
    </dialog>
  )
}
