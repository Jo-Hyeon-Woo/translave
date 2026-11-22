import type { CHATGPT_OUTPUT_ISSUES } from '../../shared/chatgpt'

type Issue = keyof typeof CHATGPT_OUTPUT_ISSUES
export class TranslationOutputError extends Error {
  constructor(readonly issue: Issue) {
    super('Invalid translation output')
  }
}
const fail = (issue: Issue): never => {
  throw new TranslationOutputError(issue)
}
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value)
const validId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256

function itemText(item: any): string {
  if (!object(item)) return fail('item')
  if (item.type === 'reasoning') return ''
  if (item.type !== 'message') return fail('kind')
  if (item.role !== 'assistant') return fail('role')
  if (item.status !== 'completed') return fail('status')
  if (
    item.phase !== undefined &&
    item.phase !== null &&
    item.phase !== 'commentary' &&
    item.phase !== 'final_answer'
  )
    return fail('phase')
  if (!Array.isArray(item.content) || !item.content.length) return fail('content')
  let text = ''
  for (const part of item.content) {
    if (!object(part)) return fail('content')
    if (part.type === 'refusal') return fail('refusal')
    if (part.type !== 'output_text' || typeof part.text !== 'string') return fail('content')
    text += part.text
  }
  return item.phase === 'commentary' ? '' : text
}
function textFrom(output: any[]): string {
  const text = output.map(itemText).join('')
  if (!text.trim()) return fail('empty')
  return text
}
function signature(item: any): string {
  // Compare only translation-relevant fields; annotations never change the translation.
  return JSON.stringify(
    item.type === 'reasoning'
      ? { id: item.id, type: item.type }
      : {
          id: item.id,
          type: item.type,
          role: item.role,
          status: item.status,
          phase: item.phase ?? null,
          content: item.content.map((part: any) => ({ type: part.type, text: part.text })),
        },
  )
}

// Request-local memory only. A done item is not a successful response on its own.
export class TranslationOutput {
  private responseId?: string
  private added = new Map<number, string>()
  private done = new Map<number, any>()
  private ids = new Map<string, number>()

  accept(type: unknown, row: any) {
    if (type === 'response.created') {
      const id = row.response?.id
      if (id === undefined) return
      if (!validId(id) || (this.responseId && id !== this.responseId)) return fail('identity')
      this.responseId = id
      return
    }
    if (type !== 'response.output_item.added' && type !== 'response.output_item.done') return
    const index = row.output_index,
      item = row.item
    if (!Number.isInteger(index) || index < 0 || index >= 128 || !object(item)) return fail('item')
    if (!validId(item.id)) return fail('identity')
    if (
      (this.ids.has(item.id) && this.ids.get(item.id) !== index) ||
      (this.added.has(index) && this.added.get(index) !== item.id)
    )
      return fail('identity')
    this.ids.set(item.id, index)
    if (type === 'response.output_item.added') {
      if (this.added.has(index) || this.done.has(index)) return fail('duplicate')
      this.added.set(index, item.id)
    } else {
      if (this.done.has(index)) return fail('duplicate')
      itemText(item)
      this.done.set(index, item)
    }
  }

  complete(response: any): string {
    if (this.responseId && response.id !== this.responseId) return fail('identity')
    if (!Array.isArray(response.output)) return fail('missing')
    if (response.output.length) {
      if (response.output.length > 128) return fail('item')
      const ids = new Set<string>()
      for (const item of response.output) {
        if (object(item) && item.id !== undefined) {
          if (!validId(item.id)) return fail('identity')
          if (ids.has(item.id)) return fail('duplicate')
          ids.add(item.id)
        }
      }
      const text = textFrom(response.output)
      for (const [index, id] of this.added) {
        if (response.output[index]?.id !== id) return fail('identity')
      }
      for (const [index, item] of this.done) {
        const final = response.output[index]
        if (!final || signature(final) !== signature(item)) return fail('identity')
      }
      return text
    }
    if (!this.done.size) return fail('empty')
    if (!this.responseId || response.id !== this.responseId) return fail('unfinished')
    const rows = [...this.done].sort(([a], [b]) => a - b)
    if (
      rows.some(([index], order) => index !== order) ||
      [...this.added].some(([index, id]) => this.done.get(index)?.id !== id)
    )
      return fail('unfinished')
    return textFrom(rows.map(([, item]) => item))
  }
}
