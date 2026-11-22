import { CHATGPT_RESPONSE_REASONS } from '../../shared/chatgpt'
import type { ChatGPTErrorCode, ChatGPTResponseDiagnostic } from '../../shared/chatgpt'
const messages: Record<ChatGPTErrorCode, string> = {
  canceled: '로그인을 취소했어요.',
  expired: '로그인이 만료되었거나 권한이 철회되었어요. 다시 로그인해 주세요.',
  auth: '로그인 응답을 확인하지 못했어요. 다시 로그인해 주세요.',
  permission: 'ChatGPT 플랜 사용 권한이 없어요. 로그인에서 권한과 계정 플랜을 확인해 주세요.',
  model: '선택한 모델이나 이미지·JSON 요청 형식을 이 연결에서 사용할 수 없어요.',
  quota: 'ChatGPT 사용량 한도 또는 요청 제한에 도달했어요. 사용량 관리를 확인해 주세요.',
  network: '네트워크 연결을 확인하고 다시 시도해 주세요.',
  unavailable: 'ChatGPT 사용 가능 여부를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.',
  incomplete: '응답이 완성되기 전에 종료되었어요. 다시 확인해 주세요.',
  invalid: '번역 JSON의 형식이나 페이지 정보를 확인하지 못했어요.',
  storage: '안전한 인증 저장소를 읽거나 저장하지 못했어요.',
  busy: '진행 중인 작업이 끝난 후 다시 시도해 주세요.',
  image: '현재 페이지 이미지를 준비하지 못했어요. 페이지 크기와 파일을 확인해 주세요.',
}
export class ChatGPTError extends Error {
  constructor(
    readonly code: ChatGPTErrorCode,
    readonly clearCredentials = false,
    readonly diagnostic?: ChatGPTResponseDiagnostic,
  ) {
    super(
      diagnostic && ['incomplete', 'invalid', 'network'].includes(code)
        ? CHATGPT_RESPONSE_REASONS[diagnostic.reason]
        : messages[code],
    )
  }
}
export function safeError(error: unknown) {
  const e = error instanceof ChatGPTError ? error : new ChatGPTError('network')
  return { code: e.code, message: e.message, ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}) }
}
export async function checkResponse(response: Response): Promise<void> {
  if (response.ok) return
  let code = ''
  try {
    const body = await response.json()
    code = body?.error?.code ?? body?.error ?? ''
  } catch {
    /* No server error text is propagated. */
  }
  throw apiError(response.status, code)
}
export function apiError(status: number, code: unknown): ChatGPTError {
  if (
    status === 429 ||
    code === 'rate_limit_exceeded' ||
    code === 'subscription_sharing_usage_limit_exceeded'
  )
    return new ChatGPTError('quota')
  if (
    ['subscription_sharing_usage_unavailable', 'subscription_sharing_user_unavailable'].includes(
      String(code),
    )
  )
    return new ChatGPTError('unavailable')
  if (
    [
      'invalid_grant',
      'invalid_refresh_token',
      'token_expired',
      'refresh_token_expired',
      'refresh_token_invalidated',
      'refresh_token_reused',
    ].includes(String(code))
  )
    return new ChatGPTError('expired', true)
  if (code === 'invalid_client') return new ChatGPTError('auth')
  if (status === 401 || code === 'invalid_token' || code === 'subscription_sharing_invalid_user')
    return new ChatGPTError('expired')
  if (
    [
      'model_not_found',
      'invalid_request_error',
      'unsupported_parameter',
      'subscription_sharing_unsupported_capability',
      'subscription_sharing_route_not_supported',
    ].includes(String(code))
  )
    return new ChatGPTError('model')
  if (
    status === 403 ||
    [
      'insufficient_scope',
      'subscription_sharing_not_enabled',
      'subscription_sharing_user_not_eligible',
      'chatpass_v2_scope_not_authorized',
      'chatpass_v2_invalid_authorization_context',
    ].includes(String(code))
  )
    return new ChatGPTError('permission')
  if (status === 400 || status === 404) return new ChatGPTError('model')
  if (status === 503) return new ChatGPTError('unavailable')
  return new ChatGPTError('network')
}
