import { useCallback, useEffect, useLayoutEffect, useId, useRef, useState } from 'react'
import {
  FileText,
  Folder,
  House,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
  Plus,
  MoreVertical,
  X,
  Check,
} from 'lucide-react'
import type {
  LibraryDocument,
  LibraryFolder,
  LibraryChange,
  LibrarySort,
} from '../../shared/contracts'
import {
  LIBRARY_SORTS,
  DEFAULT_LIBRARY_SORT,
  validLibrarySort,
  sortLibraryDocuments,
} from '../../shared/contracts'
import { loadPdf } from './pdf'
import { saveLibraryDocument } from './library'
import { DeleteConfirmation } from './DeleteConfirmation'

const labels = {
  complete: '번역 완료',
  translating: '번역 중',
  stopped: '중단됨',
  waiting: '대기 중',
}

function folderPath(id: string | null, folders: LibraryFolder[]) {
  const path: LibraryFolder[] = [],
    seen = new Set<string>()
  while (id !== null && !seen.has(id)) {
    seen.add(id)
    const folder = folders.find((f) => f.id === id)
    if (!folder) break
    path.unshift(folder)
    id = folder.parentId
  }
  return path
}
function FolderPath({
  id,
  folders,
  onNavigate,
  disabled,
  label,
}: {
  id: string | null
  folders: LibraryFolder[]
  onNavigate: (id: string | null) => void
  disabled: boolean
  label: string
}) {
  const path = useRef<HTMLElement>(null)
  useEffect(() => {
    const node = path.current
    if (!node) return
    // The current location is always last. Keep its end gutter visible after
    // navigation/resize without scrolling the dialog or the PDF behind it.
    const revealCurrent = () => {
      node.scrollLeft = node.scrollWidth
    }
    revealCurrent()
    const observer = new ResizeObserver(revealCurrent)
    observer.observe(node)
    return () => observer.disconnect()
  }, [id])
  return (
    <nav ref={path} className="library-path" aria-label={label}>
      <button
        type="button"
        className="text-button library-root"
        aria-label="최상위"
        title="최상위"
        disabled={disabled}
        onClick={() => onNavigate(null)}
        aria-current={id === null ? 'page' : undefined}
      >
        <House size={16} aria-hidden="true" />
        <span>Home</span>
      </button>
      {folderPath(id, folders).map((f) => (
        <span key={f.id} className="library-path-part">
          <ChevronRight size={13} aria-hidden="true" />
          <button
            type="button"
            className="text-button"
            disabled={disabled}
            title={f.name}
            aria-current={id === f.id ? 'page' : undefined}
            onClick={() => onNavigate(f.id)}
          >
            {f.name}
          </button>
        </span>
      ))}
    </nav>
  )
}
type Editor =
  | { kind: 'create'; parentId: string | null }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'moveFolder' | 'moveDocument'; id: string; name: string }
type Menu =
  { kind: 'add' | 'sort' } | { kind: 'folder' | 'document'; id: string; confirm?: boolean }

export function FileLibrary({
  onClose,
  onOpen,
  error,
  onError,
}: {
  onClose: () => void
  onOpen: (id: string, resume: boolean) => Promise<void>
  error: string
  onError: (message: string) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [entries, setEntries] = useState<LibraryDocument[]>([])
  const [folders, setFolders] = useState<LibraryFolder[]>([])
  const [folderId, setFolderId] = useState<string | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [name, setName] = useState('')
  const [destination, setDestination] = useState<string | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const nameInput = useRef<HTMLInputElement>(null)
  const finishedEditor = useRef<Editor | null>(null)
  const commitName = useRef<() => void>(() => {})
  const composing = useRef(false)
  const confirmingIME = useRef(false)
  const imeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editorOpener = useRef<HTMLButtonElement | null>(null)
  const restoreFocus = useRef(false)
  const saving = useRef(false)
  const mounted = useRef(false)
  const request = useRef(0)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const deletePending = useRef(false)
  const [sort, setSort] = useState<LibrarySort>(DEFAULT_LIBRARY_SORT)
  const [sortReady, setSortReady] = useState(false)
  const sortSaving = useRef(false)
  const menuId = useId()
  const menuPanel = useRef<HTMLDivElement>(null)
  const menuTrigger = useRef<HTMLButtonElement | null>(null)
  const menuFromEnd = useRef(false)
  const closeMenu = useCallback((focus = false) => {
    if (deletePending.current) return
    setMenu(null)
    setDeleteError('')
    if (focus) menuTrigger.current?.focus()
  }, [])
  const menuFolder = menu?.kind === 'folder' ? folders.find((f) => f.id === menu.id) : undefined
  const menuDocument = menu?.kind === 'document' ? entries.find((d) => d.id === menu.id) : undefined
  // Polling returns new objects even when nothing changed. Only close stale menus
  // when their owner/available actions actually change, not on every refresh.
  const menuVersion = JSON.stringify(
    menuFolder
      ? [menuFolder.id, menuFolder.name, menuFolder.parentId]
      : menuDocument
        ? [
            menuDocument.id,
            menuDocument.name,
            menuDocument.folderId,
            ...('confirm' in menu! && menu!.confirm
              ? []
              : [
                  menuDocument.status,
                  menuDocument.done,
                  menuDocument.total,
                  menuDocument.failed,
                  menuDocument.skipped,
                ]),
          ]
        : null,
  )
  const previousMenu = useRef({ menu, version: menuVersion })
  useEffect(() => {
    if (previousMenu.current.menu === menu && previousMenu.current.version !== menuVersion)
      closeMenu()
    previousMenu.current = { menu, version: menuVersion }
  }, [menu, menuVersion, closeMenu])
  useEffect(() => closeMenu(), [folderId, editor, busy, closeMenu])
  useLayoutEffect(() => {
    const panel = menuPanel.current,
      trigger = menuTrigger.current
    if (!menu || !panel || !trigger) return
    panel.showPopover()
    const position = () => {
      const anchor = trigger.getBoundingClientRect(),
        bounds = dialog.current!.getBoundingClientRect()
      panel.style.maxWidth = `${Math.max(0, bounds.width - 24)}px`
      const box = panel.getBoundingClientRect()
      panel.style.left = `${Math.max(bounds.left + 12, Math.min(anchor.right - box.width, bounds.right - box.width - 12))}px`
      panel.style.top = `${
        anchor.bottom + 4 + box.height <= bounds.bottom - 8
          ? anchor.bottom + 4
          : Math.max(bounds.top + 8, anchor.top - box.height - 4)
      }px`
    }
    position()
    const items = panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')
    items[menuFromEnd.current ? items.length - 1 : 0]?.focus()
    // Top-layer popover avoids clipping by the independently scrolling list.
    const list = dialog.current?.querySelector('.library-list')
    list?.addEventListener('scroll', position)
    window.addEventListener('resize', position)
    return () => {
      if (panel.matches(':popover-open')) panel.hidePopover()
      list?.removeEventListener('scroll', position)
      window.removeEventListener('resize', position)
    }
  }, [menu, deleteError, closeMenu])
  useEffect(() => {
    let dismissedPointer: number | null = null
    const consume = (event: Event) => {
      event.preventDefault()
      event.stopImmediatePropagation()
    }
    const outside = (event: PointerEvent) => {
      // A new gesture can never inherit a canceled gesture's click guard.
      dismissedPointer = null
      if (
        nameInput.current &&
        dialog.current?.contains(event.target as Node) &&
        event.target !== nameInput.current
      ) {
        dismissedPointer = event.pointerId
        if (composing.current) return
        consume(event)
        commitName.current()
        return
      }
      const panel = menuPanel.current
      if (
        !panel?.matches(':popover-open') ||
        panel.contains(event.target as Node) ||
        menuTrigger.current?.contains(event.target as Node)
      )
        return
      dismissedPointer = event.pointerId
      consume(event)
      closeMenu(true)
    }
    const pointerUp = (event: PointerEvent) => {
      if (event.pointerId === dismissedPointer) consume(event)
    }
    const click = (event: MouseEvent) => {
      if (dismissedPointer === null) return
      const id = (event as PointerEvent).pointerId
      if (event.detail === 0) {
        dismissedPointer = null
        return
      }
      if (id !== undefined && id !== dismissedPointer) return
      dismissedPointer = null
      consume(event)
    }
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === dismissedPointer) dismissedPointer = null
    }
    const blur = () => {
      dismissedPointer = null
    }
    // This guard belongs to the dialog lifetime, not the menu effect: the menu
    // unmounts at pointerdown, but the same gesture's click must still be eaten.
    window.addEventListener('pointerdown', outside, true)
    window.addEventListener('pointerup', pointerUp, true)
    window.addEventListener('click', click, true)
    window.addEventListener('auxclick', click, true)
    window.addEventListener('pointercancel', cancel, true)
    window.addEventListener('blur', blur)
    return () => {
      dismissedPointer = null
      window.removeEventListener('pointerdown', outside, true)
      window.removeEventListener('pointerup', pointerUp, true)
      window.removeEventListener('click', click, true)
      window.removeEventListener('auxclick', click, true)
      window.removeEventListener('pointercancel', cancel, true)
      window.removeEventListener('blur', blur)
    }
  }, [closeMenu])
  const toggleMenu = (value: Menu, button: HTMLButtonElement, fromEnd = false) => {
    if (deletePending.current) return
    setDeleteError('')
    menuFromEnd.current = fromEnd
    menuTrigger.current = button
    setMenu((current) =>
      current?.kind === value.kind &&
      (!('id' in value) || ('id' in current && current.id === value.id))
        ? null
        : value,
    )
  }
  const menuButton = (value: Menu, label: string) => (
    <button
      type="button"
      className={
        value.kind === 'add' || value.kind === 'sort'
          ? `button library-add${value.kind === 'sort' ? ' library-sort' : ''}`
          : 'icon-button library-menu-trigger'
      }
      aria-label={label}
      title={label}
      aria-haspopup="menu"
      aria-controls={menuId}
      aria-expanded={
        menu?.kind === value.kind && (!('id' in value) || ('id' in menu && menu.id === value.id))
      }
      disabled={busy || deleting || (value.kind === 'sort' && !sortReady)}
      onClick={(event) => toggleMenu(value, event.currentTarget)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          toggleMenu(value, event.currentTarget, event.key === 'ArrowUp')
        }
      }}
    >
      {value.kind === 'add' ? (
        <Plus size={16} />
      ) : value.kind === 'sort' ? (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h10M3 12h7M3 18h4M19 5v14m-3-3 3 3 3-3" />
        </svg>
      ) : (
        <MoreVertical size={18} />
      )}
    </button>
  )
  const refresh = useCallback(async () => {
    const sequence = ++request.current
    const result = await window.desktop.librarySnapshot()
    if (mounted.current && sequence === request.current) {
      setEntries(result.documents)
      setFolders(result.folders)
      setLoaded(true)
    }
  }, [])
  useEffect(() => {
    dialog.current?.showModal()
    mounted.current = true
    let disposed = false
    let sortLoaded = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        if (!sortLoaded) {
          const stored = await window.desktop.librarySortSettings()
          if (disposed) return
          setSort(validLibrarySort(stored) ? stored : DEFAULT_LIBRARY_SORT)
          setSortReady(true)
          sortLoaded = true
        }
        await refresh()
      } catch {
        if (!disposed)
          onError('파일 목록을 불러오지 못했어요. 저장 폴더의 접근 권한을 확인해 주세요.')
      } finally {
        if (!disposed) timer = setTimeout(poll, 600)
      }
    }
    void poll()
    return () => {
      disposed = true
      mounted.current = false
      request.current++
      clearTimeout(timer)
      clearTimeout(imeTimer.current)
    }
  }, [onError, refresh])
  useEffect(() => {
    if (!busy)
      (
        nameInput.current ?? form.current?.querySelector<HTMLElement>('[data-initial-focus]')
      )?.focus()
  }, [editor, busy])
  useLayoutEffect(() => {
    nameInput.current?.focus()
    nameInput.current?.select()
  }, [editor])
  useEffect(() => {
    if (editor || busy || !restoreFocus.current) return
    restoreFocus.current = false
    const target = editorOpener.current
    if (target?.isConnected) target.focus()
    else dialog.current?.querySelector<HTMLElement>('.library-path button')?.focus()
  }, [editor, busy])
  const begin = (value: Editor) => {
    editorOpener.current = menuTrigger.current
    closeMenu()
    setEditor(value)
    setName(value.kind === 'rename' ? value.name : '')
    setDestination(null)
    composing.current = false
    confirmingIME.current = false
    clearTimeout(imeTimer.current)
    onError('')
  }
  const endEditor = () => {
    finishedEditor.current = editor
    restoreFocus.current = true
    setEditor(null)
    onError('')
  }
  const save = async () => {
    if (!editor || editor === finishedEditor.current || busy || saving.current || composing.current)
      return
    saving.current = true
    const change: LibraryChange =
      editor.kind === 'create'
        ? { kind: 'create', parentId: editor.parentId, name: nameInput.current?.value ?? name }
        : editor.kind === 'rename'
          ? { kind: 'rename', id: editor.id, name: nameInput.current?.value ?? name }
          : editor.kind === 'moveFolder'
            ? { kind: 'moveFolder', id: editor.id, parentId: destination }
            : { kind: 'moveDocument', id: editor.id, folderId: destination }
    setBusy(true)
    request.current++
    onError('')
    try {
      const result = await window.desktop.changeLibrary(change)
      if (!mounted.current) return
      if (result.status === 'error') {
        onError(result.message)
        return
      }
      endEditor()
      try {
        await refresh()
      } catch {
        onError('변경은 저장했지만 목록을 갱신하지 못했어요. 파일 창을 다시 열어 주세요.')
      }
    } catch {
      onError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.')
    } finally {
      saving.current = false
      setBusy(false)
    }
  }
  commitName.current = () => {
    void save()
  }
  const blockedDestination = (id: string) =>
    editor?.kind === 'moveFolder' && folderPath(id, folders).some((f) => f.id === editor.id)
  const documents = sortLibraryDocuments(
    entries.filter((entry) => entry.folderId === folderId),
    sort,
  )
  const children = folders.filter((folder) => folder.parentId === folderId)
  const visibleFolders =
    editor?.kind === 'create'
      ? [{ id: '', parentId: editor.parentId, name: '' }, ...children]
      : children
  const itemCounts = new Map<string, number>()
  for (const folder of folders)
    if (folder.parentId !== null)
      itemCounts.set(folder.parentId, (itemCounts.get(folder.parentId) ?? 0) + 1)
  for (const entry of entries)
    if (entry.folderId !== null)
      itemCounts.set(entry.folderId, (itemCounts.get(entry.folderId) ?? 0) + 1)
  const applySort = async (next: LibrarySort) => {
    if (busy || sortSaving.current) return
    if (next === sort) {
      closeMenu(true)
      return
    }
    sortSaving.current = true
    setBusy(true)
    request.current++
    onError('')
    closeMenu(true)
    try {
      const result = await window.desktop.configureLibrarySort(next)
      if (!mounted.current) return
      if (result.status === 'saved') setSort(result.sort)
      else onError(result.message)
    } catch {
      if (mounted.current) onError('정렬 기준을 저장하지 못했어요. 다시 시도해 주세요.')
    } finally {
      sortSaving.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const add = async () => {
    const targetFolder = folderId
    setBusy(true)
    setAdding(true)
    request.current++
    onError('')
    let task: ReturnType<typeof loadPdf> | undefined
    let importedId: string | undefined
    try {
      const result = await window.desktop.openPdf()
      if (result.status === 'canceled') return
      if (result.status === 'error') {
        onError(result.message)
        return
      }
      importedId = result.document.id
      task = loadPdf(result.document.bytes)
      const pdf = await task.promise
      await pdf.getPage(1)
      await saveLibraryDocument(result.document.id, pdf, targetFolder)
      await refresh()
    } catch (cause) {
      onError(
        cause instanceof Error && cause.name === 'LibrarySaveError'
          ? cause.message
          : cause instanceof Error && cause.name === 'PasswordException'
            ? '암호로 보호된 PDF는 아직 지원하지 않아요. 암호가 해제된 파일을 선택해 주세요.'
            : 'PDF를 열 수 없어요. 파일 형식이나 저장 폴더의 접근 권한을 확인해 주세요.',
      )
    } finally {
      await task?.destroy()
      if (importedId && !(await window.desktop.discardPdfAddition(importedId).catch(() => false)))
        onError('임시 변환 PDF를 정리하지 못했어요. 다음 시작 때 다시 정리합니다.')
      setBusy(false)
      setAdding(false)
    }
  }
  const open = async (id: string, resume = false) => {
    setBusy(true)
    try {
      await onOpen(id, resume)
    } finally {
      setBusy(false)
    }
  }
  const confirmDelete = async () => {
    if (!menu || !('id' in menu) || !menu.confirm || deletePending.current) return
    const target = { kind: menu.kind, id: menu.id }
    deletePending.current = true
    setDeleting(true)
    setDeleteError('')
    try {
      const result = await window.desktop.deleteLibrary(target)
      if (!mounted.current) return
      if (result.status === 'error') setDeleteError(result.message)
      else {
        if (result.warning) onError(result.warning)
        deletePending.current = false
        closeMenu()
        const removed = new Set(result.deletion.folderIds)
        setFolderId((current) =>
          current && removed.has(current)
            ? (folderPath(current, folders)
                .reverse()
                .find((folder) => !removed.has(folder.id))?.id ?? null)
            : current,
        )
        await refresh()
      }
    } catch {
      if (mounted.current) setDeleteError('삭제하지 못했어요. 다시 시도해 주세요.')
    } finally {
      deletePending.current = false
      if (mounted.current) setDeleting(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      className="file-dialog"
      aria-labelledby="file-library-title"
      onCancel={(event) => {
        if (busy || deleting) event.preventDefault()
        else if (menu) {
          event.preventDefault()
          closeMenu(true)
        } else if (editor) {
          event.preventDefault()
          endEditor()
        } else onClose()
      }}
    >
      <div className="dialog-header">
        <h2 id="file-library-title" className="files-title">
          files
        </h2>
        <button
          className="icon-button"
          aria-label="파일 목록 닫기"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="library-toolbar">
        <button
          type="button"
          className="icon-button library-up"
          title="상위 폴더로"
          aria-label="상위 폴더로"
          disabled={busy || folderId === null}
          onClick={() => {
            setFolderId(folders.find((f) => f.id === folderId)?.parentId ?? null)
            setEditor(null)
            onError('')
          }}
        >
          <ChevronLeft size={16} />
        </button>
        <div className="library-toolbar-actions">
          {menuButton({ kind: 'sort' }, `정렬 기준: ${LIBRARY_SORTS[sort]}`)}
          {menuButton({ kind: 'add' }, '파일 또는 폴더 추가')}
        </div>
      </div>
      {editor && (editor.kind === 'moveFolder' || editor.kind === 'moveDocument') && (
        <form
          ref={form}
          className="library-editor"
          aria-label="이동 위치 선택"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <h3>이동 위치 선택</h3>
          <p className="library-move-name" title={editor.name}>
            {editor.name}
          </p>
          <FolderPath
            id={destination}
            folders={folders}
            disabled={busy}
            label="이동 경로"
            onNavigate={setDestination}
          />
          <div className="library-destinations" aria-label="이동 가능한 하위 폴더">
            {folders
              .filter((f) => f.parentId === destination && !blockedDestination(f.id))
              .map((f) => (
                <button
                  type="button"
                  className="button library-destination"
                  key={f.id}
                  title={f.name}
                  disabled={busy}
                  onClick={() => setDestination(f.id)}
                >
                  <Folder size={16} aria-hidden="true" />
                  <span>{f.name}</span>
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              ))}
            {!folders.some((f) => f.parentId === destination && !blockedDestination(f.id)) && (
              <p>하위 폴더가 없어요. 이 위치로 이동할 수 있어요.</p>
            )}
          </div>
          <div className="library-editor-actions">
            <button type="submit" className="button" disabled={busy} data-initial-focus>
              이 위치로 이동
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={endEditor}
            >
              취소
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="library-error" id="library-name-error" role="alert">
          {error}
        </p>
      )}
      <div className="library-list" aria-label="PDF 목록">
        {adding && (
          <p className="library-empty" role="status">
            자료를 가져오는 중이에요. PPT/PPTX는 PDF로 변환합니다.
          </p>
        )}
        {!loaded && !error && <p className="library-empty">파일 목록을 불러오는 중이에요.</p>}
        {loaded && !adding && documents.length === 0 && visibleFolders.length === 0 && (
          <div className="library-empty">
            <FileText size={32} />
            <h3>{folderId === null ? '읽을 문서를 모아두세요' : '빈 폴더예요'}</h3>
            <p>오른쪽 위 + 버튼으로 PDF·PPT·PPTX를 추가해 주세요.</p>
          </div>
        )}
        {visibleFolders.map((folder) => {
          const editing =
            editor?.kind === 'create'
              ? folder.id === ''
              : editor?.kind === 'rename' && editor.id === folder.id
          const contents = (
            <>
              <span className="library-thumbnail library-folder-icon">
                <Folder size={27} aria-hidden="true" />
              </span>
              <span className="library-description">
                {editing ? (
                  <span className="library-title library-title-editor">
                    <span aria-hidden="true">{folder.name || '폴더 이름'}</span>
                    <input
                      ref={nameInput}
                      className="library-title library-title-input"
                      aria-label="폴더 이름"
                      aria-invalid={!!error}
                      aria-describedby={error ? 'library-name-error' : undefined}
                      value={name}
                      disabled={busy}
                      maxLength={200}
                      onChange={(event) => setName(event.target.value)}
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
                      onKeyUp={(event) => {
                        if (event.key === 'Enter') {
                          confirmingIME.current = false
                          clearTimeout(imeTimer.current)
                        }
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.nativeEvent.isComposing ||
                          event.nativeEvent.keyCode === 229 ||
                          composing.current ||
                          confirmingIME.current
                        )
                          return
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          if (!event.repeat) void save()
                        } else if (event.key === 'Escape') {
                          event.preventDefault()
                          event.stopPropagation()
                          endEditor()
                        }
                      }}
                      onBlur={() => {
                        if (!composing.current) void save()
                      }}
                    />
                  </span>
                ) : (
                  <span className="library-title">{folder.name}</span>
                )}
                <span className="library-metadata">{itemCounts.get(folder.id) ?? 0}개 항목</span>
              </span>
            </>
          )
          return (
            <article
              className="library-row library-folder"
              key={folder.id}
              aria-label={folder.id ? `폴더 ${folder.name}` : '새 폴더'}
            >
              {editing ? (
                <div className="library-entry-open library-entry-edit">{contents}</div>
              ) : (
                <button
                  type="button"
                  className="library-entry-open"
                  title={folder.name}
                  aria-label={`${folder.name} 폴더 열기`}
                  disabled={busy}
                  onClick={() => {
                    setFolderId(folder.id)
                    setEditor(null)
                    onError('')
                  }}
                >
                  {contents}
                </button>
              )}
              {folder.id ? (
                menuButton({ kind: 'folder', id: folder.id }, `${folder.name} 폴더 메뉴`)
              ) : (
                <span className="icon-button library-menu-trigger" aria-hidden="true" />
              )}
            </article>
          )
        })}
        {documents.map((entry) => (
          <article
            className="library-row"
            key={entry.id}
            data-testid="library-row"
            aria-label={entry.name}
          >
            <button
              type="button"
              className="library-entry-open"
              title={entry.name}
              aria-label={`${entry.name} 열기`}
              disabled={busy}
              onClick={() => void open(entry.id)}
            >
              <span className="library-thumbnail">
                {entry.thumbnail ? (
                  <img src={entry.thumbnail} alt={`${entry.name} 첫 페이지`} />
                ) : (
                  <FileText size={27} aria-hidden="true" />
                )}
              </span>
              <span className="library-description">
                <span className="library-title">{entry.name}</span>
                <span className="library-metadata">
                  {entry.total}페이지 ·{' '}
                  {entry.lastOpened === null
                    ? '아직 열지 않음'
                    : `최근 열람 ${new Date(entry.lastOpened).toLocaleDateString('ko-KR')}`}
                </span>
              </span>
            </button>
            <div className="library-progress">
              <div className="library-progress-heading">
                <span className="library-count">
                  {entry.done}/{entry.total}
                </span>
                <span className={`library-state ${entry.status}`}>
                  <span>
                    {entry.status === 'stopped' && entry.failed > 0
                      ? `실패 ${entry.failed}`
                      : labels[entry.status]}
                  </span>
                  {entry.status === 'translating' && (
                    <LoaderCircle size={14} className="spin" aria-label="번역 진행 중" />
                  )}
                </span>
              </div>
              <progress
                aria-label={`${entry.name} 번역 진행률`}
                value={entry.done + entry.skipped}
                max={entry.total}
              />
            </div>
            {menuButton({ kind: 'document', id: entry.id }, `${entry.name} 파일 메뉴`)}
          </article>
        ))}
      </div>
      <div className="library-footer">
        <FolderPath
          id={folderId}
          folders={folders}
          disabled={busy}
          label="폴더 경로"
          onNavigate={(id) => {
            setFolderId(id)
            setEditor(null)
            onError('')
          }}
        />
      </div>
      {menu && (
        <div
          ref={menuPanel}
          id={menuId}
          role="menu"
          aria-label={menu && 'confirm' in menu && menu.confirm ? '파일 삭제 확인' : '파일 창 메뉴'}
          className={
            menu && 'confirm' in menu && menu.confirm ? 'chat-delete-popover' : 'library-popup'
          }
          popover="manual"
          onKeyDown={(event) => {
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            )
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? items.length - 1
                    : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
              items[next]?.focus()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeMenu(true)
            } else if (event.key === 'Tab') closeMenu(true)
          }}
        >
          {'confirm' in menu && menu.confirm ? (
            <DeleteConfirmation
              text={
                menu.kind === 'folder'
                  ? '폴더와 내부 파일·하위 폴더를 모두 삭제하시겠습니까?'
                  : '앱에서 파일과 연결된 기록을 삭제하시겠습니까?'
              }
              pending={deleting}
              error={deleteError}
              onCancel={() => closeMenu(true)}
              onConfirm={() => void confirmDelete()}
            />
          ) : menu.kind === 'sort' ? (
            (Object.keys(LIBRARY_SORTS) as LibrarySort[]).map((value) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                tabIndex={-1}
                aria-checked={sort === value}
                className="library-sort-option"
                onClick={() => void applySort(value)}
              >
                <span>{LIBRARY_SORTS[value]}</span>
                <Check
                  size={14}
                  aria-hidden="true"
                  style={{ visibility: sort === value ? 'visible' : 'hidden' }}
                />
              </button>
            ))
          ) : menu.kind === 'add' ? (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  closeMenu(true)
                  void add()
                }}
              >
                파일
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => begin({ kind: 'create', parentId: folderId })}
              >
                폴더
              </button>
            </>
          ) : menuFolder ? (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => begin({ kind: 'rename', id: menuFolder.id, name: menuFolder.name })}
              >
                폴더 이름 변경
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() =>
                  begin({ kind: 'moveFolder', id: menuFolder.id, name: menuFolder.name })
                }
              >
                폴더 위치 이동
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setDeleteError('')
                  setMenu({ kind: 'folder', id: menuFolder.id, confirm: true })
                }}
              >
                폴더 삭제
              </button>
            </>
          ) : menuDocument ? (
            <>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() =>
                  begin({ kind: 'moveDocument', id: menuDocument.id, name: menuDocument.name })
                }
              >
                파일 위치 이동
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                disabled={menuDocument.status !== 'stopped' || menuDocument.failed === 0}
                onClick={() => {
                  closeMenu(true)
                  void open(menuDocument.id, true)
                }}
              >
                실패한 페이지 재번역
              </button>
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={() => {
                  setDeleteError('')
                  setMenu({ kind: 'document', id: menuDocument.id, confirm: true })
                }}
              >
                파일 삭제
              </button>
            </>
          ) : null}
        </div>
      )}
    </dialog>
  )
}
