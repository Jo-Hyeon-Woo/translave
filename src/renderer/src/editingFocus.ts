import { useLayoutEffect } from 'react'
export interface EditingEntry {
  pending: boolean
}
export function useEditingFocus(entry: EditingEntry, allowed: boolean, focus: () => boolean) {
  useLayoutEffect(() => {
    if (!entry.pending) return
    if (
      document.querySelector(
        '.translation-menu[open], .memo-selector[open], [popover]:popover-open, [role="menu"], [role="listbox"]',
      )
    ) {
      entry.pending = false
      return
    }
    if (!allowed || document.querySelector('dialog[open]')) return
    if (focus()) entry.pending = false
  }, [entry, allowed])
}
