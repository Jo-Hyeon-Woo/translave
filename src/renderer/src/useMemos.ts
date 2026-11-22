import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { DEFAULT_MEMO_PREFERENCES } from '../../shared/memos'
import type { MemoPreferences, MemoTarget } from '../../shared/memos'
import { MemoDrafts, memoKey } from './memoDrafts'
import type { MemoEditorMemory } from './MemoEditor'

export function useMemos(documentId: string | null, page: number, active: boolean) {
  const [session] = useState(() => new MemoDrafts(window.desktop))
  const editorMemory = useRef<MemoEditorMemory>(new Map()).current
  useSyncExternalStore(session.subscribe, session.snapshot)
  const [preferences, setPreferences] = useState<MemoPreferences>(DEFAULT_MEMO_PREFERENCES)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const current = useRef(preferences)
  current.current = preferences
  const chain = useRef(Promise.resolve())
  useEffect(() => {
    let alive = true
    void window.desktop
      .memoPreferences()
      .then((result) => {
        if (!alive) return
        if (result.status === 'ok') {
          current.current = result.value
          setPreferences(result.value)
          setReady(true)
        } else setError(result.message)
      })
      .catch(() => {
        if (alive) setError('메모 설정을 읽지 못했어요.')
      })
    const unsubscribe = window.desktop.onMemoChanged((event) => {
      if (event.deleted) editorMemory.delete(event.id)
      void session.changed(event.id, event.deleted).catch(() => {})
      if (
        event.deleted &&
        current.current.selection.kind === 'standalone' &&
        current.current.selection.id === event.id
      ) {
        current.current = { ...current.current, selection: { kind: 'standalone', id: null } }
        setPreferences(current.current)
      }
    })
    const unsubscribeDeletion = window.desktop.onLibraryDeleted(({ documentIds, memoIds }) => {
      memoIds.forEach((id) => editorMemory.delete(id))
      session.removeDocuments(documentIds)
    })
    return () => {
      alive = false
      unsubscribe()
      unsubscribeDeletion()
    }
  }, [session])
  const change = (patch: Partial<MemoPreferences>): Promise<boolean> => {
    let success = false
    const operation = chain.current
      .then(async () => {
        const result = await window.desktop.memoPreferences({ ...current.current, ...patch })
        if (result.status === 'ok') {
          current.current = result.value
          setPreferences(result.value)
          setError('')
          success = true
        } else setError(result.message)
      })
      .catch(() => setError('메모 설정을 저장하지 못했어요.'))
    chain.current = operation
    return operation.then(() => success)
  }
  const reloadPreferences = async () => {
    try {
      const result = await window.desktop.memoPreferences()
      if (result.status === 'ok') {
        current.current = result.value
        setPreferences(result.value)
        setReady(true)
        setError('')
      } else setError(result.message)
    } catch {
      setError('메모 설정을 읽지 못했어요.')
    }
  }
  const target: MemoTarget | null =
    preferences.selection.kind === 'page'
      ? documentId
        ? { kind: 'page', documentId, page }
        : null
      : preferences.selection.id
        ? { kind: 'standalone', id: preferences.selection.id }
        : null
  const key = target ? memoKey(target) : ''
  useEffect(() => {
    if (ready && active && target) void session.open(target)
  }, [ready, active, key, session])
  return {
    editorMemory,
    session,
    preferences,
    change,
    reloadPreferences,
    ready,
    error,
    target,
    key,
    entry: session.entries.get(key),
  }
}
