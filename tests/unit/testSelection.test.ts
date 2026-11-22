import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  catalog,
  selectTests,
  validateCatalog,
  changedFiles,
  electronModes,
  electronProjects,
  executionMode,
} from '../../scripts/test-catalog.mjs'

const choose = (...files: string[]) => selectTests({ files })
const unit = (names: string[]) => names.map((name) => `tests/unit/${name}.test.ts`)
const e2e = (names: string[]) => names.map((name) => `tests/e2e/${name}.spec.ts`)
const command = (...args: string[]) =>
  spawnSync(process.execPath, ['scripts/test-select.mjs', ...args], { encoding: 'utf8' })

describe('test selection reflects cross-process feature contracts', () => {
  it.each([
    [
      'PDF reader',
      'src/renderer/src/PdfPage.tsx',
      ['extract', 'images'],
      ['reader', 'activeChatGPT'],
    ],
    [
      'translation batches',
      'src/main/chatgpt/batching.ts',
      ['chatgptBatching', 'chatgptQueue'],
      ['activeChatGPT'],
    ],
    ['page chat', 'src/main/chat/request.ts', ['pageChat'], ['pageChat']],
    [
      'authentication and shared lock',
      'src/main/chatgpt/service.ts',
      ['chatgpt', 'chatgptQueue', 'pageChat'],
      ['activeChatGPT', 'pageChat'],
    ],
    [
      'shared SSE',
      'src/main/chatgpt/eventStream.ts',
      ['chatgptStream', 'chatgptOutput', 'pageChat'],
      ['activeChatGPT', 'pageChat'],
    ],
    [
      'completed output',
      'src/main/chatgpt/translationOutput.ts',
      ['chatgptStream', 'chatgptOutput', 'pageChat'],
      ['activeChatGPT', 'pageChat'],
    ],
    [
      'SQLite',
      'src/main/store.ts',
      ['library', 'queue', 'chatgptQueue', 'pageChat', 'themes'],
      ['activeChatGPT', 'pageChat', 'settings', 'themes'],
    ],
    [
      'IPC/preload',
      'src/preload/index.ts',
      ['chatgpt', 'pageChat', 'images', 'library'],
      ['reader', 'activeChatGPT', 'pageChat', 'settings', 'math', 'themes'],
    ],
    [
      'shared types',
      'src/shared/contracts.ts',
      ['queue', 'images', 'pageChat'],
      ['reader', 'activeChatGPT', 'pageChat'],
    ],
    [
      'safe rendering',
      'src/renderer/src/TranslationContent.tsx',
      ['markdownMath', 'pageChat'],
      ['math', 'activeChatGPT', 'pageChat'],
    ],
    [
      'shared CSS',
      'src/renderer/src/styles.css',
      ['markdownMath', 'themes'],
      ['reader', 'activeChatGPT', 'pageChat', 'settings', 'themes', 'math'],
    ],
  ] as const)(
    '%s includes required unit and Electron coverage',
    (_label, path, units, integration) => {
      const result = choose(path)
      expect(result.unit).toEqual(expect.arrayContaining(unit([...units])))
      expect(result.e2e).toEqual(expect.arrayContaining(e2e([...integration])))
      expect(result.full).toBe(false)
    },
  )
  it('does not turn isolated PDF/category changes into every test and supports absolute paths', () => {
    const selection = selectTests({ categories: ['pdf'], kind: 'unit' })
    expect(selection.categories).toEqual(['pdf'])
    expect(selection.unit).toEqual(unit(['extract', 'library', 'presentationImport']))
    expect(selection.e2e).toEqual([])
    expect(choose(resolve('src/renderer/src/PdfPage.tsx'))).toEqual(
      choose('src/renderer/src/PdfPage.tsx'),
    )
    expect(choose('src/main/chatgpt/batching.ts').unit).not.toContain('tests/unit/pageChat.test.ts')
    expect(choose('src/main/chatgpt/batching.ts').categories).toEqual(['translation'])
  })
  it('unions multiple categories/files without duplicate executions, with kind filtering', () => {
    const result = selectTests({
      categories: ['chat', 'translation', 'chat'],
      files: ['src/main/chat/stream.ts', 'src/main/chat/stream.ts'],
    })
    expect(new Set(result.unit).size).toBe(result.unit.length)
    expect(new Set(result.e2e).size).toBe(result.e2e.length)
    expect(result.unit).toContain('tests/unit/pageChat.test.ts')
    expect(result.unit).toContain('tests/unit/chatgptStream.test.ts')
    expect(selectTests({ categories: ['chat', 'translation'], kind: 'e2e' }).unit).toEqual([])
    expect(choose('tests/unit/extract.test.ts').unit).toEqual(unit(['extract']))
    expect(choose('tests/unit/extract.test.ts').e2e).toEqual([])
  })
  it.each([
    'tests/unit/fakes.ts',
    'tests/e2e/helpers.ts',
    'tests/e2e/fakeChatGPT.cjs',
    'tests/unit/networkGuard.ts',
    'package.json',
    'package-lock.json',
    'vitest.config.ts',
    'playwright.config.ts',
    'tsconfig.json',
    'scripts/test-catalog.mts',
    'scripts/test-select.mjs',
    'tests/unit/testSelection.test.ts',
    'src/new-unmapped-feature.ts',
    '../outside-workspace.ts',
  ])('%s expands conservatively with an explicit reason', (path) => {
    const result = choose(path)
    expect(result.full).toBe(true)
    expect([...result.unit, ...result.e2e, ...result.excludedScreen].sort()).toEqual(
      Object.keys(catalog).sort(),
    )
    expect(result.reasons.some((reason) => reason.includes(path))).toBe(true)
  })
  it('labels documents-only as not executed; mixed unknown paths cannot silently disappear', () => {
    const result = choose('SPEC.md', 'PLAN.md', 'tests/README.md')
    expect(result).toMatchObject({ docsOnly: true, full: false, unit: [], e2e: [] })
    expect(result.reasons.every((r) => r.includes('문서 전용'))).toBe(true)
    expect(choose('README.md', 'src/new-feature.ts')).toMatchObject({ docsOnly: false, full: true })
  })
  it('rejects bad categories, empty input, and categories with no tests of the requested kind', () => {
    expect(() => selectTests({ categories: ['typo'] })).toThrow('카테고리')
    expect(() => selectTests({ categories: ['toString'] })).toThrow('카테고리')
    expect(() => selectTests({})).toThrow('지정')
    expect(() => choose('')).toThrow('빈 파일')
    expect(() => selectTests({ kind: 'e2e', categories: ['tooling'] })).toThrow('테스트가 없습니다')
  })
  it('catalog covers every current test; missing/obsolete mappings fail before running', () => {
    expect(() => validateCatalog()).not.toThrow()
    const root = mkdtempSync(join(tmpdir(), 'translave-selection-'))
    try {
      mkdirSync(join(root, 'tests/unit'), { recursive: true })
      mkdirSync(join(root, 'tests/e2e'), { recursive: true })
      writeFileSync(join(root, 'tests/unit/unmapped.test.ts'), '')
      expect(() => validateCatalog(root)).toThrow('unmapped.test.ts')
      expect(() => validateCatalog(root)).toThrow('extract.test.ts')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('CLI previews actual native filters without running tests; documents are explicitly untested', () => {
    const preview = command('--category', 'pdf,chat', '--unit', '--list')
    expect(preview.status).toBe(0)
    expect(preview.stdout).toContain('선택 미리보기 · 실행 안 함')
    expect(preview.stdout).toContain('직접 지정: chat')
    expect(preview.stdout).toContain('tests/unit/pageChat.test.ts')
    expect(preview.stdout).not.toContain('tests/e2e/pageChat.spec.ts')
    const docs = command('--files', 'README.md')
    expect(docs.status).toBe(0)
    expect(docs.stdout).toContain('자동 테스트 미실행')
    expect(command('--files').status).toBe(1)
    expect(command('--category', 'typo').status).toBe(1)
    expect(command('--unit', '--e2e', '--all').status).toBe(1)
    expect(command('--category', 'tooling', '--e2e').status).toBe(1)
    expect(command('--bad-option').status).toBe(1)
    expect(command().status).toBe(1)
  })
  it('daily categories and unknown/common paths keep screen coverage pending, never silently executed', () => {
    for (const files of [
      ['src/renderer/src/PdfPage.tsx'],
      ['src/main/store.ts'],
      ['src/preload/index.ts'],
      ['src/renderer/src/styles.css'],
      ['tests/e2e/helpers.ts'],
      ['unknown.ts'],
    ]) {
      const result = selectTests({ files })
      expect(result.mode).toBe('quiet')
      expect(result.e2e.every((p) => electronModes[p] === 'quiet')).toBe(true)
      expect(result.excludedScreen).toEqual(e2e(['window.screen']))
    }
    const chat = selectTests({ categories: ['chat'] })
    expect(chat.excludedScreen).toEqual([])
    expect(selectTests({ files: ['tests/e2e/window.screen.spec.ts'], kind: 'e2e' })).toMatchObject({
      e2e: [],
      excludedScreen: e2e(['window.screen']),
      docsOnly: false,
    })
  })
  it('explicit screen/full selection preserves the exact union without duplicate tests or category coupling', () => {
    const quiet = selectTests({ all: true, mode: 'quiet' })
    const screen = selectTests({ all: true, kind: 'e2e', mode: 'screen' })
    const full = selectTests({ all: true })
    expect(full.mode).toBe('all')
    expect(screen.e2e).toEqual(e2e(['window.screen']))
    expect(screen.unit).toEqual([])
    expect(screen.excludedScreen).toEqual([])
    expect([...quiet.e2e, ...screen.e2e].sort()).toEqual(full.e2e)
    expect(new Set(full.e2e).size).toBe(full.e2e.length)
    expect([...full.unit, ...full.e2e].sort()).toEqual(Object.keys(catalog).sort())
    expect(selectTests({ kind: 'e2e', categories: ['pdf'], mode: 'screen' }).e2e).toEqual(
      screen.e2e,
    )
    expect(electronProjects('quiet').flatMap((p) => p.testMatch)).not.toContain(
      '**/tests/e2e/window.screen.spec.ts',
    )
    expect(electronProjects('all').map((p) => p.name)).toEqual(['quiet', 'screen'])
    expect(() => executionMode('typo')).toThrow('quiet/screen/all')
  })
  it('CLI explicitly reports omitted screens, screen-only pending selection, and opts in without executing previews', () => {
    const quiet = command('--e2e', '--category', 'pdf', '--list')
    expect(quiet.status).toBe(0)
    expect(quiet.stdout).toContain('방식: quiet')
    expect(quiet.stdout).toContain('미실행 화면 검사: tests/e2e/window.screen.spec.ts')
    expect(quiet.stdout).toContain('--mode screen')
    const pending = command('--e2e', '--files', 'tests/e2e/window.screen.spec.ts')
    expect(pending.status).toBe(2)
    expect(pending.stdout).toContain('검사 통과가 아닙니다')
    const screen = command('--e2e', '--category', 'pdf', '--mode', 'screen', '--list')
    expect(screen.status).toBe(0)
    expect(screen.stdout).toContain('방식: screen')
    expect(screen.stdout).not.toContain('tests/e2e/reader.spec.ts')
    expect(command('--all', '--mode', 'bad', '--list').status).toBe(1)
    expect(command('--all', '--mode').status).toBe(1)
  })
  it('the unit network guard rejects accidental real inference without making any request', async () => {
    await expect(fetch('https://api.openai.com/v1/responses')).rejects.toThrow('prohibit')
    await expect(fetch('https://generativelanguage.googleapis.com/')).rejects.toThrow('prohibit')
  })
  it('Git input handles non-repositories, missing Git, empty diffs and bad refs explicitly', () => {
    for (const status of [128, null])
      expect(() => changedFiles('/unused', 'HEAD', () => ({ status, stdout: '' }))).toThrow(
        '--files',
      )
    expect(() =>
      changedFiles('/unused', 'HEAD', (args) => ({
        status: 0,
        stdout: args[0] === 'rev-parse' ? 'true\n' : '',
      })),
    ).toThrow('변경 파일이 없습니다')
    expect(() =>
      changedFiles('/unused', 'bad-ref', (args) => ({
        status: args[0] === 'diff' ? 128 : 0,
        stdout: 'true',
      })),
    ).toThrow('변경 목록')
  })
  it('Git input includes diff plus untracked names, preserves spaces and deduplicates', () => {
    const calls: string[][] = []
    const files = changedFiles('/unused', 'base-ref', (args) => {
      calls.push(args)
      return {
        status: 0,
        stdout:
          args[0] === 'rev-parse'
            ? 'true\n'
            : args[0] === 'diff'
              ? 'src/main/chat/request.ts\0file with spaces.pdf\0'
              : 'src/main/chat/request.ts\0src/renderer/src/PageChat.tsx\0',
      }
    })
    expect(calls[1]).toEqual(['diff', '--name-only', '-z', 'base-ref', '--'])
    expect(calls[2]).toEqual(['ls-files', '--others', '--exclude-standard', '-z'])
    expect(files).toEqual([
      'file with spaces.pdf',
      'src/main/chat/request.ts',
      'src/renderer/src/PageChat.tsx',
    ])
  })
})
