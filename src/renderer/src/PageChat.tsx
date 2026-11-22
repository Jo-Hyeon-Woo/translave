import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { ArrowUp, LoaderCircle, Square, X } from 'lucide-react'
import { ChatAttachmentPicker } from './ChatAttachmentPicker'
import { ChatTurnDelete } from './ChatTurnDelete'
import type {
  ChatAttachment,
  ChatEvent,
  ChatQuote,
  ChatSnapshot,
  ChatTurn,
} from '../../shared/chat'
import { CHAT_ATTACHMENT_MODE, CHAT_LIMITS } from '../../shared/chat'
import type { TranslationSettings } from '../../shared/contracts'
import { SafeMarkdown } from './TranslationContent'
import type { ChatDraft } from './chatDrafts'
import { useEditingFocus } from './editingFocus'
import type { EditingEntry } from './editingFocus'

const attachments = {
  none: '첨부하지 않음',
  page: '이 페이지 첨부',
  pdf: '전체 PDF 첨부',
  page_image: '현재 페이지 이미지',
}
const states = {
  queued: '응답 대기 중',
  streaming: '응답 생성 중 · 미완료',
  complete: '완료',
  error: '실패 · 미완료',
  stopped: '중단됨 · 미완료',
}
export interface PageChatHandle {
  clear: () => Promise<void>
}
export const PageChat = forwardRef<
  PageChatHandle,
  {
    documentId: string | null
    draft: ChatDraft
    editingEntry: EditingEntry
    focusAllowed: boolean
    page: number
    settings: TranslationSettings | null
    onSettings: () => void
    onCanClearChange: (enabled: boolean) => void
    quotes: ChatQuote[]
    quoteError: string
    onClearQuotes: () => void
    onRemoveQuote: (id: string) => void
    onHoverQuote: (quote: ChatQuote | null) => void
  }
>(function PageChat(
  {
    documentId,
    draft,
    editingEntry,
    focusAllowed,
    page,
    settings,
    onSettings,
    onCanClearChange,
    quotes,
    quoteError,
    onClearQuotes,
    onRemoveQuote,
    onHoverQuote,
  },
  ref,
) {
  const [snapshot, setSnapshot] = useState<ChatSnapshot | null>(null)
  const question = useSyncExternalStore(draft.subscribe, draft.snapshot)
  const setQuestion = draft.set
  const [attachment, setAttachment] = useState<ChatAttachment>('none')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [unseen, setUnseen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  useEditingFocus(editingEntry, focusAllowed, () => {
    if (!input.current || input.current.disabled || input.current.readOnly) return false
    input.current.focus({ preventScroll: true })
    return true
  })
  const frame = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLDivElement>(null)
  const quoteList = useRef<HTMLDivElement>(null)
  const [quoteOverflow, setQuoteOverflow] = useState({ left: false, right: false })
  const attachmentControl = useRef<HTMLDivElement>(null)
  const submitControl = useRef<HTMLDivElement>(null)
  const sending = useRef(false)
  const retrying = useRef<string | undefined>(undefined)
  const composing = useRef(false)
  const enterHeld = useRef(false)
  const compositionEnded = useRef(false)
  const compositionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [multiline, setMultiline] = useState(false)
  useEffect(() => () => onHoverQuote(null), [onHoverQuote])
  useEffect(() => () => clearTimeout(compositionTimer.current), [])
  const resizeInput = useRef<() => void>(() => {})
  resizeInput.current = () => {
    const shell = frame.current,
      mirror = measure.current,
      textarea = input.current
    if (!shell || !mirror || !textarea) return
    const style = getComputedStyle(shell)
    const width = shell.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    const single = Math.max(
      24,
      width -
        (CHAT_ATTACHMENT_MODE === 'legacy' ? (attachmentControl.current?.offsetWidth ?? 32) : 0) -
        (submitControl.current?.offsetWidth ?? 32) -
        (CHAT_ATTACHMENT_MODE === 'legacy' ? 16 : 8),
    )
    mirror.style.width = single + 'px'
    mirror.textContent = question + '\u200b'
    const expanded = quotes.length > 0 || mirror.offsetHeight > 25
    setMultiline(expanded)
    mirror.style.width = (expanded ? width : single) + 'px'
    const max = Math.min(144, Math.max(48, innerHeight * 0.22))
    const height = Math.max(24, Math.min(max, mirror.offsetHeight))
    textarea.style.height = height + 'px'
    textarea.style.overflowY = mirror.offsetHeight > max ? 'auto' : 'hidden'
  }
  useLayoutEffect(() => {
    resizeInput.current()
  }, [question, quotes.length, CHAT_ATTACHMENT_MODE === 'legacy' ? attachment : null])
  useEffect(() => {
    const observer = new ResizeObserver(() => resizeInput.current())
    if (frame.current) observer.observe(frame.current)
    const resize = () => resizeInput.current()
    window.addEventListener('resize', resize)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', resize)
    }
  }, [])
  useLayoutEffect(() => {
    const list = quoteList.current
    const update = () => {
      const left = !!list && list.scrollLeft > 1
      const right = !!list && list.scrollWidth - list.clientWidth - list.scrollLeft > 1
      setQuoteOverflow((old) => (old.left === left && old.right === right ? old : { left, right }))
    }
    update()
    if (!list) return
    const observer = new ResizeObserver(update)
    observer.observe(list)
    for (const chip of list.children) observer.observe(chip)
    list.addEventListener('scroll', update, { passive: true })
    return () => {
      observer.disconnect()
      list.removeEventListener('scroll', update)
    }
  }, [quotes])
  const atBottom = useRef(true)
  const live = useRef(true)
  useLayoutEffect(
    () => () => {
      live.current = false
    },
    [],
  )
  const clearedConversations = useRef(new Set<string>())
  const deletedTurns = useRef(new Set<string>())
  const ready =
    !!settings?.connection?.verified &&
    settings.connection.status === 'signed_in' &&
    settings.connection.planAllowed &&
    !settings.authenticationError
  const canSend = (text = question) =>
    ready &&
    !!documentId &&
    !!text.trim() &&
    text.length <= CHAT_LIMITS.questionChars &&
    !pending &&
    !snapshot?.active &&
    !sending.current
  useEffect(() => {
    live.current = true
    let alive = true
    if (!documentId)
      return () => {
        live.current = false
      }
    let loaded = false
    const early: ChatEvent[] = []
    const update = (event: ChatEvent) => {
      if (!alive) return
      setSnapshot((old) => {
        if (!old) return old
        const samePage = event.documentId === documentId && event.page === page
        const existing = samePage ? old.turns.find((t) => t.id === event.turnId) : undefined
        if (samePage && deletedTurns.current.has(event.turnId)) return old
        if (
          samePage &&
          event.turn &&
          (clearedConversations.current.has(event.conversationId) ||
            (existing && existing.revision >= event.turn.revision))
        )
          return old
        if (samePage && old.conversationId && old.conversationId !== event.conversationId)
          return old
        if (event.deleted) {
          if (!samePage) return old
          deletedTurns.current.add(event.turnId)
          return { ...old, turns: old.turns.filter((t) => t.id !== event.turnId) }
        }
        const running = event.turn && ['queued', 'streaming'].includes(event.turn.status)
        const active = running
          ? {
              documentId: event.documentId,
              page: event.page,
              conversationId: event.conversationId,
              requestId: event.requestId,
              turnId: event.turnId,
            }
          : old.active?.requestId === event.requestId
            ? null
            : old.active
        if (!samePage) return { ...old, active }
        if (!event.turn) {
          clearedConversations.current.add(event.conversationId)
          return { ...old, active, conversationId: null, turns: [] }
        }
        return {
          ...old,
          conversationId: event.conversationId,
          active,
          turns: existing
            ? old.turns.map((t) => (t.id === event.turnId ? event.turn! : t))
            : [...old.turns, event.turn],
        }
      })
    }
    const unsubscribe = window.desktop.onPageChat((event) => {
      if (loaded) update(event)
      else early.push(event)
    })
    void window.desktop
      .pageChat({ documentId, page })
      .then((result) => {
        if (!alive) return
        if (result.status === 'ok') setSnapshot(result.snapshot)
        else setError(result.message)
        loaded = true
        early.forEach(update)
      })
      .catch(() => {
        if (alive) setError('대화를 읽지 못했어요. 다시 열어 주세요.')
      })
    return () => {
      live.current = false
      alive = false
      unsubscribe()
    }
  }, [documentId, page])
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return
    if (atBottom.current) {
      node.scrollTop = node.scrollHeight
      setUnseen(false)
    } else setUnseen(true)
  }, [snapshot?.turns])
  const send = async (retry?: ChatTurn) => {
    if (!documentId || !canSend(retry?.question ?? question)) return
    sending.current = true
    retrying.current = retry?.id
    setPending(true)
    setError('')
    const submittedRevision = draft.revision
    try {
      const result = await window.desktop.sendPageChat({
        documentId,
        page,
        question: retry?.question ?? question,
        quotes: retry?.attachment.quotes ?? quotes,
        ...(CHAT_ATTACHMENT_MODE === 'legacy' ? { attachment } : {}),
        ...(retry ? { retryTurnId: retry.id } : {}),
      })
      if (result.status === 'ok' && !retry) draft.clear(submittedRevision)
      if (!live.current) return
      if (result.status === 'ok') {
        // Events can precede invoke's reply; never replace newer streamed revisions.
        setSnapshot((old) => {
          const turns = result.snapshot.turns
            .filter((t) => !deletedTurns.current.has(t.id))
            .map((t) => {
              const newer = old?.turns.find((v) => v.id === t.id && v.revision > t.revision)
              return newer ?? t
            })
          const active =
            result.snapshot.active &&
            turns.some(
              (t) =>
                t.id === result.snapshot.active?.turnId &&
                ['queued', 'streaming'].includes(t.status),
            )
              ? result.snapshot.active
              : null
          return { ...result.snapshot, turns, active }
        })
        if (!retry) {
          onClearQuotes()
        }
      } else setError(result.message)
    } catch {
      if (live.current) setError('질문을 전송하지 못했어요. 다시 시도해 주세요.')
    } finally {
      sending.current = false
      retrying.current = undefined
      if (live.current) setPending(false)
    }
  }
  const clear = async () => {
    if (!documentId || pending) return
    setPending(true)
    setError('')
    try {
      const result = await window.desktop.clearPageChat({ documentId, page })
      if (!live.current) return
      if (result.status === 'ok') {
        setSnapshot(result.snapshot)
        atBottom.current = true
        setUnseen(false)
      } else setError(result.message)
    } catch {
      if (live.current) setError('대화를 초기화하지 못했어요.')
    } finally {
      if (live.current) setPending(false)
    }
  }
  const deleteTurn = async (turn: ChatTurn): Promise<string | null> => {
    if (!documentId) return 'PDF를 먼저 열어 주세요.'
    try {
      const result = await window.desktop.deletePageChatTurn({
        documentId,
        page,
        conversationId: turn.conversationId,
        turnId: turn.id,
        requestId: turn.requestId,
      })
      if (!live.current) return null
      if (result.status === 'error') return result.message
      deletedTurns.current.add(turn.id)
      setSnapshot((old) =>
        old ? { ...old, turns: old.turns.filter((t) => t.id !== turn.id) } : old,
      )
      return null
    } catch {
      return '대화를 삭제하지 못했어요. 다시 시도해 주세요.'
    }
  }
  useImperativeHandle(ref, () => ({ clear }))
  const canClear = !!documentId && !pending && !!snapshot?.turns.length
  useLayoutEffect(() => {
    onCanClearChange(canClear)
  }, [canClear, onCanClearChange])
  const activeHere = snapshot?.active?.documentId === documentId && snapshot.active.page === page
  return (
    <section className="page-chat" id="side-content" role="tabpanel" aria-labelledby="chat-tab">
      <div className="chat-history">
        <div
          className="chat-messages"
          tabIndex={-1}
          ref={scroller}
          role="log"
          aria-label="페이지 대화"
          aria-live="off"
          onScroll={(event) => {
            const n = event.currentTarget
            atBottom.current = n.scrollHeight - n.scrollTop - n.clientHeight < 48
            if (atBottom.current) setUnseen(false)
          }}
        >
          {!documentId ? (
            <p className="muted">PDF를 열면 페이지별로 질문할 수 있어요.</p>
          ) : !snapshot?.turns.length ? (
            <p className="muted">
              이 페이지에 대해 질문해 보세요. 현재 페이지 이미지를 함께 보냅니다.
            </p>
          ) : null}
          {snapshot?.turns.map((turn, index) => (
            <article
              className="chat-turn"
              key={turn.id}
              data-turn-id={turn.id}
              data-status={turn.status}
            >
              <div className="chat-question">
                <ChatTurnDelete
                  busy={
                    ['queued', 'streaming'].includes(turn.status) || retrying.current === turn.id
                  }
                  onDelete={() => deleteTurn(turn)}
                />
                <span className="chat-speaker">나</span>
                <p data-quote-message={turn.id} data-quote-role="user">
                  {turn.question}
                </p>
                <span className="chat-attachment-label">{attachments[turn.attachment.kind]}</span>
                {!!turn.attachment.quotes?.length && (
                  <details className="chat-sent-quotes">
                    <summary tabIndex={-1}>선택 문장 {turn.attachment.quotes.length}개</summary>
                    {turn.attachment.quotes.map((quote) => (
                      <blockquote key={quote.id}>
                        <span className="chat-attachment-label">
                          {quote.source.documentName} · {quote.source.page}페이지 ·{' '}
                          {quote.source.kind === 'pdf' ? 'PDF' : '대화'}
                        </span>
                        <p>{quote.text}</p>
                      </blockquote>
                    ))}
                  </details>
                )}
              </div>
              <div className="chat-answer markdown-content" data-testid="chat-answer">
                <span className="chat-speaker">ChatGPT · {turn.model}</span>
                {turn.answer && (
                  <div data-quote-message={turn.id} data-quote-role="assistant">
                    <SafeMarkdown text={turn.answer} tabIndex={-1} />
                  </div>
                )}
                <span className="chat-turn-status" role="status">
                  {states[turn.status]}
                </span>
                {turn.error && <p className="chat-error">{turn.error}</p>}
                {['error', 'stopped'].includes(turn.status) &&
                  index === snapshot.turns.length - 1 && (
                    <button
                      tabIndex={-1}
                      className="button secondary-button"
                      type="button"
                      disabled={!ready || pending || !!snapshot.active}
                      title="현재 페이지 이미지로 같은 질문을 다시 시도합니다"
                      onClick={() => void send(turn)}
                    >
                      다시 시도
                    </button>
                  )}
              </div>
            </article>
          ))}
        </div>
        {unseen && (
          <button
            tabIndex={-1}
            className="chat-new-output button secondary-button"
            type="button"
            onClick={() => {
              const node = scroller.current
              if (node) node.scrollTop = node.scrollHeight
              atBottom.current = true
              setUnseen(false)
            }}
          >
            새 답변으로 이동
          </button>
        )}
      </div>
      <form
        className="chat-composer"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        <div
          className="chat-input-shell"
          ref={frame}
          data-multiline={multiline}
          data-attachment-mode={CHAT_ATTACHMENT_MODE}
        >
          <div className="chat-input-measure" ref={measure} aria-hidden="true" />
          {CHAT_ATTACHMENT_MODE === 'legacy' && (
            <div className="chat-attachment-control" ref={attachmentControl}>
              <ChatAttachmentPicker value={attachment} onChange={setAttachment} />
            </div>
          )}
          <textarea
            tabIndex={-1}
            aria-label="질문"
            placeholder="질문을 입력하세요"
            value={question}
            disabled={!documentId}
            rows={1}
            ref={input}
            aria-keyshortcuts="Enter Shift+Enter Alt+F10"
            onChange={(e) => setQuestion(e.target.value)}
            onCompositionStart={() => {
              composing.current = true
              compositionEnded.current = false
              clearTimeout(compositionTimer.current)
            }}
            onCompositionEnd={() => {
              composing.current = false
              // Cover IMEs that finish composition just before the confirming keydown.
              compositionEnded.current = true
              clearTimeout(compositionTimer.current)
              compositionTimer.current = setTimeout(() => {
                compositionEnded.current = false
              }, 50)
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter') {
                enterHeld.current = false
                compositionEnded.current = false
                clearTimeout(compositionTimer.current)
              }
            }}
            onBlur={() => {
              composing.current = false
              compositionEnded.current = false
              enterHeld.current = false
              clearTimeout(compositionTimer.current)
            }}
            onKeyDown={(e) => {
              if (
                e.key === 'F10' &&
                e.altKey &&
                quotes.length &&
                !composing.current &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault()
                frame.current?.querySelector<HTMLButtonElement>('.chat-quote-remove')?.focus()
                return
              }
              if (e.key !== 'Enter') return
              if (
                composing.current ||
                e.nativeEvent.isComposing ||
                e.nativeEvent.keyCode === 229 ||
                compositionEnded.current
              ) {
                enterHeld.current = true
                return
              }
              if (e.shiftKey) return
              e.preventDefault()
              if (e.repeat || enterHeld.current) return
              enterHeld.current = true
              e.currentTarget.form?.requestSubmit()
            }}
          />
          {!!quotes.length && (
            <div
              className="chat-quote-viewport"
              data-overflow-left={quoteOverflow.left}
              data-overflow-right={quoteOverflow.right}
            >
              <div
                className="chat-quote-list"
                ref={quoteList}
                tabIndex={-1}
                role="group"
                aria-label="선택 문장 첨부"
                title="첨부 조작: Alt+F10 · 방향키로 이동 · Delete로 해제 · Escape로 입력 복귀"
              >
                {quotes.map((quote, index) => (
                  <div
                    className="chat-quote-chip"
                    key={quote.id}
                    onMouseEnter={() => onHoverQuote(quote)}
                    onMouseLeave={() => onHoverQuote(null)}
                    onFocus={() => onHoverQuote(quote)}
                    onBlur={() => onHoverQuote(null)}
                  >
                    <span title={quote.text}>{quote.text}</span>
                    <button
                      type="button"
                      tabIndex={-1}
                      className="chat-quote-remove"
                      aria-label={`선택 문장 ${index + 1} 해제`}
                      title="첨부 해제"
                      onClick={() => onRemoveQuote(quote.id)}
                      onKeyDown={(e) => {
                        const buttons = [
                          ...frame.current!.querySelectorAll<HTMLButtonElement>(
                            '.chat-quote-remove',
                          ),
                        ]
                        if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
                          e.preventDefault()
                          e.stopPropagation()
                          buttons[
                            e.key === 'Home'
                              ? 0
                              : e.key === 'End'
                                ? buttons.length - 1
                                : (index + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) %
                                  buttons.length
                          ]?.focus()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          input.current?.focus()
                        } else if (e.key === 'Delete' || e.key === 'Backspace') {
                          e.preventDefault()
                          onRemoveQuote(quote.id)
                          ;(buttons[index + 1] ?? buttons[index - 1] ?? input.current)?.focus()
                        }
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="chat-submit" ref={submitControl}>
            {activeHere ? (
              <button
                tabIndex={-1}
                type="button"
                className="chat-send"
                aria-label="응답 중지"
                title="응답 중지"
                onClick={() => {
                  void window.desktop
                    .stopPageChat(snapshot!.active!.requestId)
                    .catch(() => setError('응답을 중지하지 못했어요.'))
                }}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                tabIndex={-1}
                type="submit"
                className="chat-send"
                aria-label="전송"
                title={pending ? '요청 준비 중' : '전송 · Enter'}
                disabled={!canSend()}
              >
                {pending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={20} />}
              </button>
            )}
          </div>
        </div>
        {!ready && (
          <div className="chat-connection">
            <span>ChatGPT 연결과 플랜 권한이 필요해요.</span>
            <button tabIndex={-1} type="button" onClick={onSettings}>
              ChatGPT 설정 열기
            </button>
          </div>
        )}
        {snapshot?.active && !activeHere && (
          <p className="muted" role="status">
            다른 페이지의 응답이 진행 중이에요.
          </p>
        )}
        {question.length > CHAT_LIMITS.questionChars && (
          <p className="chat-error" role="alert">
            질문은 8,000자 이하로 입력해 주세요. 입력한 내용은 자르지 않았습니다.
          </p>
        )}
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        {quoteError && (
          <p className="chat-error" role="alert">
            {quoteError}
          </p>
        )}
      </form>
    </section>
  )
})
