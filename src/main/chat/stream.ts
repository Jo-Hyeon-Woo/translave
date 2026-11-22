import { CHAT_LIMITS } from '../../shared/chat'
import { TranslationOutputError } from '../chatgpt/translationOutput'

// Only allowlisted assistant text parts become provisional chat output. The shared
// completed-output collector remains responsible for terminal validation.
export class ChatProgress {
  private items = new Map<number, { id: string; visible: boolean; parts: Map<number, string> }>()
  private sequence = -1
  constructor(private publish: (text: string) => void) {}
  accept(type: unknown, row: any) {
    if (type === 'response.output_item.added') {
      const item = row.item
      this.items.set(row.output_index, {
        id: item.id,
        visible:
          item.type === 'message' &&
          item.role === 'assistant' &&
          (item.phase == null || item.phase === 'final_answer'),
        parts: new Map(),
      })
      return
    }
    if (type !== 'response.output_text.delta') return
    const item = this.items.get(row.output_index)
    if (!item || !item.visible) return
    if (
      row.item_id !== item.id ||
      !Number.isInteger(row.content_index) ||
      row.content_index < 0 ||
      row.content_index >= 128 ||
      typeof row.delta !== 'string'
    )
      throw new TranslationOutputError('identity')
    if (row.sequence_number !== undefined) {
      if (!Number.isInteger(row.sequence_number) || row.sequence_number <= this.sequence)
        throw new TranslationOutputError('duplicate')
      this.sequence = row.sequence_number
    }
    item.parts.set(row.content_index, (item.parts.get(row.content_index) ?? '') + row.delta)
    const text = [...this.items]
      .sort(([a], [b]) => a - b)
      .filter(([, v]) => v.visible)
      .map(([, v]) =>
        [...v.parts]
          .sort(([a], [b]) => a - b)
          .map(([, t]) => t)
          .join(''),
      )
      .join('')
    if (text.length > CHAT_LIMITS.answerChars) throw new TranslationOutputError('content')
    this.publish(text)
  }
}
