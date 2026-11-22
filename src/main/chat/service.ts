import type {
  ChatActionResult,
  ChatActive,
  ChatEvent,
  ChatSend,
  ChatSnapshot,
  ChatTarget,
  ChatTurn,
} from '../../shared/chat'
import { CHAT_ATTACHMENT_MODE, CHAT_LIMITS } from '../../shared/chat'
import type { PageImage, PageResult } from '../../shared/contracts'
import { validImage } from '../batching'
import { pageMetadata } from '../chatgpt/request'
import { ChatGPTService } from '../chatgpt/service'
import { ChatGPTError, safeError } from '../chatgpt/errors'
import { PageChatStore } from './store'
import { ChatInputError, chatRequest, validatedQuotes } from './request'
import type { ChatContent } from './request'

interface Dependencies {
  store: PageChatStore
  auth: ChatGPTService
  target: (target: ChatTarget) => { name: string; total: number }
  model: () => string
  image: (target: ChatTarget, signal: AbortSignal) => Promise<PageImage>
  attachmentMode?: 'page_image' | 'legacy'
  translation: (target: ChatTarget) => PageResult | undefined
  pdf: (target: ChatTarget, signal: AbortSignal) => Promise<Uint8Array>
  notify: (event: ChatEvent) => void
  failure?: (error: unknown) => void
  waitingReason?: () => string
}
type Work = ChatActive & {
  turn: ChatTurn
  answer: string
  controller: AbortController
  timer?: ReturnType<typeof setTimeout>
}
export class PageChatService {
  private current?: Work
  private preparing?: { target: ChatTarget; turnId?: string; controller: AbortController }
  private disposed = false
  constructor(private deps: Dependencies) {}
  private valid(target: ChatTarget) {
    if (
      !target ||
      typeof target.documentId !== 'string' ||
      !Number.isInteger(target.page) ||
      target.page < 1
    )
      throw new ChatInputError('PDF와 페이지를 먼저 선택해 주세요.')
    return this.deps.target(target)
  }
  snapshot(target: ChatTarget): ChatSnapshot {
    this.valid(target)
    const conversationId = this.deps.store.conversation(target)
    const active =
      this.current &&
      !this.current.controller.signal.aborted &&
      ['queued', 'streaming'].includes(this.current.turn.status)
        ? this.current
        : undefined
    return {
      ...target,
      conversationId,
      turns: this.deps.store.turns(conversationId),
      active: active
        ? {
            documentId: active.documentId,
            page: active.page,
            conversationId: active.conversationId,
            turnId: active.turnId,
            requestId: active.requestId,
          }
        : null,
    }
  }
  private owned(work: Work) {
    return (
      !this.disposed &&
      this.current === work &&
      this.deps.store.conversation(work) === work.conversationId
    )
  }
  private notify(work: Work, turn: ChatTurn | null = work.turn) {
    this.deps.notify({
      documentId: work.documentId,
      page: work.page,
      conversationId: work.conversationId,
      turnId: work.turnId,
      requestId: work.requestId,
      turn,
    })
  }
  private flush(work: Work, status = work.turn.status, error = '') {
    clearTimeout(work.timer)
    work.timer = undefined
    if (!this.owned(work)) return
    let updated: ChatTurn | null
    try {
      updated = this.deps.store.update(work.turn, work.answer, status, error)
    } catch {
      throw new ChatGPTError('storage')
    }
    if (updated) {
      work.turn = updated
      this.notify(work)
    }
  }
  async send(input: ChatSend): Promise<ChatActionResult> {
    let release: (() => void) | undefined
    const controller = new AbortController()
    try {
      const doc = this.valid(input)
      input = {
        documentId: input.documentId,
        page: input.page,
        question: input.question,
        attachment: input.attachment,
        retryTurnId: input.retryTurnId,
        quotes: input.quotes,
      }
      if (this.current || this.preparing)
        throw new ChatInputError('진행 중인 채팅을 마치거나 중지한 뒤 전송해 주세요.')
      const imageOnly = (this.deps.attachmentMode ?? CHAT_ATTACHMENT_MODE) === 'page_image'
      if (
        (!imageOnly && !['none', 'page', 'pdf'].includes(input.attachment ?? 'none')) ||
        typeof input.question !== 'string'
      )
        throw new ChatInputError('질문과 첨부 옵션을 확인해 주세요.')
      const s = this.deps.auth.snapshot()
      if (!s.verified || !s.planAllowed || s.status !== 'signed_in')
        throw new ChatInputError('설정에서 ChatGPT 연결과 플랜 사용 권한을 확인해 주세요.')
      const waiting = this.deps.waitingReason?.()
      if (waiting) throw new ChatInputError(waiting)
      const model = this.deps.model()
      const conversation = this.deps.store.conversation(input)
      const turns = this.deps.store.turns(conversation)
      let question = input.question.trim()
      let quotes = input.quotes
      if (input.retryTurnId) {
        const last = turns.at(-1)
        if (!last || last.id !== input.retryTurnId || !['error', 'stopped'].includes(last.status))
          throw new ChatInputError('마지막 실패하거나 중단된 질문만 다시 시도할 수 있어요.')
        question = last.question
        quotes = last.attachment.quotes
      }
      const selected = validatedQuotes(quotes, input, turns)
      for (const quote of selected) quote.source.documentName = doc.name
      if (!question || question.length > CHAT_LIMITS.questionChars)
        throw new ChatInputError('질문은 1–8,000자로 입력해 주세요.')
      chatRequest(model, turns, question, [], undefined, undefined, selected)
      // Reserve before asynchronous PDF preparation, so no subsequent translation can jump ahead.
      release = this.deps.auth.reserveChat()
      this.preparing = {
        target: { documentId: input.documentId, page: input.page },
        turnId: input.retryTurnId,
        controller,
      }
      const content: ChatContent[] = []
      let pdf: { bytes: number; pages: number } | undefined
      let image: PageImage | undefined
      if (imageOnly) {
        try {
          image = await this.deps.image(
            { documentId: input.documentId, page: input.page },
            controller.signal,
          )
          controller.signal.throwIfAborted()
          if (!validImage(image)) throw new Error('invalid image')
        } catch {
          controller.signal.throwIfAborted()
          throw new ChatInputError(
            '페이지 이미지를 만들지 못했어요. 원본 PDF를 확인하고 다시 시도해 주세요.',
          )
        }
        content.push(
          {
            type: 'input_text',
            text: JSON.stringify({
              documentName: doc.name,
              ...pageMetadata(input.page),
              attachment: 'page_image',
            }),
          },
          {
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.data}`,
            detail: 'high',
          },
        )
      }
      // Preserved legacy attachments are reachable only through the explicit internal policy.
      if (!imageOnly && input.attachment === 'page') {
        const result = this.deps.translation(input)
        if (result?.status !== 'done')
          throw new ChatInputError(
            '이 페이지의 완료된 번역이 없어요. 번역을 기다리거나 첨부 옵션을 바꿔 주세요.',
          )
        const markdown = result.content?.translationMarkdown ?? result.text
        const visuals = result.content?.visualElements ?? []
        if (!markdown.trim() && !visuals.length)
          throw new ChatInputError('첨부할 번역 내용이 없어요. 첨부 옵션을 바꿔 주세요.')
        content.push({
          type: 'input_text',
          text: JSON.stringify({
            documentName: doc.name,
            page: input.page,
            translatedContent: { translationMarkdown: markdown, visualElements: visuals },
          }),
        })
      }
      if (!imageOnly && input.attachment === 'pdf') {
        let bytes: Uint8Array | undefined
        try {
          bytes = await this.deps.pdf(input, controller.signal)
          controller.signal.throwIfAborted()
          if (bytes.byteLength > CHAT_LIMITS.pdfBytes)
            throw new ChatInputError('전체 PDF 첨부는 10 MiB 이하만 지원해요.')
          pdf = { bytes: bytes.byteLength, pages: doc.total }
          content.push({
            type: 'input_text',
            text: JSON.stringify({
              documentName: doc.name,
              page: input.page,
              attachment: 'full_pdf',
            }),
          })
          content.push({
            type: 'input_file',
            filename: doc.name,
            file_data: 'data:application/pdf;base64,' + Buffer.from(bytes).toString('base64'),
          })
        } finally {
          bytes = undefined
        }
      }
      const body = chatRequest(model, turns, question, content, pdf, image, selected)
      image = undefined
      controller.signal.throwIfAborted()
      const conversationId = this.deps.store.conversation(input, true)!
      const turn = this.deps.store.start(
        conversationId,
        question,
        model,
        {
          kind: imageOnly ? 'page_image' : (input.attachment ?? 'none'),
          documentId: input.documentId,
          documentName: doc.name,
          page: input.page,
          ...(selected.length ? { quotes: selected } : {}),
        },
        input.retryTurnId,
      )
      const work: Work = {
        documentId: input.documentId,
        page: input.page,
        conversationId,
        requestId: turn.requestId,
        turnId: turn.id,
        turn,
        answer: '',
        controller,
      }
      this.current = work
      this.preparing = undefined
      const unlock = release
      release = undefined
      this.notify(work)
      void this.run(work, body, unlock).catch(() => {})
      return { status: 'ok', snapshot: this.snapshot(input) }
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof ChatInputError
            ? error.message
            : controller.signal.aborted
              ? '요청 준비를 중지했어요.'
              : '채팅 요청을 준비하지 못했어요. 연결과 로컬 저장소를 확인해 주세요.',
      }
    } finally {
      release?.()
      if (this.preparing?.controller === controller) this.preparing = undefined
    }
  }
  private async run(work: Work, body: string, release: () => void) {
    try {
      const answer = await this.deps.auth.inferChat(
        work.turn.model,
        body,
        (text) => {
          if (!this.owned(work) || work.controller.signal.aborted) return
          work.answer = text
          if (!work.timer)
            work.timer = setTimeout(() => {
              try {
                this.flush(work, 'streaming')
              } catch {
                work.controller.abort(new ChatGPTError('storage'))
              }
            }, 50)
        },
        work.controller.signal,
        () => {
          if (this.owned(work) && !work.controller.signal.aborted) this.flush(work, 'streaming')
        },
      )
      if (this.owned(work) && !work.controller.signal.aborted) {
        work.answer = answer
        this.flush(work, 'complete')
      }
    } catch (error) {
      if (this.owned(work)) {
        const aborted = work.controller.signal.aborted
        const e = safeError(aborted ? work.controller.signal.reason : error)
        const stopped = aborted && e.code === 'canceled'
        if (!stopped) this.deps.failure?.(error)
        const message =
          e.code === 'storage'
            ? '대화를 로컬 저장소에 저장하지 못했어요.'
            : stopped
              ? '응답을 중지했어요.'
              : e.code === 'invalid'
                ? '응답 형식을 확인하지 못했어요.'
                : e.code === 'incomplete'
                  ? '응답이 완성되기 전에 종료됐어요.'
                  : e.code === 'model'
                    ? '이 모델이나 첨부 형식을 사용할 수 없어요. 모델과 이미지 설정을 확인해 주세요.'
                    : e.message
        try {
          this.flush(work, stopped ? 'stopped' : 'error', message)
        } catch {
          this.notify(work, {
            ...work.turn,
            answer: work.answer,
            status: 'error',
            error: '대화를 저장하지 못했어요.',
            revision: work.turn.revision + 1,
          })
        }
      }
    } finally {
      clearTimeout(work.timer)
      body = ''
      if (this.current === work) this.current = undefined
      release()
    }
  }
  stop(requestId: string) {
    const work = this.current
    if (!work || work.requestId !== requestId) return
    work.controller.abort(new ChatGPTError('canceled'))
    try {
      this.flush(work, 'stopped', '응답을 중지했어요.')
    } catch {
      /* Fixed failure is surfaced by run. */
    }
  }
  clear(target: ChatTarget) {
    this.valid(target)
    const work = this.current
    if (
      this.preparing?.target.documentId === target.documentId &&
      this.preparing.target.page === target.page
    )
      this.preparing.controller.abort(new ChatGPTError('canceled'))
    if (work?.documentId === target.documentId && work.page === target.page)
      this.stop(work.requestId)
    this.deps.store.clear(target)
    if (work?.documentId === target.documentId && work.page === target.page) this.notify(work, null)
    return this.snapshot(target)
  }
  deleteTurn(target: ChatActive): ChatActionResult {
    try {
      this.valid(target)
      if (
        ![target.conversationId, target.turnId, target.requestId].every(
          (id) => typeof id === 'string' && id.length > 0 && id.length <= 100,
        )
      )
        throw new ChatInputError('삭제할 대화를 확인해 주세요.')
      const conversationId = this.deps.store.conversation(target)
      const turn = this.deps.store.turns(conversationId).find((t) => t.id === target.turnId)
      if (conversationId !== target.conversationId || !turn || turn.requestId !== target.requestId)
        throw new ChatInputError('대화가 변경됐어요. 다시 선택해 주세요.')
      if (
        ['queued', 'streaming'].includes(turn.status) ||
        this.current?.turnId === turn.id ||
        (this.preparing?.turnId === turn.id &&
          this.preparing.target.documentId === target.documentId &&
          this.preparing.target.page === target.page)
      )
        throw new ChatInputError('응답이 끝나거나 중지 처리가 완료된 뒤 삭제해 주세요.')
      if (!this.deps.store.deleteTurn(target))
        throw new ChatInputError('대화가 변경됐어요. 다시 선택해 주세요.')
      this.deps.notify({ ...target, turn: null, deleted: true })
      return { status: 'ok', snapshot: this.snapshot(target) }
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof ChatInputError
            ? error.message
            : '대화를 삭제하지 못했어요. 로컬 저장소를 확인해 주세요.',
      }
    }
  }
  cancelAll() {
    this.preparing?.controller.abort(new ChatGPTError('canceled'))
    if (this.current) this.stop(this.current.requestId)
  }
  removeDocuments(ids: readonly string[]) {
    if (this.preparing && ids.includes(this.preparing.target.documentId))
      this.preparing.controller.abort(new ChatGPTError('canceled'))
    const work = this.current
    if (work && ids.includes(work.documentId)) {
      // The DB transaction has committed. Invalidate ownership before abort callbacks run.
      this.current = undefined
      clearTimeout(work.timer)
      work.controller.abort(new ChatGPTError('canceled'))
    }
  }
  dispose() {
    this.cancelAll()
    this.disposed = true
    this.current = undefined
  }
}
