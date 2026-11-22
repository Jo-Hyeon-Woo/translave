import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { SafeMarkdown } from './TranslationContent'
import type { MemoExportSnapshot } from '../../shared/memos'
import './memo-print.css'

const root = createRoot(document.getElementById('root')!)
Object.assign(window, {
  renderMemoExport: async (snapshot: MemoExportSnapshot) => {
    document.title = snapshot.title
    flushSync(() =>
      root.render(
        <>
          <style>
            {snapshot.sections
              .map(
                (section, i) =>
                  `@page memo${i} { @top-left { content: ${section.page === null ? 'none' : `"${section.page}페이지 메모"`}; } }`,
              )
              .join('\n')}
          </style>
          {snapshot.sections.map((section, i) => (
            <section key={section.id} style={{ page: `memo${i}` }}>
              <SafeMarkdown text={section.body} />
            </section>
          ))}
        </>,
      ),
    )
    await document.fonts.ready
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    for (const math of document.querySelectorAll<HTMLElement>('.katex')) {
      const width = math.getBoundingClientRect().width,
        available = document.body.clientWidth
      if (width > available)
        math.style.fontSize = `${(parseFloat(getComputedStyle(math).fontSize) * available) / width}px`
    }
  },
})
