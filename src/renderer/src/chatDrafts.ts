// Session memory only. Draft identity follows a reading tab, never a document ID.
export class ChatDraft {
  text = ''
  revision = 0
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  snapshot = () => this.text
  set = (text: string) => {
    if (text === this.text) return
    this.text = text
    this.revision++
    this.listeners.forEach((listener) => listener())
  }
  clear(revision: number) {
    if (this.revision === revision) this.set('')
  }
}
export class ChatDrafts {
  private entries = new Map<string, { page: number; draft: ChatDraft }>()
  private empty = new ChatDraft()
  forTab(id: string | undefined, page: number): ChatDraft {
    if (!id) return this.empty
    let entry = this.entries.get(id)
    if (!entry || entry.page !== page) {
      entry = { page, draft: new ChatDraft() }
      this.entries.set(id, entry)
    }
    return entry.draft
  }
  sync(tabs: readonly { id: string; page: number }[]) {
    for (const [id, entry] of this.entries) {
      const tab = tabs.find((tab) => tab.id === id)
      if (!tab || tab.page !== entry.page) this.entries.delete(id)
    }
  }
}
