import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  categories,
  selectTests,
  validateCatalog,
  changedFiles,
  screenReason,
} from './test-catalog.mts'

const root = fileURLToPath(new URL('..', import.meta.url))
const usage = `테스트 선택 실행 (기존 npm test / npm run test:e2e는 전체 검사)
  npm run test:select -- --unit --category pdf
  npm run test:select -- --e2e --category chat,auth
  npm run test:select -- --category translation --category queue
  npm run test:select -- --files src/main/chat/stream.ts src/renderer/src/PageChat.tsx
  npm run test:select -- --files src/main/store.ts --list
  npm run test:select -- --changed [기준-ref] --list  (Git 저장소에서만)
  npm run test:select -- --all
  npm run test:select -- --e2e --category pdf --mode screen
  npm run test:select -- --catalog
종류 생략 시 unit+e2e. 기본 Electron 방식 quiet, --mode screen/all 명시 시 화면 검사 포함. --all은 기본 all 방식. --list는 선택만 확인하며 검사를 실행하지 않습니다.
카테고리: ${Object.entries(categories)
  .map(([id, label]) => `${id}(${label})`)
  .join(', ')}`
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: false, env })
  if (result.error) throw new Error('테스트 실행기를 시작하지 못했습니다')
  if (result.status !== 0) process.exit(result.status ?? 1)
}
try {
  const args = process.argv.slice(2)
  if (args.includes('--help')) {
    console.log(usage)
    process.exit(0)
  }
  const input = { categories: [], files: [] }
  let list = false,
    catalogOnly = false,
    kindSeen = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--unit' || arg === '--e2e') {
      if (kindSeen) throw new Error('--unit/--e2e 중 하나만 지정하세요(생략 시 둘 다)')
      input.kind = arg.slice(2)
      kindSeen = true
    } else if (arg === '--category') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('카테고리 값이 필요합니다')
      input.categories.push(...args[++i].split(','))
    } else if (arg === '--files') {
      const start = i
      while (args[i + 1] && !args[i + 1].startsWith('--')) input.files.push(args[++i])
      if (i === start) throw new Error('변경 파일 목록이 필요합니다')
    } else if (arg === '--changed') {
      const ref = args[i + 1] && !args[i + 1].startsWith('-') ? args[++i] : 'HEAD'
      input.files.push(...changedFiles(root, ref))
    } else if (arg === '--mode') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('실행 방식 값이 필요합니다')
      input.mode = args[++i]
    } else if (arg === '--all') input.all = true
    else if (arg === '--list') list = true
    else if (arg === '--catalog') catalogOnly = true
    else throw new Error(`알 수 없는 옵션: ${arg}`)
  }
  validateCatalog(root)
  if (catalogOnly) {
    console.log('테스트 카테고리 매핑 확인 완료 (--help로 선택 실행 안내).')
    process.exit(0)
  }
  const selection = selectTests(input, root)
  console.log(
    `\n[${list ? '선택 미리보기 · 실행 안 함' : '선택 실행'}] ${selection.full ? '전체 범위' : '관련 범위'} (${selection.kind})`,
  )
  console.log(`Electron 방식: ${selection.mode} · 전체 통과 여부는 미실행 화면 검사와 구분합니다.`)
  console.log(`카테고리: ${selection.categories.join(', ') || '없음'}`)
  console.log('선택 근거:\n' + selection.reasons.map((r) => `  - ${r}`).join('\n'))
  for (const kind of ['unit', 'e2e'])
    console.log(
      `${kind} (${selection[kind].length}파일):\n${selection[kind].map((p) => '  ' + p).join('\n') || '  없음'}`,
    )
  if (selection.excludedScreen.length) {
    console.log('미실행 화면 검사: ' + selection.excludedScreen.join(', '))
    console.log('이유: ' + screenReason)
    console.log(
      '별도 실행: npm run test:select -- --e2e --mode screen --files ' +
        selection.excludedScreen.join(' '),
    )
  }
  if (!selection.unit.length && !selection.e2e.length && !selection.docsOnly)
    console.log(
      '요청한 실행 방식의 실행 대상 없음. 위 화면 검사는 미실행이며 검사 통과가 아닙니다.',
    )
  if (selection.docsOnly)
    console.log('문서 전용 변경: 자동 테스트 미실행. 전체/선택 검사 통과로 보고하지 않습니다.')
  if (list || selection.docsOnly) process.exit(0)
  if (!selection.unit.length && !selection.e2e.length) process.exit(2)
  // Use native file filters; file sets are deduplicated before invoking either runner once.
  if (selection.unit.length)
    run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...selection.unit])
  if (selection.e2e.length) {
    if (selection.mode !== 'quiet')
      console.log(
        '주의: 화면 검사는 실제 창/포커스/전체 화면을 변경해 다른 앱 사용에 영향을 줄 수 있습니다.',
      )
    console.log('Electron 실행 전 현재 소스를 빌드합니다(이전 빌드 검증 방지).')
    run('npm', ['run', 'build'])
    run(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', ...selection.e2e], {
      ...process.env,
      TRANSLAVE_TEST_MODE: selection.mode,
    })
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : '선택 실행 실패')
  process.exitCode = 1
}
