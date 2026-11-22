import type { Memo, MemoAPI, MemoTarget } from '../../shared/memos'
export interface MemoDraft {
  documentId?: string
  memo?: Memo
  body: string
  loading: boolean
  saving: boolean
  error: string
  deleted: boolean
  work?: Promise<void>
}
export const memoKey = (target: MemoTarget) =>
  target.kind === 'page' ? JSON.stringify([target.documentId, target.page]) : target.id
// One owner/serialized write chain per memo. A late response never sets another draft's text.
export class MemoDrafts {
  entries = new Map<string, MemoDraft>()
  private listeners = new Set<() => void>()
  private version = 0
  constructor(private api: Pick<MemoAPI, 'memoLoad' | 'memoSave'>) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.version
  private notify() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }
  async open(target: MemoTarget) {
    const key = memoKey(target)
    if (this.entries.has(key)) return
    const entry: MemoDraft = {
      documentId: target.kind === 'page' ? target.documentId : undefined,
      body: '',
      loading: true,
      saving: false,
      error: '',
      deleted: false,
    }
    this.entries.set(key, entry)
    this.notify()
    try {
      const result = await this.api.memoLoad(target)
      if (entry.deleted) return
      if (result.status === 'ok') {
        entry.memo = result.value
        entry.body = result.value.body
      } else entry.error = result.message
    } catch {
      entry.error = '메모를 읽지 못했어요. 다시 시도해 주세요.'
    } finally {
      entry.loading = false
      this.notify()
    }
  }
  edit(key: string, body: string) {
    const entry = this.entries.get(key)
    if (!entry?.memo || entry.deleted) return
    entry.body = body
    this.notify()
    if (!entry.error) void this.save(entry)
  }
  retry(key: string, target: MemoTarget) {
    const entry = this.entries.get(key)
    if (!entry?.memo) {
      this.entries.delete(key)
      return this.open(target)
    }
    entry.error = ''
    return this.save(entry)
  }
  private save(entry: MemoDraft): Promise<void> {
    if (entry.work) return entry.work
    if (!entry.memo || entry.deleted || entry.body === entry.memo.body) return Promise.resolve()
    entry.saving = true
    this.notify()
    entry.work = (async () => {
      try {
        while (entry.memo && !entry.deleted && entry.body !== entry.memo.body) {
          const body = entry.body
          const result = await this.api.memoSave({
            id: entry.memo.id,
            revision: entry.memo.revision,
            body,
          })
          if (entry.deleted) return
          if (result.status === 'error') {
            entry.error = result.message
            if (result.current) entry.memo = result.current
            return
          }
          entry.memo = result.value
        }
      } catch {
        if (!entry.deleted) entry.error = '메모를 저장하지 못했어요. 초안을 유지하고 있어요.'
      } finally {
        entry.saving = false
        entry.work = undefined
        this.notify()
      }
    })()
    return entry.work
  }
  async flush(id: string): Promise<boolean> {
    const entry = [...this.entries.values()].find((e) => e.memo?.id === id)
    if (!entry) return true
    if (entry.error) return false
    await this.save(entry)
    return !entry.error && !entry.deleted
  }
  async changed(id: string, deleted: boolean) {
    for (const entry of this.entries.values()) {
      if (entry.memo?.id !== id) continue
      if (deleted) {
        entry.deleted = true
        entry.body = ''
        entry.memo = undefined
        entry.error = ''
      } else if (!entry.saving) {
        const result = await this.api.memoLoad(
          entry.memo.documentId
            ? { kind: 'page', documentId: entry.memo.documentId, page: entry.memo.page! }
            : { kind: 'standalone', id },
        )
        if (
          result.status === 'ok' &&
          !entry.deleted &&
          result.value.revision >= (entry.memo?.revision ?? 0)
        ) {
          const clean = entry.body === entry.memo?.body
          entry.memo = result.value
          if (clean) entry.body = result.value.body
        }
      }
    }
    this.notify()
  }
  removeDocuments(ids: readonly string[]) {
    for (const [key, entry] of this.entries) {
      if (!entry.documentId || !ids.includes(entry.documentId)) continue
      entry.deleted = true
      entry.body = ''
      entry.memo = undefined
      this.entries.delete(key)
    }
    this.notify()
  }
}
