import { describe, expect, it, vi } from 'vitest'
import { readTranslationStream, translateImage } from '../../src/main/chatgpt/inference'
import { safeError } from '../../src/main/chatgpt/errors'
const content = {
  contentType: 'text',
  translationMarkdown: '한글 수식 $4 \\times 128$\n\n번역 본문',
  visualElements: [],
  readingNotes: [],
  unclearRegions: [],
}
const completed = () => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    error: null,
    incomplete_details: null,
    output: [
      {
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: JSON.stringify({ pages: [{ page: 3, part: 1, ...content }] }),
          },
        ],
      },
    ],
  },
})
function response(
  text: string,
  chunkSize = 13,
  mime = 'text/event-stream',
  requestId = 'req_fake123',
) {
  const bytes = new TextEncoder().encode(text)
  let at = 0
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at === bytes.length) {
          controller.close()
          return
        }
        controller.enqueue(bytes.slice(at, at + chunkSize))
        at = Math.min(bytes.length, at + chunkSize)
      },
    }),
    { headers: { 'Content-Type': mime, 'x-request-id': requestId } },
  )
}
const frame = (row: unknown) => 'data: ' + JSON.stringify(row) + '\n\n'

describe('ChatGPT stream framing, completion contract and private diagnostics', () => {
  it('classifies response.failed quota without treating stream termination as success', async () => {
    await expect(
      readTranslationStream(
        response(
          frame({
            type: 'response.failed',
            response: {
              status: 'failed',
              error: { code: 'subscription_sharing_usage_limit_exceeded' },
            },
          }),
        ),
        3,
      ),
    ).rejects.toMatchObject({ code: 'quota', diagnostic: { lastPhase: 'failed' } })
  })
  it('explicitly requests SSE with the official one-image JSON body and never retries', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('Accept')).toBe('text/event-stream')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        stream: true,
        store: false,
        input: [
          {
            content: [
              { type: 'input_text', text: expect.stringContaining('"page":3') },
              { type: 'input_image', image_url: 'data:image/jpeg;base64,YWJj', detail: 'high' },
            ],
          },
        ],
        text: { format: { type: 'json_schema', strict: true } },
      })
      return response(
        JSON.stringify({ detail: 'PRIVATE_ADMISSION_MESSAGE' }),
        1,
        'application/json',
      )
    })
    await expect(
      translateImage(
        fetcher,
        'FAKE_TOKEN',
        'gpt-6.1-sol',
        3,
        { mimeType: 'image/jpeg', data: 'YWJj', width: 100, height: 100 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ diagnostic: { bodyFormat: 'detail' } })
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0][0]).toBe('https://api.openai.com/v1/responses')
  })
  it.each(['application/json', 'text/plain', 'application/octet-stream', 'text/html'])(
    'validates completed SSE despite a mismatched %s header, with split prefix/BOM/UTF-8',
    async (mime) => {
      const body = '\uFEFF\n:event keep-alive\nevent: response.completed\n' + frame(completed())
      expect(await readTranslationStream(response(body, 1, mime), 3)).toEqual(content)
    },
  )
  it('validates SSE with no Content-Type and preserves the entire first large chunk', async () => {
    const payload = frame({ type: 'response.output_text.delta', delta: '가'.repeat(12000) })
    const raw = new TextEncoder().encode(payload + frame(completed()))
    expect(
      await readTranslationStream(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(raw)
              c.close()
            },
          }),
        ),
        3,
      ),
    ).toEqual(content)
  })
  it.each([
    [
      'application/json',
      JSON.stringify({ detail: 'PRIVATE_ADMISSION_MESSAGE' }),
      'json',
      'detail',
      'server_error',
    ],
    [
      'text/plain',
      JSON.stringify({ detail: 'PRIVATE_ADMISSION_MESSAGE' }),
      'text',
      'detail',
      'server_error',
    ],
    [
      'application/json',
      JSON.stringify(completed().response),
      'json',
      'response',
      'unexpected_format',
    ],
    ['text/html', '<html>PRIVATE_GATEWAY</html>', 'html', 'html', 'unexpected_format'],
    ['text/x-PRIVATE_HEADER', 'PRIVATE_TEXT', 'other', 'text', 'unexpected_format'],
    ['application/json', '{PRIVATE_MALFORMED', 'json', 'invalid_json', 'unexpected_format'],
    [
      'application/json',
      JSON.stringify({ PRIVATE_KEY: 'PRIVATE_BODY' }),
      'json',
      'json',
      'unexpected_format',
    ],
  ])(
    'classifies nonstream %s/%s without leaking response text',
    async (mime, body, mediaType, bodyFormat, reason) => {
      try {
        await readTranslationStream(response(body, 1, mime), 3)
        throw new Error('expected failure')
      } catch (e) {
        const error = safeError(e)
        expect(error).toMatchObject({
          diagnostic: { httpStatus: 200, mediaType, bodyFormat, reason },
        })
        expect(JSON.stringify(error)).not.toContain('PRIVATE_')
      }
    },
  )
  it('classifies an empty response and bounds/cancels nonstream JSON without reading it all', async () => {
    await expect(readTranslationStream(new Response(null), 3)).rejects.toMatchObject({
      diagnostic: { mediaType: 'missing', bodyFormat: 'empty', reason: 'unexpected_format' },
    })
    let pulls = 0,
      canceled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new TextEncoder().encode((pulls++ === 0 ? '{' : '') + ' '.repeat(1024)))
      },
      cancel() {
        canceled++
      },
    })
    await expect(readTranslationStream(new Response(stream), 3)).rejects.toMatchObject({
      diagnostic: { bodyFormat: 'invalid_json', reason: 'unexpected_format' },
    })
    expect(pulls).toBeLessThanOrEqual(18)
    expect(canceled).toBe(1)
  })
  it('retains code/field classification for non-2xx JSON and direct admission detail', async () => {
    await expect(
      readTranslationStream(
        new Response(
          JSON.stringify({
            error: {
              code: 'subscription_sharing_unsupported_capability',
              param: 'text.format.schema.PRIVATE_KEY',
              message: 'PRIVATE_BODY',
            },
          }),
          { status: 400 },
        ),
        3,
      ),
    ).rejects.toMatchObject({
      code: 'model',
      diagnostic: {
        apiCode: 'subscription_sharing_unsupported_capability',
        parameter: 'format',
        bodyFormat: 'api_error',
        httpStatus: 400,
      },
    })
    await expect(
      readTranslationStream(Response.json({ detail: 'PRIVATE_REGION_POLICY' }, { status: 403 }), 3),
    ).rejects.toMatchObject({
      code: 'permission',
      clearCredentials: false,
      diagnostic: { bodyFormat: 'detail', httpStatus: 403 },
    })
    await expect(
      readTranslationStream(response('data: [DONE]\n\n', 1, 'application/json'), 3),
    ).rejects.toMatchObject({
      diagnostic: { mediaType: 'json', bodyFormat: 'sse', reason: 'missing_completion' },
    })
  })
  it.each(['\n', '\r\n', '\r'])(
    'accepts one-byte UTF-8 and %j SSE line boundaries',
    async (newline) => {
      const body = [
        ':keep-alive',
        'retry: 1000',
        '',
        'event: response.created',
        'data: {"type":"response.created"}',
        '',
        'event: response.completed',
        'data: ' + JSON.stringify(completed()),
        '',
        '',
      ].join(newline)
      expect(await readTranslationStream(response(body, 1), 3)).toEqual(content)
    },
  )
  it('accepts multiline data, no final blank line and named completion; type conflicts still fail', async () => {
    const row: any = completed()
    delete row.type
    const pretty = JSON.stringify(row, null, 2)
      .split('\n')
      .map((line) => 'data: ' + line)
      .join('\n')
    expect(
      await readTranslationStream(response('event: response.completed\n' + pretty), 3),
    ).toEqual(content)
    await expect(
      readTranslationStream(
        response('event: response.completed\n' + frame({ type: 'response.created' })),
        3,
      ),
    ).rejects.toMatchObject({ code: 'invalid', diagnostic: { reason: 'invalid_event' } })
  })
  it('does not await a closed connection after an explicit completed event', async () => {
    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(frame(completed())))
      },
      cancel() {},
    })
    expect(
      await readTranslationStream(
        new Response(source, { headers: { 'Content-Type': 'Text/Event-Stream; charset=utf-8' } }),
        3,
      ),
    ).toEqual(content)
  })
  it('does not accept valid partial JSON or [DONE] without completed, and preserves safe last phase', async () => {
    const body =
      frame({ type: 'response.created', response: { id: 'DO_NOT_EXPOSE_RESPONSE_ID' } }) +
      frame({
        type: 'response.output_text.delta',
        delta: completed().response.output[0].content[0].text,
      }) +
      'data: [DONE]\n\n'
    await expect(readTranslationStream(response(body), 3)).rejects.toMatchObject({
      code: 'incomplete',
      diagnostic: {
        reason: 'missing_completion',
        httpStatus: 200,
        lastPhase: 'text',
        requestId: 'req_fake123',
      },
    })
  })
  it.each([
    ['max_output_tokens', 'output_limit'],
    ['content_filter', 'content_filter'],
    ['private_reason', 'server_incomplete'],
  ])('distinguishes server incomplete %s without copying raw reason', async (reason, expected) => {
    await expect(
      readTranslationStream(
        response(
          frame({
            type: 'response.incomplete',
            response: {
              status: 'incomplete',
              incomplete_details: { reason },
              output: [completed().response.output[0]],
            },
          }),
        ),
        3,
      ),
    ).rejects.toMatchObject({
      code: 'incomplete',
      diagnostic: { reason: expected, lastPhase: 'incomplete' },
    })
  })
  it.each([
    ['subscription_sharing_unsupported_capability', 'model'],
    ['subscription_sharing_usage_limit_exceeded', 'quota'],
    ['subscription_sharing_user_not_eligible', 'permission'],
  ])('named SSE errors classify %s instead of disappearing at EOF', async (code, category) => {
    const body =
      'event: error\ndata: ' +
      JSON.stringify({
        type: 'invalid_request_error',
        error: { code, param: 'text.format', message: 'PRIVATE_TOKEN_IMAGE_TRANSLATION' },
      }) +
      '\n\n'
    await expect(readTranslationStream(response(body), 3)).rejects.toMatchObject({
      code: category,
      diagnostic: { reason: 'server_error', lastPhase: 'failed' },
    })
  })
  it('recognizes JSON errors in HTTP 200 but never accepts non-stream JSON completion', async () => {
    await expect(
      readTranslationStream(
        response(
          JSON.stringify({
            error: {
              code: 'subscription_sharing_unsupported_capability',
              message: 'PRIVATE_SERVER_MESSAGE',
            },
          }),
          5,
          'application/json',
        ),
        3,
      ),
    ).rejects.toMatchObject({
      code: 'model',
      diagnostic: { reason: 'server_error', httpStatus: 200 },
    })
    await expect(
      readTranslationStream(
        response(JSON.stringify(completed().response), 5, 'application/json'),
        3,
      ),
    ).rejects.toMatchObject({ code: 'incomplete', diagnostic: { reason: 'unexpected_format' } })
    await expect(
      readTranslationStream(response('<html>PRIVATE_BODY</html>', 5, 'text/html'), 3),
    ).rejects.toMatchObject({ diagnostic: { reason: 'unexpected_format' } })
  })
  it('includes allowlisted server code and a fixed field label, never raw parameter paths', async () => {
    const r = response(
      'event: error\n' +
        frame({
          code: 'subscription_sharing_unsupported_capability',
          param: 'text.format.schema.PRIVATE_FIELD',
          message: 'PRIVATE_TRANSLATION',
        }),
    )
    try {
      await readTranslationStream(r, 3)
      throw new Error('expected failure')
    } catch (e) {
      const error = safeError(e)
      expect(error.diagnostic).toMatchObject({
        apiCode: 'subscription_sharing_unsupported_capability',
        parameter: 'format',
      })
      expect(JSON.stringify(error)).not.toContain('PRIVATE_')
    }
  })
  it('retains HTTP error classification and only safe metadata', async () => {
    const r = new Response(
      JSON.stringify({
        error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'PRIVATE_BODY' },
      }),
      {
        status: 429,
        headers: { 'x-request-id': 'req_fake429', 'Content-Type': 'application/json' },
      },
    )
    await expect(readTranslationStream(r, 3)).rejects.toMatchObject({
      code: 'quota',
      diagnostic: { httpStatus: 429, requestId: 'req_fake429', lastPhase: 'failed' },
    })
  })
  it('distinguishes invalid terminal shape, invalid final JSON and invalid event JSON', async () => {
    const status = completed()
    status.response.status = 'in_progress'
    await expect(readTranslationStream(response(frame(status)), 3)).rejects.toMatchObject({
      code: 'incomplete',
      diagnostic: { reason: 'invalid_completion' },
    })
    const missing: any = completed()
    delete missing.response.output
    await expect(readTranslationStream(response(frame(missing)), 3)).rejects.toMatchObject({
      code: 'invalid',
      diagnostic: { reason: 'invalid_output' },
    })
    const empty: any = completed()
    empty.response.output = [null]
    await expect(readTranslationStream(response(frame(empty)), 3)).rejects.toMatchObject({
      code: 'invalid',
      diagnostic: { reason: 'invalid_output' },
    })
    const invalid = completed()
    invalid.response.output[0].content[0].text = '{bad'
    await expect(readTranslationStream(response(frame(invalid)), 3)).rejects.toMatchObject({
      code: 'invalid',
      diagnostic: { reason: 'invalid_json' },
    })
    await expect(readTranslationStream(response('data: {bad\n\n'), 3)).rejects.toMatchObject({
      code: 'invalid',
      diagnostic: { reason: 'invalid_event' },
    })
  })
  it('bounds stream bytes and rejects invalid UTF-8 instead of silently replacing bytes', async () => {
    await expect(
      readTranslationStream(response('a'.repeat(4 * 1024 * 1024 + 1), 1024 * 1024), 3),
    ).rejects.toMatchObject({ code: 'invalid' })
    const source = new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([255]))
        c.close()
      },
    })
    await expect(
      readTranslationStream(
        new Response(source, { headers: { 'Content-Type': 'text/event-stream' } }),
        3,
      ),
    ).rejects.toMatchObject({ diagnostic: { reason: 'invalid_event' } })
  })
  it('sanitizes transport failures, unknown types, server messages and malicious request IDs without logging', async () => {
    const spies = ['log', 'info', 'debug', 'warn', 'error'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    )
    try {
      let count = 0
      const stream = new ReadableStream({
        pull(c) {
          if (count++ === 0)
            c.enqueue(new TextEncoder().encode(frame({ type: 'response.in_progress' })))
          else c.error(new Error('PRIVATE_TOKEN_PDF_IMAGE_TRANSLATION'))
        },
      })
      const failures: unknown[] = []
      for (const r of [
        new Response(stream, {
          headers: { 'Content-Type': 'text/event-stream', 'x-request-id': 'Bearer PRIVATE_AUTH' },
        }),
        response(frame({ type: 'PRIVATE_SOURCE_TYPE' }), 20, 'text/event-stream', 'PRIVATE_AUTH'),
        response(
          'event: error\n' +
            frame({ error: { code: 'PRIVATE_UNKNOWN_CODE', message: 'PRIVATE_TRANSLATION' } }),
        ),
      ]) {
        try {
          await readTranslationStream(r, 3)
          throw new Error('expected rejection')
        } catch (e) {
          failures.push(safeError(e))
        }
      }
      expect(failures[0]).toMatchObject({
        code: 'network',
        diagnostic: { reason: 'connection_lost', lastPhase: 'generating' },
      })
      expect(JSON.stringify(failures)).not.toContain('PRIVATE_')
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})
