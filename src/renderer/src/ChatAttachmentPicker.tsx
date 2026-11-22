import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { File, FileText, Plus } from 'lucide-react'
import type { ChatAttachment } from '../../shared/chat'

const choices: ChatAttachment[] = ['pdf', 'page', 'none']
const labels = { none: '첨부 없음', page: '현재 페이지', pdf: '전체 PDF' }
const duration = 260
const easing = 'cubic-bezier(0.22, 0.7, 0.3, 1)'
type Phase = 'closed' | 'open' | 'closing'
type Rect = { x: number; y: number; width: number; height: number }
const rect = (node: Element): Rect => {
  const r = node.getBoundingClientRect()
  return { x: r.x, y: r.y, width: r.width, height: r.height }
}
function Icon({ kind }: { kind: ChatAttachment }) {
  return (
    <span className="attachment-icon" aria-hidden="true">
      {kind === 'none' ? (
        <Plus size={16} className="attachment-plus" />
      ) : kind === 'page' ? (
        <FileText size={16} />
      ) : (
        <>
          <File size={16} />
          <svg className="attachment-pdf-word" viewBox="0 0 24 24">
            <text x="12" y="19" textAnchor="middle">
              PDF
            </text>
          </svg>
        </>
      )}
    </span>
  )
}

// The popup's surface shrinks independently of the moving row. Text/icons never scale.
// Attachment value commits immediately; only the visual transition is transient.
export function ChatAttachmentPicker({
  value,
  onChange,
}: {
  value: ChatAttachment
  onChange: (value: ChatAttachment) => void
}) {
  const committed = useRef(value)
  committed.current = value
  const [phase, setPhase] = useState<Phase>('closed')
  const [revision, setRevision] = useState(0)
  const [reduced, setReduced] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const rows = useRef<Partial<Record<ChatAttachment, HTMLButtonElement | null>>>({})
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const animations = useRef<Animation[]>([])
  const generation = useRef(0)
  const motion = useRef<{
    open: boolean
    chosen: ChatAttachment
    surface: Rect
    radius: string
    rows: Partial<Record<ChatAttachment, Rect>>
    focus: boolean
  } | null>(null)
  const stop = () => {
    generation.current++
    animations.current.forEach((a) => a.cancel())
    animations.current = []
  }
  const begin = (open: boolean, chosen = value, focus = true) => {
    const opening = phaseRef.current === 'closed'
    const source = opening ? rect(trigger.current!) : rect(surface.current!)
    const positions: Partial<Record<ChatAttachment, Rect>> = {}
    if (!opening)
      for (const kind of choices) {
        const node = rows.current[kind]!.querySelector(
          kind === 'none' ? '.attachment-icon' : '.attachment-pill',
        )!
        positions[kind] = rect(node)
      }
    motion.current = {
      open,
      chosen,
      surface: source,
      radius: getComputedStyle(opening ? trigger.current! : surface.current!).borderRadius,
      rows: positions,
      focus,
    }
    stop()
    phaseRef.current = open ? 'open' : 'closing'
    setPhase(phaseRef.current)
    setRevision((n) => n + 1)
  }
  const close = (focus = false) => {
    if (phaseRef.current !== 'closed') begin(false, committed.current, focus)
  }
  const choose = (next: ChatAttachment) => {
    committed.current = next
    begin(false, next)
    onChange(next)
  }
  useLayoutEffect(() => {
    const m = motion.current
    if (!m || phaseRef.current === 'closed') return
    stop()
    const token = generation.current
    const background = surface.current!,
      target = rect(trigger.current!),
      base = rect(background)
    const surfaceFrame = (r: Rect, borderRadius: string) => ({
      left: `${r.x - base.x}px`,
      top: `${r.y - base.y}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      borderRadius,
    })
    const animate = (node: Element, keyframes: Keyframe[]) => {
      const a = node.animate(keyframes, {
        duration: reduced ? 0 : duration,
        easing,
        fill: 'forwards',
      })
      animations.current.push(a)
    }
    animate(background, [
      surfaceFrame(m.surface, m.radius),
      {
        ...surfaceFrame(
          m.open ? base : target,
          getComputedStyle(m.open ? background : trigger.current!).borderRadius,
        ),
        opacity: m.open ? 1 : 0,
      },
    ])
    for (const kind of choices) {
      const row = rows.current[kind]!,
        pill = row.querySelector(kind === 'none' ? '.attachment-icon' : '.attachment-pill')!
      const from = m.rows[kind] ?? target,
        r = rect(pill)
      const dx = from.x + from.width / 2 - r.x - r.width / 2
      const dy = from.y + from.height / 2 - r.y - r.height / 2
      const destination =
        kind === 'none' ? rect(trigger.current!.querySelector('.attachment-icon')!) : target
      const endX = destination.x + destination.width / 2 - r.x - r.width / 2
      const endY = destination.y + destination.height / 2 - r.y - r.height / 2
      if (kind === m.chosen) {
        animate(row, [
          { transform: `translate(${dx}px, ${dy}px)`, opacity: 1 },
          { transform: m.open ? 'none' : `translate(${endX}px, ${endY}px)`, opacity: 1 },
        ])
      } else animate(row, [{ opacity: m.open ? 0 : 1 }, { opacity: m.open ? 1 : 0 }])
    }
    const plus = rows.current.none!.querySelector('.attachment-plus')!
    animate(plus, [
      { transform: `rotate(${m.open ? 0 : 45}deg)` },
      { transform: `rotate(${m.open ? 45 : 0}deg)` },
    ])
    const noneLabel = rows.current.none!.querySelector('.attachment-label')!
    animate(noneLabel, [
      { opacity: m.open && m.chosen === 'none' ? 0 : 1 },
      { opacity: !m.open && m.chosen === 'none' ? 0 : 1 },
    ])
    if (m.open && m.focus) rows.current[m.chosen]?.focus({ preventScroll: true })
    const settle = () => {
      if (token !== generation.current) return
      motion.current = null
      if (!m.open) {
        phaseRef.current = 'closed'
        setPhase('closed')
        if (m.focus) trigger.current?.focus({ preventScroll: true })
      }
    }
    if (reduced) settle()
    else
      void Promise.all(animations.current.map((a) => a.finished))
        .then(settle)
        .catch(() => {})
  }, [revision, reduced])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close()
    }
    media.addEventListener('change', update)
    window.addEventListener('pointerdown', outside)
    return () => {
      media.removeEventListener('change', update)
      window.removeEventListener('pointerdown', outside)
    }
  }, [value])
  useEffect(() => () => stop(), [])
  return (
    <div className="attachment-picker" ref={root} data-state={phase} data-value={value}>
      <span className="attachment-size" aria-hidden="true">
        {choices.map((kind) => (
          <span className="attachment-pill" key={kind}>
            <Icon kind={kind} />
            <span className="attachment-label">{labels[kind]}</span>
          </span>
        ))}
      </span>
      <button
        type="button"
        ref={trigger}
        className={`attachment-trigger attachment-pill attachment-${value}`}
        aria-label={`채팅 첨부: ${labels[value]}`}
        title={labels[value]}
        aria-haspopup="menu"
        aria-expanded={phase !== 'closed'}
        aria-controls="chat-attachment-menu"
        onClick={() => (phase === 'closed' ? begin(true) : close(true))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            event.stopPropagation()
            begin(true)
          }
        }}
      >
        <Icon kind={value} />
        {value !== 'none' && <span className="attachment-label">{labels[value]}</span>}
      </button>
      <div
        className="attachment-popup"
        id="chat-attachment-menu"
        role="menu"
        aria-label="채팅 첨부 선택"
        hidden={phase === 'closed'}
        onKeyDown={(event) => {
          const index = choices.findIndex((kind) => rows.current[kind] === document.activeElement)
          if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault()
            event.stopPropagation()
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? 2
                  : (index + (event.key === 'ArrowDown' ? 1 : 2)) % 3
            rows.current[choices[next]]?.focus()
          } else if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (event.key === 'Tab') close()
        }}
      >
        <div className="attachment-popup-surface" ref={surface} aria-hidden="true" />
        {choices.map((kind) => (
          <button
            type="button"
            key={kind}
            ref={(node) => {
              rows.current[kind] = node
            }}
            className="attachment-option"
            role="menuitemradio"
            aria-checked={value === kind}
            tabIndex={-1}
            onClick={() => choose(kind)}
          >
            <span className={`attachment-pill attachment-${kind}`}>
              <Icon kind={kind} />
              <span className="attachment-label">{labels[kind]}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
