export type ChatAttachment = 'none' | 'page' | 'pdf'
// Legacy selection remains available to the preserved implementation, never the active IPC path.
export const CHAT_ATTACHMENT_MODE: 'page_image' | 'legacy' = 'page_image'
export type ChatTurnStatus = 'queued' | 'streaming' | 'complete' | 'error' | 'stopped'
export interface ChatQuote {
  id: string
  text: string
  source: ChatTarget & { documentName: string } & (
      | { kind: 'pdf'; start: number; end: number }
      | {
          kind: 'chat'
          ranges: { turnId: string; role: 'user' | 'assistant'; start: number; end: number }[]
        }
    )
}
export interface ChatAttachmentInfo {
  kind: ChatAttachment | 'page_image'
  documentId: string
  documentName: string
  page: number
  quotes?: ChatQuote[]
}
export interface ChatTurn {
  id: string
  requestId: string
  conversationId: string
  question: string
  answer: string
  status: ChatTurnStatus
  model: string
  attachment: ChatAttachmentInfo
  error: string
  revision: number
}
export interface ChatTarget {
  documentId: string
  page: number
}
export interface ChatActive extends ChatTarget {
  requestId: string
  conversationId: string
  turnId: string
}
export interface ChatSnapshot extends ChatTarget {
  conversationId: string | null
  turns: ChatTurn[]
  active: ChatActive | null
}
export interface ChatEvent extends ChatActive {
  turn: ChatTurn | null
  deleted?: true
}
export interface ChatSend extends ChatTarget {
  question: string
  attachment?: ChatAttachment
  retryTurnId?: string
  quotes?: ChatQuote[]
}
export type ChatActionResult =
  { status: 'ok'; snapshot: ChatSnapshot } | { status: 'error'; message: string }
export interface PageChatAPI {
  pageChatImageSource: (ticket: string) => Promise<import('./contracts').OpenResult>
  onPageChatImageCanceled: (callback: (ticket: string) => void) => () => void
  pageChat: (target: ChatTarget) => Promise<ChatActionResult>
  sendPageChat: (input: ChatSend) => Promise<ChatActionResult>
  stopPageChat: (requestId: string) => Promise<void>
  clearPageChat: (target: ChatTarget) => Promise<ChatActionResult>
  deletePageChatTurn: (target: ChatActive) => Promise<ChatActionResult>
  onPageChat: (callback: (event: ChatEvent) => void) => () => void
}
export const CHAT_LIMITS = Object.freeze({
  questionChars: 8000,
  answerChars: 131072,
  pdfBytes: 10 * 1024 * 1024,
  requestBytes: 16 * 1024 * 1024,
  inputTokens: 131072,
  outputReserve: 16384,
  quotes: 32,
  quoteChars: 65536,
})
