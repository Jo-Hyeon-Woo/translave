export type MemoTarget =
  { kind: 'page'; documentId: string; page: number } | { kind: 'standalone'; id: string }
export type MemoSelection = { kind: 'page' } | { kind: 'standalone'; id: string | null }
export type MemoMode = 'preview' | 'source'
export type MemoSort = 'modified' | 'created' | 'name'
export type MemoExportScope = 'single' | 'document'
export type MemoExportFormat = 'pdf' | 'md'
export interface MemoExportInput {
  target: MemoTarget
  scope: MemoExportScope
  format: MemoExportFormat
  drafts: { id: string; body: string }[]
}
export interface MemoExportSnapshot {
  title: string
  sections: { id: string; page: number | null; body: string }[]
}
export type MemoExportResult =
  { status: 'saved' | 'canceled' } | { status: 'error'; message: string }
export interface MemoPreferences {
  selection: MemoSelection
  mode: MemoMode
  sort: MemoSort
}
export const DEFAULT_MEMO_PREFERENCES: MemoPreferences = {
  selection: { kind: 'page' },
  mode: 'preview',
  sort: 'modified',
}
export interface Memo {
  id: string
  documentId: string | null
  page: number | null
  title: string
  body: string
  createdAt: number
  updatedAt: number
  revision: number
}
export type MemoSummary = Omit<Memo, 'body'>
export type MemoResult<T> =
  { status: 'ok'; value: T } | { status: 'error'; message: string; current?: Memo }
export interface MemoAPI {
  memoExport: (input: MemoExportInput) => Promise<MemoExportResult>
  memoList: () => Promise<MemoResult<MemoSummary[]>>
  memoLoad: (target: MemoTarget) => Promise<MemoResult<Memo>>
  memoCreate: (title: string) => Promise<MemoResult<Memo>>
  memoSave: (input: { id: string; revision: number; body: string }) => Promise<MemoResult<Memo>>
  memoRename: (input: { id: string; revision: number; title: string }) => Promise<MemoResult<Memo>>
  memoDelete: (input: { id: string; revision: number }) => Promise<MemoResult<void>>
  memoPreferences: (next?: MemoPreferences) => Promise<MemoResult<MemoPreferences>>
  onMemoChanged: (callback: (event: { id: string; deleted: boolean }) => void) => () => void
}
export function shortMemoTitle(title: string): string {
  const segments = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(title)].map(
    (s) => s.segment,
  )
  return segments.length > 12 ? segments.slice(0, 12).join('') + '…' : title
}
export function sortMemos(entries: MemoSummary[], sort: MemoSort): MemoSummary[] {
  const name = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })
  return [...entries].sort(
    (a, b) =>
      (sort === 'name'
        ? name.compare(a.title, b.title)
        : sort === 'created'
          ? b.createdAt - a.createdAt
          : b.updatedAt - a.updatedAt) ||
      name.compare(a.title, b.title) ||
      a.id.localeCompare(b.id),
  )
}
