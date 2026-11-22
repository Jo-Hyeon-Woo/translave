// Loaded before the main module by Electron -r. Every external request is replaced;
// only the fake OAuth loopback callback uses the real fetch implementation.
const { shell, nativeImage, app, session, ipcMain } = require('electron')
const { resolve, relative, basename } = require('node:path')
const { tmpdir } = require('node:os')
const profile = process.env.TRANSLAVE_TEST_USER_DATA
const insideTemp = profile && relative(resolve(tmpdir()), resolve(profile))
if (!insideTemp || insideTemp.startsWith('..') || !basename(profile).startsWith('translave-'))
  throw new Error('Fake bootstrap requires an isolated temporary test profile')
const crypto = require('node:crypto')
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const jwk = keys.publicKey.export({ format: 'jwk' })
jwk.kid = 'active-test-key'
const issuer = 'https://auth.openai.com'
const discovery = {
  issuer,
  authorization_endpoint: issuer + '/api/accounts/authorize',
  token_endpoint: issuer + '/api/accounts/oauth/token',
  jwks_uri: issuer + '/.well-known/jwks.json',
  revocation_endpoint: issuer + '/oauth/revoke',
}
const state = {
  calls: [],
  chatCalls: [],
  timeline: [],
  chatMode: 'normal',
  chatAdvance: null,
  chatFinish: null,
  chatText: '',
  models: 0,
  refreshes: 0,
  gemini: 0,
  unknown: 0,
  logs: 0,
  runtimeWarnings: 0,
  logSites: [],
  active: 0,
  maxActive: 0,
  mode: 'normal',
  holdDoc: '',
  holdPage: 1,
  release: null,
  registration: 0,
  refreshExpired: false,
  imageOK: true,
  promptOK: true,
  inputOK: true,
  blockedNetwork: 0,
}
globalThis.__activeFake = state
// Delay only the reply, after the real SQLite handler has committed. No memo text is recorded.
const memoReplies = []
state.holdMemoReplies = false
state.memoHeld = 0
state.releaseMemoReplies = () => {
  state.holdMemoReplies = false
  for (const release of memoReplies.splice(0)) release()
  state.memoHeld = 0
}
const sourceReplies = []
state.holdSourceChannel = ''
state.sourceHeld = 0
state.releaseSourceReplies = () => {
  state.holdSourceChannel = ''
  for (const release of sourceReplies.splice(0)) release()
  state.sourceHeld = 0
}
const registerHandler = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) =>
  registerHandler(
    channel,
    !['memos:save', 'page-chat:image-source', 'queue:source'].includes(channel)
      ? listener
      : async (...args) => {
          const result = await listener(...args)
          if (channel === 'memos:save' && state.holdMemoReplies)
            await new Promise((resolve) => {
              memoReplies.push(resolve)
              state.memoHeld++
            })
          if (channel === state.holdSourceChannel)
            await new Promise((resolve) => {
              sourceReplies.push(resolve)
              state.sourceHeld++
            })
          return result
        },
  )
// Prevent renderer requests from reaching the internet even if output safety regresses.
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*'] },
    (_details, callback) => {
      state.blockedNetwork++
      callback({ cancel: true })
    },
  )
})
for (const method of ['log', 'warn', 'error', 'info', 'debug'])
  console[method] = (...args) => {
    const stack = new Error().stack ?? ''
    if (
      stack.includes('node:internal/process/warning') &&
      args.some((a) =>
        /SQLite is an experimental feature|The 'NO_COLOR' env is ignored/.test(String(a)),
      )
    ) {
      state.runtimeWarnings++
      return
    }
    state.logs++
    state.logSites.push({
      method,
      warning: args.some(
        (a) =>
          typeof a === 'string' &&
          /ExperimentalWarning|SQLite|Electron Security Warning|Debugger/.test(a),
      ),
      site: (new Error().stack ?? '')
        .split('\n')
        .slice(2, 4)
        .map((line) => line.replace(/.*[(/]([^/]+:\d+:\d+)\)?.*/, '$1')),
    })
  }
const realFetch = globalThis.fetch
let nonce = '',
  clientId = ''
shell.openExternal = async (raw) => {
  const url = new URL(raw)
  if (url.origin !== issuer) return
  nonce = url.searchParams.get('nonce')
  clientId =
    url.searchParams.get('client_id') === 'dynamic_agent_client'
      ? 'oaiapp_active_' + ++state.registration
      : url.searchParams.get('client_id')
  const callback = new URL(url.searchParams.get('redirect_uri'))
  if (callback.hostname !== '127.0.0.1') throw new Error('unexpected callback')
  callback.search = new URLSearchParams({
    state: url.searchParams.get('state'),
    ...(state.mode === 'cancel'
      ? { error: 'access_denied' }
      : { code: 'FAKE_AUTH_CODE', client_id: clientId }),
  }).toString()
  await realFetch(callback)
}
const jwt = (id, includeNonce) => {
  const b = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const text =
    b({ alg: 'RS256', kid: jwk.kid }) +
    '.' +
    b({
      sub: 'fake-user-' + id,
      email: 'fake@example.test',
      iss: issuer,
      aud: id,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...(includeNonce ? { nonce } : {}),
    })
  return (
    text + '.' + crypto.sign('RSA-SHA256', Buffer.from(text), keys.privateKey).toString('base64url')
  )
}
globalThis.fetch = async (raw, init) => {
  const u = String(raw)
  if (u.includes('generativelanguage.googleapis.com')) {
    state.gemini++
    throw new Error('inactive Gemini route')
  }
  if (u.endsWith('/openid-configuration')) return Response.json(discovery)
  if (u === discovery.jwks_uri) return Response.json({ keys: [jwk] })
  if (u === discovery.token_endpoint) {
    const params = new URLSearchParams(String(init?.body)),
      refresh = params.get('grant_type') === 'refresh_token'
    if (refresh) {
      state.refreshes++
      if (state.refreshExpired) return Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    const id = params.get('client_id')
    return Response.json({
      access_token: 'FAKE_ACCESS',
      refresh_token: 'FAKE_REFRESH',
      id_token: jwt(id, !refresh),
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    })
  }
  if (u === discovery.revocation_endpoint) return new Response(null, { status: 200 })
  if (u === 'https://api.openai.com/v1/models') {
    state.models++
    return Response.json({
      models: [
        { slug: 'gpt-6.1-sol', display_name: '가짜 모델 1', visibility: 'list' },
        { slug: 'gpt-6-sol', display_name: '가짜 모델 2', visibility: 'list' },
      ],
    })
  }
  if (u === 'https://api.openai.com/v1/responses') {
    state.active++
    state.maxActive = Math.max(state.maxActive, state.active)
    let retained = false
    try {
      const body = JSON.parse(String(init?.body))
      if (!body.text?.format) {
        state.timeline.push('chat')
        state.chatCalls.push(body)
        retained = true
        let controller,
          closed = false,
          index = 0
        const chunks = state.chatText
          ? state.chatText.match(/[\s\S]{1,400}/g)
          : [
              '## 채팅 답변\n\n첫 번째 조각입니다.\n\n',
              '기술 용어(Technical term)와 $4 \\times 128$을 설명합니다.\n\n',
              '<script>window.__chatUnsafe=1</script>\n\n![차단](https://invalid.test/chat.png) [위험](javascript:alert(1))\n\n```js\nconst x = 1\n```',
            ]
        const item = (text, status = 'completed') => ({
          id: 'msg_chat',
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          status,
          content: [{ type: 'output_text', text }],
        })
        const done = () => {
          if (closed) return
          closed = true
          state.active--
          state.chatAdvance = null
          state.chatFinish = null
          init?.signal?.removeEventListener('abort', abort)
        }
        const emit = (row) => {
          if (!closed)
            controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(row) + '\n\n'))
        }
        const abort = () => {
          if (!closed) {
            controller.close()
            done()
          }
        }
        const advance = () => {
          if (closed || index >= chunks.length) return
          emit({
            type: 'response.output_text.delta',
            item_id: 'msg_chat',
            output_index: 0,
            content_index: 0,
            delta: chunks[index++],
          })
        }
        const finish = () => {
          if (closed) return
          while (index < chunks.length) advance()
          if (state.chatMode === 'failed')
            emit({
              type: 'response.failed',
              response: { error: { code: 'server_error', message: 'PRIVATE_FAKE_SERVER' } },
            })
          else if (state.chatMode === 'incomplete')
            emit({ type: 'response.incomplete', response: { status: 'incomplete' } })
          else if (state.chatMode !== 'missing') {
            const final = item(chunks.join(''))
            emit({ type: 'response.output_item.done', output_index: 0, item: final })
            emit({
              type: 'response.completed',
              response: {
                id: 'resp_chat',
                status: state.chatMode === 'invalid' ? 'incomplete' : 'completed',
                output: [final],
              },
            })
          }
          controller.close()
          done()
        }
        const stream = new ReadableStream({
          start(c) {
            controller = c
            emit({ type: 'response.created', response: { id: 'resp_chat' } })
            emit({
              type: 'response.output_item.added',
              output_index: 0,
              item: item('', 'in_progress'),
            })
            advance()
            state.chatAdvance = advance
            state.chatFinish = finish
            init?.signal?.addEventListener('abort', abort, { once: true })
            if (state.chatMode !== 'hold') setTimeout(finish, 120)
          },
          cancel() {
            done()
          },
        })
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
      }
      const parts = body.input[0].content
      const metas = parts.filter((_, i) => i % 2 === 0).map((p) => JSON.parse(p.text)),
        meta = metas[0]
      state.inputOK &&=
        parts.length === metas.length * 2 &&
        body.store === false &&
        body.stream === true &&
        !('max_output_tokens' in body) &&
        !('media_resolution' in body)
      state.promptOK &&=
        body.instructions.includes('Korean(original English)') &&
        !body.instructions.includes('Do not summarize')
      const colors = {
        A: [255, 204, 204],
        B: [204, 230, 255],
        C: [204, 255, 204],
        D: [255, 230, 153],
      }
      const docs = metas.map((m, i) => {
        state.inputOK &&=
          m.part === 1 &&
          m.image === i + 1 &&
          parts[i * 2 + 1].type === 'input_image' &&
          !parts[i * 2].text.includes('EXTRACTED_SECRET')
        const bitmap = nativeImage.createFromBuffer(
            Buffer.from(parts[i * 2 + 1].image_url.split(',')[1], 'base64'),
          ),
          pixel = bitmap.toBitmap()
        state.imageOK &&=
          !bitmap.isEmpty() && bitmap.getSize().width >= 500 && bitmap.getSize().height >= 500
        let name = 'Sample',
          best = 1200
        for (const [key, rgb] of Object.entries(colors)) {
          const d =
            Math.abs(rgb[0] - pixel[2]) + Math.abs(rgb[1] - pixel[1]) + Math.abs(rgb[2] - pixel[0])
          if (d < best) {
            best = d
            name = key
          }
        }
        return best > 80 ? 'Sample' : name
      })
      const doc = docs[0]
      state.inputOK &&= docs.every((d) => d === doc)
      state.calls.push({ doc, page: meta.page, pages: metas.map((m) => m.page), model: body.model })
      state.timeline.push('translation:' + doc + ':' + metas.map((m) => m.page).join(','))
      if (state.holdDoc === doc && metas.some((m) => m.page === state.holdPage)) {
        state.holdDoc = ''
        await new Promise((resolve, reject) => {
          state.release = resolve
          init?.signal?.addEventListener('abort', () => reject(new Error('canceled')), {
            once: true,
          })
        })
      }
      if (state.mode === 'quota' || state.mode === 'rate')
        return Response.json(
          {
            error: {
              code:
                state.mode === 'quota'
                  ? 'subscription_sharing_usage_limit_exceeded'
                  : 'rate_limit_exceeded',
            },
          },
          { status: 429, headers: { 'retry-after': '0' } },
        )
      if (state.mode === 'auth')
        return Response.json({ error: { code: 'invalid_token' } }, { status: 401 })
      if (state.mode === 'invalid')
        return new Response(
          'data: ' +
            JSON.stringify({
              type: 'response.completed',
              response: {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: '{bad' }],
                  },
                ],
              },
            }) +
            '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      if (state.mode === 'incomplete')
        return new Response(
          'data: ' +
            JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete' } }) +
            '\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        )
      let values = metas
        .map((meta) => {
          const value = {
            page: meta.page,
            part: 1,
            contentType: state.mode === 'unreadable' ? 'unreadable' : 'text',
            translationMarkdown: `문서 ${doc} · ${meta.page}페이지 · 교착 상태(Deadlock) $4 \\times 128$\n\n<script>window.__unsafe=1</script>\n\n![외부](https://invalid.test/image.png) [링크](javascript:alert(1))`,
            visualElements: [
              { id: 'fig1', type: 'diagram', location: '중앙', descriptionMarkdown: '관계 $x^2$' },
            ],
            readingNotes: ['읽기 순서'],
            unclearRegions: state.mode === 'unreadable' ? ['작은 글자'] : [],
          }
          if (state.content) Object.assign(value, state.content)
          if (state.bodies) value.translationMarkdown = state.bodies[meta.page - 1]
          return value
        })
        .reverse()
      if (state.mode === 'shrink' && values.length > 1) values = values.slice(1)
      const item = {
        id: 'msg_fake',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: JSON.stringify({ pages: values }) }],
      }
      // The first real failure involved an absent MIME; exercise the repaired transport and collector.
      const rows = [
        { type: 'response.created', response: { id: 'resp_fake', status: 'in_progress' } },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: { id: 'resp_fake', status: 'completed', output: [] },
        },
      ]
      const bytes = new TextEncoder().encode(
        rows.map((row) => 'data: ' + JSON.stringify(row) + '\n\n').join(''),
      )
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes)
            c.close()
          },
        }),
      )
    } finally {
      if (!retained) state.active--
    }
  }
  state.unknown++
  throw new Error('unexpected external request')
}
