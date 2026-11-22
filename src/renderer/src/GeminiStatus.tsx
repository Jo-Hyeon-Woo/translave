import type { TranslationSettings } from '../../shared/contracts'

export function GeminiStatus({
  settings,
  failed,
  sample = false,
  onOpen,
}: {
  settings: TranslationSettings | null
  failed: boolean
  sample?: boolean
  onOpen?: () => void
}) {
  const auth = !!settings?.authenticationError
  const ready = !!settings?.configured && !failed && !auth
  const status = failed
    ? 'Gemini 키 설정 실패'
    : !settings?.configured
      ? 'Gemini API 키 미설정'
      : auth
        ? 'Gemini 인증 또는 접근 권한 오류'
        : 'Gemini 키 적용됨 · 실제 인증 확인과는 별개입니다.'
  const label = failed
    ? '설정 실패'
    : auth && settings?.configured
      ? '접근 오류'
      : settings?.configured
        ? 'Gemini 설정됨'
        : sample
          ? '예시 번역'
          : '연결 대기'
  return (
    <span
      className="connection-badge"
      role="status"
      aria-label={status}
      title={sample ? status + ' · 미리 작성된 예시 번역입니다.' : status}
      data-state={ready ? 'ready' : 'error'}
    >
      <span aria-hidden="true" />
      {label === '연결 대기' && onOpen ? (
        <button className="connection-wait" aria-label="Gemini API 키 설정 열기" onClick={onOpen}>
          {label}
        </button>
      ) : (
        label
      )}
    </span>
  )
}
