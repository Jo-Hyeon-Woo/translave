import {
  CHATGPT_RESPONSE_REASONS,
  CHATGPT_STREAM_PHASES,
  CHATGPT_PARAMETER_LABELS,
  CHATGPT_RESPONSE_MEDIA,
  CHATGPT_RESPONSE_BODY,
  CHATGPT_OUTPUT_ISSUES,
} from '../../shared/chatgpt'
import type { ChatGPTResponseDiagnostic } from '../../shared/chatgpt'
export function ChatGPTDiagnostics({
  diagnostic,
  tabIndex,
}: {
  diagnostic: ChatGPTResponseDiagnostic
  tabIndex?: number
}) {
  return (
    <details className="chatgpt-response-diagnostic">
      <summary tabIndex={tabIndex}>응답 진단</summary>
      <dl>
        <dt>종료 구분</dt>
        <dd>{CHATGPT_RESPONSE_REASONS[diagnostic.reason]}</dd>
        {diagnostic.httpStatus !== undefined && (
          <>
            <dt>HTTP 상태</dt>
            <dd>{diagnostic.httpStatus}</dd>
          </>
        )}
        <dt>마지막 신호</dt>
        <dd>{CHATGPT_STREAM_PHASES[diagnostic.lastPhase]}</dd>
        {diagnostic.outputIssue && (
          <>
            <dt>출력 검사</dt>
            <dd>{CHATGPT_OUTPUT_ISSUES[diagnostic.outputIssue]}</dd>
          </>
        )}
        {diagnostic.mediaType && (
          <>
            <dt>응답 헤더 형식</dt>
            <dd>{CHATGPT_RESPONSE_MEDIA[diagnostic.mediaType]}</dd>
          </>
        )}
        {diagnostic.bodyFormat && (
          <>
            <dt>실제 응답 형태</dt>
            <dd>{CHATGPT_RESPONSE_BODY[diagnostic.bodyFormat]}</dd>
          </>
        )}
        {diagnostic.apiCode && (
          <>
            <dt>서버 오류 코드</dt>
            <dd>{diagnostic.apiCode}</dd>
          </>
        )}
        {diagnostic.parameter && (
          <>
            <dt>관련 항목</dt>
            <dd>{CHATGPT_PARAMETER_LABELS[diagnostic.parameter]}</dd>
          </>
        )}
        {diagnostic.requestId && (
          <>
            <dt>요청 식별자</dt>
            <dd>{diagnostic.requestId}</dd>
          </>
        )}
      </dl>
    </details>
  )
}
