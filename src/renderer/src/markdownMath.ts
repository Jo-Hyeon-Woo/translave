import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { unified } from 'unified'
import { VFile } from 'vfile'
import type { Root as MarkdownRoot } from 'mdast'
import type { Root, Element } from 'hast'

export const MATH_LIMITS = { maxExpand: 256, maxSize: 20, maxLength: 8192 } as const
const recoveryParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
type MarkdownNode = {
  type: string
  value?: string
  children?: MarkdownNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
  data?: object
}
type Formula = { source: string; display: boolean }
declare module 'hast' {
  interface ElementData {
    formula?: Formula
  }
}
function literal(source: string, display: boolean): Element {
  return {
    type: 'element',
    tagName: display ? 'div' : 'span',
    properties: { className: [display ? 'app-math-block' : 'app-math-inline', 'math-literal'] },
    children: [{ type: 'text', value: source }],
  }
}

// Operate on math nodes only: code/escapes/HTML have already been identified by Markdown.
export function remarkMathPolicy() {
  return (tree: MarkdownRoot, file: VFile) => {
    function rewrite(parent: MarkdownNode, source: string) {
      parent.children = parent.children?.flatMap((node): MarkdownNode[] => {
        const display = node.type === 'math'
        if (display || node.type === 'inlineMath') {
          const raw = source.slice(node.position?.start.offset, node.position?.end.offset)
          const value = node.value || ''
          const after = source.charAt(node.position?.end.offset ?? source.length)
          // Bare currency paired by the math parser must stay text. Explicit numeric $5$ is math.
          if (
            !display &&
            /^\d/.test(value) &&
            (/^\d/.test(after) ||
              (!/[\\^_+*=<>/{}-]/.test(value) && /\d[\d,.]*\s+\p{L}{2,}/u.test(value)))
          ) {
            return [{ type: 'text', value: raw }]
          }
          const lines = raw.split(/\r?\n/)
          const fence = lines[0]?.match(/^\s*(\${2,})\s*$/)?.[1]
          if (display && (!fence || lines.length < 3 || !lines.at(-1)?.trim().endsWith(fence))) {
            // A missing closing fence must not consume the following paragraphs/headings.
            const split = raw.indexOf('\n\n')
            const first = split < 0 ? raw : raw.slice(0, split)
            const rest = split < 0 ? '' : raw.slice(split + 2)
            const recovered = recoveryParser.parse(rest)
            rewrite(recovered, rest)
            return [
              {
                type: 'paragraph',
                children: [{ type: 'text', value: first }],
                data: {
                  hName: 'div',
                  hProperties: { className: ['math-literal', 'app-math-block'] },
                },
              },
              ...(recovered.children as MarkdownNode[]),
            ]
          }
          const math: Element = {
            type: 'element',
            tagName: 'code',
            properties: { className: ['language-math', display ? 'math-display' : 'math-inline'] },
            children: [{ type: 'text', value }],
            data: { formula: { source: raw, display } satisfies Formula },
          }
          node.data = {
            hName: display ? 'div' : 'span',
            hProperties: { className: [display ? 'app-math-block' : 'app-math-inline'] },
            hChildren: [math],
          }
        } else if (node.children) rewrite(node, source)
        return [node]
      })
    }
    rewrite(tree, String(file))
  }
}

// KaTeX 0.16 has direct console diagnostics (font metrics, \message/\show), even with strict mode.
// Its renderer is synchronous: suppress only this call, never an asynchronous task or the app logger.
function withoutMathDiagnostics(action: () => void): void {
  const methods = ['log', 'info', 'debug', 'warn', 'error'] as const
  const previous = methods.map((key) => console[key])
  try {
    for (const key of methods) console[key] = () => {}
    action()
  } finally {
    methods.forEach((key, index) => {
      console[key] = previous[index]
    })
  }
}

export function rehypeSafeKatex() {
  return (tree: Root) => {
    function rewrite(parent: Root | Element) {
      for (const [index, node] of parent.children.entries()) {
        if (node.type !== 'element') continue
        const code = node.children[0]
        const formula = code?.type === 'element' ? code.data?.formula : undefined
        if (!formula || code?.type !== 'element') {
          rewrite(node)
          continue
        }
        const source = code.children[0]
        const value = source?.type === 'text' ? source.value : ''
        if (
          value.length > MATH_LIMITS.maxLength ||
          /\\(?:message|errmessage|show|href|url|includegraphics|html[A-Za-z]*)\b/.test(value)
        ) {
          parent.children[index] = literal(formula.source, formula.display)
          continue
        }
        const isolated: Root = { type: 'root', children: [code] }
        const diagnostics = new VFile()
        let failed = false
        try {
          withoutMathDiagnostics(() => {
            // Fresh options/macros for every formula; definitions never escape this scope.
            rehypeKatex({
              trust: false,
              strict: 'error',
              maxExpand: MATH_LIMITS.maxExpand,
              maxSize: MATH_LIMITS.maxSize,
              macros: {},
              output: 'htmlAndMathml',
            })(isolated, diagnostics)
          })
          failed = diagnostics.messages.length > 0
        } catch {
          failed = true
        }
        diagnostics.messages.length = 0
        // Keep exception/source-bearing diagnostics local and discard them; never forward to React.
        if (failed) parent.children[index] = literal(formula.source, formula.display)
        else node.children = isolated.children as Element['children']
      }
    }
    rewrite(tree)
  }
}
