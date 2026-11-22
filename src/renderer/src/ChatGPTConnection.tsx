import logo from './assets/chatgpt-logo-white.svg'
import { useState } from 'react'
import { Check, RefreshCw } from 'lucide-react'
import type { ChatGPTSnapshot } from '../../shared/chatgpt'
export function chatgptLabel(s: ChatGPTSnapshot | null): string {
  if (!s) return '불러오는 중'
  if (s.status === 'authorizing') return '브라우저 로그인 중'
  if (s.status === 'restored') return '저장된 연결 · 확인 필요'
  if (s.status === 'expired') return '다시 로그인 필요'
  if (s.status === 'signed_in')
    return s.planAllowed ? '로그인됨 · 플랜 허용' : '로그인됨 · 플랜 미허용'
  return '연결 대기'
}
export function ChatGPTConnection({
  state,
  refresh,
  onConfirm,
}: {
  state: ChatGPTSnapshot | null
  refresh: (state: ChatGPTSnapshot) => void
  onConfirm: () => void
}) {
  const [pending, setPending] = useState(false)
  const [localError, setLocalError] = useState('')
  const run = async (action: () => Promise<ChatGPTSnapshot>) => {
    if (pending) return
    setPending(true)
    setLocalError('')
    try {
      refresh(await action())
    } catch {
      setLocalError('연결 작업을 마치지 못했어요. 다시 시도해 주세요.')
    } finally {
      setPending(false)
    }
  }
  const authorizing = state?.status === 'authorizing'
  const signedIn = state?.status === 'signed_in' || state?.status === 'restored'
  const busy = pending || state?.busy || authorizing
  const label = authorizing ? '로그인 취소' : signedIn ? 'ChatGPT 로그아웃' : 'ChatGPT로 로그인'
  const model = state?.selectedModel ?? state?.models.find((m) => m.supported)?.slug ?? ''
  return (
    <div className="chatgpt-connection settings-form">
      <div className="settings-row-scroll">
        <div className="settings-control-row">
          <div className="settings-row-left">
            <button
              type="button"
              className="button chatgpt-signin"
              disabled={!state || (!authorizing && (pending || (!signedIn && !!busy)))}
              onClick={() => {
                if (authorizing) {
                  void window.desktop
                    .chatgptCancel()
                    .then(refresh)
                    .catch(() => setLocalError('로그인을 취소하지 못했어요.'))
                } else {
                  void run(() =>
                    signedIn
                      ? window.desktop.chatgptLogout()
                      : window.desktop.chatgptSignIn(state?.activeId ?? undefined),
                  )
                }
              }}
            >
              <img src={logo} width="18" height="18" alt="" aria-hidden="true" />
              {label}
            </button>
            <select
              className="chatgpt-model"
              aria-label="ChatGPT 번역 모델"
              value={model}
              disabled={pending || authorizing || !state?.models.length}
              onChange={(e) => void run(() => window.desktop.chatgptChooseModel(e.target.value))}
            >
              {!model && <option value="">모델 선택</option>}
              {state?.models.map((m) => (
                <option key={m.slug} value={m.slug} disabled={!m.supported}>
                  {m.name}
                  {m.supported ? '' : ' · 기능 미확인'}
                </option>
              ))}
            </select>
          </div>
          <div className="settings-row-actions">
            <button
              type="button"
              className="settings-icon-button settings-refresh"
              title="모델 목록 확인"
              aria-label="모델 목록 확인"
              disabled={!!busy || !state?.planAllowed}
              onClick={() => void run(() => window.desktop.chatgptModels())}
            >
              <RefreshCw size={16} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="settings-icon-button settings-confirm"
              title="ChatGPT 연결 확인"
              aria-label="ChatGPT 연결 확인"
              onClick={onConfirm}
            >
              <Check size={17} aria-hidden="true" />
            </button>
          </div>
        </div>
      </div>
      {busy && (
        <p className="settings-status" role="status">
          {authorizing ? '브라우저에서 로그인을 진행해 주세요.' : '연결 작업 중이에요.'}
        </p>
      )}
      {state?.notice && state.status !== 'signed_in' && (
        <p className="settings-status" role="status">
          {state.notice}
        </p>
      )}
      {(localError || state?.error || (signedIn && !state?.planAllowed)) && (
        <p className="settings-error" role="alert">
          {localError || state?.error?.message || '로그인했지만 ChatGPT 플랜 사용 권한이 없어요.'}
        </p>
      )}
    </div>
  )
}
