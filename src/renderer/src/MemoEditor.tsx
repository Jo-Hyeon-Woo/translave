import { useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import {
  EditorState,
  EditorSelection,
  StateEffect,
  StateField,
  Transaction,
} from '@codemirror/state'
import type { Range } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentMore, indentLess } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { SafeMarkdown } from './TranslationContent'
import type { MemoMode } from '../../shared/memos'
import { useEditingFocus } from './editingFocus'
import type { EditingEntry } from './editingFocus'

// Keep original source offsets for editing, including unfinished math. SafeMarkdown
// applies the existing math/currency/fallback policy when a widget is rendered.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath)
const memoTree = StateField.define({
  create: (state) => processor.parse(state.doc.toString()),
  update: (value, tr) => (tr.docChanged ? processor.parse(tr.newDoc.toString()) : value),
})
const renderedRoots = new WeakMap<HTMLElement, ReturnType<typeof createRoot>>()
const modeEffect = StateEffect.define<MemoMode>()
const focusEffect = StateEffect.define<boolean>()
const focused = StateField.define({
  create: () => false,
  update: (v, tr) => tr.effects.find((e) => e.is(focusEffect))?.value ?? v,
})
class Marker extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: Marker) {
    return this.text === other.text
  }
  toDOM() {
    const span = document.createElement('span')
    span.className = 'memo-list-marker'
    span.textContent = this.text
    return span
  }
}
class Rendered extends WidgetType {
  constructor(
    readonly text: string,
    readonly from: number,
    readonly block: boolean,
  ) {
    super()
  }
  eq(other: Rendered) {
    return this.text === other.text && this.from === other.from && this.block === other.block
  }
  toDOM(view: EditorView) {
    const dom = document.createElement(this.block ? 'div' : 'span')
    dom.className = 'memo-rendered markdown-content'
    dom.contentEditable = 'false'
    const root = createRoot(dom)
    renderedRoots.set(dom, root)
    root.render(<SafeMarkdown text={this.text} tabIndex={-1} />)
    dom.addEventListener('mousedown', (event) => {
      if (!(event instanceof MouseEvent) || event.button !== 0) return
      event.preventDefault()
      view.dispatch({ selection: { anchor: this.from }, effects: focusEffect.of(true) })
      view.focus()
    })
    return dom
  }
  destroy(dom: HTMLElement) {
    const root = renderedRoots.get(dom)
    renderedRoots.delete(dom)
    queueMicrotask(() => root?.unmount())
  }
}
function preview(state: EditorState, source: boolean): DecorationSet {
  if (source) return Decoration.none
  const body = state.doc.toString(),
    decorations: Range<Decoration>[] = []
  const tree: any = state.field(memoTree)
  const editing = (from: number, to: number) =>
    state.field(focused) &&
    state.selection.ranges.some(
      (r) => r.from <= state.doc.lineAt(to).to && r.to >= state.doc.lineAt(from).from,
    )
  const hide = (from: number, to: number) => {
    if (to > from) decorations.push(Decoration.replace({}).range(from, to))
  }
  const line = (from: number, cls: string) =>
    decorations.push(Decoration.line({ class: cls }).range(state.doc.lineAt(from).from))
  const walk = (node: any) => {
    const from = node.position?.start.offset,
      to = node.position?.end.offset
    if (from === undefined || to === undefined) return
    const active = editing(from, to),
      children = node.children ?? []
    if (['table', 'code', 'math', 'inlineMath'].includes(node.type) && !active) {
      decorations.push(
        Decoration.replace({
          block: node.type !== 'inlineMath',
          widget: new Rendered(body.slice(from, to), from, node.type !== 'inlineMath'),
        }).range(from, to),
      )
      return
    }
    const cls = (
      {
        strong: 'memo-strong',
        emphasis: 'memo-emphasis',
        delete: 'memo-strike',
        inlineCode: 'memo-inline-code',
        link: 'memo-link',
        linkReference: 'memo-link',
      } as Record<string, string>
    )[node.type]
    if (cls) decorations.push(Decoration.mark({ class: cls }).range(from, to))
    if (node.type === 'heading') {
      line(from, `memo-heading memo-heading-${node.depth}`)
      if (!active && children.length) {
        hide(from, children[0].position.start.offset)
        hide(children.at(-1).position.end.offset, to)
      }
    }
    if (!active && cls && children.length) {
      hide(from, children[0].position.start.offset)
      hide(children.at(-1).position.end.offset, to)
    }
    if (!active && node.type === 'inlineCode') {
      const ticks = body.slice(from, to).match(/^`+/)?.[0].length ?? 1
      hide(from, from + ticks)
      hide(to - ticks, to)
    }
    if (node.type === 'blockquote') {
      for (let n = state.doc.lineAt(from).number; n <= state.doc.lineAt(to).number; n++) {
        const row = state.doc.line(n),
          prefix = row.text.match(/^\s*>\s?/)
        line(row.from, 'memo-blockquote')
        if (prefix && !active) hide(row.from, row.from + prefix[0].length)
      }
    }
    if (node.type === 'listItem' && !active) {
      const prefix = body.slice(from, to).match(/^([-+*]|\d+[.)])\s+(\[[xX ]\]\s+)?/)
      if (prefix)
        decorations.push(
          Decoration.replace({
            widget: new Marker(
              prefix[2]
                ? /x/i.test(prefix[2])
                  ? '☑ '
                  : '☐ '
                : /^\d/.test(prefix[1])
                  ? prefix[1] + ' '
                  : '• ',
            ),
          }).range(from, from + prefix[0].length),
        )
    }
    children.forEach(walk)
  }
  tree.children.forEach(walk)
  return Decoration.set(decorations, true)
}
export type MemoEditorMemory = Map<
  string,
  {
    state?: EditorState
    scroll?: ReturnType<EditorView['scrollSnapshot']>
    onChange: (body: string) => void
    composing: boolean
  }
>
const selectionWithin = (state: EditorState, length: number) =>
  EditorSelection.create(
    state.selection.ranges.map((range) =>
      EditorSelection.range(Math.min(range.anchor, length), Math.min(range.head, length)),
    ),
    state.selection.mainIndex,
  )
export function MemoEditor({
  owner,
  memory,
  editingEntry,
  focusAllowed,
  body,
  mode,
  onChange,
}: {
  owner: string
  memory: MemoEditorMemory
  editingEntry: EditingEntry
  focusAllowed: boolean
  body: string
  mode: MemoMode
  onChange: (body: string) => void
}) {
  const host = useRef<HTMLDivElement>(null),
    editor = useRef<EditorView | null>(null)
  let entry = memory.get(owner)
  if (!entry) {
    entry = { onChange, composing: false }
    memory.set(owner, entry)
  }
  const binding = entry
  binding.onChange = onChange
  useLayoutEffect(() => {
    const source = StateField.define({
      create: () => mode,
      update: (v, tr) => tr.effects.find((e) => e.is(modeEffect))?.value ?? v,
    })
    const rendered = StateField.define<DecorationSet>({
      create: (state) => preview(state, state.field(source) === 'source'),
      update: (v, tr) =>
        tr.docChanged || tr.selection || tr.effects.length
          ? preview(tr.state, tr.state.field(source) === 'source')
          : v,
      provide: (field) => EditorView.decorations.from(field),
    })
    binding.composing = false
    let state = binding.state,
      scroll = binding.scroll
    if (state && state.doc.toString() !== body) {
      const update = state.update({
        changes: { from: 0, to: state.doc.length, insert: body },
        selection: selectionWithin(state, body.length),
        annotations: Transaction.addToHistory.of(false),
      })
      state = update.state
      scroll = scroll?.map(update.changes)
    }
    if (state) state = state.update({ effects: [modeEffect.of(mode), focusEffect.of(false)] }).state
    const view = new EditorView({
      parent: host.current!,
      scrollTo: scroll,
      state:
        state ??
        EditorState.create({
          doc: body,
          extensions: [
            focused,
            memoTree,
            source,
            rendered,
            markdown(),
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap]),
            EditorView.lineWrapping,
            EditorView.contentAttributes.of({
              'aria-label': '메모 본문',
              role: 'textbox',
              'aria-multiline': 'true',
              tabindex: '-1',
              'data-testid': 'memo-editor',
            }),
            EditorView.domEventHandlers({
              keydown: (event, view) => {
                if (
                  event.key !== 'Tab' ||
                  !event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  !view.hasFocus ||
                  event.isComposing ||
                  event.keyCode === 229 ||
                  binding.composing ||
                  view.composing ||
                  view.dom.ownerDocument.querySelector(
                    '.app-shell dialog[open], .app-shell .translation-menu[open], .app-shell .memo-selector[open], .app-shell [popover]:popover-open',
                  )
                )
                  return false
                event.preventDefault()
                event.stopPropagation()
                return (event.shiftKey ? indentLess : indentMore)(view)
              },
              compositionstart: () => {
                binding.composing = true
                return false
              },
              compositionend: () => {
                binding.composing = false
                return false
              },
              focus: (_event, view) => {
                view.dispatch({ effects: focusEffect.of(true) })
              },
              blur: (_event, view) => {
                binding.composing = false
                view.dispatch({ effects: focusEffect.of(false) })
              },
            }),
            EditorView.updateListener.of((update) => {
              if (update.docChanged) binding.onChange(update.state.doc.toString())
            }),
          ],
        }),
    })
    view.scrollDOM.tabIndex = -1
    editor.current = view
    return () => {
      binding.scroll = view.scrollSnapshot()
      view.contentDOM.blur()
      binding.state = view.state
      binding.composing = false
      editor.current = null
      view.destroy()
    }
  }, [owner])
  useLayoutEffect(() => {
    editor.current?.dispatch({ effects: modeEffect.of(mode) })
  }, [mode])
  useLayoutEffect(() => {
    const view = editor.current
    if (view && !view.composing && view.state.doc.toString() !== body)
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: body },
        selection: selectionWithin(view.state, body.length),
        annotations: Transaction.addToHistory.of(false),
      })
  }, [body])
  useEditingFocus(editingEntry, focusAllowed, () => {
    if (!editor.current || !host.current?.isConnected) return false
    editor.current.focus()
    return true
  })
  return <div ref={host} className="memo-editor" data-mode={mode} />
}
