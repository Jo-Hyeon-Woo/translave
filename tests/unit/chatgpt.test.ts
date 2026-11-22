import { apiError } from '../../src/main/chatgpt/errors'
import { describe, it, expect, vi } from 'vitest'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { ChatGPTService } from '../../src/main/chatgpt/service'
import { FileAuthVault } from '../../src/main/chatgpt/vault'
import type { AuthRecord, AuthVault } from '../../src/main/chatgpt/vault'
import {
  ISSUER,
  RESOURCE,
  SCOPES,
  pkceChallenge,
  verifyIdentity,
} from '../../src/main/chatgpt/oauth'
import { parseModels, readTranslationStream } from '../../src/main/chatgpt/inference'

const content = {
  contentType: 'text',
  translationMarkdown: '교착 상태(Deadlock)와 처리량(Throughput) $4 \\times 128$\n\n한국어 본문',
  visualElements: [],
  readingNotes: [],
  unclearRegions: [],
}
function sse(
  page = 2,
  options: { type?: string; raw?: string; code?: string; status?: string } = {},
) {
  const type = options.type ?? 'response.completed'
  const row = {
    type,
    response: {
      status: options.status ?? 'completed',
      error: options.code ? { code: options.code } : null,
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: options.raw ?? JSON.stringify({ pages: [{ page, part: 1, ...content }] }),
            },
          ],
        },
      ],
    },
  }
  return new Response('data: ' + JSON.stringify(row) + '\n\n', {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
class MemoryVault implements AuthVault {
  record: AuthRecord = { profiles: [], activeId: null }
  fail = false
  async hostId() {
    return 'urn:uuid:11111111-1111-4111-8111-111111111111'
  }
  async load() {
    return structuredClone(this.record)
  }
  async save(record: AuthRecord) {
    if (this.fail) throw new Error('disk')
    this.record = structuredClone(record)
  }
}
async function harness() {
  const vault = new MemoryVault(),
    keys = await generateKeyPair('ES256')
  const jwk = await exportJWK(keys.publicKey)
  jwk.kid = 'fake-key'
  const d = {
    issuer: ISSUER,
    authorization_endpoint: ISSUER + '/api/accounts/authorize',
    token_endpoint: ISSUER + '/api/accounts/oauth/token',
    jwks_uri: ISSUER + '/.well-known/jwks.json',
    revocation_endpoint: ISSUER + '/oauth/revoke',
  }
  let authorize: URL | undefined
  let mode = 'success',
    scope = SCOPES,
    nonceBad = false,
    responseMode = 'normal',
    refreshExpired = false,
    revokeFailed = false
  let inference = 0,
    refreshes = 0,
    revocations = 0,
    renderCount = 0
  let requestBody: any, tokenBody: URLSearchParams | undefined
  let release: (() => void) | undefined
  const jwt = async (
    nonce?: string,
    subject = 'verified-subject',
    aud = 'oaiapp_fake',
    issuer = ISSUER,
    expiration: number | string = '1h',
  ) =>
    new SignJWT({ ...(nonce ? { nonce } : {}), email: 'fake@example.test' })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid })
      .setSubject(subject)
      .setIssuer(issuer)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime(expiration)
      .sign(keys.privateKey)
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url)
    if (path.endsWith('openid-configuration')) return Response.json(d)
    if (path === d.jwks_uri) return Response.json({ keys: [jwk] })
    if (path === d.token_endpoint) {
      tokenBody = new URLSearchParams(String(init?.body))
      const refresh = tokenBody.get('grant_type') === 'refresh_token'
      if (refresh) {
        refreshes++
        if (refreshExpired) return Response.json({ error: 'invalid_grant' }, { status: 400 })
      }
      return Response.json({
        access_token: 'FAKE_ACCESS_SECRET',
        refresh_token: 'FAKE_REFRESH_' + refreshes,
        id_token: await jwt(
          refresh ? undefined : nonceBad ? 'wrong' : authorize!.searchParams.get('nonce')!,
        ),
        expires_in: 3600,
        token_type: 'Bearer',
        scope,
      })
    }
    if (path === d.revocation_endpoint) {
      revocations++
      return new Response(null, { status: revokeFailed ? 503 : 200 })
    }
    if (path.endsWith('/models'))
      return Response.json({
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'Account model', visibility: 'list' },
          { slug: 'future-unverified', display_name: 'Unknown capability', visibility: 'list' },
        ],
      })
    if (path.endsWith('/responses')) {
      inference++
      if (responseMode === 'timeout')
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      requestBody = JSON.parse(String(init?.body))
      if (responseMode === 'delayed')
        await new Promise<void>((resolve) => {
          release = resolve
        })
      if (responseMode === 'invalid') return sse(2, { raw: '{broken' })
      return sse()
    }
    throw new Error('Unexpected request')
  }
  const openBrowser = async (url: string) => {
    authorize = new URL(url)
    if (mode === 'wait') return
    const callback = new URL(authorize.searchParams.get('redirect_uri')!)
    callback.search = new URLSearchParams({
      state: mode === 'state' ? 'wrong-state' : authorize.searchParams.get('state')!,
      ...(mode === 'cancel'
        ? { error: 'access_denied' }
        : { code: 'FAKE_CODE', client_id: 'oaiapp_fake' }),
    }).toString()
    await fetch(callback)
  }
  const render = vi.fn(async () => {
    renderCount++
    return {
      mimeType: 'image/jpeg' as const,
      data: Buffer.from('fake-image-data').toString('base64'),
      width: 400,
      height: 300,
    }
  })
  const service = new ChatGPTService({ vault, fetcher, openBrowser, render })
  await service.initialize()
  return {
    service,
    vault,
    fetcher,
    d,
    jwt,
    render,
    get authorize() {
      return authorize
    },
    get tokenBody() {
      return tokenBody
    },
    get requestBody() {
      return requestBody
    },
    get inference() {
      return inference
    },
    get refreshes() {
      return refreshes
    },
    get revocations() {
      return revocations
    },
    get renderCount() {
      return renderCount
    },
    set mode(v: string) {
      mode = v
    },
    set scope(v: string) {
      scope = v
    },
    set nonceBad(v: boolean) {
      nonceBad = v
    },
    set responseMode(v: string) {
      responseMode = v
    },
    set refreshExpired(v: boolean) {
      refreshExpired = v
    },
    set revokeFailed(v: boolean) {
      revokeFailed = v
    },
    release: () => release?.(),
    deps: { vault, fetcher, openBrowser, render },
  }
}
const target = {
  documentId: 'a'.repeat(64),
  documentName: 'Original A.pdf',
  page: 2,
  model: 'gpt-6.1-sol',
}

describe('official ChatGPT login and isolated single-page trial (fake services only)', () => {
  it('PKCE, issued registration, verified JWT and separate plan permission; no implicit inference', async () => {
    const h = await harness(),
      state = await h.service.signIn()
    expect(state.status).toBe('signed_in')
    expect(state.planAllowed).toBe(true)
    expect(state.verified).toBe(true)
    expect(h.authorize!.origin).toBe(ISSUER)
    expect(h.authorize!.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(h.authorize!.searchParams.get('agent_name_hint')).toBe('Translave')
    expect(h.authorize!.searchParams.get('code_challenge')).toBe(
      pkceChallenge(h.tokenBody!.get('code_verifier')!),
    )
    expect(h.tokenBody!.get('client_id')).toBe('oaiapp_fake')
    expect(h.tokenBody!.get('resource')).toBe(RESOURCE)
    expect(h.inference).toBe(0)
    expect(JSON.stringify(state)).not.toContain('FAKE_ACCESS_SECRET')
    await h.service.discoverModels()
    expect(h.inference).toBe(0)
    await h.service.signIn(state.activeId!)
    expect(h.authorize!.searchParams.get('client_id')).toBe('oaiapp_fake')
    expect(h.authorize!.searchParams.has('agent_name_hint')).toBe(false)
    expect(h.vault.record.profiles).toHaveLength(1)
    h.scope = 'openid profile email'
    const identityOnly = await h.service.signIn(state.activeId!)
    expect(identityOnly.status).toBe('signed_in')
    expect(identityOnly.planAllowed).toBe(false)
    expect((await h.service.discoverModels()).error?.code).toBe('permission')
    expect(h.inference).toBe(0)
  })
  it.each(['state', 'cancel', 'nonce'])(
    'rejects %s mismatch/cancel without storing credentials',
    async (mode) => {
      const h = await harness()
      if (mode === 'nonce') h.nonceBad = true
      else h.mode = mode
      const s = await h.service.signIn()
      expect(s.error?.code).toBe(mode === 'cancel' ? 'canceled' : 'auth')
      expect(h.vault.record.profiles.every((p) => !p.credentials)).toBe(true)
      expect(h.inference).toBe(0)
    },
  )
  it('validates signature, issuer, audience, expiry, nonce and returning subject', async () => {
    const h = await harness(),
      token = await h.jwt('nonce')
    expect(await verifyIdentity(h.fetcher, h.d, token, 'oaiapp_fake', 'nonce')).toMatchObject({
      subject: 'verified-subject',
    })
    for (const [aud, nonce, subject] of [
      ['wrong-aud', 'nonce', undefined],
      ['oaiapp_fake', 'wrong', undefined],
      ['oaiapp_fake', 'nonce', 'wrong-sub'],
    ])
      await expect(
        verifyIdentity(h.fetcher, h.d, token, aud!, nonce, subject),
      ).rejects.toMatchObject({ code: 'auth' })
    const other = await generateKeyPair('ES256')
    const forged = await new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'ES256', kid: 'fake-key' })
      .setSubject('s')
      .setIssuer(ISSUER)
      .setAudience('oaiapp_fake')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(other.privateKey)
    await expect(
      verifyIdentity(h.fetcher, h.d, forged, 'oaiapp_fake', 'nonce'),
    ).rejects.toMatchObject({ code: 'auth' })
    const expired = await new SignJWT({ nonce: 'nonce' })
      .setProtectedHeader({ alg: 'ES256', kid: 'fake-key' })
      .setSubject('s')
      .setIssuer(ISSUER)
      .setAudience('oaiapp_fake')
      .setIssuedAt()
      .setExpirationTime(1)
      .sign(other.privateKey)
    await expect(
      verifyIdentity(h.fetcher, h.d, expired, 'oaiapp_fake', 'nonce'),
    ).rejects.toMatchObject({ code: 'auth' })
  })
  it('cancels browser wait and preserves secure-storage failure without opening login', async () => {
    const h = await harness()
    h.mode = 'wait'
    const pending = h.service.signIn()
    await vi.waitFor(() => expect(h.authorize).toBeDefined())
    h.service.cancel()
    expect((await pending).error?.code).toBe('canceled')
    const blocked = await harness()
    blocked.vault.fail = true
    expect((await blocked.service.signIn()).status).toBe('disconnected')
    expect(blocked.authorize).toBeUndefined()
  })
  it('restores unverified, refreshes serially, rotates tokens and logs out with revocation', async () => {
    const h = await harness()
    await h.service.signIn()
    const restored = new ChatGPTService(h.deps)
    await restored.initialize()
    expect(restored.snapshot()).toMatchObject({ status: 'restored', verified: false })
    await Promise.all([restored.discoverModels(), restored.discoverModels()])
    expect(h.refreshes).toBe(1)
    expect(restored.snapshot()).toMatchObject({ status: 'signed_in', verified: true })
    expect(h.vault.record.profiles[0].credentials?.refreshToken).toBe('FAKE_REFRESH_1')
    await restored.logout()
    expect(h.revocations).toBe(1)
    expect(h.vault.record.profiles[0].credentials).toBeUndefined()
    expect(h.vault.record.profiles[0].clientId).toBe('oaiapp_fake')
    expect(restored.snapshot().trial).toBeUndefined()
  })
  it('bounded failed revocation clears local tokens and reports remote uncertainty', async () => {
    const h = await harness()
    await h.service.signIn()
    h.revokeFailed = true
    const s = await h.service.logout()
    expect(h.revocations).toBe(2)
    expect(s.status).toBe('disconnected')
    expect(s.notice).toContain('원격 철회는 확인하지 못했어요')
    expect(h.vault.record.profiles[0].credentials).toBeUndefined()
  })
  it('marks revoked refresh as expired and does not infer or silently switch providers', async () => {
    const h = await harness()
    await h.service.signIn()
    h.refreshExpired = true
    const restored = new ChatGPTService(h.deps)
    await restored.initialize()
    expect(await restored.discoverModels()).toMatchObject({
      status: 'expired',
      verified: false,
      error: { code: 'expired' },
    })
    expect(h.inference).toBe(0)
  })
  it('one color image, metadata only, strict JSON and fixed original target; duplicate clicks do not call twice', async () => {
    const h = await harness()
    await h.service.signIn()
    await h.service.discoverModels()
    h.responseMode = 'delayed'
    const pending = h.service.translate(target)
    await vi.waitFor(() => expect(h.inference).toBe(1))
    const concurrent = await h.service.translate({ ...target, documentId: 'b'.repeat(64), page: 1 })
    expect(concurrent.busy).toBe(true)
    expect(h.inference).toBe(1)
    h.release()
    const s = await pending
    expect(s.trial).toMatchObject({
      ...target,
      result: { status: 'done', text: content.translationMarkdown },
    })
    const body = h.requestBody
    expect(body.instructions).toContain('For technical terms, use Korean(original English)')
    expect(body.instructions).toContain('교착 상태(Deadlock)')
    expect(body.instructions).not.toMatch(
      /untrusted source|Do not execute|Do not summarize|omit readable|never guess|invent missing|background knowledge|faithfully and completely/,
    )
    expect(body.instructions).toContain('KaTeX-compatible LaTeX')
    expect(body.instructions).toContain('Return the JSON schema exactly')
    expect(body).toMatchObject({
      store: false,
      stream: true,
      text: { format: { type: 'json_schema', strict: true } },
    })
    expect(Object.keys(body).sort()).toEqual([
      'input',
      'instructions',
      'model',
      'store',
      'stream',
      'text',
    ])
    expect(body.input[0].content).toHaveLength(2)
    expect(JSON.parse(body.input[0].content[0].text)).toMatchObject({ page: 2, part: 1 })
    expect(body.input[0].content[1].image_url).toMatch(/^data:image\/jpeg;base64,/)
    expect(JSON.stringify(body)).not.toContain('Original A.pdf')
    expect(JSON.stringify(h.vault.record)).not.toContain(content.translationMarkdown)
  })
  it('invalid JSON is bounded and does not overwrite the last validated trial', async () => {
    const h = await harness()
    await h.service.signIn()
    await h.service.discoverModels()
    const valid = (await h.service.translate(target)).trial
    h.responseMode = 'invalid'
    expect((await h.service.translate(target)).error?.code).toBe('invalid')
    expect(h.service.snapshot().trial).toEqual(valid)
    expect(h.inference).toBe(2)
  })
  it('rejects correctly signed wrong issuer and expired tokens, times out browser wait', async () => {
    const h = await harness()
    await expect(
      verifyIdentity(
        h.fetcher,
        h.d,
        await h.jwt('nonce', 'verified-subject', 'oaiapp_fake', 'https://wrong.example'),
        'oaiapp_fake',
        'nonce',
      ),
    ).rejects.toMatchObject({ code: 'auth' })
    await expect(
      verifyIdentity(
        h.fetcher,
        h.d,
        await h.jwt('nonce', 'verified-subject', 'oaiapp_fake', ISSUER, 1),
        'oaiapp_fake',
        'nonce',
      ),
    ).rejects.toMatchObject({ code: 'auth' })
    h.mode = 'wait'
    vi.useFakeTimers()
    const pending = h.service.signIn()
    await vi.waitFor(() => expect(h.authorize).toBeDefined())
    try {
      await vi.advanceTimersByTimeAsync(300001)
      expect((await pending).error?.code).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })
  it('logout during a delayed trial discards stale response and clears credentials', async () => {
    const h = await harness()
    await h.service.signIn()
    await h.service.discoverModels()
    h.responseMode = 'delayed'
    const pending = h.service.translate(target)
    await vi.waitFor(() => expect(h.inference).toBe(1))
    const loggedOut = h.service.logout()
    h.release()
    await pending
    expect(await loggedOut).toMatchObject({
      status: 'disconnected',
      verified: false,
      planAllowed: false,
    })
    expect(h.service.snapshot().trial).toBeUndefined()
    expect(h.vault.record.profiles[0].credentials).toBeUndefined()
  })
  it('distinguishes the manual 3-minute timeout from a server incomplete response without retry', async () => {
    const h = await harness()
    await h.service.signIn()
    await h.service.discoverModels()
    h.responseMode = 'timeout'
    vi.useFakeTimers()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const c = new AbortController()
      setTimeout(() => c.abort(new DOMException('Timed out', 'TimeoutError')), ms)
      return c.signal
    })
    try {
      const pending = h.service.translate(target)
      await vi.advanceTimersByTimeAsync(180001)
      const s = await pending
      expect(s.error).toMatchObject({ code: 'incomplete', diagnostic: { reason: 'timeout' } })
      expect(s.error?.message).toContain('3분')
      expect(s.trial).toBeUndefined()
      expect(h.inference).toBe(1)
    } finally {
      timeout.mockRestore()
      vi.useRealTimers()
    }
  })
  it('model availability comes from account catalog, unknown capabilities are unavailable', () => {
    expect(
      parseModels({
        models: [
          { slug: 'future', display_name: 'Future', visibility: 'list' },
          { slug: 'gpt-6-sol', display_name: 'Hidden', visibility: 'hide' },
        ],
      }),
    ).toEqual([{ slug: 'future', name: 'Future', supported: false }])
  })
  it('accepts blank/visual-only/unreadable by existing validation and preserves math JSON exactly', async () => {
    for (const c of [
      { ...content, contentType: 'blank', translationMarkdown: '' },
      {
        ...content,
        contentType: 'visual_only',
        translationMarkdown: '',
        visualElements: [
          { id: 'v', type: 'diagram', location: '중앙', descriptionMarkdown: '관계 $x^2$' },
        ],
      },
      {
        ...content,
        contentType: 'unreadable',
        translationMarkdown: '',
        unclearRegions: ['읽기 어려움'],
      },
    ])
      expect(
        await readTranslationStream(
          sse(2, { raw: JSON.stringify({ pages: [{ page: 2, part: 1, ...c }] }) }),
          2,
        ),
      ).toEqual(c)
    expect((await readTranslationStream(sse(), 2)).translationMarkdown).toBe(
      content.translationMarkdown,
    )
  })
})
describe('protected local credential storage', () => {
  it.each(['active', 'none', 'missing'] as const)(
    'keeps only the active registration on restore (%s), without inventing plan confirmation',
    async (mode) => {
      const h = await harness()
      await h.service.signIn()
      const active = structuredClone(h.vault.record.profiles[0])
      const other = { ...structuredClone(active), id: 'other', clientId: 'oaiapp_other' }
      h.vault.record = {
        planNoticeSeen: false,
        profiles: [other, active],
        activeId: mode === 'active' ? active.id : mode === 'missing' ? 'missing' : null,
      }
      const restored = new ChatGPTService({
        vault: h.vault,
        fetcher: h.fetcher,
        openBrowser: async () => {},
        render: h.render,
      })
      await restored.initialize()
      expect(h.vault.record).toEqual({
        planNoticeSeen: false,
        profiles: mode === 'active' ? [active] : [],
        activeId: mode === 'active' ? active.id : null,
      })
      expect(restored.snapshot()).toMatchObject({
        status: mode === 'active' ? 'restored' : 'disconnected',
        verified: false,
        activeId: mode === 'active' ? active.id : null,
      })
      expect(restored.snapshot()).not.toHaveProperty('acknowledged')
      expect(h.inference).toBe(0)
      if (mode === 'active') {
        expect((await restored.discoverModels()).verified).toBe(true)
        expect(h.vault.record.profiles).toHaveLength(1)
        expect(h.vault.record.profiles[0].id).toBe(active.id)
      }
      restored.dispose()
    },
  )
  it('reports cleanup failure without deleting credentials, falling back to another account or allowing inference', async () => {
    const h = await harness()
    await h.service.signIn()
    const active = h.vault.record.profiles[0]
    h.vault.record.profiles.push({
      ...structuredClone(active),
      id: 'other',
      clientId: 'oaiapp_other',
    })
    const before = structuredClone(h.vault.record)
    h.vault.fail = true
    const restored = new ChatGPTService({
      vault: h.vault,
      fetcher: h.fetcher,
      openBrowser: async () => {},
      render: h.render,
    })
    await restored.initialize()
    expect(restored.snapshot()).toMatchObject({
      status: 'disconnected',
      verified: false,
      planAllowed: false,
      error: { code: 'storage' },
      profiles: [],
      activeId: null,
    })
    expect(h.vault.record).toEqual(before)
    expect((await restored.signIn()).error?.code).toBe('storage')
    expect(h.inference).toBe(0)
    restored.dispose()
  })
  it('repeated sign-in and refresh retain one registration, and no extra confirmation is written', async () => {
    const h = await harness()
    const first = await h.service.signIn()
    await h.service.signIn()
    expect(h.authorize!.searchParams.get('client_id')).toBe('oaiapp_fake')
    expect(h.vault.record.profiles).toHaveLength(1)
    expect(h.service.snapshot().activeId).toBe(first.activeId)
    expect(h.vault.record).not.toHaveProperty('planNoticeSeen')
    await h.service.discoverModels()
    await h.service.translate(target)
    expect(h.inference).toBe(1)
    expect(h.vault.record).not.toHaveProperty('planNoticeSeen')
  })
  it('restores encrypted records, stable host, refuses unavailable/plaintext backend and preserves disk', async () => {
    const path = await mkdtemp(join(tmpdir(), 'translave-auth-unit-')),
      key = randomBytes(32)
    const encryption = {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => 'keychain',
      encryptString: (s: string) => {
        const iv = randomBytes(12),
          cipher = createCipheriv('aes-256-gcm', key, iv),
          bytes = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()])
        return Buffer.concat([iv, cipher.getAuthTag(), bytes])
      },
      decryptString: (b: Buffer) => {
        const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
        d.setAuthTag(b.subarray(12, 28))
        return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
      },
    }
    try {
      const vault = new FileAuthVault(path, encryption),
        h = await harness()
      await h.service.signIn()
      await vault.save(h.vault.record)
      const host = await vault.hostId(),
        restored = new FileAuthVault(path, encryption)
      expect(await restored.hostId()).toBe(host)
      expect(await restored.load()).toEqual(h.vault.record)
      const before = await readFile(join(path, 'connections.enc'))
      expect(before.includes(Buffer.from('FAKE_ACCESS_SECRET'))).toBe(false)
      const plain = new FileAuthVault(path, {
        ...encryption,
        getSelectedStorageBackend: () => 'basic_text',
      })
      await expect(plain.save(h.vault.record)).rejects.toMatchObject({ code: 'storage' })
      await expect(
        new FileAuthVault(path, { ...encryption, isEncryptionAvailable: () => false }).load(),
      ).rejects.toMatchObject({ code: 'storage' })
      expect(await readFile(join(path, 'connections.enc'))).toEqual(before)
      const active = h.vault.record.profiles[0]
      const multiple = {
        planNoticeSeen: false,
        activeId: active.id,
        profiles: [
          { ...structuredClone(active), id: 'old-registration', clientId: 'oaiapp_old' },
          active,
        ],
      }
      await vault.save(multiple)
      const encrypted = await readFile(join(path, 'connections.enc'))
      const failing = new FileAuthVault(path, {
        ...encryption,
        encryptString: () => {
          throw new Error('fake write failure')
        },
      })
      const blocked = new ChatGPTService({
        vault: failing,
        fetcher: h.fetcher,
        openBrowser: async () => {},
        render: h.render,
      })
      await blocked.initialize()
      expect(blocked.snapshot().error?.code).toBe('storage')
      expect(await readFile(join(path, 'connections.enc'))).toEqual(encrypted)
      const service = new ChatGPTService({
        vault: restored,
        fetcher: h.fetcher,
        openBrowser: async () => {},
        render: h.render,
      })
      await service.initialize()
      expect(await restored.load()).toEqual({
        planNoticeSeen: false,
        profiles: [active],
        activeId: active.id,
      })
      const restart = new ChatGPTService({
        vault: new FileAuthVault(path, encryption),
        fetcher: h.fetcher,
        openBrowser: async () => {},
        render: h.render,
      })
      await restart.initialize()
      expect(restart.snapshot()).toMatchObject({
        status: 'restored',
        verified: false,
        activeId: active.id,
      })
      expect(restart.snapshot().profiles).toHaveLength(1)
      expect(h.inference).toBe(0)
      service.dispose()
      restart.dispose()
      blocked.dispose()
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  })
})

it.each([
  [0, 'subscription_sharing_user_not_eligible', 'permission', false],
  [0, 'chatpass_v2_scope_not_authorized', 'permission', false],
  [503, 'subscription_sharing_usage_unavailable', 'unavailable', false],
  [400, 'subscription_sharing_unsupported_capability', 'model', false],
  [403, 'subscription_sharing_route_not_supported', 'model', false],
  [400, 'refresh_token_reused', 'expired', true],
  [400, 'invalid_refresh_token', 'expired', true],
  [401, 'subscription_sharing_invalid_user', 'expired', false],
  [400, 'invalid_client', 'auth', false],
] as const)(
  'classifies official admission/refresh error %s %s without raw server diagnostics',
  (status, code, category, clear) => {
    expect(apiError(status, code)).toMatchObject({ code: category, clearCredentials: clear })
  },
)

it('queue inference shares the trial lock and maps rendering failure without another inference call', async () => {
  const h = await harness()
  await h.service.signIn()
  await h.service.discoverModels()
  h.responseMode = 'delayed'
  const job = h.service.infer(2, 'gpt-6.1-sol', () => h.render())
  await vi.waitFor(() => expect(h.inference).toBe(1))
  expect((await h.service.translate(target)).busy).toBe(true)
  await expect(h.service.infer(2, 'gpt-6.1-sol', () => h.render())).rejects.toMatchObject({
    code: 'busy',
  })
  h.release()
  expect(await job).toEqual(content)
  await expect(
    h.service.infer(2, 'gpt-6.1-sol', async () => {
      throw new Error('PRIVATE_IMAGE')
    }),
  ).rejects.toMatchObject({ code: 'image' })
  expect(h.inference).toBe(1)
})

it('a prepared batch shares the same inference lock as single-page/trial requests', async () => {
  const h = await harness()
  await h.service.signIn()
  await h.service.discoverModels()
  h.responseMode = 'delayed'
  const job = h.service.inferBatch('gpt-6.1-sol', [{ page: 2, part: 1, image: await h.render() }])
  await vi.waitFor(() => expect(h.inference).toBe(1))
  expect((await h.service.translate(target)).busy).toBe(true)
  await expect(
    h.service.inferBatch('gpt-6.1-sol', [{ page: 2, part: 1, image: await h.render() }]),
  ).rejects.toMatchObject({ code: 'busy' })
  h.release()
  expect((await job).get('2:1')).toEqual(content)
  expect(h.inference).toBe(1)
})
