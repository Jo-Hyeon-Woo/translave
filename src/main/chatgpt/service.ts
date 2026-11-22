import { randomUUID } from 'node:crypto'
import type { ChatGPTSnapshot, ChatGPTTrial } from '../../shared/chatgpt'
import type { PageImage, PageTranslation } from '../../shared/contracts'
import type { AuthRecord, AuthVault, Credentials, Registration } from './vault'
import { ChatGPTError, checkResponse, safeError } from './errors'
import {
  discovery,
  listenCallback,
  pkceChallenge,
  randomSecret,
  RESOURCE,
  SCOPES,
  verifyIdentity,
} from './oauth'
import type { Discovery, Fetch } from './oauth'
import type { PageImageInput } from './request'
import { listModels, translateImage, translateImages, readResponseTextStream } from './inference'
import { ChatProgress } from '../chat/stream'
import { CHAT_LIMITS } from '../../shared/chat'
export interface TrialTarget {
  documentId: string
  documentName: string
  page: number
  model: string
}
export interface ChatGPTDependencies {
  vault: AuthVault
  openBrowser: (url: string) => Promise<unknown>
  fetcher?: Fetch
  render: (target: TrialTarget, ticket: string, signal: AbortSignal) => Promise<PageImage>
}
export class ChatGPTService {
  private record: AuthRecord = { profiles: [], activeId: null }
  private status: ChatGPTSnapshot['status'] = 'disconnected'
  private verified = false
  private planDenied = false
  private models: ChatGPTSnapshot['models'] = []
  private error?: ChatGPTSnapshot['error']
  private notice?: string
  private trial?: ChatGPTTrial
  private operation?: AbortController
  private authAttempt?: AbortController
  private refreshing?: Promise<void>
  private mutation = false
  private authDone?: Promise<void>
  private operationDone?: Promise<void>
  private chatReservation?: symbol
  private ticket?: { id: string; target: TrialTarget }
  private epoch = 0
  private host?: string
  private loadFailed = false
  private readonly fetcher: Fetch
  constructor(private deps: ChatGPTDependencies) {
    this.fetcher = deps.fetcher ?? ((...args) => globalThis.fetch(...args))
  }
  async initialize() {
    try {
      const saved = await this.deps.vault.load()
      const active = saved.profiles.find((p) => p.id === saved.activeId)
      const next = { ...saved, profiles: active ? [active] : [], activeId: active?.id ?? null }
      if (saved.profiles.length !== next.profiles.length || saved.activeId !== next.activeId)
        await this.persist(next)
      else this.record = next
      this.status = this.active()?.credentials ? 'restored' : 'disconnected'
    } catch (e) {
      this.loadFailed = true
      this.error = safeError(e)
    }
  }
  private active() {
    return this.record.profiles.find((p) => p.id === this.record.activeId)
  }
  snapshot(): ChatGPTSnapshot {
    return {
      status: this.status,
      profiles: this.record.profiles.map((p, i) => ({
        id: p.id,
        label: `${p.email || 'ChatGPT 계정'} · 연결 ${i + 1}`,
      })),
      activeId: this.record.activeId,
      planAllowed:
        (this.active()?.credentials?.scopes.includes('chatgpt.tokens.use.direct') ?? false) &&
        !this.planDenied,
      verified: this.verified,
      models: this.models,
      busy: !!this.operation || this.mutation,
      error: this.error,
      notice: this.notice,
      trial: this.trial,
    }
  }
  private async persist(next: AuthRecord) {
    try {
      await this.deps.vault.save(next)
    } catch {
      throw new ChatGPTError('storage')
    }
    this.record = next
  }
  private credentials(raw: any, previous?: Credentials): Credentials {
    if (
      !raw ||
      typeof raw.access_token !== 'string' ||
      !raw.access_token ||
      raw.token_type?.toLowerCase() !== 'bearer' ||
      !Number.isFinite(raw.expires_in) ||
      raw.expires_in <= 0 ||
      (raw.refresh_token !== undefined && typeof raw.refresh_token !== 'string') ||
      (raw.id_token !== undefined && typeof raw.id_token !== 'string')
    )
      throw new ChatGPTError('auth')
    const scopes =
      typeof raw.scope === 'string' ? raw.scope.split(/\s+/).filter(Boolean) : previous?.scopes
    if (!scopes) throw new ChatGPTError('auth')
    return {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token ?? previous?.refreshToken,
      idToken: raw.id_token ?? previous?.idToken ?? '',
      scopes,
      expiresAt: Date.now() + raw.expires_in * 1000,
      earliestRefreshAt:
        typeof raw.earliest_refresh_at === 'number' ? raw.earliest_refresh_at * 1000 : 0,
      nonce: previous?.nonce ?? '',
    }
  }
  private async token(d: Discovery, params: URLSearchParams, signal: AbortSignal) {
    const r = await this.fetcher(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal,
      redirect: 'error',
    })
    await checkResponse(r)
    return r.json()
  }
  private async updateProfile(profile: Registration) {
    await this.persist({ ...this.record, profiles: [profile], activeId: profile.id })
  }
  async signIn(profileId?: string) {
    if (this.authAttempt || this.operation || this.mutation) return this.snapshot()
    if (this.loadFailed) return this.snapshot()
    const selected = this.active()
    if (profileId && profileId !== selected?.id) {
      this.error = safeError(new ChatGPTError('auth'))
      return this.snapshot()
    }
    const controller = new AbortController(),
      epoch = ++this.epoch
    let finishAuth!: () => void
    this.authDone = new Promise((resolve) => {
      finishAuth = resolve
    })
    this.authAttempt = controller
    this.status = 'authorizing'
    this.error = undefined
    this.notice = undefined
    const timer = setTimeout(() => controller.abort(new ChatGPTError('expired')), 300000)
    let listener: Awaited<ReturnType<typeof listenCallback>> | undefined
    try {
      this.host ??= await this.deps.vault.hostId()
      // Verify safe storage before opening the browser; never fall back to plaintext.
      try {
        await this.deps.vault.save(this.record)
      } catch {
        throw new ChatGPTError('storage')
      }
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)])
      const d = await discovery(this.fetcher, signal)
      const state = randomSecret(),
        nonce = randomSecret(),
        verifier = randomSecret()
      listener = await listenCallback(state, selected?.clientId, signal)
      const url = new URL(d.authorization_endpoint)
      url.search = new URLSearchParams({
        client_id: selected?.clientId ?? 'dynamic_agent_client',
        ext_agent_host_id: this.host,
        response_type: 'code',
        redirect_uri: listener.redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: pkceChallenge(verifier),
        ...(selected ? {} : { agent_name_hint: 'Translave' }),
        ...(selected?.credentials?.idToken ? { id_token_hint: selected.credentials.idToken } : {}),
        ...(selected?.email ? { login_hint: selected.email } : {}),
        ...(selected &&
        (this.planDenied || !selected.credentials?.scopes.includes('chatgpt.tokens.use.direct'))
          ? { prompt: 'consent' }
          : {}),
      }).toString()
      await this.deps.openBrowser(url.href)
      const callback = await listener.result
      listener.close()
      listener = undefined
      signal.throwIfAborted()
      const registration: Registration = selected ?? {
        id: randomUUID(),
        clientId: callback.clientId,
      }
      // Keep an issued registration across an expired code. Identity remains unverified until JWT verification.
      if (!selected) await this.updateProfile(registration)
      const raw = await this.token(
        d,
        new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: callback.clientId,
          code: callback.code,
          code_verifier: verifier,
          redirect_uri: new URL(url).searchParams.get('redirect_uri')!,
          resource: RESOURCE,
        }),
        signal,
      )
      if (typeof raw.id_token !== 'string') throw new ChatGPTError('auth')
      const identity = await verifyIdentity(
        this.fetcher,
        d,
        raw.id_token,
        callback.clientId,
        nonce,
        selected?.subject,
      )
      const credentials = this.credentials(raw)
      credentials.nonce = nonce
      if (epoch !== this.epoch) return this.snapshot()
      signal.throwIfAborted()
      await this.updateProfile({ ...registration, ...identity, credentials })
      this.status = 'signed_in'
      this.planDenied = false
      this.verified = true
      this.models = []
      this.trial = undefined
      this.notice = credentials.scopes.includes('chatgpt.tokens.use.direct')
        ? '로그인했어요. 번역은 ChatGPT 플랜 또는 사용 가능한 크레딧을 사용합니다.'
        : '로그인했지만 ChatGPT 플랜 사용은 허용되지 않았어요.'
    } catch (e) {
      if (epoch === this.epoch) {
        this.error = safeError(controller.signal.aborted ? controller.signal.reason : e)
        this.status = this.active()?.credentials
          ? this.verified
            ? 'signed_in'
            : 'restored'
          : 'disconnected'
      }
    } finally {
      clearTimeout(timer)
      listener?.close()
      if (this.authAttempt === controller) this.authAttempt = undefined
      finishAuth()
    }
    return this.snapshot()
  }
  cancel() {
    this.authAttempt?.abort(new ChatGPTError('canceled'))
    this.operation?.abort(new ChatGPTError('canceled'))
    return this.snapshot()
  }
  private async access(signal: AbortSignal): Promise<string> {
    const profile = this.active(),
      c = profile?.credentials
    if (!profile || !c) throw new ChatGPTError('expired')
    if (!c.scopes.includes('chatgpt.tokens.use.direct')) throw new ChatGPTError('permission')
    if (
      (!this.verified && Date.now() >= c.earliestRefreshAt) ||
      Date.now() >= c.expiresAt - 60000
    ) {
      this.refreshing ??= this.refresh(profile, signal).finally(() => {
        this.refreshing = undefined
      })
      await this.refreshing
    }
    const current = this.active()?.credentials
    if (!current?.scopes.includes('chatgpt.tokens.use.direct')) throw new ChatGPTError('permission')
    return current.accessToken
  }
  private async refresh(profile: Registration, signal: AbortSignal) {
    const c = profile.credentials!
    if (!c.refreshToken) throw new ChatGPTError('expired')
    if (Date.now() < c.earliestRefreshAt) throw new ChatGPTError('network')
    const d = await discovery(this.fetcher, signal)
    const raw = await this.token(
      d,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: profile.clientId,
        refresh_token: c.refreshToken,
        resource: RESOURCE,
      }),
      signal,
    )
    if (raw.id_token)
      await verifyIdentity(
        this.fetcher,
        d,
        raw.id_token,
        profile.clientId,
        c.nonce,
        profile.subject,
        true,
      )
    signal.throwIfAborted()
    const credentials = this.credentials(raw, c)
    await this.updateProfile({ ...profile, credentials })
    this.verified = true
    this.status = 'signed_in'
  }
  private async handleFailure(e: unknown) {
    this.error = safeError(e)
    if (this.error.code === 'expired') {
      this.verified = false
      this.models = []
      this.status = 'expired'
      const active = this.active()
      if (active && e instanceof ChatGPTError && e.clearCredentials) {
        try {
          await this.updateProfile({ ...active, credentials: undefined })
        } catch {
          /* No unsafe replacement. */
        }
      }
    }
    if (this.error.code === 'permission') {
      this.planDenied = true
      this.models = []
      this.verified = false
    }
  }
  async discoverModels() {
    if (this.authAttempt || this.operation || this.mutation) return this.snapshot()
    const controller = new AbortController()
    this.operation = controller
    this.error = undefined
    let finish!: () => void
    this.operationDone = new Promise((resolve) => {
      finish = resolve
    })
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30000)])
      const token = await this.access(signal)
      this.models = await listModels(this.fetcher, token, signal)
      signal.throwIfAborted()
      this.verified = true
      this.status = 'signed_in'
      if (!this.models.some((m) => m.supported)) throw new ChatGPTError('model')
    } catch (e) {
      await this.handleFailure(controller.signal.aborted ? controller.signal.reason : e)
    } finally {
      if (this.operation === controller) this.operation = undefined
      finish()
    }
    return this.snapshot()
  }
  source(ticket: string) {
    return this.ticket?.id === ticket && !this.operation?.signal.aborted
      ? this.ticket.target
      : undefined
  }
  async stopInference() {
    this.operation?.abort(new ChatGPTError('canceled'))
    await this.operationDone
  }
  chatPending() {
    return !!this.chatReservation
  }
  reserveChat() {
    if (this.chatReservation) throw new ChatGPTError('busy')
    const reservation = Symbol()
    this.chatReservation = reservation
    return () => {
      if (this.chatReservation === reservation) this.chatReservation = undefined
    }
  }
  async inferChat(
    model: string,
    body: string,
    publish: (text: string) => void,
    external: AbortSignal,
    started?: () => void,
  ) {
    if (!this.chatReservation) throw new ChatGPTError('busy')
    while (this.operation) {
      external.throwIfAborted()
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          cleanup()
          reject(new ChatGPTError('canceled'))
        }
        const cleanup = () => external.removeEventListener('abort', abort)
        external.addEventListener('abort', abort, { once: true })
        void this.operationDone?.then(() => {
          cleanup()
          resolve()
        })
        if (external.aborted) abort()
      })
    }
    external.throwIfAborted()
    return this.withInference(
      model,
      async (token, signal) => {
        started?.()
        const progress = new ChatProgress(publish)
        const response = await this.fetcher(RESOURCE + '/responses', {
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
        const text = await readResponseTextStream(response, (type, row) =>
          progress.accept(type, row),
        )
        if (text.length > CHAT_LIMITS.answerChars) throw new ChatGPTError('invalid')
        return text
      },
      external,
      true,
    )
  }
  async infer(
    page: number,
    model: string,
    render: (signal: AbortSignal) => Promise<PageImage>,
    external?: AbortSignal,
    maxRequestBytes?: number,
  ): Promise<PageTranslation> {
    return this.withInference(
      model,
      async (token, signal) => {
        let image: PageImage
        try {
          image = await render(signal)
        } catch (error) {
          if (signal.aborted) throw error
          throw new ChatGPTError('image')
        }
        return translateImage(this.fetcher, token, model, page, image, signal, maxRequestBytes)
      },
      external,
    )
  }
  async inferBatch(
    model: string,
    images: PageImageInput[],
    external?: AbortSignal,
    maxRequestBytes?: number,
  ) {
    return this.withInference(
      model,
      (token, signal) =>
        translateImages(this.fetcher, token, model, images, signal, maxRequestBytes),
      external,
    )
  }
  private async withInference<T>(
    model: string,
    perform: (token: string, signal: AbortSignal) => Promise<T>,
    external?: AbortSignal,
    chatPriority = false,
  ): Promise<T> {
    if (
      this.authAttempt ||
      this.operation ||
      this.mutation ||
      (this.chatReservation && !chatPriority)
    )
      throw new ChatGPTError('busy')
    const controller = new AbortController(),
      epoch = this.epoch
    let finish!: () => void
    this.operationDone = new Promise((resolve) => {
      finish = resolve
    })
    this.operation = controller
    this.error = undefined
    let signal: AbortSignal | undefined
    try {
      if (!this.models.some((m) => m.slug === model && m.supported)) throw new ChatGPTError('model')
      signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(180000),
        ...(external ? [external] : []),
      ])
      const token = await this.access(signal)
      const content = await perform(token, signal)
      signal.throwIfAborted()
      if (epoch !== this.epoch) throw new ChatGPTError('canceled')
      return content
    } catch (error) {
      const failure = controller.signal.aborted
        ? controller.signal.reason
        : external?.aborted
          ? external.reason
          : signal?.aborted && signal.reason?.name === 'TimeoutError'
            ? new ChatGPTError('incomplete', false, { reason: 'timeout', lastPhase: 'none' })
            : error
      if (epoch === this.epoch && !controller.signal.aborted && !external?.aborted)
        await this.handleFailure(failure)
      throw failure instanceof ChatGPTError ? failure : new ChatGPTError('network')
    } finally {
      if (this.operation === controller) this.operation = undefined
      finish()
    }
  }
  async translate(target: TrialTarget) {
    if (this.authAttempt || this.operation || this.mutation) return this.snapshot()
    this.ticket = { id: randomSecret(), target: { ...target } }
    const ticket = this.ticket.id
    try {
      const content = await this.infer(target.page, target.model, (signal) =>
        this.deps.render(target, ticket, signal),
      )
      this.trial = {
        ...target,
        result:
          content.contentType === 'unreadable'
            ? {
                status: 'error',
                code: 'unreadable',
                message: '판독하기 어려운 영역을 확인해 주세요.',
                content,
              }
            : { status: 'done', text: content.translationMarkdown, content },
      }
    } catch {
      /* infer records only safe errors, never partial output. */
    } finally {
      this.ticket = undefined
    }
    return this.snapshot()
  }
  async logout() {
    if (this.mutation) return this.snapshot()
    this.mutation = true
    this.epoch++
    this.cancel()
    this.models = []
    this.trial = undefined
    this.verified = false
    this.error = undefined
    this.notice = undefined
    await Promise.all([this.authDone, this.operationDone])
    this.error = undefined
    const profile = this.active()
    let revoked = !profile?.credentials
    try {
      if (profile?.credentials?.refreshToken) {
        for (let i = 0; i < 2; i++) {
          try {
            const signal = AbortSignal.timeout(10000),
              d = await discovery(this.fetcher, signal)
            if (!d.revocation_endpoint) break
            const r = await this.fetcher(d.revocation_endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                token: profile.credentials.refreshToken,
                token_type_hint: 'refresh_token',
                client_id: profile.clientId,
              }),
              signal,
              redirect: 'error',
            })
            if (r.status === 200) {
              revoked = true
              break
            }
            if (r.status < 500) break
          } catch {
            /* Bounded retry. No raw diagnostics. */
          }
          if (i === 0) await new Promise((resolve) => setTimeout(resolve, 250))
        }
      }
      if (profile) await this.updateProfile({ ...profile, credentials: undefined })
      this.status = 'disconnected'
      this.notice = revoked
        ? '로그아웃했어요.'
        : '로컬 로그아웃 완료. 원격 철회는 확인하지 못했어요. ChatGPT 설정에서 앱 연결을 해제할 수 있어요.'
    } catch (e) {
      // Stop use in this process even if disk cleanup fails; explicitly report the failure.
      if (profile) profile.credentials = undefined
      this.status = 'disconnected'
      this.error = safeError(new ChatGPTError('storage'))
      this.notice =
        '이 실행에서는 로그아웃했지만 저장된 인증 정보 삭제에 실패했어요. ChatGPT 설정에서 앱 연결을 해제해 주세요.'
    } finally {
      this.mutation = false
    }
    return this.snapshot()
  }
  dispose() {
    this.epoch++
    this.cancel()
    this.trial = undefined
    this.ticket = undefined
  }
}
