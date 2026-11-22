import { defineConfig } from '@playwright/test'
import { electronProjects, executionMode, electronModes } from './scripts/test-catalog.mjs'

// Direct Playwright runs are quiet too. Screen projects only exist after explicit opt-in.
const mode = executionMode(process.env.TRANSLAVE_TEST_MODE ?? 'quiet')
console.log(`Electron 실행 방식: ${mode} (세부 시나리오 범위는 Playwright 파일/이름 필터 적용)`)
if (mode === 'quiet')
  console.log(
    '기본 제외 화면 검사: ' +
      Object.keys(electronModes)
        .filter((p) => electronModes[p] === 'screen')
        .join(', ') +
      ' · 별도 실행: npm run test:e2e:screen',
  )
if (mode !== 'quiet')
  console.log(
    '화면 검사: 실제 창 활성화·최대화·전체 화면 전환이 다른 앱 사용에 영향을 줄 수 있습니다.',
  )
export default defineConfig({
  testDir: './tests/e2e',
  projects: electronProjects(mode),
  workers: 1,
  timeout: 45_000,
  use: { trace: 'retain-on-failure' },
})
