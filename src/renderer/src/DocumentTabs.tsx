import { useEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { Plus, X } from 'lucide-react'
import type { ReadingWorkspace } from '../../shared/readingTabs'

type TabDrag = {
  id: string
  pointer: number
  source: HTMLButtonElement
  order: string
  startX: number
  startY: number
  x: number
  y: number
  started: boolean
  index: number
  step: number
  grab: number
  rect: DOMRect
  background: string
  before: string | null | undefined
}

export function DocumentTabs({
  workspace,
  disabled,
  onSelect,
  onClose,
  onReorder,
  onAdd,
}: {
  workspace: ReadingWorkspace
  disabled: boolean
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onReorder: (id: string, beforeId: string | null) => void
  onAdd: () => void
}) {
  const strip = useRef<HTMLDivElement>(null)
  const gesture = useRef<TabDrag | null>(null)
  const frame = useRef(0)
  const blockClick = useRef(false)
  const [drag, setDrag] = useState<{
    id: string
    index: number | null
    step: number
    x: number
    y: number
  } | null>(null)
  const order = workspace.tabs.map((tab) => tab.id).join(':')
  const sourceIndex = workspace.tabs.findIndex((tab) => tab.id === drag?.id)
  const projected = [...workspace.tabs]
  if (drag && sourceIndex >= 0) {
    const [source] = projected.splice(sourceIndex, 1)
    projected.splice(drag.index ?? sourceIndex, 0, source)
  }
  const finish = (update = true) => {
    const current = gesture.current
    gesture.current = null
    cancelAnimationFrame(frame.current)
    frame.current = 0
    if (current?.source.hasPointerCapture(current.pointer))
      current.source.releasePointerCapture(current.pointer)
    if (update) setDrag(null)
  }
  const locate = () => {
    const current = gesture.current,
      root = strip.current
    if (!current?.started || !root) return
    const list = root.querySelector<HTMLElement>('.document-tab-list')!
    const bounds = root.getBoundingClientRect(),
      listBounds = list.getBoundingClientRect()
    const nodes = [...list.querySelectorAll<HTMLElement>('[data-tab-id]')]
    let index: number | null = null
    current.before = undefined
    if (
      current.x >= bounds.left &&
      current.x <= Math.min(bounds.right, listBounds.right) &&
      current.y >= bounds.top &&
      current.y <= bounds.bottom
    ) {
      // Use fixed layout slots, never the animated neighbors' screen positions.
      const position = (current.x - current.grab - listBounds.left) / current.step
      if (Math.abs(position - current.index) > 0.5 + 4 / current.step)
        current.index = Math.max(0, Math.min(nodes.length - 1, Math.round(position)))
      index = current.index
      current.before =
        nodes.filter((node) => node.dataset.tabId !== current.id)[index]?.dataset.tabId ?? null
    }
    setDrag((old) =>
      old?.id === current.id && old.index === index && old.x === current.x && old.y === current.y
        ? old
        : { id: current.id, index, step: current.step, x: current.x, y: current.y },
    )
  }
  const autoScroll = () => {
    const current = gesture.current,
      root = strip.current
    if (!current?.started || !root) return
    const bounds = root.getBoundingClientRect()
    if (
      current.y >= bounds.top &&
      current.y <= bounds.bottom &&
      current.x >= bounds.left &&
      current.x <= bounds.right
    ) {
      const left = current.x - bounds.left,
        right = bounds.right - current.x
      if (left < 32) root.scrollLeft -= Math.ceil((32 - left) / 2)
      else if (right < 32) root.scrollLeft += Math.ceil((32 - right) / 2)
    }
    locate()
    frame.current = requestAnimationFrame(autoScroll)
  }
  const start = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (event.button !== 0 || !event.isPrimary || gesture.current) return
    const tab = event.currentTarget.parentElement!
    const rect = tab.getBoundingClientRect()
    gesture.current = {
      id,
      source: event.currentTarget,
      pointer: event.pointerId,
      order,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      started: false,
      index: workspace.tabs.findIndex((tab) => tab.id === id),
      step: rect.width + parseFloat(getComputedStyle(tab.parentElement!).columnGap),
      grab: event.clientX - rect.left,
      rect,
      background: getComputedStyle(tab).backgroundColor,
      before: undefined,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    if (
      !current.started &&
      Math.hypot(current.x - current.startX, current.y - current.startY) >= 6
    ) {
      current.started = true
      blockClick.current = true
      autoScroll()
    }
    if (current.started) {
      event.preventDefault()
      locate()
    }
  }
  const drop = (event: PointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || current.pointer !== event.pointerId) return
    current.x = event.clientX
    current.y = event.clientY
    if (current.started) {
      event.preventDefault()
      locate()
    }
    finish()
    if (current.started && current.before !== undefined) onReorder(current.id, current.before)
  }
  useEffect(() => {
    if (gesture.current && gesture.current.order !== order) finish()
  }, [order])
  useEffect(() => {
    const cancel = () => finish()
    const key = (event: KeyboardEvent) => {
      if (!gesture.current) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        cancel()
      } else if (event.key === 'Tab') cancel()
    }
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', cancel)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', cancel)
      finish(false)
    }
  }, [])
  useEffect(() => {
    const root = strip.current
    if (!root) return
    const reveal = () => {
      const active = root.querySelector<HTMLElement>('[data-active="true"]')
      if (!active) return
      const bounds = root.getBoundingClientRect(),
        item = active.getBoundingClientRect(),
        padding = getComputedStyle(root),
        left = bounds.left + parseFloat(padding.paddingLeft),
        right = bounds.right - parseFloat(padding.paddingRight)
      if (item.left < left) root.scrollLeft += item.left - left
      else if (item.right > right) root.scrollLeft += item.right - right
    }
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(root)
    return () => observer.disconnect()
  }, [workspace.activeId, workspace.tabs.length])
  const current = gesture.current
  const floating = workspace.tabs[sourceIndex]
  return (
    <div
      className="document-tabs"
      ref={strip}
      tabIndex={-1}
      aria-label="열린 문서"
      data-dragging={!!drag}
      onDragStart={(event) => event.preventDefault()}
      onPointerDownCapture={() => {
        if (!gesture.current) blockClick.current = false
      }}
      onPointerMove={move}
      onPointerUp={drop}
      onPointerCancel={() => finish()}
      onLostPointerCapture={() => finish()}
      onClickCapture={(event) => {
        if (blockClick.current && event.detail > 0) {
          blockClick.current = false
          event.preventDefault()
          event.stopPropagation()
        }
      }}
    >
      <div className="document-tab-list" role="tablist" aria-label="문서 탭">
        {workspace.tabs.map((tab, index) => {
          const slot = projected.findIndex((item) => item.id === tab.id)
          return (
            <div
              className="file-button document-tab"
              key={tab.id}
              data-active={tab.id === workspace.activeId}
              data-tab-id={tab.id}
              data-drag-source={drag?.id === tab.id}
              data-divider={
                slot > 0 &&
                projected[slot - 1].id !== workspace.activeId &&
                tab.id !== workspace.activeId
              }
              style={
                drag ? { transform: `translateX(${(slot - index) * drag.step}px)` } : undefined
              }
            >
              <button
                className="document-tab-title"
                type="button"
                role="tab"
                tabIndex={-1}
                aria-selected={tab.id === workspace.activeId}
                aria-controls="pdf-reader"
                title={tab.name}
                onPointerDown={(event) => start(event, tab.id)}
                onClick={() => onSelect(tab.id)}
              >
                <span className="file-name" title={tab.name}>
                  {tab.name}
                </span>
              </button>
              <button
                className="document-tab-close"
                type="button"
                tabIndex={-1}
                title={`${tab.name} 탭 닫기`}
                aria-label={`${tab.name} 탭 닫기`}
                onClick={() => onClose(tab.id)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          )
        })}
      </div>
      <button
        className="document-add"
        type="button"
        tabIndex={-1}
        disabled={disabled}
        aria-label="파일 목록 열기"
        aria-haspopup="dialog"
        title="파일 목록 열기"
        onClick={onAdd}
      >
        {!workspace.tabs.length && <span className="file-name">파일 선택</span>}
        <Plus size={17} aria-hidden="true" />
      </button>
      {drag &&
        current &&
        floating &&
        createPortal(
          <div
            className="file-button document-tab document-tab-floating"
            data-active={floating.id === workspace.activeId}
            aria-hidden="true"
            style={{
              left: drag.x - current.grab,
              top: drag.y - current.startY + current.rect.top,
              width: current.rect.width,
              height: current.rect.height,
              background: `linear-gradient(${current.background}, ${current.background}), var(--frame)`,
            }}
          >
            <span className="document-tab-title">
              <span className="file-name">{floating.name}</span>
            </span>
            <span className="document-tab-close">
              <X size={14} />
            </span>
          </div>,
          strip.current!.closest('.app-shell')!,
        )}
    </div>
  )
}
