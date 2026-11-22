import { describe, expect, it, vi } from 'vitest'
import { readTranslationStream } from '../../src/main/chatgpt/inference'
import { safeError } from '../../src/main/chatgpt/errors'

const content = {
  contentType: 'text',
  translationMarkdown: '완성 번역 $4 \\times 128$',
  visualElements: [],
  readingNotes: [],
  unclearRegions: [],
}
const message = () => ({
  id: 'msg_PRIVATE_ID',
  type: 'message',
  role: 'assistant',
  status: 'completed',
  phase: 'final_answer',
  content: [
    { type: 'output_text', text: JSON.stringify({ pages: [{ page: 5, part: 1, ...content }] }) },
  ],
})
const created = {
  type: 'response.created',
  response: { id: 'resp_PRIVATE_ID', status: 'in_progress' },
}
const done = (item: any = message(), index = 0) => ({
  type: 'response.output_item.done',
  item,
  output_index: index,
})
const end = (output: unknown = []) => ({
  type: 'response.completed',
  response: {
    id: 'resp_PRIVATE_ID',
    status: 'completed',
    error: null,
    incomplete_details: null,
    output,
  },
})
const added = (id = message().id, index = 0) => ({
  type: 'response.output_item.added',
  output_index: index,
  item: { id, type: 'message', role: 'assistant', status: 'in_progress', content: [] },
})
function stream(...rows: any[]) {
  // Actual screenshot had no Content-Type. Keep this transport variant in the regression.
  const data = new TextEncoder().encode(
    rows.map((row) => 'data: ' + JSON.stringify(row) + '\n\n').join(''),
  )
  let at = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        if (at === data.length) return c.close()
        c.enqueue(data.subarray(at, at + 7))
        at = Math.min(at + 7, data.length)
      },
    }),
  )
}

describe('completed ChatGPT output items, final snapshot and safe rejection', () => {
  it('uses finalized items only after linked whole-response completion and preserves math/page JSON', async () => {
    expect(await readTranslationStream(stream(created, added(), done(), end()), 5)).toEqual(content)
  })
  it('checks a full final snapshot against collected items without appending content twice', async () => {
    expect(
      await readTranslationStream(stream(created, added(), done(), end([message()])), 5),
    ).toEqual(content)
    const conflicting = message()
    conflicting.content[0].text = 'PRIVATE_DIFFERENT_TEXT'
    await expect(
      readTranslationStream(stream(created, done(), end([conflicting])), 5),
    ).rejects.toMatchObject({ diagnostic: { outputIssue: 'identity' } })
  })
  it('rejects duplicate IDs in a full snapshot and never reuses a previous request collection', async () => {
    await expect(
      readTranslationStream(stream(end([message(), { ...message(), phase: 'commentary' }])), 5),
    ).rejects.toMatchObject({ diagnostic: { outputIssue: 'duplicate' } })
    expect(await readTranslationStream(stream(created, done(), end()), 5)).toEqual(content)
    await expect(readTranslationStream(stream(created, end()), 5)).rejects.toMatchObject({
      diagnostic: { outputIssue: 'empty' },
    })
  })
  it('keeps reasoning/commentary separate from final JSON in both full and empty snapshots', async () => {
    const reasoning = { id: 'rs_PRIVATE_ID', type: 'reasoning', summary: [] }
    const commentary = {
      ...message(),
      id: 'comment_PRIVATE_ID',
      phase: 'commentary',
      content: [{ type: 'output_text', text: 'PRIVATE_COMMENTARY' }],
    }
    const items = [reasoning, commentary, message()]
    expect(await readTranslationStream(stream(created, end(items)), 5)).toEqual(content)
    expect(
      await readTranslationStream(
        stream(created, ...items.map((item, index) => done(item, index)), end()),
        5,
      ),
    ).toEqual(content)
  })
  it.each(['delta', 'text_done', 'item_done'])(
    '%s cannot substitute for whole-response completion',
    async (kind) => {
      const row =
        kind === 'item_done'
          ? done()
          : {
              type: kind === 'delta' ? 'response.output_text.delta' : 'response.output_text.done',
              text: message().content[0].text,
              delta: message().content[0].text,
            }
      await expect(readTranslationStream(stream(created, row), 5)).rejects.toMatchObject({
        diagnostic: { reason: 'missing_completion' },
      })
      if (kind !== 'item_done')
        await expect(readTranslationStream(stream(created, row, end()), 5)).rejects.toMatchObject({
          diagnostic: { outputIssue: 'empty' },
        })
    },
  )
  it.each([
    [
      'response ID conflict',
      () => [
        created,
        done(),
        { ...end(), response: { ...end().response, id: 'resp_OTHER_PRIVATE' } },
      ],
      'identity',
    ],
    ['missing response link', () => [done(), end()], 'unfinished'],
    ['output gap', () => [created, done(message(), 1), end()], 'unfinished'],
    [
      'unfinished added item',
      () => [created, added('msg_OTHER_PRIVATE', 1), done(), end()],
      'unfinished',
    ],
    ['duplicate item', () => [created, done(), done(), end()], 'duplicate'],
    ['reused item ID', () => [created, done(), done(message(), 1), end()], 'identity'],
    [
      'added item ID conflict',
      () => [created, added(), done({ ...message(), id: 'msg_OTHER_PRIVATE' }), end()],
      'identity',
    ],
    [
      'missing final output',
      () => [
        created,
        done(),
        { type: 'response.completed', response: { id: 'resp_PRIVATE_ID', status: 'completed' } },
      ],
      'missing',
    ],
    ['bad final output', () => [created, done(), end(null)], 'missing'],
    [
      'unexpected tool',
      () => [end([{ id: 'fc_PRIVATE_ID', type: 'function_call', arguments: 'PRIVATE_PAYLOAD' }])],
      'kind',
    ],
    [
      'refusal',
      () => [end([{ ...message(), content: [{ type: 'refusal', refusal: 'PRIVATE_REFUSAL' }] }])],
      'refusal',
    ],
    ['wrong role', () => [end([{ ...message(), role: 'PRIVATE_ROLE' }])], 'role'],
    ['unknown phase', () => [end([{ ...message(), phase: 'PRIVATE_PHASE' }])], 'phase'],
    [
      'bad content type',
      () => [end([{ ...message(), content: [{ type: 'PRIVATE_TYPE', text: 'PRIVATE_TEXT' }] }])],
      'content',
    ],
    ['empty content', () => [end([{ ...message(), content: [] }])], 'content'],
    [
      'empty translation',
      () => [end([{ ...message(), content: [{ type: 'output_text', text: ' ' }] }])],
      'empty',
    ],
    ['null item', () => [end([null])], 'item'],
  ] as const)('rejects %s without exposing original values', async (_label, rows, issue) => {
    try {
      await readTranslationStream(stream(...rows()), 5)
      throw new Error('expected rejection')
    } catch (e) {
      const error = safeError(e)
      expect(error).toMatchObject({ code: 'invalid', diagnostic: { outputIssue: issue } })
      expect(JSON.stringify(error)).not.toContain('PRIVATE_')
    }
  })
  it.each([undefined, null, 'in_progress', 'incomplete', 'PRIVATE_STATUS'])(
    'does not infer message completion from terminal status when item status is %s',
    async (status) => {
      await expect(
        readTranslationStream(stream(end([{ ...message(), status }])), 5),
      ).rejects.toMatchObject({ diagnostic: { outputIssue: 'status' } })
    },
  )
  it('still rejects parent incomplete/error status and wrong page JSON with completed items', async () => {
    await expect(
      readTranslationStream(
        stream(created, done(), {
          ...end(),
          response: { ...end().response, status: 'incomplete' },
        }),
        5,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'invalid_completion' } })
    await expect(
      readTranslationStream(
        stream(created, done(), {
          ...end(),
          response: { ...end().response, error: { message: 'PRIVATE_ERROR' } },
        }),
        5,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'invalid_completion' } })
    await expect(readTranslationStream(stream(created, done(), end()), 6)).rejects.toMatchObject({
      code: 'invalid',
      diagnostic: { reason: 'invalid_json' },
    })
  })
  it('never logs collected message text or output rejection data', async () => {
    const spies = ['log', 'error', 'warn', 'debug', 'info'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    )
    try {
      await readTranslationStream(stream(created, done(), end()), 5)
      await readTranslationStream(stream(created, done(), done(), end()), 5).catch(() => {})
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})
