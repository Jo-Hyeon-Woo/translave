import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ChatQuote } from '../../shared/chat'
import { CHAT_LIMITS } from '../../shared/chat'

type Owner = { documentId: string | null; documentName: string; page: number }
type Candidate = { quote: ChatQuote; range: Range; root: HTMLElement }
const sources = '.textLayer, [data-quote-message]'
const excluded = 'input, textarea, button, summary, [role="menu"], dialog, [contenteditable="true"]'
const textNodes = (root: Node) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  return nodes
}
function offset(root: HTMLElement, node: Node, position: number) {
  const prefix = document.createRange()
  prefix.selectNodeContents(root)
  prefix.setEnd(node, position)
  return prefix.toString().length
}
function restore(root: HTMLElement, start: number, end: number): Range | null {
  const nodes = textNodes(root)
  let index = 0,
    first: [Text, number] | undefined,
    last: [Text, number] | undefined
  for (const n of nodes) {
    if (!first && start <= index + n.length) first = [n, start - index]
    if (end <= index + n.length) {
      last = [n, end - index]
      break
    }
    index += n.length
  }
  if (!first || !last) return null
  const range = document.createRange()
  range.setStart(...first)
  range.setEnd(...last)
  return range
}
function rootsFor(quote: ChatQuote): { root: HTMLElement; start: number; end: number }[] {
  if (quote.source.kind === 'pdf') {
    const root = document.querySelector<HTMLElement>('.textLayer')
    return root ? [{ root, start: quote.source.start, end: quote.source.end }] : []
  }
  return quote.source.ranges.flatMap((part) => {
    const root = [...document.querySelectorAll<HTMLElement>('[data-quote-message]')].find(
      (n) => n.dataset.quoteMessage === part.turnId && n.dataset.quoteRole === part.role,
    )
    return root ? [{ root, start: part.start, end: part.end }] : []
  })
}

export function useChatSelection(owner: Owner, blocked: boolean, onAdd: () => void) {
  const key = `${owner.documentId}:${owner.page}`
  const [draft, setDraft] = useState<{ key: string; quotes: ChatQuote[] }>({ key, quotes: [] })
  const quotes = draft.key === key ? draft.quotes : []
  const [candidate, setCandidate] = useState<Candidate | null>(null)
  const [position, setPosition] = useState({ left: 0, top: 0 })
  const [hovered, setHovered] = useState<ChatQuote | null>(null)
  const [error, setError] = useState('')
  const button = useRef<HTMLButtonElement>(null)
  const current = useRef({ owner, key, blocked })
  current.current = { owner, key, blocked }
  useLayoutEffect(() => {
    CSS.highlights?.delete('chat-quote-source')
    setCandidate(null)
    setHovered(null)
    setError('')
    setDraft({ key, quotes: [] })
  }, [key])
  useEffect(() => {
    if (blocked) {
      setCandidate(null)
      setHovered(null)
    }
  }, [blocked])
  useEffect(() => {
    const inspect = () => {
      const { owner: target, blocked } = current.current
      const selection = window.getSelection()
      if (
        blocked ||
        document.activeElement?.matches('input, textarea, [contenteditable="true"]') ||
        !target.documentId ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount !== 1
      ) {
        setCandidate(null)
        return
      }
      const range = selection.getRangeAt(0)
      const element = (n: Node) => (n instanceof Element ? n : n.parentElement)
      if (
        element(range.startContainer)?.closest(excluded) ||
        element(range.endContainer)?.closest(excluded)
      ) {
        setCandidate(null)
        return
      }
      const startRoot = element(range.startContainer)?.closest<HTMLElement>(sources)
      const endRoot = element(range.endContainer)?.closest<HTMLElement>(sources)
      if (
        !startRoot ||
        !endRoot ||
        startRoot.classList.contains('textLayer') !== endRoot.classList.contains('textLayer') ||
        (startRoot.classList.contains('textLayer') && startRoot !== endRoot)
      ) {
        setCandidate(null)
        return
      }
      const selected = [...document.querySelectorAll<HTMLElement>(sources)].flatMap((root) => {
        if (!root.getClientRects().length || !range.intersectsNode(root)) return []
        if (root.classList.contains('textLayer') !== startRoot.classList.contains('textLayer'))
          return []
        const clip = document.createRange()
        clip.selectNodeContents(root)
        if (root.contains(range.startContainer))
          clip.setStart(range.startContainer, range.startOffset)
        if (root.contains(range.endContainer)) clip.setEnd(range.endContainer, range.endOffset)
        if (!clip.toString().trim()) return []
        return [
          {
            root,
            start: offset(root, clip.startContainer, clip.startOffset),
            end: offset(root, clip.endContainer, clip.endOffset),
            text: clip.toString(),
          },
        ]
      })
      if (!selected.length) {
        setCandidate(null)
        return
      }
      const base = {
        documentId: target.documentId,
        documentName: target.documentName,
        page: target.page,
      }
      const first = selected[0]
      const quote: ChatQuote = {
        id: crypto.randomUUID(),
        text: selected.map((p) => p.text).join('\n\n'),
        source: first.root.classList.contains('textLayer')
          ? { ...base, kind: 'pdf', start: first.start, end: first.end }
          : {
              ...base,
              kind: 'chat',
              ranges: selected.map((p) => ({
                turnId: p.root.dataset.quoteMessage!,
                role: p.root.dataset.quoteRole as 'user' | 'assistant',
                start: p.start,
                end: p.end,
              })),
            },
      }
      setCandidate({ quote, range: range.cloneRange(), root: startRoot })
    }
    const down = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.chat-selection-add'))
        setCandidate(null)
    }
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCandidate(null)
    }
    document.addEventListener('selectionchange', inspect)
    document.addEventListener('pointerup', inspect)
    document.addEventListener('pointerdown', down)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('selectionchange', inspect)
      document.removeEventListener('pointerup', inspect)
      document.removeEventListener('pointerdown', down)
      document.removeEventListener('keydown', escape)
    }
  }, [])
  useLayoutEffect(() => {
    if (!candidate) return
    const place = () => {
      if (!candidate.root.isConnected) {
        setCandidate(null)
        return
      }
      const rects = [...candidate.range.getClientRects()]
      const viewport = candidate.root
        .closest('.viewer-scroll, .chat-messages')
        ?.getBoundingClientRect()
      const r = rects.find(
        (r) =>
          r.bottom > Math.max(0, viewport?.top ?? 0) &&
          r.top < Math.min(innerHeight, viewport?.bottom ?? innerHeight) &&
          r.right > Math.max(0, viewport?.left ?? 0) &&
          r.left < Math.min(innerWidth, viewport?.right ?? innerWidth),
      )
      if (!r) {
        setCandidate(null)
        return
      }
      const b = button.current?.getBoundingClientRect()
      const width = b?.width ?? 120,
        height = b?.height ?? 36
      setPosition({
        left: Math.max(8, Math.min(innerWidth - width - 8, r.left + r.width / 2 - width / 2)),
        top: Math.max(8, Math.min(innerHeight - height - 8, r.top - height - 8)),
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = new ResizeObserver(place)
    observer.observe(candidate.root)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer.disconnect()
    }
  }, [candidate])
  useEffect(() => {
    const clear = () => CSS.highlights?.delete('chat-quote-source')
    const paint = () => {
      clear()
      if (
        !hovered ||
        blocked ||
        hovered.source.documentId !== owner.documentId ||
        hovered.source.page !== owner.page
      )
        return
      const parts = rootsFor(hovered)
      const ranges = parts.map((p) => restore(p.root, p.start, p.end))
      // A missing/replaced message must never highlight a different passage.
      if (
        ranges.some((r) => !r) ||
        !ranges.length ||
        ranges.map((r) => r!.toString()).join('\n\n') !== hovered.text
      )
        return
      CSS.highlights?.set('chat-quote-source', new Highlight(...(ranges as Range[])))
    }
    paint()
    if (!hovered) return clear
    const observer = new MutationObserver(paint)
    const workspace = document.querySelector('.workspace')
    if (workspace)
      observer.observe(workspace, { childList: true, subtree: true, characterData: true })
    window.addEventListener('resize', paint)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', paint)
      clear()
    }
  }, [hovered, blocked, owner.documentId, owner.page])
  const clearQuotes = useCallback(() => {
    if (current.current.key !== key) return
    setDraft({ key, quotes: [] })
    setHovered(null)
    setError('')
  }, [key])
  const removeQuote = (id: string) => {
    setDraft((old) => ({ ...old, quotes: old.quotes.filter((q) => q.id !== id) }))
    setHovered(null)
    setError('')
  }
  const popup =
    candidate &&
    !blocked &&
    candidate.quote.source.documentId === owner.documentId &&
    candidate.quote.source.page === owner.page
      ? createPortal(
          <button
            ref={button}
            type="button"
            tabIndex={-1}
            className="chat-selection-add"
            style={position}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => {
              if (!candidate.root.isConnected || current.current.key !== key) return
              if (
                quotes.length >= CHAT_LIMITS.quotes ||
                quotes.reduce((n, q) => n + q.text.length, candidate.quote.text.length) >
                  CHAT_LIMITS.quoteChars
              ) {
                setError('선택 문장 첨부가 한도를 넘었어요. 일부 첨부를 해제해 주세요.')
                onAdd()
                return
              }
              setDraft({ key, quotes: [...quotes, candidate.quote] })
              setCandidate(null)
              setError('')
              window.getSelection()?.removeAllRanges()
              onAdd()
            }}
          >
            채팅에 추가
          </button>,
          document.body,
        )
      : null
  return { quotes, popup, error, clearQuotes, removeQuote, hoverQuote: setHovered }
}
