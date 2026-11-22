import type { ChatGPTAPI } from './chatgpt'
import type { PageChatAPI } from './chat'
import type { MemoAPI } from './memos'
import type { ThemeConfigurationResult, ThemeId } from './themes'
import type { ReadingWorkspace, ReadingWorkspaceResult } from './readingTabs'

export interface OpenedDocument {
  id: string
  name: string
  bytes: Uint8Array
  sample: boolean
}

export type OpenResult =
  | { status: 'opened'; document: OpenedDocument }
  | { status: 'canceled' }
  | { status: 'error'; message: string }

export interface DesktopAPI extends ChatGPTAPI, PageChatAPI, MemoAPI {
  readingWorkspace: () => Promise<ReadingWorkspaceResult>
  saveReadingWorkspace: (
    workspace: ReadingWorkspace,
  ) => Promise<{ status: 'saved' } | { status: 'error'; message: string }>
  themeSettings: () => Promise<ThemeId>
  configureTheme: (theme: ThemeId) => Promise<ThemeConfigurationResult>
  librarySortSettings: () => Promise<LibrarySort>
  configureLibrarySort: (sort: LibrarySort) => Promise<LibrarySortResult>
  windowFullscreen: () => Promise<boolean>
  onWindowFullscreen: (callback: (fullscreen: boolean) => void) => () => void
  listDocuments: () => Promise<LibraryDocument[]>
  librarySnapshot: () => Promise<{ documents: LibraryDocument[]; folders: LibraryFolder[] }>
  changeLibrary: (change: LibraryChange) => Promise<LibraryChangeResult>
  deleteLibrary: (target: LibraryDeleteTarget) => Promise<LibraryDeleteResult>
  onLibraryDeleted: (callback: (deletion: LibraryDeletion) => void) => () => void
  addDocument: (input: {
    id: string
    total: number
    thumbnail: string
    folderId?: string | null
  }) => Promise<void | { status: 'error'; message: string }>
  openLibraryDocument: (id: string, reconnect?: boolean) => Promise<OpenResult>
  translationSettings: () => Promise<TranslationSettings>
  configureBudget: (budget: BatchBudget) => Promise<ConfigurationResult>
  configureImages: (images: ImageSettings) => Promise<ConfigurationResult>
  configureTranslation: (input: { apiKey: string }) => Promise<ConfigurationResult>
  activateDocument: (input: {
    documentId: string
    name: string
    total: number
    page?: number
  }) => Promise<DocumentSession>
  queueSnapshot: (session: string, page: number) => Promise<QueueSnapshot>
  focusPage: (session: string, page: number) => Promise<QueueSnapshot>
  claimPage: (session?: string) => Promise<ExtractionJob | null>
  readJobPdf: (session: string, token: string) => Promise<OpenResult>
  failJobPdf: (session: string, token: string) => Promise<void>
  submitPage: (session: string, token: string, pages: SourcePage[]) => Promise<void>
  onRenderRequested: (callback: (request: RenderRequest) => void) => () => void
  completeRender: (requestId: string, image: RenderResult) => Promise<void>
  pauseQueue: (session: string, paused: boolean) => Promise<void>
  retryQueue: (session: string, page?: number) => Promise<void>
  openApiKeys: () => Promise<void>
  openDataFolder: () => Promise<void>
  openPdf: () => Promise<OpenResult>
  discardPdfAddition: (id: string) => Promise<boolean>
  openSample: () => Promise<OpenResult>
  onOpenRequested: (callback: () => void) => () => void
}

export interface LibraryDocument {
  id: string
  folderId: string | null
  name: string
  total: number
  done: number
  skipped: number
  failed: number
  thumbnail: string
  lastOpened: number | null
  addedAt: number | null
  status: 'complete' | 'translating' | 'stopped' | 'waiting'
}

export interface LibraryFolder {
  id: string
  parentId: string | null
  name: string
}
export type LibraryChange =
  | { kind: 'create'; parentId: string | null; name: string }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'moveFolder'; id: string; parentId: string | null }
  | { kind: 'moveDocument'; id: string; folderId: string | null }
export type LibraryChangeResult = { status: 'saved' } | { status: 'error'; message: string }
export type LibraryDeleteTarget = { kind: 'document' | 'folder'; id: string }
export interface LibraryDeletion {
  documentIds: string[]
  folderIds: string[]
  memoIds: string[]
}
export type LibraryDeleteResult =
  | { status: 'deleted'; deletion: LibraryDeletion; warning?: string }
  | { status: 'error'; message: string }
export const LIBRARY_SORTS = {
  recent: '최근 열어본 순',
  added: '추가된 날짜 순',
  name: '이름순',
} as const
export type LibrarySort = keyof typeof LIBRARY_SORTS
export const DEFAULT_LIBRARY_SORT: LibrarySort = 'recent'
export const validLibrarySort = (value: unknown): value is LibrarySort =>
  typeof value === 'string' && Object.hasOwn(LIBRARY_SORTS, value)
export type LibrarySortResult =
  { status: 'saved'; sort: LibrarySort } | { status: 'error'; message: string }
const libraryNames = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' })
export function sortLibraryDocuments(
  entries: LibraryDocument[],
  sort: LibrarySort,
): LibraryDocument[] {
  const time = (value: number | null) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
  const binary = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return [...entries].sort(
    (a, b) =>
      (sort === 'recent' ? time(b.lastOpened) - time(a.lastOpened) : 0) ||
      (sort !== 'name' ? time(b.addedAt) - time(a.addedAt) : 0) ||
      libraryNames.compare(a.name, b.name) ||
      binary(a.name, b.name) ||
      binary(a.id, b.id),
  )
}

export const GEMINI_MODEL = 'gemini-3.5-flash-lite'
export interface TranslationSettings {
  configured: boolean
  model: string
  revision: number
  budget: BatchBudget
  images: ImageSettings
  /** Read-only UI status from existing queue results; not an authentication probe. */
  authenticationError?: boolean
  provider?: 'chatgpt' | 'gemini'
  connection?: {
    status: import('./chatgpt').ChatGPTSnapshot['status']
    verified: boolean
    planAllowed: boolean
    reason: string
  }
}
export type ConfigurationResult =
  { status: 'configured'; settings: TranslationSettings } | { status: 'error'; message: string }
export interface BatchBudget {
  inputTokens: number
  outputTokens: number
}
export const DEFAULT_BATCH_BUDGET: BatchBudget = { inputTokens: 16000, outputTokens: 16384 }
export const BATCH_BUDGET_ERROR =
  '입력 예산은 4,096–32,000, 출력 상한은 2,048–16,384 사이의 정수로 입력해 주세요.'
export function validBatchBudget(value: unknown): value is BatchBudget {
  const budget = value as BatchBudget | null
  return Boolean(
    budget &&
    Number.isInteger(budget.inputTokens) &&
    budget.inputTokens >= 4096 &&
    budget.inputTokens <= 32000 &&
    Number.isInteger(budget.outputTokens) &&
    budget.outputTokens >= 2048 &&
    budget.outputTokens <= 16384,
  )
}
export const MAX_PLAN_PAGES = 16
export interface SourcePage {
  page: number
  width: number
  height: number
  outputTokens: number
}
export interface ImageSettings {
  dpi: number
  format: 'jpeg' | 'png'
  quality: number
  mediaResolution: 'low' | 'medium' | 'high'
  maxRequestBytes: number
}
export const DEFAULT_IMAGE_SETTINGS: ImageSettings = {
  dpi: 144,
  format: 'jpeg',
  quality: 0.9,
  mediaResolution: 'high',
  maxRequestBytes: 16 * 1024 * 1024,
}
export interface Region {
  x: number
  y: number
  width: number
  height: number
}
export interface SourcePart extends SourcePage {
  part: number
  region: Region
  order: number[]
}
export interface PageImage {
  mimeType: 'image/jpeg' | 'image/png'
  data: string
  width: number
  height: number
}
export type RenderResult = PageImage | { status: 'error'; code: 'capacity' | 'render' } | null
export interface RenderRequest {
  requestId: string
  session: string
  token: string
  source: SourcePart
  images: ImageSettings
}
export type ImageRenderer = (
  part: SourcePart,
  settings: ImageSettings,
  signal: AbortSignal,
) => Promise<PageImage>
export interface VisualElement {
  id: string
  type: string
  location: string
  descriptionMarkdown: string
}
export interface PageTranslation {
  contentType: 'text' | 'visual_only' | 'blank' | 'unreadable'
  translationMarkdown: string
  visualElements: VisualElement[]
  readingNotes: string[]
  unclearRegions: string[]
}
export interface TranslationRequest {
  id: string
  documentId: string
  pages: SourcePage[]
}
export type TranslationResult =
  | { status: 'done'; text: string; content?: PageTranslation; provenance?: TranslationProvenance }
  | {
      status: 'error'
      code: string
      message: string
      content?: PageTranslation
      diagnostic?: import('./chatgpt').ChatGPTResponseDiagnostic
      provenance?: TranslationProvenance
    }
  | { status: 'canceled' }
  | { status: 'skipped' }

export interface TranslationProvenance {
  provider: 'gemini' | 'chatgpt'
  model: string
  version: string
  legacy: boolean
}

export function translationVersion(images: ImageSettings): string {
  return `auto:ko:gemini:${GEMINI_MODEL}:image1:prompt4:schema1:render1:${images.dpi}:${images.format}:${images.quality}:${images.mediaResolution}`
}
export const TRANSLATION_VERSION = translationVersion(DEFAULT_IMAGE_SETTINGS)
export type PageResult =
  | Exclude<TranslationResult, { status: 'canceled' }>
  | { status: 'queued' | 'extracting' | 'translating' }
export interface DocumentSession {
  session: string
  page: number
}
export interface QueueSnapshot {
  session: string
  page: number
  result: PageResult
  paused: boolean
  reason: string
  configured: boolean
  total: number
  done: number
  skipped: number
  failed: number
  activePage: number | null
  activePages: number[]
}
export interface ExtractionJob {
  session: string
  documentId: string
  token: string
  pages: number[]
}
