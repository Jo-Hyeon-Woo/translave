import type { PageResult } from './contracts'

export type ChatGPTErrorCode =
  | 'canceled'
  | 'expired'
  | 'auth'
  | 'permission'
  | 'model'
  | 'quota'
  | 'network'
  | 'unavailable'
  | 'incomplete'
  | 'invalid'
  | 'storage'
  | 'busy'
  | 'image'
export const CHATGPT_RESPONSE_REASONS = {
  unexpected_format: '번역 서버에서 스트림 대신 다른 응답 형식을 받았어요.',
  missing_completion: '서버의 번역 완료 신호를 받기 전에 응답 연결이 닫혔어요.',
  server_incomplete: '서버가 번역을 완료하지 못했다고 알려왔어요.',
  output_limit: '서버의 출력 한도에 도달해 번역이 중단됐어요.',
  content_filter: '서버의 콘텐츠 처리 제한으로 번역이 중단됐어요.',
  invalid_completion: '완료 신호와 응답 상태가 일치하지 않아 결과를 사용하지 않았어요.',
  invalid_output: '완료 응답의 번역 결과 형식을 확인하지 못했어요.',
  invalid_json: '번역 JSON의 형식이나 페이지 정보를 확인하지 못했어요.',
  invalid_event: '서버의 응답 이벤트 형식을 확인하지 못했어요.',
  connection_lost: '번역 응답을 받던 중 네트워크 연결이 끊겼어요.',
  timeout: '번역 확인의 3분 대기시간이 지났어요.',
  server_error: '서버가 번역 요청에 오류를 반환했어요.',
} as const
export const CHATGPT_STREAM_PHASES = {
  none: '아직 받지 못함',
  started: '응답 시작',
  generating: '응답 생성 중',
  text: '번역문 수신 중',
  item_done: '출력 항목 수신 완료',
  completed: '응답 완료',
  failed: '서버 오류',
  incomplete: '서버의 불완전 종료',
  other: '기타 응답 신호',
} as const
export const CHATGPT_DIAGNOSTIC_CODES = [
  'rate_limit_exceeded',
  'invalid_request_error',
  'unsupported_parameter',
  'model_not_found',
  'invalid_token',
  'subscription_sharing_usage_limit_exceeded',
  'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_unavailable',
  'subscription_sharing_user_not_eligible',
  'subscription_sharing_unsupported_capability',
  'subscription_sharing_route_not_supported',
  'subscription_sharing_invalid_user',
  'chatpass_v2_scope_not_authorized',
  'chatpass_v2_invalid_authorization_context',
  'insufficient_scope',
  'server_error',
] as const
export const CHATGPT_PARAMETER_LABELS = {
  model: '모델',
  format: 'JSON 출력 설정',
  image: '이미지 입력',
  input: '입력 형식',
  instructions: '번역 지시문',
} as const
export const CHATGPT_RESPONSE_MEDIA = {
  sse: 'text/event-stream',
  json: 'JSON',
  html: 'HTML',
  text: '일반 텍스트',
  binary: '바이너리',
  missing: '헤더 없음',
  other: '기타',
} as const
export const CHATGPT_RESPONSE_BODY = {
  sse: '이벤트 스트림',
  api_error: 'API 오류 JSON',
  detail: '직접 경로 안내 JSON',
  response: '비스트림 응답 JSON',
  json: '기타 JSON',
  invalid_json: '불완전하거나 잘못된 JSON',
  html: 'HTML 문서',
  text: '기타 텍스트',
  empty: '빈 응답',
} as const
export const CHATGPT_OUTPUT_ISSUES = {
  missing: '완료 출력 배열 누락 또는 형식 오류',
  empty: '완성된 번역 메시지 없음',
  item: '출력 항목 형식 오류',
  kind: '지원하지 않는 출력 항목',
  status: '개별 메시지가 완료 상태가 아님',
  role: 'assistant 메시지가 아님',
  phase: '메시지 단계 형식 오류',
  content: '메시지 본문 형식 오류',
  refusal: '번역 대신 거절 응답을 받음',
  duplicate: '중복된 출력 항목',
  identity: '응답 또는 출력 항목 식별자 불일치',
  unfinished: '수집된 출력 항목의 완료 확인 불가',
} as const
export interface ChatGPTResponseDiagnostic {
  reason: keyof typeof CHATGPT_RESPONSE_REASONS
  httpStatus?: number
  lastPhase: keyof typeof CHATGPT_STREAM_PHASES
  requestId?: string
  apiCode?: (typeof CHATGPT_DIAGNOSTIC_CODES)[number]
  parameter?: keyof typeof CHATGPT_PARAMETER_LABELS
  mediaType?: keyof typeof CHATGPT_RESPONSE_MEDIA
  bodyFormat?: keyof typeof CHATGPT_RESPONSE_BODY
  outputIssue?: keyof typeof CHATGPT_OUTPUT_ISSUES
  retryAfterMs?: number
}
export interface ChatGPTModel {
  slug: string
  name: string
  supported: boolean
}
export interface ChatGPTTrial {
  documentId: string
  documentName: string
  page: number
  model: string
  result: PageResult
}
export interface ChatGPTSnapshot {
  selectedModel?: string
  status: 'disconnected' | 'authorizing' | 'restored' | 'signed_in' | 'expired'
  profiles: { id: string; label: string }[]
  activeId: string | null
  planAllowed: boolean
  verified: boolean
  models: ChatGPTModel[]
  busy: boolean
  error?: { code: ChatGPTErrorCode; message: string; diagnostic?: ChatGPTResponseDiagnostic }
  notice?: string
  trial?: ChatGPTTrial
}
export interface ChatGPTAPI {
  chatgptChooseModel: (model: string) => Promise<ChatGPTSnapshot>
  onChatGPTRenderCanceled: (callback: (ticket: string) => void) => () => void
  chatgptSnapshot: () => Promise<ChatGPTSnapshot>
  chatgptSignIn: (profileId?: string) => Promise<ChatGPTSnapshot>
  chatgptCancel: () => Promise<ChatGPTSnapshot>
  chatgptLogout: () => Promise<ChatGPTSnapshot>
  chatgptModels: () => Promise<ChatGPTSnapshot>
  chatgptTranslate: (input: {
    documentId: string
    page: number
    model: string
  }) => Promise<ChatGPTSnapshot>
  chatgptSource: (ticket: string) => Promise<import('./contracts').OpenResult>
  chatgptUsage: () => Promise<void>
}
