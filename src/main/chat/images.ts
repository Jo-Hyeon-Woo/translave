import { randomUUID } from 'node:crypto'
import type { ChatTarget } from '../../shared/chat'
import type { ImageSettings, OpenResult, PageImage } from '../../shared/contracts'
import { ImageBridge } from '../imageBridge'

// Opaque tickets own a frozen document/page and a separate worker PDF lifetime.
export class PageChatImages {
  private tickets = new Map<string, { target: ChatTarget; signal: AbortSignal }>()
  constructor(
    private deps: {
      bridge: ImageBridge
      images: () => ImageSettings
      read: (target: ChatTarget) => Promise<OpenResult>
      cancel: (ticket: string) => void
    },
  ) {}
  async source(ticket: string): Promise<OpenResult> {
    const owned = this.tickets.get(ticket)
    if (!owned || owned.signal.aborted)
      return { status: 'error', message: '페이지 이미지 요청이 만료됐어요.' }
    let result: OpenResult
    try {
      result = await this.deps.read(owned.target)
    } catch {
      return { status: 'error', message: '원본 PDF를 읽을 수 없어요.' }
    }
    if (this.tickets.get(ticket) !== owned || owned.signal.aborted)
      return { status: 'error', message: '페이지 이미지 요청이 만료됐어요.' }
    if (result.status !== 'opened' || result.document.id !== owned.target.documentId)
      return { status: 'error', message: '원본 PDF를 확인해 주세요.' }
    return result
  }
  async render(target: ChatTarget, signal: AbortSignal): Promise<PageImage> {
    signal.throwIfAborted()
    const ticket = randomUUID()
    this.tickets.set(ticket, { target: { ...target }, signal })
    const cancel = () => this.deps.cancel(ticket)
    signal.addEventListener('abort', cancel, { once: true })
    try {
      return await this.deps.bridge.request(
        {
          session: 'page-chat',
          token: ticket,
          source: {
            page: target.page,
            part: 1,
            width: 1,
            height: 1,
            outputTokens: 2048,
            region: { x: 0, y: 0, width: 1, height: 1 },
            order: [],
          },
          images: { ...this.deps.images() },
        },
        signal,
      )
    } finally {
      this.tickets.delete(ticket)
      signal.removeEventListener('abort', cancel)
      cancel()
    }
  }
}
