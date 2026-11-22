import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { DeleteConfirmation } from './DeleteConfirmation'

export function ChatTurnDelete({
  busy,
  onDelete,
}: {
  busy: boolean
  onDelete: () => Promise<string | null>
}) {
  const id = useId()
  const trigger = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const saving = useRef(false)
  const confirm = useRef(onDelete)
  const alive = useRef(true)
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const close = (focus = false) => {
    popup.current?.hidePopover()
    setOpen(false)
    if (focus) trigger.current?.focus()
  }
  const position = () => {
    const panel = popup.current!,
      button = trigger.current!
    const bounds = button.closest('.translation-panel')!.getBoundingClientRect()
    const anchor = button.getBoundingClientRect()
    panel.style.maxWidth = `${Math.min(bounds.width, innerWidth) - 16}px`
    const box = panel.getBoundingClientRect()
    panel.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.right - box.width, innerWidth - box.width - 8))}px`
    panel.style.top = `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - box.height - 8))}px`
  }
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useLayoutEffect(() => {
    if (!open) return
    const panel = popup.current!,
      button = trigger.current!
    const sidebar = button.closest('.translation-panel')!
    position()
    panel.querySelector<HTMLButtonElement>('button')?.focus()
    const observer = new ResizeObserver(position)
    observer.observe(sidebar)
    observer.observe(panel)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])
  return (
    <>
      <button
        ref={trigger}
        type="button"
        tabIndex={-1}
        className="chat-turn-delete"
        aria-label="질문과 답변 삭제"
        title={
          busy ? '응답이 끝나거나 중지 처리가 완료된 뒤 삭제할 수 있어요.' : '질문과 답변 삭제'
        }
        disabled={busy || pending}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          if (popup.current?.matches(':popover-open')) close()
          else {
            setError('')
            confirm.current = onDelete
            setOpen(true)
            popup.current?.showPopover()
            position()
          }
        }}
      >
        <X size={14} aria-hidden="true" />
      </button>
      <div
        ref={popup}
        id={id}
        popover="auto"
        role="menu"
        aria-label="대화 삭제 확인"
        className="chat-delete-popover"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault()
            event.stopPropagation()
            close(true)
          } else if (
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)
          ) {
            event.preventDefault()
            event.stopPropagation()
            const buttons = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
            ]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : (index +
                      (['ArrowLeft', 'ArrowUp'].includes(event.key) || event.shiftKey ? -1 : 1) +
                      buttons.length) %
                    buttons.length
            buttons[next]?.focus()
          }
        }}
      >
        <DeleteConfirmation
          text="대화를 삭제하시겠습니까?"
          pending={busy || pending}
          error={error}
          onCancel={() => close(true)}
          onConfirm={async () => {
            if (busy || saving.current) return
            saving.current = true
            setPending(true)
            setError('')
            try {
              const message = await confirm.current()
              if (!alive.current) return
              if (message) setError(message)
              else close()
            } finally {
              saving.current = false
              if (alive.current) setPending(false)
            }
          }}
        />
      </div>
    </>
  )
}
