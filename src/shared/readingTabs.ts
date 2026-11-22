export interface ReadingTab {
  id: string
  documentId: string
  name: string
  page: number
  zoom: number | 'fit'
  scrollTop: number
  scrollLeft: number
}
export interface ReadingWorkspace {
  tabs: ReadingTab[]
  activeId: string | null
}
export const emptyReadingWorkspace = (): ReadingWorkspace => ({ tabs: [], activeId: null })

export function validReadingWorkspace(value: unknown): value is ReadingWorkspace {
  if (!value || typeof value !== 'object') return false
  const w = value as ReadingWorkspace
  if (!Array.isArray(w.tabs)) return false
  const ids = new Set<string>()
  for (const t of w.tabs) {
    if (
      !t ||
      typeof t.id !== 'string' ||
      !t.id ||
      t.id.length > 128 ||
      ids.has(t.id) ||
      typeof t.documentId !== 'string' ||
      !t.documentId ||
      t.documentId.length > 128 ||
      typeof t.name !== 'string' ||
      t.name.length > 1024 ||
      !Number.isInteger(t.page) ||
      t.page < 1 ||
      t.page > 100000 ||
      (t.zoom !== 'fit' &&
        (typeof t.zoom !== 'number' || !Number.isFinite(t.zoom) || t.zoom < 0.25 || t.zoom > 3)) ||
      ![t.scrollTop, t.scrollLeft].every(
        (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100000000,
      )
    )
      return false
    ids.add(t.id)
  }
  return w.tabs.length ? typeof w.activeId === 'string' && ids.has(w.activeId) : w.activeId === null
}

export function closeReadingTab(w: ReadingWorkspace, id: string): ReadingWorkspace {
  const index = w.tabs.findIndex((t) => t.id === id)
  if (index < 0) return w
  const tabs = w.tabs.filter((t) => t.id !== id)
  return {
    tabs,
    activeId: w.activeId === id ? (tabs[index]?.id ?? tabs[index - 1]?.id ?? null) : w.activeId,
  }
}
export function removeDocumentTabs(
  w: ReadingWorkspace,
  documentIds: readonly string[],
): ReadingWorkspace {
  const removed = new Set(documentIds)
  // Apply the same right-neighbour/left-neighbour rule as an individual close.
  return w.tabs.reduce(
    (next, tab) => (removed.has(tab.documentId) ? closeReadingTab(next, tab.id) : next),
    w,
  )
}
export function moveReadingTab(
  w: ReadingWorkspace,
  id: string,
  beforeId: string | null,
): ReadingWorkspace {
  const source = w.tabs.find((tab) => tab.id === id)
  if (
    !source ||
    beforeId === id ||
    (beforeId !== null && !w.tabs.some((tab) => tab.id === beforeId))
  )
    return w
  const tabs = w.tabs.filter((tab) => tab.id !== id)
  tabs.splice(
    beforeId === null ? tabs.length : tabs.findIndex((tab) => tab.id === beforeId),
    0,
    source,
  )
  return tabs.every((tab, index) => tab === w.tabs[index]) ? w : { ...w, tabs }
}
export function cycleReadingTab(w: ReadingWorkspace, direction: number): ReadingWorkspace {
  if (w.tabs.length < 2) return w
  const index = w.tabs.findIndex((tab) => tab.id === w.activeId)
  if (index < 0) return w
  return {
    ...w,
    activeId: w.tabs[(index + (direction < 0 ? -1 : 1) + w.tabs.length) % w.tabs.length].id,
  }
}
export type ReadingWorkspaceResult =
  { status: 'loaded'; workspace: ReadingWorkspace } | { status: 'error'; message: string }
