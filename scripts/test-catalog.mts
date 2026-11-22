import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

// The only category / path mapping. File-level filters deliberately keep complete scenarios.
export const categories = {
  pdf: 'PDF 읽기·파일 관리',
  translation: '번역 요청·이미지·묶음·응답',
  queue: '큐·우선순위·실행 제어',
  chat: '페이지 채팅·첨부·스트리밍',
  auth: '인증·세션·모델·권한',
  storage: 'DB·설정·캐시·마이그레이션',
  output: 'Markdown·수식·출력 안전성',
  ui: '설정·테마·레이아웃',
  tooling: '테스트 선택 실행 규칙',
} as const
export type Category = keyof typeof categories
export type Kind = 'unit' | 'e2e' | 'both'
export type ExecutionMode = 'quiet' | 'screen' | 'all'
const product = Object.keys(categories).filter((c) => c !== 'tooling') as Category[]
export const catalog: Record<string, Category[]> = {
  'tests/unit/extract.test.ts': ['pdf'],
  'tests/unit/library.test.ts': ['pdf', 'storage', 'queue'],
  'tests/unit/presentationImport.test.ts': ['pdf', 'storage'],
  'tests/unit/translation.test.ts': ['translation'],
  'tests/unit/translationLanguage.test.ts': ['translation'],
  'tests/unit/images.test.ts': ['translation', 'storage'],
  'tests/unit/budget.test.ts': ['translation', 'storage'],
  'tests/unit/queue.test.ts': ['queue', 'storage'],
  'tests/unit/chatgpt.test.ts': ['auth', 'translation', 'queue'],
  'tests/unit/chatgptStream.test.ts': ['translation', 'chat', 'auth'],
  'tests/unit/chatgptOutput.test.ts': ['translation', 'chat'],
  'tests/unit/chatgptBatching.test.ts': ['translation'],
  'tests/unit/chatgptQueue.test.ts': ['translation', 'queue', 'auth', 'storage'],
  'tests/unit/pageChat.test.ts': ['chat', 'queue', 'auth', 'storage'],
  'tests/unit/memos.test.ts': ['storage', 'ui'],
  'tests/unit/themes.test.ts': ['ui', 'storage'],
  'tests/unit/markdownMath.test.ts': ['output', 'translation', 'storage'],
  'tests/unit/testSelection.test.ts': ['tooling'],
  'tests/e2e/reader.spec.ts': ['pdf', 'ui'],
  'tests/e2e/window.screen.spec.ts': ['pdf', 'ui'],
  'tests/e2e/activeChatGPT.spec.ts': ['translation', 'queue', 'auth', 'storage'],
  'tests/e2e/pageChat.spec.ts': ['chat', 'queue', 'auth', 'storage', 'output'],
  'tests/e2e/memos.spec.ts': ['pdf', 'ui', 'storage', 'output'],
  'tests/e2e/settings.spec.ts': ['ui', 'translation', 'auth', 'storage'],
  'tests/e2e/themes.spec.ts': ['ui', 'storage'],
  'tests/e2e/math.spec.ts': ['output', 'translation', 'storage', 'ui'],
}
// Execution mode is independent of feature categories. Config and CLI consume this
// same mapping; an unclassified Electron test fails catalog validation.
export const electronModes: Record<string, 'quiet' | 'screen'> = {
  'tests/e2e/reader.spec.ts': 'quiet',
  'tests/e2e/window.screen.spec.ts': 'screen',
  'tests/e2e/activeChatGPT.spec.ts': 'quiet',
  'tests/e2e/pageChat.spec.ts': 'quiet',
  'tests/e2e/memos.spec.ts': 'quiet',
  'tests/e2e/settings.spec.ts': 'quiet',
  'tests/e2e/themes.spec.ts': 'quiet',
  'tests/e2e/math.spec.ts': 'quiet',
}
export const screenReason = '네이티브 포커스·최대화·macOS 전체 화면/복원은 실제 창이 필요'
export function executionMode(value: string): ExecutionMode {
  if (!['quiet', 'screen', 'all'].includes(value))
    throw new Error('실행 방식은 quiet/screen/all 중 하나여야 합니다')
  return value as ExecutionMode
}
export function electronProjects(mode: ExecutionMode) {
  return (['quiet', 'screen'] as const)
    .filter((name) => mode === 'all' || mode === name)
    .map((name) => ({
      name,
      testMatch: Object.entries(electronModes)
        .filter(([, value]) => value === name)
        .map(([path]) => '**/' + path),
    }))
}
type Rule = { pattern: RegExp; categories?: Category[]; full?: boolean; reason: string }
// All matching rules contribute; unknown non-document paths always expand to full.
const rules: Rule[] = [
  {
    pattern:
      /^(package(?:-lock)?\.json|.*\.config\.[cm]?[jt]s|tsconfig.*\.json|scripts\/test-[^/]+\.[cm]?[jt]s|tests\/unit\/testSelection\.test\.ts)$/,
    full: true,
    reason: '의존성·빌드/테스트 설정·선택 규칙 자체 변경',
  },
  {
    pattern: /^tests\/(?:unit|e2e)\/(?!.*\.(?:test|spec)\.ts$)/,
    full: true,
    reason: '공용 테스트 도우미·가짜 제공자·격리 정책 변경: 모든 소비자를 보수적으로 포함',
  },
  {
    pattern:
      /^src\/(?:main\/index\.ts|preload\/|shared\/(?:contracts|chatgpt|chat)\.ts|renderer\/src\/env\.d\.ts)/,
    categories: product,
    reason: 'IPC·preload·공유 계약: 메인/렌더러와 저장·번역·채팅 연결',
  },
  {
    pattern: /^src\/main\/chatgpt\/(?:service|oauth|vault|errors)\.ts$/,
    categories: ['auth', 'translation', 'queue', 'chat', 'storage'],
    reason: '인증·토큰·공용 추론 잠금/오류: 번역과 채팅 실행 제어까지 포함',
  },
  {
    pattern: /^src\/main\/chatgpt\/(?:inference|eventStream|translationOutput)\.ts$/,
    categories: ['translation', 'chat', 'auth'],
    reason: '공용 SSE·완료 출력 수집: 번역/채팅 스트리밍과 오류 분류',
  },
  {
    pattern: /^src\/main\/chatgpt\/(?:batching|instructions|request)\.ts$/,
    categories: ['translation'],
    reason: 'ChatGPT 이미지 묶음·요청·번역 지시문',
  },
  {
    pattern: /^src\/main\/(?:queue|activeTranslation)\.ts$/,
    categories: ['queue', 'translation', 'chat'],
    reason: '공용 작업 큐·제공자 선택과 채팅 양보/재개',
  },
  {
    pattern: /^src\/main\/chatgpt\/provider\.ts$/,
    categories: ['queue', 'translation', 'chat', 'auth'],
    reason: '번역 제공자·채팅 우선 잠금·인증 대기/속도 제한',
  },
  {
    pattern: /^src\/main\/(?:translation|translationLanguage|batching|imageBridge)\.ts$/,
    categories: ['translation', 'queue'],
    reason: '이미지 브리지·보존된 Gemini 요청/검증과 큐',
  },
  {
    pattern: /^src\/main\/store\.ts$/,
    categories: ['storage', 'translation', 'queue', 'chat', 'ui', 'pdf'],
    reason: 'SQLite 공용 저장·마이그레이션: 문서/번역/채팅/설정과 재시작',
  },
  {
    pattern: /^src\/main\/chat\/(?:service|store|request|stream)\.ts$/,
    categories: ['chat', 'queue', 'storage'],
    reason: '페이지 채팅·대화 저장·부분 스트림과 공용 잠금',
  },
  {
    pattern: /^src\/renderer\/src\/(?:pdf|PdfPage|extract|translationWorker)\.[jt]sx?$/,
    categories: ['pdf', 'translation', 'queue'],
    reason: 'PDF 표시/추출과 백그라운드 번역 이미지·IPC',
  },
  {
    pattern: /^src\/main\/presentationImport\.ts$/,
    categories: ['pdf', 'storage', 'queue', 'chat'],
    reason: 'PPT/PPTX 로컬 변환·파생 PDF와 기존 읽기/번역/채팅 소유권',
  },
  {
    pattern: /^src\/renderer\/src\/(?:FileLibrary|library)\.[jt]sx?$/,
    categories: ['pdf', 'queue', 'storage'],
    reason: '파일 목록·문서 열기/등록과 번역 예약',
  },
  {
    pattern: /^src\/renderer\/src\/(?:TranslationContent|markdownMath)\.[jt]sx?$/,
    categories: ['output', 'translation', 'chat'],
    reason: '공용 안전 Markdown/수식: 번역 본문/설명과 채팅 화면',
  },
  {
    pattern: /^src\/renderer\/src\/(?:PageChat\.tsx|chatDrafts\.ts)$/,
    categories: ['chat', 'output'],
    reason: '페이지 채팅 입력·표시·Markdown/수식',
  },
  {
    pattern: /^src\/renderer\/src\/editingFocus\.ts$/,
    categories: ['pdf', 'chat', 'ui'],
    reason: '문서/사이드바 전환 시 채팅·메모 편집 포커스와 메뉴/창 우선권',
  },
  {
    pattern:
      /^src\/(?:main\/(?:memos|memoExport)\.ts|shared\/memos\.ts|renderer\/src\/(?:(?:Memo\w+|useMemos|memoDrafts)\.[jt]sx?|memo-print\.css)|renderer\/memo-export\.html)$/,
    categories: ['pdf', 'ui', 'storage', 'output'],
    reason: '페이지/공통 메모 소유권·편집·로컬 저장/복원과 안전한 실시간 표시',
  },
  {
    pattern: /^src\/renderer\/src\/DeleteConfirmation\.tsx$/,
    categories: ['chat', 'ui', 'storage'],
    reason: '채팅/메모가 공유하는 삭제 확인 UI',
  },
  {
    pattern: /^src\/renderer\/src\/(?:ChatGPT\w+|GeminiStatus|TranslationSettings)\.tsx$/,
    categories: ['auth', 'ui', 'translation', 'chat', 'storage'],
    reason: '연결/설정 화면과 적용·저장·오류 상태',
  },
  {
    pattern: /^src\/(?:shared\/themes\.ts|renderer\/src\/theme\.ts)$/,
    categories: ['ui', 'storage'],
    reason: '테마 선택·색상·저장/복원',
  },
  {
    pattern: /^src\/renderer\/src\/(?:useTranslation|sample-translations)\.[jt]sx?$/,
    categories: ['translation', 'queue', 'output'],
    reason: '현재 문서 번역 상태와 결과 표시',
  },
  {
    pattern: /^src\/renderer\/(?:index\.html|src\/(?:App\.tsx|main\.tsx|styles\.css|assets\/))/,
    categories: product,
    reason: '공용 앱 조립·스타일·레이아웃: 모든 화면/키보드/상태를 포함',
  },
  {
    pattern:
      /^(?:tests\/fixtures\/|resources\/|scripts\/(?:create-fixtures|prepare-pdfjs)\.mjs|src\/renderer\/public\/)/,
    categories: ['pdf', 'translation', 'chat', 'output', 'ui'],
    reason: 'PDF·수식 자료/로컬 자원과 이를 쓰는 화면',
  },
]
export type Selection = {
  kind: Kind
  mode: ExecutionMode
  excludedScreen: string[]
  categories: Category[]
  unit: string[]
  e2e: string[]
  reasons: string[]
  full: boolean
  docsOnly: boolean
}
export type SelectionInput = {
  kind?: Kind
  mode?: string
  categories?: string[]
  files?: string[]
  all?: boolean
}
const sorted = <T extends string>(items: Iterable<T>) => [...new Set(items)].sort()
export function selectTests(input: SelectionInput, root = process.cwd()): Selection {
  const kind = input.kind ?? 'both'
  const mode = executionMode(input.mode ?? (input.all ? 'all' : 'quiet'))
  if (!['unit', 'e2e', 'both'].includes(kind)) throw new Error('알 수 없는 테스트 종류')
  const selected = new Set<Category>()
  const exact = new Set<string>()
  const reasons: string[] = []
  let full = !!input.all
  let docs = 0
  const paths = sorted(
    (input.files ?? []).map((p) => {
      const path = relative(resolve(root), isAbsolute(p) ? p : resolve(root, p)).replaceAll(
        '\\',
        '/',
      )
      if (!p.trim()) throw new Error('빈 파일 경로')
      return path
    }),
  )
  for (const category of input.categories ?? []) {
    if (!Object.hasOwn(categories, category)) throw new Error(`알 수 없는 카테고리: ${category}`)
    selected.add(category as Category)
    reasons.push(`직접 지정: ${category}`)
  }
  if (input.all) reasons.push('명시적 전체 검사')
  if (!input.all && !selected.size && !paths.length)
    throw new Error('카테고리 또는 변경 파일을 지정하세요')
  for (const path of paths) {
    const matches = rules.filter((rule) => rule.pattern.test(path))
    if (matches.length) {
      for (const rule of matches) {
        full ||= !!rule.full
        rule.categories?.forEach((c) => selected.add(c))
        reasons.push(`${path}: ${rule.reason}`)
      }
    } else if (Object.hasOwn(catalog, path)) {
      exact.add(path)
      reasons.push(`${path}: 변경된 테스트 파일 직접 실행`)
    } else if (
      /\.(?:md|mdx|txt)$/.test(path) &&
      !path.startsWith('src/') &&
      !path.startsWith('../')
    ) {
      docs++
      reasons.push(`${path}: 문서 전용(제품 완료 기준 검토는 별도)`)
    } else {
      full = true
      reasons.push(`${path}: 미매핑 경로이므로 선택 누락 방지를 위해 전체로 확대`)
    }
  }
  const files = Object.keys(catalog).filter(
    (p) => full || exact.has(p) || catalog[p].some((c) => selected.has(c)),
  )
  const unit = kind === 'e2e' ? [] : files.filter((p) => p.startsWith('tests/unit/'))
  const applicableE2e = kind === 'unit' ? [] : files.filter((p) => p.startsWith('tests/e2e/'))
  const e2e = applicableE2e.filter((p) => mode === 'all' || electronModes[p] === mode)
  const excludedScreen = applicableE2e.filter(
    (p) => mode === 'quiet' && electronModes[p] === 'screen',
  )
  const docsOnly = paths.length > 0 && docs === paths.length && !selected.size && !input.all
  if (!unit.length && !applicableE2e.length && !docsOnly)
    throw new Error('선택한 범주에 해당 종류의 테스트가 없습니다')
  if (!unit.length && !e2e.length && !excludedScreen.length && !docsOnly)
    throw new Error('선택한 범주에 해당 실행 방식의 테스트가 없습니다')
  return {
    kind,
    mode,
    excludedScreen: sorted(excludedScreen),
    categories: sorted(
      full
        ? [...unit, ...applicableE2e].flatMap((p) => catalog[p])
        : [...selected, ...[...exact].flatMap((p) => catalog[p])],
    ),
    unit: sorted(unit),
    e2e: sorted(e2e),
    reasons: sorted(reasons),
    full,
    docsOnly,
  }
}

// Prevent a new test from silently falling outside selection (also run before full scripts).
export function validateCatalog(root = process.cwd()) {
  const actual = ['unit', 'e2e'].flatMap((kind) =>
    readdirSync(resolve(root, 'tests', kind), { recursive: true })
      .filter((p) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(String(p)))
      .map((p) => `tests/${kind}/${String(p).replaceAll('\\', '/')}`),
  )
  const missing = actual.filter((p) => !Object.hasOwn(catalog, p))
  const obsolete = Object.keys(catalog).filter((p) => !actual.includes(p))
  if (missing.length || obsolete.length)
    throw new Error(`테스트 목록 매핑 불일치: ${[...missing, ...obsolete].join(', ')}`)
  const integrations = actual.filter((p) => p.startsWith('tests/e2e/'))
  if (
    integrations.some((p) => !Object.hasOwn(electronModes, p)) ||
    Object.entries(electronModes).some(
      ([p, mode]) => !integrations.includes(p) || !['quiet', 'screen'].includes(mode),
    )
  )
    throw new Error('Electron 실행 방식 매핑 불일치')
  for (const [path, tags] of Object.entries(catalog))
    if (!tags.length || tags.some((c) => !Object.hasOwn(categories, c)))
      throw new Error(`테스트 범주 오류: ${path}`)
}

type GitResult = { status: number | null; stdout: string }
export function changedFiles(
  root: string,
  ref = 'HEAD',
  git: (args: string[]) => GitResult = (args) => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    })
    return { status: result.status, stdout: result.stdout ?? '' }
  },
) {
  const check = git(['rev-parse', '--is-inside-work-tree'])
  if (check.status !== 0 || check.stdout.trim() !== 'true')
    throw new Error('Git 저장소가 아닙니다. --files로 변경 파일을 지정하세요')
  const files: string[] = []
  // Against ref: committed changes after ref, staged AND unstaged. Include untracked files.
  for (const args of [
    ['diff', '--name-only', '-z', ref, '--'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    const result = git(args)
    if (result.status !== 0)
      throw new Error('Git 변경 목록을 확인하지 못했습니다. --files를 사용하세요')
    files.push(...result.stdout.split('\0').filter(Boolean))
  }
  if (!files.length) throw new Error('Git 변경 파일이 없습니다. 빈 선택은 검사 통과가 아닙니다')
  return sorted(files)
}
