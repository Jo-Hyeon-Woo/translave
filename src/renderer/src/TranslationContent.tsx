import Markdown from 'react-markdown'
import { memo } from 'react'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { remarkMathPolicy, rehypeSafeKatex } from './markdownMath'
import 'katex/dist/katex.min.css'
import type { PageResult } from '../../shared/contracts'

export const SafeMarkdown = memo(function SafeMarkdown({
  text,
  tabIndex,
}: {
  text: string
  tabIndex?: number
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath, remarkMathPolicy]}
      rehypePlugins={[rehypeSafeKatex]}
      skipHtml
      urlTransform={() => ''}
      components={{
        img: () => null,
        a: ({ children }) => <span>{children}</span>,
        div: ({ node: _node, ...props }) => (
          <div
            {...props}
            tabIndex={
              props.className?.split(' ').includes('app-math-block') ? tabIndex : props.tabIndex
            }
          />
        ),
        span: ({ node: _node, ...props }) => (
          <span
            {...props}
            tabIndex={
              props.className?.split(' ').includes('app-math-inline') ? tabIndex : props.tabIndex
            }
          />
        ),
        pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={tabIndex} />,
        table: ({ children }) => (
          <div className="markdown-table-scroll" tabIndex={tabIndex}>
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  )
})
export function TranslationContent({
  result,
  tabIndex,
}: {
  result: PageResult
  tabIndex?: number
}) {
  if (result.status !== 'done' && result.status !== 'error') return null
  const content = result.content
  const markdown = content?.translationMarkdown ?? (result.status === 'done' ? result.text : '')
  return (
    <div data-testid="live-translation">
      {markdown && (
        <article className="translation-content markdown-content">
          <SafeMarkdown text={markdown} tabIndex={tabIndex} />
        </article>
      )}
      {!markdown && result.status === 'done' && (
        <div className="translation-state" role="status">
          <p>
            {content?.contentType === 'blank'
              ? '빈 페이지입니다.'
              : '시각 요소 설명을 확인해 주세요.'}
          </p>
        </div>
      )}
      {result.status === 'error' && (
        <div className="translation-state translation-error" role="alert">
          <p>{result.message}</p>
        </div>
      )}
      {result.provenance && (
        <details className="translation-details" data-testid="translation-provenance">
          <summary tabIndex={tabIndex}>번역 출처</summary>
          <p>
            {result.provenance.provider === 'gemini' ? 'Gemini' : 'ChatGPT'} ·{' '}
            {result.provenance.model}
            {result.provenance.legacy ? ' · 기존 저장 결과' : ''}
          </p>
        </details>
      )}
      {content && (content.visualElements.length > 0 || content.readingNotes.length > 0) && (
        <details className="translation-details" data-testid="translation-metadata">
          <summary tabIndex={tabIndex}>추가 설명 · 읽기 정보</summary>
          {content.visualElements.map((element) => (
            <section key={element.id} className="visual-description">
              <h3>{element.location}</h3>
              <SafeMarkdown text={element.descriptionMarkdown} tabIndex={tabIndex} />
            </section>
          ))}
          {content.readingNotes.length > 0 && (
            <ul>
              {content.readingNotes.map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          )}
        </details>
      )}
      {content && content.unclearRegions.length > 0 && (
        <details
          className="translation-details unclear-details"
          data-testid="unclear-regions"
          open={result.status === 'error'}
        >
          <summary tabIndex={tabIndex}>판독 문제 · {content.unclearRegions.length}곳</summary>
          <ul>
            {content.unclearRegions.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}
