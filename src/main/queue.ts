import { randomUUID } from 'node:crypto'
import type {
  DocumentSession,
  ExtractionJob,
  PageResult,
  QueueSnapshot,
  TranslationSettings,
  TranslationResult,
  TranslationRequest,
} from '../shared/contracts'
import { TranslationStore } from './store'
import { MAX_PLAN_PAGES, translationVersion } from '../shared/contracts'
import type { SourcePage } from '../shared/contracts'
import { STOPS_QUEUE } from './translation'

interface Provider {
  planPages?: number
  cacheVersion?(): string
  waitingReason?(): string
  resume?(): void
  settings(): TranslationSettings
  translate(
    input: TranslationRequest,
    onPage: (page: number, result: Exclude<TranslationResult, { status: 'canceled' }>) => void,
    priority: () => number,
    onBatch: (pages: number[]) => void,
    shouldYield?: () => boolean,
  ): Promise<boolean | void>
  cancel(id?: string): void
}
interface Session {
  token: string
  id: string
  total: number
  page: number
  paused: boolean
  reason: string
  results: Map<number, PageResult>
}
const stopsQueue = STOPS_QUEUE

export class TranslationQueue {
  private sessions = new Map<string, Session>()
  private order: string[] = []
  private parked = new Map<string, { job: ExtractionJob; pages: SourcePage[] }>()
  private job:
    | (ExtractionJob & {
        session: string
        claimed: number
        phase: 'extracting' | 'translating'
        activePages: number[]
      })
    | undefined
  private running = false
  private paused: boolean
  constructor(
    private store: TranslationStore,
    private provider: Provider,
  ) {
    this.paused = store.queuePaused()
  }

  enqueue(id: string, name: string, total: number): DocumentSession {
    let state = this.sessions.get(id)
    if (!state) {
      const saved = this.store.register(id, name, total)
      state = {
        token: randomUUID(),
        id,
        total,
        page: saved.page,
        paused: saved.paused,
        reason: saved.reason,
        results: this.store.load(id),
      }
      this.sessions.set(id, state)
      this.order.push(id)
    }
    return { session: state.token, page: state.page }
  }
  activate(id: string, name: string, total: number): DocumentSession {
    const result = this.enqueue(id, name, total)
    this.order = [id, ...this.order.filter((entry) => entry !== id)]
    return result
  }
  restore(): void {
    for (const entry of this.store.scheduled()) this.enqueue(entry.id, entry.name, entry.total)
  }
  detach(): void {
    this.provider.cancel()
    this.clearJob()
    this.parked.clear()
    this.sessions.clear()
    this.order = []
  }
  removeDocuments(ids: readonly string[]): void {
    for (const id of ids) {
      const state = this.sessions.get(id)
      const parked = this.parked.get(id)
      const job = state && this.job?.session === state.token ? this.job : undefined
      if (job) this.clearJob()
      this.sessions.delete(id)
      this.parked.delete(id)
      if (parked) this.provider.cancel(parked.job.token)
      if (job) this.provider.cancel(job.token)
    }
    this.order = this.order.filter((id) => !ids.includes(id))
  }
  private next(): Session | undefined {
    return this.order
      .map((id) => this.sessions.get(id)!)
      .find(
        (state) =>
          !state.paused &&
          (this.parked.has(state.id) ||
            state.results.size < state.total ||
            [...state.results.values()].some(
              (r) => r.status === 'extracting' || r.status === 'translating',
            )),
      )
  }
  library() {
    return this.store.list().map((entry) => {
      const state = this.sessions.get(entry.id)
      if (!state) return entry
      const snap = this.snapshot(state.token, state.page)
      return {
        ...entry,
        done: snap.done,
        skipped: snap.skipped,
        failed: snap.failed,
        status:
          snap.done + snap.skipped === snap.total
            ? ('complete' as const)
            : state.paused ||
                (snap.done + snap.skipped + snap.failed === snap.total && snap.failed > 0)
              ? ('stopped' as const)
              : this.job?.session === state.token
                ? ('translating' as const)
                : ('waiting' as const),
      }
    })
  }
  private require(session: string): Session {
    const state = [...this.sessions.values()].find((state) => state.token === session)
    if (!state) throw new Error('이전 문서의 요청입니다.')
    return state
  }
  imageJob(page: number): { session: string; token: string } {
    if (!this.job || this.job.phase !== 'translating' || !this.job.pages.includes(page))
      throw new Error('stale image request')
    return { session: this.job.session, token: this.job.token }
  }
  imagesChanged(): void {
    this.budgetChanged()
    this.store.version =
      this.provider.cacheVersion?.() ?? translationVersion(this.provider.settings().images)
    for (const state of this.sessions.values()) {
      state.results = this.store.load(state.id)
      if (state.reason) this.setPause(state, false)
    }
  }
  sourceJob(session: string, token: string): string | undefined {
    return this.job?.session === session && this.job.token === token
      ? this.require(session).id
      : undefined
  }
  failSource(session: string, token: string): void {
    if (!this.sourceJob(session, token)) return
    this.setPause(
      this.require(session),
      true,
      '원본 PDF를 읽을 수 없어요. 파일 목록에서 다시 열어 주세요.',
    )
    this.clearJob()
  }
  private validPage(state: Session, page: number): void {
    if (!Number.isInteger(page) || page < 1 || page > state.total)
      throw new Error('페이지 번호가 올바르지 않습니다.')
  }
  focus(session: string, page: number): QueueSnapshot {
    const state = this.require(session)
    this.validPage(state, page)
    if (state.page !== page) {
      this.store.position(state.id, page)
      state.page = page
    }
    return this.snapshot(session, page)
  }
  hasAuthenticationError(): boolean {
    for (const state of this.sessions.values())
      for (const result of state.results.values())
        if (result.status === 'error' && result.code === 'auth') return true
    return false
  }
  snapshot(session: string, page: number): QueueSnapshot {
    const state = this.require(session)
    this.validPage(state, page)
    const counts = { done: 0, skipped: 0, failed: 0 }
    for (const result of state.results.values()) {
      if (result.status === 'done') counts.done++
      if (result.status === 'skipped') counts.skipped++
      if (result.status === 'error') counts.failed++
    }
    return {
      session,
      page,
      result: state.results.get(page) || { status: 'queued' },
      paused: state.paused || this.paused,
      reason: state.reason || this.provider.waitingReason?.() || '',
      configured: this.provider.settings().configured,
      total: state.total,
      ...counts,
      activePage: this.job?.session === session ? (this.job.activePages[0] ?? null) : null,
      activePages: this.job?.session === session ? [...this.job.activePages] : [],
    }
  }
  private clearJob(): void {
    if (this.job) {
      const state = this.require(this.job.session)
      for (const page of this.job.pages) {
        const status = state.results.get(page)?.status
        if (status === 'extracting' || status === 'translating') state.results.delete(page)
      }
    }
    this.job = undefined
  }
  claim(_session?: string): ExtractionJob | null {
    const state = this.next()
    if (this.job?.phase === 'extracting' && Date.now() - this.job.claimed > 60000) this.clearJob()
    if (!state || this.paused || this.running || this.job || !this.provider.settings().configured)
      return null
    const session = state.token
    const parked = this.parked.get(state.id)
    if (parked) {
      this.job = {
        ...parked.job,
        session,
        claimed: Date.now(),
        phase: 'extracting',
        activePages: [],
      }
      return { ...parked.job, session, documentId: state.id }
    }
    const pending = Array.from({ length: state.total }, (_, i) => i + 1).filter(
      (page) => !state.results.has(page),
    )
    if (!pending.length) return null
    const index = Math.max(0, pending.indexOf(state.page))
    const limit = this.provider.planPages ?? MAX_PLAN_PAGES
    const start = Math.floor(index / limit) * limit
    const pages = pending.slice(start, start + limit)
    const job = {
      token: randomUUID(),
      pages,
      session,
      documentId: state.id,
      claimed: Date.now(),
      phase: 'extracting' as const,
      activePages: pages,
    }
    this.job = job
    for (const page of pages) state.results.set(page, { status: 'extracting' })
    return { token: job.token, pages: [...pages], session, documentId: state.id }
  }
  async submit(session: string, token: string, pages: SourcePage[]): Promise<void> {
    const job = this.job
    const state = [...this.sessions.values()].find((s) => s.token === session)
    if (
      !state ||
      state.token !== session ||
      !job ||
      job.session !== session ||
      job.token !== token ||
      job.phase !== 'extracting'
    )
      return
    if (
      pages.length !== job.pages.length ||
      new Set(pages.map((p) => p.page)).size !== pages.length ||
      pages.some((p) => !job.pages.includes(p.page))
    )
      throw new Error('추출한 페이지가 요청과 다릅니다.')
    job.phase = 'translating'
    this.running = true
    pages = this.parked.get(state.id)?.pages ?? pages
    this.parked.delete(state.id)
    for (const page of job.pages) {
      if (state.results.get(page)?.status === 'extracting') state.results.delete(page)
    }
    const current = () => this.sessions.get(state.id) === state && this.job === job
    try {
      const yielded = await this.provider.translate(
        { id: token, documentId: state.id, pages },
        (page, result) => {
          if (!current()) return
          if (!job.pages.includes(page)) throw new Error('페이지 응답이 요청과 다릅니다.')
          this.store.save(state.id, page, result)
          state.results.set(page, result)
          if (result.status === 'error' && stopsQueue.has(result.code))
            this.setPause(state, true, result.message)
        },
        () =>
          !state.results.has(state.page) || state.results.get(state.page)?.status === 'translating'
            ? state.page
            : 0,
        (activePages) => {
          if (!current()) return
          for (const page of job.activePages) {
            if (state.results.get(page)?.status === 'translating') state.results.delete(page)
          }
          job.activePages = activePages
          for (const page of activePages) state.results.set(page, { status: 'translating' })
        },
        () => this.next()?.id !== state.id,
      )
      if (yielded && current()) this.parked.set(state.id, { job, pages })
    } catch {
      if (current()) {
        for (const page of job.activePages) {
          if (!['done', 'skipped', 'error'].includes(state.results.get(page)?.status || ''))
            state.results.set(page, {
              status: 'error',
              code: 'storage',
              message:
                '번역 작업 또는 저장에 실패했어요. 저장 폴더를 확인한 뒤 다시 시도해 주세요.',
            })
        }
        state.paused = true
        state.reason = '로컬 DB 또는 번역 작업 오류로 이 문서의 번역을 멈췄어요.'
      }
    } finally {
      if (this.job === job) this.clearJob()
      this.running = false
    }
  }
  private setPause(state: Session, paused: boolean, reason = ''): void {
    this.store.pause(state.id, paused, reason)
    state.paused = paused
    state.reason = reason
  }
  pause(session: string, paused: boolean): void {
    const state = this.require(session)
    this.store.pauseAll(paused)
    this.paused = paused
    if (paused) this.budgetChanged()
    else {
      this.provider.resume?.()
      this.setPause(state, false)
      this.resetErrors(state, true)
    }
  }
  private resetErrors(state: Session, onlyBlocking = false): void {
    for (const [page, result] of state.results) {
      if (result.status === 'error' && (!onlyBlocking || stopsQueue.has(result.code))) {
        this.store.remove(state.id, page)
        state.results.delete(page)
      }
    }
  }
  retry(session: string, page?: number): void {
    this.provider.resume?.()
    const state = this.require(session)
    if (page !== undefined) {
      this.validPage(state, page)
      this.store.remove(state.id, page)
      state.results.delete(page)
      this.cancelDocument(state)
      state.page = page
    } else this.resetErrors(state)
    this.store.pauseAll(false)
    this.paused = false
    this.setPause(state, false)
    this.order = [state.id, ...this.order.filter((id) => id !== state.id)]
  }
  private cancelDocument(state: Session): void {
    const parked = this.parked.get(state.id)
    if (parked) this.provider.cancel(parked.job.token)
    this.parked.delete(state.id)
    if (this.job?.session === state.token) {
      this.provider.cancel(this.job.token)
      this.clearJob()
    }
  }
  budgetChanged(): void {
    this.provider.cancel()
    this.clearJob()
    this.parked.clear()
  }
  credentialsChanged(): void {
    if (this.provider.cacheVersion) {
      this.imagesChanged()
      return
    }
    this.budgetChanged()
    if (this.provider.settings().configured) {
      for (const state of this.sessions.values()) {
        // A manually paused document stays paused; key-related errors can recover.
        if (state.reason) {
          this.resetErrors(state, true)
          this.setPause(state, false)
        }
      }
    }
  }
}
