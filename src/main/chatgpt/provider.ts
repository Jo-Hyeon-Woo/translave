import { createHash } from 'node:crypto'
import type {
  ImageRenderer,
  ImageSettings,
  TranslationRequest,
  TranslationResult,
  TranslationSettings,
  SourcePage,
  PageImage,
  PageTranslation,
} from '../../shared/contracts'
import { DEFAULT_IMAGE_SETTINGS } from '../../shared/contracts'
import { ChatGPTService } from './service'
import { ChatGPTError, safeError } from './errors'
import { TranslationStore } from '../store'
import { validImage, validSourcePage } from '../batching'
import {
  batchPolicy,
  DEFAULT_CHATGPT_BATCH_POLICY,
  fitsChatGPT,
  planChatGPTBatches,
} from './batching'
import type { ChatGPTBatchPolicy } from './batching'
import { translationRequestBody } from './request'
import type { PageImageInput } from './request'

type Group = { pages: SourcePage[]; depth: number }
type Checkpoint = {
  groups: Group[]
  completed: Set<number>
  failures: Map<number, number>
  calls: number
  maxCalls: number
  version: string
}

type Publish = (page: number, result: Exclude<TranslationResult, { status: 'canceled' }>) => void
export class ChatGPTProvider {
  readonly planPages: number
  private policy: ChatGPTBatchPolicy
  private checkpoints = new Map<string, Checkpoint>()
  private images: ImageSettings
  private model = ''
  private revision = 0
  private active?: { id: string; controller: AbortController }
  private blocked = ''
  private cooldown = 0
  private attempts = new Map<string, number>()
  constructor(
    private auth: ChatGPTService,
    private store: TranslationStore,
    private render: ImageRenderer,
    policy: ChatGPTBatchPolicy = { ...DEFAULT_CHATGPT_BATCH_POLICY },
  ) {
    this.policy = batchPolicy(policy)
    this.planPages = this.policy.maxPages
    this.images = { ...DEFAULT_IMAGE_SETTINGS }
  }
  sync() {
    const s = this.auth.snapshot()
    const saved = s.activeId ? this.store.selectedModel(s.activeId) : ''
    this.model = saved
    if (s.activeId && s.models.length && !s.models.some((m) => m.slug === saved && m.supported)) {
      this.model = s.models.find((m) => m.supported)?.slug ?? ''
      if (this.model) this.store.saveSelectedModel(s.activeId, this.model)
    }
    this.blocked = ''
    this.cooldown = 0
    this.attempts.clear()
    this.checkpoints.clear()
    this.revision++
  }
  chooseModel(model: string) {
    const s = this.auth.snapshot()
    if (!s.activeId || !s.models.some((m) => m.slug === model && m.supported))
      throw new ChatGPTError('model')
    this.store.saveSelectedModel(s.activeId, model)
    this.model = model
    this.blocked = ''
    this.attempts.clear()
    this.checkpoints.clear()
    this.revision++
  }
  selectedModel() {
    return this.model
  }
  chatWaitingReason() {
    if (this.cooldown > Date.now())
      return 'ChatGPT 요청 제한으로 대기 중이에요. 잠시 후 다시 전송해 주세요.'
    return this.blocked
  }
  chatFailure(error: unknown) {
    const e = safeError(error)
    if (e.code !== 'quota' && e.code !== 'unavailable') return
    this.cooldown = Date.now() + (e.diagnostic?.retryAfterMs ?? 30000)
    if (e.diagnostic?.apiCode === 'subscription_sharing_usage_limit_exceeded')
      this.blocked = e.message
    this.revision++
  }
  cacheVersion() {
    const profile = this.auth.snapshot().activeId ?? 'none'
    const account = createHash('sha256').update(profile).digest('hex').slice(0, 32)
    const p = this.images
    return `auto:ko:chatgpt:${account}:${this.model || 'pending'}:image1:prompt1:schema1:render1:${p.dpi}:${p.format}:${p.quality}:detail-high`
  }
  waitingReason() {
    const s = this.auth.snapshot()
    if (this.blocked) return this.blocked
    if (this.cooldown > Date.now()) return 'ChatGPT 요청 제한으로 대기 중이에요.'
    if (this.auth.chatPending?.()) return '채팅 응답이 끝나면 번역을 계속합니다.'
    if (s.busy && !this.active) return 'ChatGPT 연결 작업이 끝나면 번역을 시작합니다.'
    if (s.status === 'expired') return s.error?.message || 'ChatGPT에 다시 로그인해 주세요.'
    if (s.status === 'disconnected' || s.status === 'authorizing')
      return '설정에서 ChatGPT를 연결해 주세요.'
    if (!s.planAllowed) return 'ChatGPT 플랜 사용 권한을 확인해 주세요.'
    if (!s.verified) return '저장된 ChatGPT 연결을 확인해 주세요.'
    if (!s.models.some((m) => m.slug === this.model && m.supported))
      return '설정에서 ChatGPT 모델 목록을 확인해 주세요.'
    return ''
  }
  settings(): TranslationSettings {
    const s = this.auth.snapshot(),
      reason = this.waitingReason()
    return {
      provider: 'chatgpt',
      configured: !reason,
      model: this.model,
      revision: this.revision,
      budget: { inputTokens: this.policy.inputTokens, outputTokens: this.policy.outputTokens },
      images: { ...this.images },
      authenticationError: ['expired', 'auth', 'permission'].includes(s.error?.code ?? ''),
      connection: { status: s.status, verified: s.verified, planAllowed: s.planAllowed, reason },
    }
  }
  setImages(images: ImageSettings) {
    this.cancel()
    this.images = { ...images }
    this.revision++
  }
  resume() {
    this.blocked = ''
    this.attempts.clear()
    this.checkpoints.clear()
    this.revision++
  }
  cancel(id?: string) {
    if (!id || this.active?.id === id) this.active?.controller.abort(new ChatGPTError('canceled'))
    if (id) this.checkpoints.delete(id)
    else this.checkpoints.clear()
  }
  async translate(
    input: TranslationRequest,
    publish: Publish,
    priority: () => number,
    onBatch: (pages: number[]) => void,
    shouldYield: () => boolean = () => false,
  ) {
    if (
      !input.pages.length ||
      input.pages.length > this.planPages ||
      new Set(input.pages.map((p) => p.page)).size !== input.pages.length ||
      input.pages.some((p) => !validSourcePage(p))
    )
      throw new Error('invalid page plan')
    if (this.active || this.auth.snapshot().busy || !this.settings().configured) return true
    const controller = new AbortController(),
      signal = controller.signal,
      version = this.cacheVersion()
    const images = { ...this.images },
      model = this.model
    const cache = new Map<number, PageImage>()
    let cacheBytes = 0,
      yielded = false
    const forget = (page: number) => {
      const value = cache.get(page)
      if (value) cacheBytes -= value.data.length
      cache.delete(page)
    }
    let checkpoint = this.checkpoints.get(input.id)
    if (checkpoint?.version !== version) checkpoint = undefined
    const stored = this.store.load(input.documentId)
    const completed = checkpoint?.completed ?? new Set<number>()
    for (const [page, result] of stored)
      if (['done', 'skipped', 'error'].includes(result.status)) completed.add(page)
    const plan = checkpoint
      ? undefined
      : planChatGPTBatches(
          input.pages.filter((p) => !completed.has(p.page)),
          model,
          images,
          this.policy,
        )
    const work: Checkpoint = checkpoint ?? {
      groups: plan!.groups.map((pages) => ({ pages, depth: 0 })),
      completed,
      failures: new Map(),
      calls: 0,
      maxCalls: 3 * (2 * input.pages.length - 1),
      version,
    }
    const emit = (page: number, result: Parameters<Publish>[1]) => {
      signal.throwIfAborted()
      if (version !== this.cacheVersion()) throw new ChatGPTError('canceled')
      publish(page, result) // Storage failures must escape; never retry an API due to this callback.
      completed.add(page)
      forget(page)
      this.attempts.delete(`${input.documentId}:${page}:${version}`)
    }
    const capacity = (page: number) =>
      emit(page, {
        status: 'error',
        code: 'image',
        message: '이 페이지를 현재 이미지·묶음 예산 또는 전송 용량으로 처리할 수 없어요.',
      })
    const park = () => {
      this.checkpoints.set(input.id, work)
      yielded = true
      return true as const
    }
    const requeue = (pages: SourcePage[], depth: number) => {
      if (pages.length) work.groups.unshift({ pages, depth })
    }
    this.active = { id: input.id, controller }
    try {
      for (const p of plan?.rejected ?? []) capacity(p.page)
      while (work.groups.length) {
        signal.throwIfAborted()
        if (version !== this.cacheVersion()) return
        if (shouldYield() || this.auth.chatPending?.()) return park()
        const current = priority()
        // The next queue plan must include a newly focused page outside this extraction window.
        if (current > 0 && !input.pages.some((p) => p.page === current)) return
        const preferred = work.groups.findIndex((g) =>
          g.pages.some((p) => p.page === current && !completed.has(p.page)),
        )
        const group = work.groups.splice(preferred < 0 ? 0 : preferred, 1)[0]
        const pending = group.pages.filter((p) => !completed.has(p.page))
        if (!pending.length) continue
        const prepared: PageImageInput[] = [],
          actual: SourcePage[] = []
        const sources: SourcePage[] = []
        onBatch(pending.map((p) => p.page))
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i]
          signal.throwIfAborted()
          let image = cache.get(p.page)
          if (!image) {
            try {
              image = await this.render(
                { ...p, part: 1, region: { x: 0, y: 0, width: 1, height: 1 }, order: [] },
                images,
                signal,
              )
            } catch {
              signal.throwIfAborted()
              capacity(p.page)
              continue
            }
            signal.throwIfAborted()
            if (!validImage(image)) {
              capacity(p.page)
              continue
            }
            // Evict only inactive candidates, never the currently assembled request.
            for (const key of cache.keys()) {
              if (cacheBytes + image.data.length <= this.policy.maxCacheBytes) break
              if (!prepared.some((v) => v.page === key)) forget(key)
            }
            if (cacheBytes + image.data.length > this.policy.maxCacheBytes) {
              capacity(p.page)
              continue
            }
            cache.set(p.page, image)
            cacheBytes += image.data.length
          }
          const value: PageImageInput = { page: p.page, part: 1, image }
          const shape = {
            ...p,
            width: (image.width * 72) / images.dpi,
            height: (image.height * 72) / images.dpi,
          }
          const candidate = [...prepared, value],
            shapes = [...actual, shape]
          const fits =
            fitsChatGPT(shapes, model, images, this.policy) &&
            Buffer.byteLength(translationRequestBody(model, candidate)) <=
              Math.min(images.maxRequestBytes, this.policy.maxRequestBytes)
          if (!fits) {
            if (!prepared.length) {
              capacity(p.page)
              continue
            }
            requeue(pending.slice(i), group.depth)
            break
          }
          prepared.push(value)
          sources.push(p)
          actual.push(shape)
        }
        if (!prepared.length) continue
        if (shouldYield() || this.auth.chatPending?.()) {
          requeue(sources, group.depth)
          return park()
        }
        const focused = priority()
        if (focused > 0 && !completed.has(focused) && !prepared.some((p) => p.page === focused)) {
          requeue(sources, group.depth)
          if (!input.pages.some((p) => p.page === focused)) return
          continue
        }
        if (work.calls >= work.maxCalls) {
          const remaining = [...sources, ...work.groups.flatMap((g) => g.pages)]
          for (const p of remaining)
            if (!completed.has(p.page))
              emit(p.page, {
                status: 'error',
                code: 'invalid',
                message: '묶음 번역의 재시도 한도에 도달했어요. 다시 번역을 선택해 주세요.',
              })
          return
        }
        onBatch(prepared.map((p) => p.page))
        let values: Map<string, PageTranslation>
        try {
          work.calls++
          values = await this.auth.inferBatch(
            model,
            prepared,
            signal,
            Math.min(images.maxRequestBytes, this.policy.maxRequestBytes),
          )
          signal.throwIfAborted()
          if (version !== this.cacheVersion()) return
        } catch (error) {
          if (signal.aborted || version !== this.cacheVersion()) return
          const e = safeError(error)
          if (e.code === 'busy') {
            work.calls--
            requeue(sources, group.depth)
            return park()
          }
          if (['auth', 'expired', 'permission', 'model', 'storage'].includes(e.code)) {
            this.blocked = e.message
            this.revision++
            requeue(sources, group.depth)
            return park()
          }
          if (e.code === 'quota' || e.code === 'unavailable') {
            let count = 0
            for (const p of sources) {
              const key = `${input.documentId}:${p.page}:${version}`,
                n = (this.attempts.get(key) ?? 0) + 1
              this.attempts.set(key, n)
              count = Math.max(count, n)
            }
            const rate =
              (e.diagnostic?.httpStatus === 429 ||
                e.diagnostic?.apiCode === 'rate_limit_exceeded') &&
              e.diagnostic?.apiCode !== 'subscription_sharing_usage_limit_exceeded'
            this.cooldown = Date.now() + (e.diagnostic?.retryAfterMs ?? 30000)
            if (!rate || count > 2) this.blocked = e.message
            this.revision++
            requeue(sources, group.depth)
            return park()
          }
          const shrinkable =
            e.diagnostic?.reason === 'invalid_json' || e.diagnostic?.reason === 'output_limit'
          if (shrinkable)
            for (const p of sources) work.failures.set(p.page, (work.failures.get(p.page) ?? 0) + 1)
          if (
            shrinkable &&
            sources.length > 1 &&
            group.depth < 4 &&
            sources.every((p) => (work.failures.get(p.page) ?? 0) < 5)
          ) {
            const split = Math.ceil(sources.length / 2)
            requeue(sources.slice(split), group.depth + 1)
            requeue(sources.slice(0, split), group.depth + 1)
            continue
          }
          for (const p of sources)
            emit(p.page, {
              status: 'error',
              code: e.code,
              message: e.message,
              ...(e.diagnostic ? { diagnostic: e.diagnostic } : {}),
            })
          continue
        }
        // Whole-response validation has succeeded. A DB error here never enters API recovery.
        for (const p of sources) {
          const content = values.get(`${p.page}:1`)!
          emit(
            p.page,
            content.contentType === 'unreadable'
              ? {
                  status: 'error',
                  code: 'unreadable',
                  message: '판독하기 어려운 영역을 확인해 주세요.',
                  content,
                }
              : { status: 'done', text: content.translationMarkdown, content },
          )
        }
      }
    } finally {
      cache.clear()
      if (!yielded) this.checkpoints.delete(input.id)
      if (this.active?.controller === controller) this.active = undefined
    }
  }
}
