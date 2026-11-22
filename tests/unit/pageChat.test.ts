import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatGPTService } from '../../src/main/chatgpt/service'
import { ChatGPTProvider } from '../../src/main/chatgpt/provider'
import { TranslationQueue } from '../../src/main/queue'
import { TranslationStore } from '../../src/main/store'
import { PageChatService } from '../../src/main/chat/service'
import { PageChatImages } from '../../src/main/chat/images'
import { ImageBridge } from '../../src/main/imageBridge'
import { chatInstructions, chatRequest, ChatInputError } from '../../src/main/chat/request'
import { ChatProgress } from '../../src/main/chat/stream'
import { readResponseTextStream } from '../../src/main/chatgpt/inference'
import { CHAT_LIMITS } from '../../src/shared/chat'
import type {
  ChatActionResult,
  ChatActive,
  ChatEvent,
  ChatQuote,
  ChatSend,
  ChatTurn,
} from '../../src/shared/chat'
import type { PageImage, PageResult, RenderRequest } from '../../src/shared/contracts'
import { DEFAULT_IMAGE_SETTINGS, TRANSLATION_VERSION } from '../../src/shared/contracts'
import { content, imagePage } from './fakes'
import { ChatDrafts } from '../../src/renderer/src/chatDrafts'

describe('reading-tab question drafts', () => {
  it('retains independent tab drafts until that tab actually changes page or closes', () => {
    const drafts = new ChatDrafts()
    const first = drafts.forTab('first', 1),
      duplicate = drafts.forTab('duplicate', 2)
    first.set('first draft')
    duplicate.set('duplicate draft')
    drafts.sync([
      { id: 'duplicate', page: 2 },
      { id: 'first', page: 1 },
    ])
    expect(drafts.forTab('first', 1)).toBe(first)
    expect(drafts.forTab('duplicate', 2).text).toBe('duplicate draft')
    drafts.sync([
      { id: 'first', page: 2 },
      { id: 'duplicate', page: 2 },
    ])
    expect(drafts.forTab('first', 2).text).toBe('')
    drafts.sync([
      { id: 'first', page: 1 },
      { id: 'duplicate', page: 2 },
    ])
    expect(drafts.forTab('first', 1).text).toBe('')
    expect(drafts.forTab('duplicate', 2)).toBe(duplicate)
    drafts.sync([{ id: 'duplicate', page: 2 }])
    expect(drafts.forTab('first', 1)).not.toBe(first)
    expect(duplicate.text).toBe('duplicate draft')
  })

  it('clears only the submitted revision, including after leaving the sending tab', () => {
    const drafts = new ChatDrafts(),
      draft = drafts.forTab('sending', 1)
    const changed = vi.fn(),
      unsubscribe = draft.subscribe(changed)
    draft.set('submitted')
    const submitted = draft.revision
    draft.set('new question')
    draft.clear(submitted)
    expect(draft.text).toBe('new question')
    drafts.forTab('other', 2).set('other question')
    draft.clear(draft.revision)
    expect(draft.text).toBe('')
    expect(drafts.forTab('other', 2).text).toBe('other question')
    drafts.sync([{ id: 'sending', page: 2 }])
    const next = drafts.forTab('sending', 2)
    next.set('next page question')
    draft.clear(draft.revision)
    expect(next.text).toBe('next page question')
    expect(changed).toHaveBeenCalledTimes(3)
    unsubscribe()
    draft.set('unobserved')
    expect(changed).toHaveBeenCalledTimes(3)
  })
})

const target = { documentId: 'A', page: 1 }
const input = (attachment: ChatSend['attachment'] = 'none', extra = {}): ChatSend => ({
  ...target,
  question: '질문',
  attachment,
  ...extra,
})
const frame = (v: unknown) => 'data: ' + JSON.stringify(v) + '\n\n'
const finalItem = (text: string, phase = 'final_answer', id = 'msg_chat') => ({
  id,
  type: 'message',
  role: 'assistant',
  status: 'completed',
  phase,
  content: [{ type: 'output_text', text }],
})
function controlled() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
  const send = (row: unknown) => controller.enqueue(new TextEncoder().encode(frame(row)))
  send({ type: 'response.created', response: { id: 'resp_chat' } })
  send({
    type: 'response.output_item.added',
    output_index: 0,
    item: { ...finalItem(''), status: 'in_progress' },
  })
  return {
    response,
    send,
    delta: (text: string) =>
      send({
        type: 'response.output_text.delta',
        output_index: 0,
        item_id: 'msg_chat',
        content_index: 0,
        delta: text,
      }),
    finish: (text: string) => {
      const item = finalItem(text)
      send({ type: 'response.output_item.done', output_index: 0, item })
      send({
        type: 'response.completed',
        response: { id: 'resp_chat', status: 'completed', output: [item] },
      })
      controller.close()
    },
    close: () => controller.close(),
    disconnect: () => controller.error(new Error('PRIVATE_NETWORK_DETAIL')),
  }
}
function completed(text = '한국어 답변 $2^{-1}$') {
  return new Response(
    frame({
      type: 'response.completed',
      response: { status: 'completed', output: [finalItem(text)] },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  )
}
async function setup(path = ':memory:', attachmentMode: 'legacy' | 'page_image' = 'legacy') {
  const store = new TranslationStore(path, TRANSLATION_VERSION)
  store.register('A', 'A.pdf', 3)
  store.register('B', 'B.pdf', 3)
  const events: ChatEvent[] = [],
    calls: any[] = []
  let responder = (_body: any): Response | Promise<Response> => completed()
  const record: any = {
    activeId: 'fake',
    planNoticeSeen: true,
    profiles: [
      {
        id: 'fake',
        clientId: 'fake_client',
        credentials: {
          accessToken: 'PRIVATE_FAKE_ACCESS',
          refreshToken: 'PRIVATE_FAKE_REFRESH',
          idToken: '',
          scopes: ['chatgpt.tokens.use.direct'],
          expiresAt: Date.now() + 3600000,
          earliestRefreshAt: Date.now() + 3600000,
          nonce: '',
        },
      },
    ],
  }
  const auth = new ChatGPTService({
    vault: { load: async () => record, save: async () => {}, hostId: async () => 'fake' },
    openBrowser: async () => {
      throw new Error('implicit login')
    },
    render: async () => {
      throw new Error('implicit render')
    },
    fetcher: async (url, options) => {
      if (String(url).endsWith('/models'))
        return Response.json({
          models: [{ slug: 'gpt-6.1-sol', display_name: 'fake', visibility: 'list' }],
        })
      expect(String(url)).toBe('https://api.openai.com/v1/responses')
      const body = JSON.parse(String(options?.body))
      calls.push(body)
      return responder(body)
    },
  })
  await auth.initialize()
  await auth.discoverModels()
  let translation: PageResult | undefined = {
    status: 'done',
    text: '고정된 번역',
    content: content('고정된 번역'),
  }
  let pdf: Uint8Array = new TextEncoder().encode('%PDF-FAKE_ORIGINAL')
  let pdfFailure = false,
    model = 'gpt-6.1-sol'
  const readPDF = vi.fn(async () => {
    if (pdfFailure) throw new ChatInputError('원본 PDF가 변경되었어요.')
    return pdf
  })
  const renderImage = vi.fn(
    async (_target: typeof target, _signal: AbortSignal): Promise<PageImage> => ({
      mimeType: 'image/jpeg',
      data: '/9j/2Q==',
      width: 800,
      height: 800,
    }),
  )
  const service = new PageChatService({
    store: store.chats,
    auth,
    target: (t) => {
      if (!['A', 'B'].includes(t.documentId) || t.page > 3) throw new Error('invalid target')
      return { name: t.documentId + '.pdf', total: 3 }
    },
    model: () => model,
    attachmentMode,
    image: renderImage,
    translation: () => translation,
    pdf: readPDF,
    notify: (e) => events.push(e),
  })
  const wait = async (t = target) => {
    await vi.waitFor(() => {
      expect(service.snapshot(t).active).toBeNull()
      expect(auth.chatPending()).toBe(false)
    })
    return service.snapshot(t)
  }
  return {
    store,
    auth,
    service,
    calls,
    events,
    wait,
    readPDF,
    renderImage,
    set response(v: typeof responder) {
      responder = v
    },
    set translation(v: PageResult | undefined) {
      translation = v
    },
    set pdf(v: Uint8Array) {
      pdf = v
    },
    set pdfFailure(v: boolean) {
      pdfFailure = v
    },
    set model(v: string) {
      model = v
    },
    dispose() {
      service.dispose()
      auth.dispose()
      store.close()
    },
  }
}
const ok = (result: ChatActionResult) => {
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') throw new Error('expected ok')
  return result.snapshot
}
const deletion = (turn: ChatTurn, owner = target): ChatActive => ({
  ...owner,
  conversationId: turn.conversationId,
  turnId: turn.id,
  requestId: turn.requestId,
})

describe('individual question/answer deletion with stable ownership', () => {
  it('deletes only the middle pair, preserves other attachments and conversations across restart, and omits it from future context', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-delete-'))
    const path = join(folder, 'chat.sqlite')
    let h = await setup(path, 'page_image')
    try {
      for (const question of ['first', 'middle', 'last']) {
        h.response = () => completed(`answer-${question}`)
        ok(await h.service.send(input('none', { question, quotes: [quote(question)] })))
        await h.wait()
      }
      const before = h.service.snapshot(target)
      for (const owner of [
        { documentId: 'A', page: 2 },
        { documentId: 'B', page: 1 },
      ]) {
        ok(await h.service.send(input('none', owner)))
        await h.wait(owner)
      }
      const others = [
        h.service.snapshot({ documentId: 'A', page: 2 }),
        h.service.snapshot({ documentId: 'B', page: 1 }),
      ]
      const remove = deletion(before.turns[1])
      for (const wrong of [
        { page: 2 },
        { documentId: 'B' },
        { conversationId: 'other' },
        { requestId: 'old' },
        { turnId: 'missing' },
      ]) {
        expect(h.service.deleteTurn({ ...remove, ...wrong }).status).toBe('error')
        expect(h.service.snapshot(target)).toEqual(before)
      }
      const calls = h.calls.length
      expect(ok(h.service.deleteTurn(remove)).turns).toEqual([before.turns[0], before.turns[2]])
      expect(h.calls).toHaveLength(calls)
      expect(h.events.at(-1)).toMatchObject({ ...remove, deleted: true, turn: null })
      expect(h.store.chats.update(before.turns[1], 'late', 'complete')).toBeNull()
      expect(h.service.deleteTurn(remove).status).toBe('error')
      h.dispose()
      h = await setup(path, 'page_image')
      expect(h.service.snapshot(target).turns).toEqual([before.turns[0], before.turns[2]])
      expect(h.service.snapshot({ documentId: 'A', page: 2 })).toEqual(others[0])
      expect(h.service.snapshot({ documentId: 'B', page: 1 })).toEqual(others[1])
      ok(await h.service.send(input('none', { question: 'after-deletion' })))
      await h.wait()
      expect(h.service.snapshot(target).turns.map((t) => t.question)).toEqual([
        'first',
        'last',
        'after-deletion',
      ])
      const body = JSON.stringify(h.calls[0])
      expect(body).not.toContain('middle')
      expect(body).toContain('answer-first')
      expect(body).toContain('answer-last')
      for (const turn of h.service.snapshot(target).turns) ok(h.service.deleteTurn(deletion(turn)))
      ok(await h.service.send(input('none', { question: 'new-only' })))
      await h.wait()
      expect(h.calls.at(-1).input).toHaveLength(1)
    } finally {
      h.dispose()
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('rejects queued/streaming deletion, allows terminal pairs, and never cancels or rewrites another request', async () => {
    const h = await setup()
    try {
      ok(await h.service.send(input('none', { question: 'old-completed' })))
      const old = (await h.wait()).turns[0]
      const stream = controlled()
      h.response = () => stream.response
      const started = ok(await h.service.send(input('none', { question: 'running' })))
      const running = started.turns[1]
      expect(h.service.deleteTurn(deletion(running)).status).toBe('error')
      await vi.waitFor(() => expect(h.calls).toHaveLength(2))
      stream.delta('partial')
      await vi.waitFor(() => expect(h.service.snapshot(target).turns[1].status).toBe('streaming'))
      expect(h.service.deleteTurn(deletion(running)).status).toBe('error')
      const body = JSON.stringify(h.calls[1])
      ok(h.service.deleteTurn(deletion(old)))
      expect(h.service.snapshot(target).active?.turnId).toBe(running.id)
      expect(JSON.stringify(h.calls[1])).toBe(body)
      stream.finish('completed-current')
      await h.wait()
      ok(h.service.deleteTurn(deletion(running)))
      for (const status of ['stopped', 'error'] as const) {
        const s = controlled()
        h.response = () => s.response
        const turn = ok(await h.service.send(input('none', { question: status }))).turns[0]
        await vi.waitFor(() => expect(h.service.snapshot(target).turns[0].status).toBe('streaming'))
        if (status === 'stopped') {
          h.service.stop(turn.requestId)
          expect(h.service.deleteTurn(deletion(turn)).status).toBe('error')
          s.finish('ignored-late-completion')
        } else s.close()
        const result = await h.wait()
        expect(result.turns[0].status).toBe(status)
        ok(h.service.deleteTurn(deletion(result.turns[0])))
      }
      expect(h.calls).toHaveLength(4)
    } finally {
      h.dispose()
    }
  })
  it('rejects a stopped pair while retry image preparation is in progress and rejects the previous attempt ID afterward', async () => {
    const h = await setup(':memory:', 'page_image')
    try {
      let stream = controlled()
      h.response = () => stream.response
      const turn = ok(await h.service.send(input())).turns[0]
      h.service.stop(turn.requestId)
      stream.finish('ignored-late-completion')
      await h.wait()
      let release!: (image: PageImage) => void
      const image = await h.renderImage.mock.results[0].value
      h.renderImage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      stream = controlled()
      const retry = h.service.send(input('none', { retryTurnId: turn.id }))
      await vi.waitFor(() => expect(h.renderImage).toHaveBeenCalledTimes(2))
      expect(h.service.deleteTurn(deletion(turn)).status).toBe('error')
      release(image)
      const retried = ok(await retry).turns[0]
      h.service.stop(retried.requestId)
      stream.finish('ignored-late-retry')
      await h.wait()
      expect(h.service.deleteTurn(deletion(turn)).status).toBe('error')
      ok(h.service.deleteTurn(deletion(retried)))
    } finally {
      h.dispose()
    }
  })
  it('keeps persisted records and emits no deletion on SQLite failure without exposing diagnostics', async () => {
    const h = await setup()
    try {
      ok(await h.service.send(input()))
      const before = await h.wait(),
        events = h.events.length
      const db = (h.store as any).db
      db.exec(
        "CREATE TRIGGER block_chat_delete BEFORE DELETE ON chat_turns BEGIN SELECT RAISE(FAIL,'PRIVATE_STORAGE_DETAIL'); END",
      )
      const result = h.service.deleteTurn(deletion(before.turns[0]))
      expect(result).toEqual({
        status: 'error',
        message: '대화를 삭제하지 못했어요. 로컬 저장소를 확인해 주세요.',
      })
      expect(h.service.snapshot(target)).toEqual(before)
      expect(h.events).toHaveLength(events)
      db.exec('DROP TRIGGER block_chat_delete')
      ok(h.service.deleteTurn(deletion(before.turns[0])))
    } finally {
      h.dispose()
    }
  })
})

const quote = (id = 'quote-1'): ChatQuote => ({
  id,
  text: 'SELECTED_FAKE_QUOTE <script>never execute</script> $2^{-1}$',
  source: { ...target, documentName: 'A.pdf', kind: 'pdf', start: 12, end: 70 },
})
describe('selected quotations with required page images (fake only)', () => {
  it('sends only explicit quotations beside the image and question, persists sources, and restores history without replaying images', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-quotes-'))
    const path = join(folder, 'translations.sqlite')
    let h = await setup(path, 'page_image')
    const q = quote()
    try {
      const first = ok(await h.service.send(input('none', { quotes: [q] })))
      await h.wait()
      const body = h.calls[0],
        user = body.input.at(-1).content
      expect(user.filter((c: any) => c.type === 'input_image')).toHaveLength(1)
      const references = user.filter((c: any) => c.type === 'input_text').map((c: any) => c.text)
      expect(references.at(-1)).toBe('질문')
      expect(JSON.parse(references[1])).toEqual({
        reference: 'selected_quotations',
        quotations: [q],
      })
      expect(JSON.stringify(body)).not.toContain('고정된 번역')
      expect(h.service.snapshot(target).turns[0].attachment.quotes).toEqual([q])
      h.dispose()
      h = await setup(path, 'page_image')
      expect(h.service.snapshot(target).turns[0]).toMatchObject({
        id: first.turns[0].id,
        attachment: { quotes: [q] },
      })
      expect(h.calls).toHaveLength(0)
      ok(await h.service.send(input('none', { question: '후속 질문' })))
      await h.wait()
      expect(h.calls[0].input[0].content[0].text).toBe(
        JSON.stringify({ reference: 'selected_quotations', quotations: [q] }),
      )
      expect(JSON.stringify(h.calls[0]).match(/input_image/g)).toHaveLength(1)
    } finally {
      h.dispose()
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('freezes excerpts before asynchronous image preparation, maps to the original page, and retries the stored excerpts', async () => {
    const h = await setup(':memory:', 'page_image')
    try {
      let resolve!: (image: PageImage) => void
      h.renderImage.mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r
          }),
      )
      const q = quote(),
        expected = structuredClone(q)
      const sending = h.service.send(input('none', { quotes: [q] }))
      q.text = 'MUTATED_DRAFT'
      q.source.page = 2
      expect(h.service.snapshot({ documentId: 'B', page: 2 }).turns).toEqual([])
      resolve({ mimeType: 'image/jpeg', data: '/9j/2Q==', width: 800, height: 800 })
      const snapshot = ok(await sending)
      await h.wait()
      expect(h.service.snapshot(target).turns[0].attachment.quotes).toEqual([expected])
      expect(h.service.snapshot({ documentId: 'B', page: 2 }).turns).toEqual([])
      const turn = snapshot.turns[0]
      h.store.chats.update(h.service.snapshot(target).turns[0], '', 'stopped')
      ok(
        await h.service.send(
          input('none', { retryTurnId: turn.id, quotes: [quote('ignored-draft')] }),
        ),
      )
      await h.wait()
      expect(h.service.snapshot(target).turns[0].attachment.quotes).toEqual([expected])
      expect(JSON.stringify(h.calls.at(-1))).not.toContain('ignored-draft')
    } finally {
      h.dispose()
    }
  })
  it('accepts chat message ranges but rejects other-page, unknown-message, duplicate or malformed quotations before images and inference', async () => {
    const h = await setup(':memory:', 'page_image')
    try {
      ok(await h.service.send(input()))
      await h.wait()
      const original = h.service.snapshot(target).turns[0]
      const q: ChatQuote = {
        ...quote(),
        source: {
          ...target,
          documentName: 'A.pdf',
          kind: 'chat',
          ranges: [{ turnId: original.id, role: 'assistant', start: 0, end: 4 }],
        },
      }
      ok(await h.service.send(input('none', { quotes: [q] })))
      await h.wait()
      expect(h.service.snapshot(target).turns[1].attachment.quotes).toEqual([q])
      const calls = h.calls.length,
        renders = h.renderImage.mock.calls.length
      for (const invalid of [
        [{ ...quote(), source: { ...quote().source, page: 2 } }],
        [
          {
            ...q,
            source: { ...q.source, ranges: [{ turnId: 'absent', role: 'user', start: 0, end: 2 }] },
          },
        ],
        [quote(), quote()],
        [{ ...quote(), text: '' }],
        [{ ...quote(), source: { ...quote().source, start: -1 } }],
        [{ ...quote(), text: 'x'.repeat(CHAT_LIMITS.quoteChars + 1) }],
      ])
        expect((await h.service.send(input('none', { quotes: invalid }))).status).toBe('error')
      expect(h.calls).toHaveLength(calls)
      expect(h.renderImage).toHaveBeenCalledTimes(renders)
    } finally {
      h.dispose()
    }
  })
})

describe('active page-image chat (fake only)', () => {
  it.each(['none', 'page', 'pdf', undefined] as const)(
    'always sends a page image, ignoring legacy choice %s and unavailable translations',
    async (attachment) => {
      const h = await setup(':memory:', 'page_image')
      try {
        h.translation = undefined
        ok(await h.service.send({ ...target, question: '첫 질문', attachment }))
        await h.wait()
        ok(await h.service.send({ ...target, question: '후속 질문', attachment }))
        const saved = await h.wait()
        const body = h.calls[1],
          parts = body.input.at(-1).content
        expect(body.input.slice(0, 2).map((m: any) => m.role)).toEqual(['user', 'assistant'])
        expect(JSON.parse(parts[0].text)).toMatchObject({
          documentName: 'A.pdf',
          page: 1,
          part: 1,
          attachment: 'page_image',
        })
        expect(parts[1]).toEqual({
          type: 'input_image',
          image_url: 'data:image/jpeg;base64,/9j/2Q==',
          detail: 'high',
        })
        expect(parts[2]).toEqual({ type: 'input_text', text: '후속 질문' })
        expect(JSON.stringify(body)).not.toMatch(
          /input_file|translatedContent|고정된 번역|FAKE_ORIGINAL/,
        )
        expect(h.readPDF).not.toHaveBeenCalled()
        expect(h.renderImage).toHaveBeenCalledTimes(2)
        expect(saved.turns.every((t) => t.attachment.kind === 'page_image')).toBe(true)
        expect(JSON.stringify(saved)).not.toMatch(/base64|\/9j\/|translatedContent/)
      } finally {
        h.dispose()
      }
    },
  )
  it('freezes document/page during image generation, blocks duplicate sends and keeps streamed results on the original conversation', async () => {
    const h = await setup(':memory:', 'page_image'),
      stream = controlled()
    let finish!: (image: PageImage) => void
    h.renderImage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    h.response = () => stream.response
    try {
      const sending = input('pdf'),
        pending = h.service.send(sending)
      sending.documentId = 'B'
      sending.page = 2
      expect(h.renderImage.mock.calls[0][0]).toEqual(target)
      expect((await h.service.send(input())).status).toBe('error')
      expect(h.service.snapshot({ documentId: 'B', page: 2 }).turns).toHaveLength(0)
      finish({ mimeType: 'image/png', data: 'AAAA', width: 800, height: 800 })
      ok(await pending)
      await vi.waitFor(() => expect(h.calls).toHaveLength(1))
      stream.delta('부분 답변')
      stream.finish('원래 페이지 답변')
      const result = await h.wait()
      expect(result.turns[0].answer).toBe('원래 페이지 답변')
      expect(result.turns[0].attachment).toMatchObject({
        documentId: 'A',
        page: 1,
        kind: 'page_image',
      })
      expect(h.service.snapshot({ documentId: 'B', page: 2 }).turns).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })
  it('refuses missing PDF or failed/invalid image without creating a turn or falling back to text, then releases the reservation', async () => {
    const h = await setup(':memory:', 'page_image')
    try {
      expect((await h.service.send(input('none', { documentId: '' }))).status).toBe('error')
      expect(h.renderImage).not.toHaveBeenCalled()
      for (const result of ['throw', 'invalid']) {
        if (result === 'throw')
          h.renderImage.mockRejectedValueOnce(new Error('PRIVATE_IMAGE_DETAIL'))
        else
          h.renderImage.mockResolvedValueOnce({
            mimeType: 'image/png',
            data: '',
            width: 0,
            height: 0,
          })
        expect(await h.service.send(input())).toMatchObject({
          status: 'error',
          message: expect.stringContaining('이미지'),
        })
        expect(h.service.snapshot(target).turns).toHaveLength(0)
        expect(h.auth.chatPending()).toBe(false)
      }
      expect(h.calls).toHaveLength(0)
      ok(await h.service.send(input()))
      await h.wait()
    } finally {
      h.dispose()
    }
  })
  it.each(['clear', 'cancelAll'] as const)(
    'rejects a late image after preparation %s without resurrecting a turn',
    async (action) => {
      const h = await setup(':memory:', 'page_image')
      let finish!: (image: PageImage) => void
      h.renderImage.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
      )
      try {
        const pending = h.service.send(input())
        if (action === 'clear') h.service.clear(target)
        else h.service.cancelAll()
        expect(h.renderImage.mock.calls[0][1].aborted).toBe(true)
        finish({ mimeType: 'image/jpeg', data: 'AAAA', width: 1, height: 1 })
        expect((await pending).status).toBe('error')
        expect(h.calls).toHaveLength(0)
        expect(h.service.snapshot(target).turns).toHaveLength(0)
        expect(h.auth.chatPending()).toBe(false)
      } finally {
        h.dispose()
      }
    },
  )
  it('persists new image metadata alongside unchanged legacy attachment records and never replays old attachments', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-chat-image-')),
      path = join(folder, 'db.sqlite')
    let h = await setup(path, 'page_image')
    try {
      const id = h.store.chats.conversation(target, true)!
      for (const kind of ['none', 'page', 'pdf'] as const) {
        const turn = h.store.chats.start(id, '예전 질문', 'gpt-6.1-sol', {
          kind,
          ...target,
          documentName: 'A.pdf',
        })
        h.store.chats.update(turn, '예전 답변', 'complete')
      }
      ok(await h.service.send(input()))
      await h.wait()
      expect(h.calls[0].input.filter((m: any) => Array.isArray(m.content))).toHaveLength(1)
      h.dispose()
      h = await setup(path, 'page_image')
      expect(h.service.snapshot(target).turns.map((t) => t.attachment.kind)).toEqual([
        'none',
        'page',
        'pdf',
        'page_image',
      ])
      expect(h.calls).toHaveLength(0)
    } finally {
      h.dispose()
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('owns source tickets only during rendering and rejects unknown, canceled or changed originals', async () => {
    let request!: RenderRequest
    const bridge = new ImageBridge((r) => {
        request = r
      }),
      cancel = vi.fn(),
      read = vi.fn(async (t: typeof target) => ({
        status: 'opened' as const,
        document: { id: t.documentId, name: 'A.pdf', bytes: new Uint8Array(), sample: false },
      }))
    const images = new PageChatImages({
      bridge,
      images: () => DEFAULT_IMAGE_SETTINGS,
      read,
      cancel,
    })
    const controller = new AbortController(),
      pending = images.render(target, controller.signal)
    expect((await images.source('unknown')).status).toBe('error')
    expect(read).not.toHaveBeenCalled()
    expect((await images.source(request.token)).status).toBe('opened')
    read.mockResolvedValueOnce({
      status: 'opened',
      document: { id: 'B', name: 'B.pdf', bytes: new Uint8Array(), sample: false },
    })
    expect((await images.source(request.token)).status).toBe('error')
    read.mockRejectedValueOnce(new Error('PRIVATE_SOURCE_DETAIL'))
    expect((await images.source(request.token)).status).toBe('error')
    controller.abort()
    await expect(pending).rejects.toThrow()
    expect((await images.source(request.token)).status).toBe('error')
    expect(cancel).toHaveBeenCalledWith(request.token)
    expect(bridge.size).toBe(0)
  })
})

describe('preserved legacy attachments, page storage and local history (fake only)', () => {
  it('separates document/page conversations, persists complete formulas and recovers interrupted turns on restart without touching translations/settings', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-chat-'))
    try {
      const path = join(folder, 'db.sqlite'),
        h = await setup(path)
      h.store.save('A', 1, { status: 'done', text: '기존 번역', content: content() })
      h.store.saveSelectedModel('fake', 'gpt-6.1-sol')
      for (const t of [target, { documentId: 'A', page: 2 }, { documentId: 'B', page: 1 }]) {
        ok(await h.service.send(input('none', t)))
        await h.wait(t)
      }
      const id = h.store.chats.conversation(target)!
      h.store.chats.start(id, '중단된 질문', 'gpt-6.1-sol', {
        kind: 'none',
        documentId: 'A',
        documentName: 'A.pdf',
        page: 1,
      })
      h.dispose()
      const next = await setup(path)
      expect(next.calls).toHaveLength(0)
      expect(next.service.snapshot(target).turns.map((t) => t.status)).toEqual([
        'complete',
        'stopped',
      ])
      expect(next.service.snapshot(target).turns[0].answer).toBe('한국어 답변 $2^{-1}$')
      expect(next.service.snapshot({ documentId: 'B', page: 1 }).turns).toHaveLength(1)
      expect(next.store.load('A').get(1)).toMatchObject({ status: 'done', text: '기존 번역' })
      expect(next.store.selectedModel('fake')).toBe('gpt-6.1-sol')
      next.dispose()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('sends complete history in every mode; no context for none, fixed translation for page, one original PDF for pdf and no attachment replay', async () => {
    const h = await setup()
    try {
      ok(await h.service.send(input()))
      await h.wait()
      expect(h.calls[0].input).toEqual([
        { role: 'user', content: [{ type: 'input_text', text: '질문' }] },
      ])
      const stream = controlled()
      h.response = () => stream.response
      ok(await h.service.send(input('page', { question: '두 번째' })))
      h.translation = { status: 'done', text: '나중에 변경됨' }
      await vi.waitFor(() => expect(h.calls).toHaveLength(2))
      const page = h.calls[1]
      expect(page.input.slice(0, 2)).toEqual([
        { role: 'user', content: '질문' },
        { role: 'assistant', content: '한국어 답변 $2^{-1}$' },
      ])
      expect(page.input[2].content[0].text).toContain('고정된 번역')
      expect(page.input[2].content[0].text).toContain('visualElements')
      expect(JSON.stringify(page)).not.toContain('나중에 변경됨')
      expect(JSON.stringify(page)).not.toContain('input_image')
      stream.finish('완성')
      await h.wait()
      h.response = () => completed()
      ok(await h.service.send(input('pdf')))
      await h.wait()
      const full = h.calls[2]
      expect(full.input.slice(0, 4).map((m: any) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ])
      const files = full.input.flatMap((m: any) =>
        Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'input_file') : [],
      )
      expect(files).toHaveLength(1)
      expect(Buffer.from(files[0].file_data.split(',')[1], 'base64').toString()).toBe(
        '%PDF-FAKE_ORIGINAL',
      )
      expect(files[0].filename).toBe('A.pdf')
      expect(JSON.stringify(full)).not.toContain('고정된 번역')
      expect(full).toMatchObject({ store: false, stream: true, instructions: chatInstructions })
      for (const field of [
        'text',
        'previous_response_id',
        'conversation',
        'max_output_tokens',
        'tools',
        'metadata',
        'temperature',
      ])
        expect(full).not.toHaveProperty(field)
      expect(JSON.stringify(h.store.chats.turns(h.store.chats.conversation(target)))).not.toMatch(
        /base64|FAKE_ORIGINAL|고정된 번역|PRIVATE_FAKE/,
      )
      expect(h.readPDF).toHaveBeenCalledTimes(1)
    } finally {
      h.dispose()
    }
  })
  it('does not infer, render or substitute unavailable translations; rejects changed/oversized PDF, unknown models and oversized questions before inference', async () => {
    const h = await setup()
    try {
      h.translation = undefined
      expect((await h.service.send(input('page'))).status).toBe('error')
      h.translation = { status: 'done', text: '' }
      expect((await h.service.send(input('page'))).status).toBe('error')
      h.pdfFailure = true
      expect(await h.service.send(input('pdf'))).toMatchObject({
        status: 'error',
        message: expect.stringContaining('변경'),
      })
      h.pdfFailure = false
      h.pdf = new Uint8Array(CHAT_LIMITS.pdfBytes + 1)
      expect((await h.service.send(input('pdf'))).status).toBe('error')
      expect((await h.service.send(input('none', { question: 'x'.repeat(8001) }))).status).toBe(
        'error',
      )
      h.model = 'unknown'
      expect((await h.service.send(input())).status).toBe('error')
      expect(h.calls).toHaveLength(0)
      expect(h.auth.chatPending()).toBe(false)
    } finally {
      h.dispose()
    }
  })
  it('stops on long history/PDF context/request bounds rather than silently truncating; no plan permission means no inference', async () => {
    const h = await setup()
    try {
      const c = h.store.chats.conversation(target, true)!
      for (let n = 0; n < 2; n++) {
        const t = h.store.chats.start(c, 'q', 'gpt-6.1-sol', {
          kind: 'none',
          ...target,
          documentName: 'A.pdf',
        })
        h.store.chats.update(t, 'x'.repeat(70000), 'complete')
      }
      expect(await h.service.send(input())).toMatchObject({
        status: 'error',
        message: expect.stringContaining('입력 예산'),
      })
      expect(() => chatRequest('gpt-6.1-sol', [], 'q', [], { bytes: 1, pages: 100 })).toThrow(
        '입력 예산',
      )
      expect(() =>
        chatRequest('gpt-6.1-sol', [], 'q', [
          {
            type: 'input_file',
            filename: 'a.pdf',
            file_data: 'A'.repeat(CHAT_LIMITS.requestBytes),
          },
        ]),
      ).toThrow('전송 용량')
      const spy = vi.spyOn(h.auth, 'snapshot')
      spy.mockReturnValue({ ...h.auth.snapshot(), planAllowed: false })
      expect(await h.service.send(input())).toMatchObject({
        status: 'error',
        message: expect.stringContaining('플랜'),
      })
      expect(h.calls).toHaveLength(0)
    } finally {
      h.dispose()
    }
  })
})

describe('real deltas, terminal ownership, retries and cancellation (fake streams)', () => {
  it('reports a local chat write failure without inference, raw diagnostics or falsely completed turns', async () => {
    const h = await setup()
    try {
      vi.spyOn(h.store.chats, 'update').mockImplementationOnce(() => {
        throw new Error('PRIVATE_STORAGE_DETAIL')
      })
      ok(await h.service.send(input()))
      const result = await h.wait()
      expect(result.turns[0]).toMatchObject({
        status: 'error',
        question: '질문',
        error: '대화를 로컬 저장소에 저장하지 못했어요.',
      })
      expect(h.calls).toHaveLength(0)
      expect(JSON.stringify(h.events)).not.toContain('PRIVATE_STORAGE_DETAIL')
    } finally {
      h.dispose()
    }
  })
  it.each([
    [429, 'rate_limit_exceeded', 'quota'],
    [429, 'subscription_sharing_usage_limit_exceeded', 'quota'],
    [401, 'invalid_token', 'expired'],
    [403, 'insufficient_scope', 'permission'],
    [400, 'subscription_sharing_unsupported_capability', 'model'],
    [503, 'subscription_sharing_usage_unavailable', 'unavailable'],
  ])(
    'classifies HTTP %s / %s without fallback, secret error propagation or automatic chat retry',
    async (status, code, expected) => {
      const h = await setup()
      h.response = () =>
        Response.json(
          { error: { code, message: 'PRIVATE_BODY_TOKEN' } },
          { status: Number(status), headers: { 'retry-after': '3' } },
        )
      try {
        ok(await h.service.send(input('pdf')))
        const s = await h.wait()
        expect(s.turns[0].status).toBe('error')
        expect(h.auth.snapshot().error?.code).toBe(expected)
        expect(h.calls).toHaveLength(1)
        expect(h.auth.chatPending()).toBe(false)
        expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE_BODY_TOKEN|PRIVATE_FAKE_ACCESS/)
      } finally {
        h.dispose()
      }
    },
  )
  it('streams multiple chunks before completion to the original page, coalesces updates and replaces final text without duplication', async () => {
    const h = await setup(),
      stream = controlled()
    h.response = () => stream.response
    try {
      ok(await h.service.send(input()))
      stream.delta('첫 조각 ')
      await vi.waitFor(() => expect(h.service.snapshot(target).turns[0].answer).toBe('첫 조각 '))
      expect(h.service.snapshot(target).turns[0].status).toBe('streaming')
      for (let n = 0; n < 100; n++) stream.delta('가')
      await new Promise((r) => setTimeout(r, 70))
      expect(h.events.length).toBeLessThan(10)
      expect(h.service.snapshot({ documentId: 'A', page: 2 }).turns).toEqual([])
      stream.finish('최종 $2^{-1}$')
      const saved = await h.wait()
      expect(saved.turns[0]).toMatchObject({ status: 'complete', answer: '최종 $2^{-1}$' })
      expect(
        h.events.every((e) => e.documentId === 'A' && e.page === 1 && !!e.requestId && !!e.turnId),
      ).toBe(true)
    } finally {
      h.dispose()
    }
  })
  it.each(['missing', 'failed', 'incomplete', 'invalid', 'network'])(
    'preserves partial text as an error for %s; manual retry reuses the turn and excludes its partial history',
    async (mode) => {
      const h = await setup(),
        stream = controlled()
      h.response = () => stream.response
      try {
        const original = ok(await h.service.send(input())).turns[0]
        stream.delta('불완전 내용')
        await vi.waitFor(() =>
          expect(h.service.snapshot(target).turns[0].answer).toBe('불완전 내용'),
        )
        if (mode === 'missing') stream.close()
        if (mode === 'network') stream.disconnect()
        if (mode === 'failed')
          stream.send({
            type: 'response.failed',
            response: { error: { code: 'server_error', message: 'PRIVATE_SERVER' } },
          })
        if (mode === 'incomplete')
          stream.send({ type: 'response.incomplete', response: { status: 'incomplete' } })
        if (mode === 'invalid')
          stream.send({
            type: 'response.completed',
            response: { status: 'in_progress', output: [] },
          })
        let snapshot = await h.wait()
        expect(snapshot.turns[0]).toMatchObject({ status: 'error', answer: '불완전 내용' })
        if (mode === 'network') expect(h.auth.snapshot().error?.code).toBe('network')
        expect(h.calls).toHaveLength(1)
        h.response = () => completed('재시도 완료')
        ok(await h.service.send(input('none', { retryTurnId: original.id })))
        snapshot = await h.wait()
        expect(snapshot.turns).toHaveLength(1)
        expect(snapshot.turns[0]).toMatchObject({
          id: original.id,
          status: 'complete',
          question: '질문',
          answer: '재시도 완료',
        })
        expect(h.calls[1].input).toHaveLength(1)
        expect(JSON.stringify(h.events)).not.toMatch(/PRIVATE_SERVER|PRIVATE_NETWORK_DETAIL/)
      } finally {
        h.dispose()
      }
    },
  )
  it.each(['stop', 'clear'])(
    'ignores late chunks/completion after %s without rebuilding a conversation',
    async (action) => {
      const h = await setup(),
        stream = controlled()
      h.response = () => stream.response
      try {
        const saved = ok(await h.service.send(input()))
        stream.delta('받은 내용')
        await vi.waitFor(() => expect(h.service.snapshot(target).turns[0].answer).toBe('받은 내용'))
        if (action === 'stop') h.service.stop(saved.active!.requestId)
        else h.service.clear(target)
        stream.delta('늦은 조각')
        stream.finish('늦은 완료')
        const result = await h.wait()
        if (action === 'clear') expect(result.turns).toEqual([])
        else expect(result.turns[0]).toMatchObject({ status: 'stopped', answer: '받은 내용' })
        expect(JSON.stringify(result)).not.toContain('늦은')
        expect(h.calls).toHaveLength(1)
      } finally {
        h.dispose()
      }
    },
  )
  it('does not interleave commentary, reasoning or unrelated indices; complete output remains strictly validated', async () => {
    const chunks: string[] = [],
      p = new ChatProgress((t) => chunks.push(t))
    p.accept('response.output_item.added', {
      output_index: 0,
      item: { id: 'comment', type: 'message', role: 'assistant', phase: 'commentary' },
    })
    p.accept('response.output_text.delta', {
      output_index: 0,
      item_id: 'comment',
      content_index: 0,
      delta: '숨김',
    })
    p.accept('response.output_item.added', {
      output_index: 1,
      item: { id: 'final', type: 'message', role: 'assistant', phase: 'final_answer' },
    })
    p.accept('response.output_text.delta', {
      output_index: 1,
      item_id: 'final',
      content_index: 1,
      delta: '뒤',
    })
    p.accept('response.output_text.delta', {
      output_index: 1,
      item_id: 'final',
      content_index: 0,
      delta: '앞',
    })
    expect(chunks).toEqual(['뒤', '앞뒤'])
    expect(() =>
      p.accept('response.output_text.delta', {
        output_index: 1,
        item_id: 'wrong',
        content_index: 0,
        delta: '비밀',
      }),
    ).toThrow()
    const response = new Response(
      frame({
        type: 'response.completed',
        response: {
          status: 'completed',
          output: [
            finalItem('중간', 'commentary', 'c'),
            { id: 'r', type: 'reasoning' },
            finalItem('최종'),
          ],
        },
      }),
    )
    expect(await readResponseTextStream(response)).toBe('최종')
    await expect(
      readResponseTextStream(
        new Response(
          frame({
            type: 'response.completed',
            response: { status: 'completed', output: [{ type: 'function_call' }] },
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: 'invalid' })
  })
  it('prevents duplicate sends and disposes without accepting late data or exposing secrets in logs', async () => {
    const h = await setup(),
      stream = controlled()
    h.response = () => stream.response
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((k) =>
      vi.spyOn(console, k as 'log').mockImplementation(() => {}),
    )
    try {
      ok(await h.service.send(input()))
      expect((await h.service.send(input())).status).toBe('error')
      h.service.dispose()
      stream.finish('늦음')
      await vi.waitFor(() => expect(h.auth.chatPending()).toBe(false))
      expect(h.service.snapshot(target).turns[0].status).toBe('stopped')
      spies.forEach((spy) => expect(spy).not.toHaveBeenCalled())
    } finally {
      spies.forEach((spy) => spy.mockRestore())
      h.dispose()
    }
  })
})

it.each(['complete', 'cancel'])(
  'runs chat after the in-flight translation, ahead of the next batch, and resumes translations after chat %s',
  async (outcome) => {
    const h = await setup(),
      translationStream = controlled(),
      chatStream = controlled()
    // Use a real pending image translation through the shared service lock.
    let first = true
    h.response = () => {
      if (first) {
        first = false
        return translationStream.response
      }
      return chatStream.response
    }
    const original = h.auth.inferBatch('gpt-6.1-sol', [
      {
        page: 1,
        part: 1,
        image: {
          mimeType: 'image/jpeg',
          data: Buffer.from('fake').toString('base64'),
          width: 800,
          height: 800,
        },
      },
    ])
    await vi.waitFor(() => expect(h.calls).toHaveLength(1))
    ok(await h.service.send(input()))
    expect(h.auth.chatPending()).toBe(true)
    await expect(h.auth.inferBatch('gpt-6.1-sol', [])).rejects.toMatchObject({ code: 'busy' })
    expect(h.calls).toHaveLength(1)
    translationStream.finish(JSON.stringify({ pages: [{ page: 1, part: 1, ...content() }] }))
    await original
    await vi.waitFor(() => expect(h.calls).toHaveLength(2))
    if (outcome === 'cancel') h.service.stop(h.service.snapshot(target).active!.requestId)
    chatStream.finish('채팅 답변')
    await h.wait()
    expect(h.auth.chatPending()).toBe(false)
    const provider = new ChatGPTProvider(h.auth, h.store, async () => ({
      mimeType: 'image/jpeg',
      data: Buffer.from('fake').toString('base64'),
      width: 800,
      height: 800,
    }))
    provider.sync()
    expect(provider.settings().configured).toBe(true)
    h.response = () => completed(JSON.stringify({ pages: [{ page: 1, part: 1, ...content() }] }))
    const queue = new TranslationQueue(h.store, provider),
      session = queue.activate('A', 'A.pdf', 1),
      job = queue.claim()!
    await queue.submit(session.session, job.token, [imagePage(1)])
    expect(h.store.load('A').get(1)?.status).toBe('done')
    expect(h.calls).toHaveLength(3)
    expect(h.service.snapshot(target).turns[0].status).toBe(
      outcome === 'cancel' ? 'stopped' : 'complete',
    )
    h.dispose()
  },
)

it('deleting a document cancels its streaming or image-preparation owner and late responses never restore it, while another owner keeps running', async () => {
  const h = await setup(':memory:', 'page_image')
  const stream = controlled()
  h.response = () => stream.response
  const sent = await h.service.send(input())
  expect(sent.status).toBe('ok')
  await vi.waitFor(() => expect(h.calls.length).toBe(1))
  h.store.deleteLibrary({ kind: 'document', id: 'A' })
  h.service.removeDocuments(['A'])
  stream.finish('late fake')
  await vi.waitFor(() => expect(h.auth.chatPending()).toBe(false))
  expect(h.store.chats.conversation(target)).toBeNull()
  expect(h.events.some((e) => e.turn?.status === 'complete')).toBe(false)
  const otherStream = controlled()
  h.response = () => otherStream.response
  expect((await h.service.send({ ...input(), documentId: 'B' })).status).toBe('ok')
  h.service.removeDocuments(['A'])
  otherStream.finish('kept fake')
  await h.wait({ documentId: 'B', page: 1 })
  expect(h.service.snapshot({ documentId: 'B', page: 1 }).turns[0].status).toBe('complete')
  h.service.dispose()
  h.auth.dispose()
  h.store.close()
  const preparing = await setup(':memory:', 'page_image')
  let release!: (image: PageImage) => void
  preparing.renderImage.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      }),
  )
  const pending = preparing.service.send(input())
  await vi.waitFor(() => expect(preparing.renderImage).toHaveBeenCalledTimes(1))
  preparing.store.deleteLibrary({ kind: 'document', id: 'A' })
  preparing.service.removeDocuments(['A'])
  release({ mimeType: 'image/jpeg', data: '/9j/2Q==', width: 800, height: 800 })
  expect((await pending).status).toBe('error')
  expect(preparing.calls).toHaveLength(0)
  expect(preparing.store.chats.conversation(target)).toBeNull()
  preparing.service.dispose()
  preparing.auth.dispose()
  preparing.store.close()
})
