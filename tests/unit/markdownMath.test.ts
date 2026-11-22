import type { PageTranslation } from '../../src/shared/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SafeMarkdown, TranslationContent } from '../../src/renderer/src/TranslationContent'
import { basicMath, richMath, moneyAndCode, unsafeMath, visualMath } from '../fixtures/math'
import { MATH_LIMITS } from '../../src/renderer/src/markdownMath'
import { instruction, TranslationService } from '../../src/main/translation'
import { TranslationQueue } from '../../src/main/queue'
import { TranslationStore } from '../../src/main/store'
import { TRANSLATION_VERSION } from '../../src/shared/contracts'
import { content, envelope, fakeRender, imagePage, sources } from './fakes'
const render = (text: string) => renderToStaticMarkup(createElement(SafeMarkdown, { text }))
const mathCount = (html: string) => (html.match(/class="katex"/g) || []).length

describe('safe Markdown math', () => {
  it('renders the requested inline expressions and richer math in headings, lists, tables and blocks with MathML', () => {
    expect(mathCount(render(basicMath))).toBe(4)
    const html = render(richMath)
    expect(mathCount(html)).toBe(11)
    expect(html).toContain('<math ')
    expect(html).toContain('application/x-tex')
    expect(html).toContain('katex-html')
    expect(html).toContain('app-math-block')
    expect(html).not.toContain('math-literal')
    expect(html).toContain('Unicode × → ⇒ 그대로')
  })
  it('keeps currency, escaped dollars, inline code and all fenced code literal', () => {
    const html = render(moneyAndCode)
    expect(mathCount(html)).toBe(0)
    expect(html).toContain('금액 $5와 $10, 달러 $1,200.50, 금액 $20.00.')
    expect(html).toContain('<code>$4 \\times 128$</code>')
    expect(html).toContain('<pre><code class="language-math">$4 \\times 128$')
    expect(mathCount(render(String.raw`통화 $5 and $10, 수식 $x^2$`))).toBe(1)
    expect(mathCount(render(String.raw`숫자 $5$`))).toBe(1)
  })
  it('retains surrounding prose and the exact source of invalid/unsupported/oversized math without leaking diagnostics', () => {
    const spies = ['log', 'info', 'debug', 'warn', 'error'].map((key) =>
      vi.spyOn(console, key as 'log').mockImplementation(() => {}),
    )
    try {
      const html = render(unsafeMath)
      expect(html).toContain('정상 앞')
      expect(html).toContain('정상 뒤')
      expect(html).toContain('math-literal')
      expect(html).toContain('기밀수식')
      expect(html).not.toMatch(/<(?:script|img|a)(?: |>)/)
      expect(html).not.toContain('class="unsafe"')
      expect(html).toContain('수식로그비밀') // readable fallback only, never a console diagnostic
      expect(render('$' + 'x'.repeat(MATH_LIMITS.maxLength + 1) + '$')).toContain('math-literal')
      expect(render('$\\privateMacro$')).toContain('math-literal')
      for (const spy of spies) expect(spy).not.toHaveBeenCalled()
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
  it('recovers paragraphs/headings after an unclosed display fence, and leaves undelimited/legacy notation literal', () => {
    const html = render('$$\n\\frac{1}{2}\n\n## 다음 제목\n\n다음 본문 $2^{-1}$.')
    expect(html).toContain('math-literal')
    expect(html).toContain('<h2>다음 제목</h2>')
    expect(html).toContain('다음 본문')
    expect(mathCount(html)).toBe(1)
    expect(mathCount(render(String.raw`그대로 2^{-1} \(x^2\) \[x^2\]`))).toBe(0)
  })
  it('shares math rendering with visual descriptions but keeps reading/unclear notes as plain text', () => {
    const html = renderToStaticMarkup(
      createElement(TranslationContent, {
        result: {
          status: 'done',
          text: basicMath,
          content: {
            ...content(basicMath),
            visualElements: [
              { id: 'f', type: 'diagram', location: '중앙', descriptionMarkdown: visualMath },
            ],
            readingNotes: ['$2^{-1}$'],
            unclearRegions: ['$x^2$'],
          },
        },
      }),
    )
    expect(mathCount(html)).toBe(6)
    expect(html).toContain('<li>$2^{-1}$</li>')
    expect(html).toContain('<li>$x^2$</li>')
  })
  it('keeps JSON to queue/store strings unchanged and reuses completion without another request or cache relabeling', async () => {
    const body = richMath,
      fetcher = vi.fn<typeof fetch>(async (_url, options) => {
        return envelope(
          JSON.stringify({
            pages: sources(options).map(({ page, part }) => ({ page, part, ...content(body) })),
          }),
        )
      })
    const service = new TranslationService(fetcher, fakeRender)
    service.configure({ apiKey: 'fake-math-only' })
    const store = new TranslationStore(':memory:', TRANSLATION_VERSION)
    try {
      const queue = new TranslationQueue(store, service),
        doc = 'c'.repeat(64)
      queue.activate(doc, 'math.pdf', 1)
      const job = queue.claim()!
      await queue.submit(job.session, job.token, [imagePage(1)])
      const saved = store.load(doc).get(1)!
      expect(saved).toMatchObject({
        status: 'done',
        text: body,
        content: { translationMarkdown: body },
      })
      expect(
        mathCount(renderToStaticMarkup(createElement(TranslationContent, { result: saved }))),
      ).toBe(11)
      queue.activate(doc, 'math.pdf', 1)
      expect(queue.claim()).toBeNull()
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(store.version).toContain(':prompt4:')
      const request = JSON.parse(String(fetcher.mock.calls[0][1]?.body))
      expect(request.systemInstruction.parts[0].text).toContain('KaTeX-compatible LaTeX')
      expect(instruction).toContain('Correctly JSON-escape backslashes and newlines')
    } finally {
      store.close()
    }
  })
})

describe('safe Markdown and separate metadata', () => {
  it('renders GFM headings, lists, tables and code while blocking HTML, images and all links', () => {
    const html = renderToStaticMarkup(
      createElement(SafeMarkdown, {
        text: '# 제목\n\n- 항목\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n```js\nconst x = 1\n```\n\n<script>alert(1)</script>\n<img src="https://evil.invalid/a">\n\n![remote](https://evil.invalid/image)\n\n[unsafe](javascript:alert(1)) [safe text](https://example.com)',
      }),
    )
    expect(html).toContain('<h1>제목</h1>')
    expect(html).toContain('<table>')
    expect(html).toContain('<pre>')
    expect(html).not.toMatch(/<script|<img|href=|evil.invalid|javascript:/)
    expect(html).toContain('unsafe')
    expect(html).toContain('safe text')
  })
  it('keeps visual/reading/unclear content outside the translation article and shows unreadable error', () => {
    const data: PageTranslation = {
      ...content('## 본문'),
      visualElements: [{ id: 'f', type: 'diagram', location: '중앙', descriptionMarkdown: '설명' }],
      readingNotes: ['읽기 순서'],
      unclearRegions: ['불명 영역'],
    }
    const html = renderToStaticMarkup(
      createElement(TranslationContent, {
        result: { status: 'error', code: 'unreadable', message: '확인 필요', content: data },
      }),
    )
    expect(html.split('</article>')[0]).not.toContain('읽기 순서')
    expect(html).toContain('<details')
    expect(html).toContain('role="alert"')
    expect(html).toContain('불명 영역')
  })
})
