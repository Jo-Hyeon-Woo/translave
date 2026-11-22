import { CHATGPT_DIAGNOSTIC_CODES } from '../../shared/chatgpt'
import { EventStreamDecoder } from './eventStream'
import { TranslationOutput, TranslationOutputError } from './translationOutput'
import type { ChatGPTResponseDiagnostic } from '../../shared/chatgpt'
import { translationRequestBody } from './request'
import type { PageImageInput } from './request'
import { CHATGPT_MODEL_PROFILES } from './batching'
import { validateResponse, validImage } from '../batching'
import type { PageImage, PageTranslation } from '../../shared/contracts'
import type { ChatGPTModel } from '../../shared/chatgpt'
import { ChatGPTError, checkResponse, apiError } from './errors'
import { RESOURCE } from './oauth'
import type { Fetch } from './oauth'

// Capability evidence, not an availability/default-model list. Intersect account catalog on every refresh.
// https://developers.openai.com/api/docs/models/{gpt-6.1-sol,gpt-6-sol}, checked 2026-10-19.
const documentedImageJSON = new Set(Object.keys(CHATGPT_MODEL_PROFILES))
export function parseModels(raw: unknown): ChatGPTModel[] {
  const rows = (raw as { models?: unknown } | null)?.models
  if (!Array.isArray(rows)) throw new ChatGPTError('model')
  const found = new Set<string>()
  return rows.flatMap((row) => {
    if (
      !row ||
      row.visibility !== 'list' ||
      typeof row.slug !== 'string' ||
      typeof row.display_name !== 'string' ||
      found.has(row.slug)
    )
      return []
    found.add(row.slug)
    return [
      { slug: row.slug, name: row.display_name, supported: documentedImageJSON.has(row.slug) },
    ]
  })
}
export async function listModels(fetcher: Fetch, token: string, signal: AbortSignal) {
  const response = await fetcher(RESOURCE + '/models', {
    headers: { Authorization: 'Bearer ' + token },
    signal,
    redirect: 'error',
  })
  await checkResponse(response)
  return parseModels(await response.json())
}
const MAX_STREAM_BYTES = 4 * 1024 * 1024
const MAX_DIAGNOSTIC_BYTES = 16 * 1024
function mediaType(response: Response): NonNullable<ChatGPTResponseDiagnostic['mediaType']> {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!mime) return 'missing'
  if (mime === 'text/event-stream') return 'sse'
  if (mime === 'application/json' || mime.endsWith('+json')) return 'json'
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime === 'text/plain') return 'text'
  if (mime === 'application/octet-stream') return 'binary'
  return 'other'
}
function responseDiagnostic(
  response: Response,
  reason: ChatGPTResponseDiagnostic['reason'],
  lastPhase: ChatGPTResponseDiagnostic['lastPhase'],
  apiCode?: unknown,
  param?: unknown,
  bodyFormat?: ChatGPTResponseDiagnostic['bodyFormat'],
): ChatGPTResponseDiagnostic {
  const id = response.headers.get('x-request-id')
  const retry = response.headers.get('retry-after')
  const retryMs =
    retry === null
      ? NaN
      : /^\d+(?:\.\d+)?$/.test(retry.trim())
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now()
  const code = CHATGPT_DIAGNOSTIC_CODES.find((value) => value === apiCode)
  let parameter: ChatGPTResponseDiagnostic['parameter']
  if (typeof param === 'string') {
    if (param === 'model') parameter = 'model'
    else if (param === 'text' || param === 'text.format' || param.startsWith('text.format.'))
      parameter = 'format'
    else if (
      /^input(?:\[[0-9]{1,2}\])?\.content(?:\[[0-9]{1,2}\])?\.(?:image_url|detail|type)$/.test(
        param,
      )
    )
      parameter = 'image'
    else if (param === 'input' || /^input\[[0-9]{1,2}\]$/.test(param)) parameter = 'input'
    else if (param === 'instructions') parameter = 'instructions'
  }
  return {
    reason,
    httpStatus: response.status,
    lastPhase,
    mediaType: mediaType(response),
    ...(Number.isFinite(retryMs) && retryMs >= 0 && retryMs <= 8.64e15 - Date.now()
      ? { retryAfterMs: Math.ceil(retryMs) }
      : {}),
    ...(bodyFormat ? { bodyFormat } : {}),
    ...(code ? { apiCode: code } : {}),
    ...(parameter ? { parameter } : {}),
    ...(id && /^req_[A-Za-z0-9_-]{1,96}$/.test(id) ? { requestId: id } : {}),
  }
}
// Never return arbitrary server event/type/message/detail strings in diagnostics.
function streamPhase(type: unknown): ChatGPTResponseDiagnostic['lastPhase'] {
  if (type === 'response.created') return 'started'
  if (type === 'response.in_progress') return 'generating'
  if (type === 'response.output_text.delta' || type === 'response.output_text.done') return 'text'
  if (type === 'response.output_item.done') return 'item_done'
  if (type === 'response.completed') return 'completed'
  if (type === 'response.incomplete') return 'incomplete'
  if (type === 'response.failed' || type === 'error') return 'failed'
  return 'other'
}
function nonStreamError(response: Response, raw: string, complete: boolean): never {
  // Body text is inspected only in bounded memory. Never propagate messages, keys or values.
  const text = raw.trimStart()
  let data: any,
    shape: ChatGPTResponseDiagnostic['bodyFormat'] = !text
      ? 'empty'
      : text.startsWith('<')
        ? 'html'
        : 'text'
  if (/^[{[]/.test(text)) {
    shape = 'invalid_json'
    if (complete) {
      try {
        data = JSON.parse(text)
        shape = 'json'
      } catch {
        /* A partial or malformed document is never successful output. */
      }
    }
  }
  const isObject = data && typeof data === 'object' && !Array.isArray(data)
  const error = isObject && (data.error || data.type === 'error')
  const detail = isObject && Object.hasOwn(data, 'detail')
  if (error) shape = 'api_error'
  else if (detail) shape = 'detail'
  else if (isObject && (data.object === 'response' || (data.status && data.output)))
    shape = 'response'
  const e = apiError(response.status, data?.error?.code ?? data?.code ?? data?.error)
  const serverError = !response.ok || error || detail
  throw new ChatGPTError(
    serverError && (!response.ok || error) ? e.code : 'incomplete',
    serverError ? e.clearCredentials : false,
    responseDiagnostic(
      response,
      serverError ? 'server_error' : 'unexpected_format',
      serverError ? 'failed' : 'none',
      data?.error?.code ?? data?.code,
      data?.error?.param ?? data?.param,
      shape,
    ),
  )
}
async function openEventStream(response: Response) {
  if (!response.body) return nonStreamError(response, '', true)
  const reader = response.body.getReader()
  if (response.ok && mediaType(response) === 'sse') return { reader, initial: [] }
  const initial: Uint8Array[] = []
  let size = 0,
    complete = false,
    handedOff = false
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch {
        throw new ChatGPTError(
          'network',
          false,
          responseDiagnostic(response, 'connection_lost', 'none'),
        )
      }
      if (chunk.done) {
        complete = true
        break
      }
      initial.push(chunk.value)
      size += chunk.value.byteLength
      const head = Buffer.concat(initial, Math.min(size, 32))
      // A UTF-8 BOM itself can span network chunks.
      if (head[0] === 0xef && size < 3) continue
      const prefix = head.toString('utf8').replace(/^\uFEFF/, '')
      const start = prefix.replace(/^[\r\n]*/, '')
      // MIME does not replace the stream/completed/JSON validation contract. Only recognized
      // SSE framing may enter the parser when the header is missing or different.
      if (response.ok && /^(?:data:|event:|id:|retry:|:)/.test(start)) {
        handedOff = true
        return { reader, initial }
      }
      if (size > MAX_DIAGNOSTIC_BYTES) break
      const maybeSSE = ['', 'data:', 'event:', 'id:', 'retry:'].some((s) => s.startsWith(start))
      if (start && !/^[\s{[]/.test(start) && !maybeSSE) break
    }
    return nonStreamError(
      response,
      Buffer.concat(initial, Math.min(size, MAX_DIAGNOSTIC_BYTES)).toString('utf8'),
      complete,
    )
  } finally {
    if (!handedOff) {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
}
export async function readResponseTextStream(
  response: Response,
  onEvent?: (type: unknown, row: any) => void,
): Promise<string> {
  const { reader, initial } = await openEventStream(response),
    decoder = new TextDecoder('utf-8', { fatal: true }),
    output = new TranslationOutput()
  let bytes = 0,
    completed: string | undefined,
    lastPhase: ChatGPTResponseDiagnostic['lastPhase'] = 'none'
  const fail = (
    reason: ChatGPTResponseDiagnostic['reason'],
    code: 'incomplete' | 'invalid' | 'network' = 'incomplete',
    outputIssue?: ChatGPTResponseDiagnostic['outputIssue'],
  ): never => {
    throw new ChatGPTError(code, false, {
      ...responseDiagnostic(response, reason, lastPhase, undefined, undefined, 'sse'),
      ...(outputIssue ? { outputIssue } : {}),
    })
  }
  const stream = new EventStreamDecoder((data, name) => {
    if (data === '[DONE]') return true
    let row: any
    try {
      row = JSON.parse(data)
    } catch {
      return fail('invalid_event', 'invalid')
    }
    if (!row || typeof row !== 'object' || Array.isArray(row))
      return fail('invalid_event', 'invalid')
    // Named SSE errors may carry an API error envelope rather than a Responses type field.
    const type = name && name !== 'message' ? name : row.type
    lastPhase = streamPhase(type)
    if (type === 'error' || type === 'response.failed') {
      const e = apiError(0, row.response?.error?.code ?? row.error?.code ?? row.code ?? row.error)
      throw new ChatGPTError(
        e.code,
        e.clearCredentials,
        responseDiagnostic(
          response,
          'server_error',
          lastPhase,
          row.response?.error?.code ?? row.error?.code ?? row.code,
          row.response?.error?.param ?? row.error?.param ?? row.param,
          'sse',
        ),
      )
    }
    if (row.type !== undefined && row.type !== type) return fail('invalid_event', 'invalid')
    try {
      output.accept(type, row)
      onEvent?.(type, row)
    } catch (error) {
      return fail(
        'invalid_output',
        'invalid',
        error instanceof TranslationOutputError ? error.issue : 'item',
      )
    }
    if (type === 'response.incomplete') {
      const reason = row.response?.incomplete_details?.reason
      return fail(
        reason === 'max_output_tokens'
          ? 'output_limit'
          : reason === 'content_filter'
            ? 'content_filter'
            : 'server_incomplete',
      )
    }
    if (type !== 'response.completed') return true
    if (
      row.response?.status !== 'completed' ||
      row.response?.error ||
      row.response?.incomplete_details
    )
      return fail('invalid_completion')
    try {
      completed = output.complete(row.response)
    } catch (error) {
      return fail(
        'invalid_output',
        'invalid',
        error instanceof TranslationOutputError ? error.issue : 'item',
      )
    }
    return false
  })
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = initial.length ? { value: initial.shift()!, done: false } : await reader.read()
      } catch {
        return fail('connection_lost', 'network')
      }
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_STREAM_BYTES) return fail('invalid_output', 'invalid')
      let decoded: string
      try {
        decoded = decoder.decode(chunk.value, { stream: true })
      } catch {
        return fail('invalid_event', 'invalid')
      }
      stream.push(decoded)
      if (completed !== undefined) break
    }
    let tail: string
    try {
      tail = decoder.decode()
    } catch {
      return fail('invalid_event', 'invalid')
    }
    stream.push(tail)
    stream.finish()
    if (completed === undefined) return fail('missing_completion')
    return completed
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
export async function readTranslationBatchStream(
  response: Response,
  parts: { page: number; part: number }[],
): Promise<Map<string, PageTranslation>> {
  const text = await readResponseTextStream(response)
  try {
    return validateResponse(text, parts)
  } catch {
    throw new ChatGPTError(
      'invalid',
      false,
      responseDiagnostic(response, 'invalid_json', 'completed', undefined, undefined, 'sse'),
    )
  }
}
export async function readTranslationStream(
  response: Response,
  page: number,
): Promise<PageTranslation> {
  return (await readTranslationBatchStream(response, [{ page, part: 1 }])).get(`${page}:1`)!
}
export async function translateImages(
  fetcher: Fetch,
  token: string,
  model: string,
  images: PageImageInput[],
  signal: AbortSignal,
  maxRequestBytes = 16 * 1024 * 1024,
): Promise<Map<string, PageTranslation>> {
  if (
    !images.length ||
    images.length > 16 ||
    new Set(images.map((p) => p.page)).size !== images.length ||
    images.some(
      (p) => !Number.isInteger(p.page) || p.page < 1 || p.part !== 1 || !validImage(p.image),
    )
  )
    throw new ChatGPTError('image')
  const body = translationRequestBody(model, images)
  if (Buffer.byteLength(body) > Math.min(maxRequestBytes, 16 * 1024 * 1024))
    throw new ChatGPTError('image')
  const response = await fetcher(RESOURCE + '/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body,
    signal,
    redirect: 'error',
  })
  return readTranslationBatchStream(
    response,
    images.map((p) => ({ page: p.page, part: p.part })),
  )
}
export async function translateImage(
  fetcher: Fetch,
  token: string,
  model: string,
  page: number,
  image: PageImage,
  signal: AbortSignal,
  maxRequestBytes = 16 * 1024 * 1024,
): Promise<PageTranslation> {
  return (
    await translateImages(
      fetcher,
      token,
      model,
      [{ page, part: 1, image }],
      signal,
      maxRequestBytes,
    )
  ).get(`${page}:1`)!
}
