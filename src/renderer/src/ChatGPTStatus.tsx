import type { TranslationSettings } from '../../shared/contracts'
export function ChatGPTStatus({
  settings,
  onOpen,
  sample = false,
  tabIndex,
}: {
  settings: TranslationSettings | null
  onOpen?: () => void
  sample?: boolean
  tabIndex?: number
}) {
  const s = settings?.connection
  const ready =
    !!s?.verified && s.status === 'signed_in' && s.planAllowed && !settings?.authenticationError
  const label = sample
    ? '예시 번역'
    : ready
      ? 'ChatGPT 로그인됨'
      : s?.status === 'restored'
        ? '연결 확인 필요'
        : s?.status === 'expired'
          ? '다시 로그인'
          : s?.status === 'authorizing'
            ? '로그인 중'
            : s?.status === 'signed_in' && !s.planAllowed
              ? '플랜 미허용'
              : '연결 대기'
  const title = ready
    ? s?.reason
      ? 'ChatGPT 로그인됨 · ' + s.reason
      : 'ChatGPT 로그인됨 · 플랜 허용 · 모델 사용 가능 여부는 실제 요청 시 확인합니다.'
    : s?.reason || 'ChatGPT 연결이 필요합니다.'
  return (
    <span
      className="connection-badge"
      role="status"
      aria-label={title + (sample ? ' · 미리 작성된 예시 번역입니다.' : '')}
      title={title + (sample ? ' · 미리 작성된 예시 번역입니다.' : '')}
      data-state={ready ? 'ready' : 'error'}
    >
      <span aria-hidden="true" />
      {!ready && onOpen ? (
        <button
          tabIndex={tabIndex}
          className="connection-wait"
          aria-label="ChatGPT 연결 설정 열기"
          onClick={onOpen}
        >
          {label}
        </button>
      ) : (
        label
      )}
    </span>
  )
}
