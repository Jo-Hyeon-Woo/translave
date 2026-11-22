import { dragPanel } from './readerLayout'
import { test, createTestProfile, closeTestApp, launchTestApp, connectFakeChatGPT } from './helpers'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { THEME_PALETTE, themeColors } from '../../src/shared/themes'
import type { ThemeId } from '../../src/shared/themes'

let app: ElectronApplication
let page: Page
let profile: string
let errors: string[]
let external: string[]
const themeSection = () => page.locator('[data-section="theme"]')
const themeHeader = () => page.getByRole('button', { name: '테마 선택', exact: true })
const applied = () => themeSection().getByRole('img')
const stored = () => page.evaluate(() => window.desktop.themeSettings())
const count = () => app.evaluate(() => (globalThis as any).__activeFake.calls.length)
async function launch() {
  ;({ app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) external.push(request.url())
    })
  }))
}
test.beforeEach(async () => {
  errors = []
  external = []
  profile = await createTestProfile('themes')
  await launch()
})
test.afterEach(async () => {
  await closeTestApp(app, profile)
  expect(errors).toEqual([])
  expect(external).toEqual([])
})
async function settings() {
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(themeHeader()).toBeVisible()
}
async function openTheme() {
  await settings()
  await themeHeader().click()
  await expect(themeHeader()).toHaveAttribute('aria-expanded', 'true')
}
async function choose(id: ThemeId) {
  const name = THEME_PALETTE.find((entry) => entry.id === id)!.name
  await page.getByRole('button', { name: name + ' 테마', exact: true }).click()
}
async function settleSettings() {
  await page.locator('.settings-dialog').evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {})),
    )
  })
  await expect(page.locator('.settings-section-panel[data-open="true"]')).toHaveCount(1)
}
async function save(keyboard = false) {
  const button = page.getByRole('button', { name: '테마 적용', exact: true })
  if (keyboard) {
    await button.focus()
    await button.press('Enter')
  } else await button.click()
  await expect(themeHeader()).toHaveAttribute('aria-expanded', 'false')
}
async function uiState() {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.pdf-surface canvas')
    let pixels = 0
    if (canvas) {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 0; i < data.length; i++) pixels = (pixels * 31 + data[i]) | 0
    }
    return {
      page: document.querySelector<HTMLInputElement>('[aria-label="현재 페이지"]')?.value,
      zoom: document.querySelector('[data-testid="zoom-value"]')?.textContent,
      ratio: (document.querySelector('.app-shell') as HTMLElement)?.style.getPropertyValue(
        '--panel-ratio',
      ),
      text: document.querySelector('[data-testid="live-translation"]')?.textContent,
      canvas: canvas ? [canvas.width, canvas.height, pixels] : null,
    }
  })
}
async function view() {
  await app.evaluate(() => {
    ;(globalThis as any).__activeFake.bodies = [1, 2, 3, 4].map(
      (n) =>
        `# 가짜 번역 ${n}\n\n테마 검증을 위한 본문입니다.\n\n- 첫 항목\n- 두 번째 항목\n\n| 항목 | 값 |\n|---|---|\n| 수치 | 123 |\n\n\`\`\`js\nconst value = 123;\n\`\`\``,
    )
  })
  await connectFakeChatGPT(page)
  await page.getByRole('button', { name: '샘플 문서로 둘러보기' }).click()
  await expect(page.getByTestId('live-translation')).toContainText('가짜 번역 1')
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.listDocuments()))[0]?.done)
    .toBe(4)
  const input = page.getByRole('textbox', { name: '현재 페이지' })
  await input.fill('2')
  await input.press('Enter')
  await expect(page.getByTestId('live-translation')).toContainText('가짜 번역 2')
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await dragPanel(page)
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  await expect.poll(async () => (await uiState()).canvas?.[0] ?? 0).toBeGreaterThan(0)
}

test('theme choice and reset are drafts; apply persists, collapses only the menu and restores on restart', async () => {
  await openTheme()
  await expect(applied()).toHaveAttribute('aria-label', '현재 테마: 세이지')
  const before = await page
    .locator('.titlebar')
    .evaluate((node) => getComputedStyle(node).backgroundColor)
  await page.getByRole('button', { name: '블루 테마', exact: true }).focus()
  await page.getByRole('button', { name: '블루 테마', exact: true }).press('Space')
  await expect(page.locator('.theme-swatch[aria-pressed="true"]')).toHaveCount(1)
  expect(await stored()).toBe('sage')
  expect(
    await page.locator('.titlebar').evaluate((node) => getComputedStyle(node).backgroundColor),
  ).toBe(before)
  await themeHeader().click()
  await themeHeader().press('Enter')
  await expect(page.getByRole('button', { name: '블루 테마', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await save(true)
  await expect(page.getByRole('dialog', { name: 'settings' })).toBeVisible()
  expect(await stored()).toBe('blue')
  await expect(applied()).toHaveAttribute('aria-label', '현재 테마: 블루')
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
    ),
  ).toBe('#dfeaf0')
  await themeHeader().click()
  await themeSection().getByRole('button', { name: '테마 기본값으로 복귀' }).click()
  await expect(page.getByRole('button', { name: '세이지 테마', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  expect(await stored()).toBe('blue')
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await openTheme()
  await expect(page.getByRole('button', { name: '블루 테마', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await app.close()
  await launch()
  expect(await stored()).toBe('blue')
  expect(await page.locator('html').getAttribute('data-theme')).toBe('blue')
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
    ),
  ).toBe('#dfeaf0')
  await openTheme()
  await expect(applied()).toHaveAttribute('aria-label', '현재 테마: 블루')
  await themeSection().getByRole('button', { name: '테마 기본값으로 복귀' }).click()
  await save()
  expect(await stored()).toBe('sage')
  await app.close()
  await launch()
  expect(await stored()).toBe('sage')
  expect(await count()).toBe(0)
})

test('real SQLite save failure keeps the applied theme, open error and selection; invalid IPC is rejected', async ({}, info) => {
  await openTheme()
  await choose('blue')
  await save()
  await themeHeader().click()
  const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  db.exec(
    "CREATE TRIGGER reject_theme BEFORE UPDATE ON theme_settings BEGIN SELECT RAISE(ABORT,'test failure'); END;",
  )
  try {
    await choose('rose')
    await page.getByRole('button', { name: '테마 적용' }).click()
    await expect(themeSection().getByRole('alert')).toContainText('테마를 저장하지 못했어요.')
    await expect(themeHeader()).toHaveAttribute('aria-expanded', 'true')
    await expect(applied()).toHaveAttribute('aria-label', '현재 테마: 블루')
    await expect(page.getByRole('button', { name: '로즈 테마' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(await stored()).toBe('blue')
    expect(await page.locator('html').getAttribute('data-theme')).toBe('blue')
    expect(db.prepare('SELECT theme FROM theme_settings').get()?.theme).toBe('blue')
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getBackgroundColor().toLowerCase(),
      ),
    ).toBe('#dfeaf0')
    await settleSettings()
    await page.screenshot({ path: info.outputPath('theme-save-error.png') })
  } finally {
    db.exec('DROP TRIGGER reject_theme')
    db.close()
  }
  const response = await page.evaluate(() => window.desktop.configureTheme('unsupported' as any))
  expect(response.status).toBe('error')
  expect(await stored()).toBe('blue')
  await page.getByRole('button', { name: '테마 적용' }).click()
  await expect(themeHeader()).toHaveAttribute('aria-expanded', 'false')
  expect(await stored()).toBe('rose')
  expect(await count()).toBe(0)
})

for (const value of [null, 'unsupported']) {
  test(`startup uses the default for ${value === null ? 'missing' : 'unknown'} saved theme without changing other settings`, async () => {
    await app.close()
    const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
    db.prepare('UPDATE budget_settings SET input_tokens=14000,output_tokens=12000 WHERE id=1').run()
    if (value !== null) db.prepare('INSERT INTO theme_settings(id,theme) VALUES(1,?)').run(value)
    db.close()
    await launch()
    expect(await stored()).toBe('sage')
    expect(await page.locator('html').getAttribute('data-theme')).toBe('sage')
    const after = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
    expect(
      after.prepare('SELECT input_tokens,output_tokens FROM budget_settings WHERE id=1').get(),
    ).toEqual({ input_tokens: 14000, output_tokens: 12000 })
    after.close()
    expect(await count()).toBe(0)
  })
}

test('every theme covers dialogs, cards, controls, focus and errors while PDF state, pixels, cache and requests stay unchanged', async ({}, info) => {
  await view()
  await expect(page.locator('.connection-badge')).toHaveAttribute('data-state', 'ready')
  const before = await uiState(),
    calls = await count()
  const translations = await page.evaluate(() => window.desktop.translationSettings())
  const documents = await page.evaluate(() => window.desktop.listDocuments())
  const colors = []
  for (const preset of THEME_PALETTE) {
    await openTheme()
    await choose(preset.id)
    await save()
    await themeHeader().click()
    await page.keyboard.press('Tab')
    await page.getByRole('button', { name: preset.name + ' 테마', exact: true }).focus()
    const expected = themeColors(preset.id)
    const actual = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement)
      return Object.fromEntries(
        ['frame', 'surface', 'reader-background', 'input-focus', 'status-success', 'error'].map(
          (key) => [key, style.getPropertyValue('--' + key).trim()],
        ),
      )
    })
    for (const key of Object.keys(actual)) expect(actual[key]).toBe(expected[key])
    await expect(
      page.getByRole('button', { name: preset.name + ' 테마', exact: true }),
    ).toBeFocused()
    await settleSettings()
    await expect(page.getByRole('button', { name: '테마 적용', exact: true })).toBeInViewport()
    await page.screenshot({ path: info.outputPath(preset.id + '-settings-focus.png') })
    await page.getByRole('button', { name: '번역 이미지 설정', exact: true }).click()
    await page.getByLabel('이미지 해상도 (DPI)').fill('1')
    await page.getByRole('button', { name: '이미지 설정 적용' }).click()
    await expect(page.locator('[data-section="images"]').getByRole('alert')).toBeVisible()
    await settleSettings()
    await page.screenshot({ path: info.outputPath(preset.id + '-error.png') })
    await page.getByRole('button', { name: '설정 닫기' }).click()
    expect(await uiState()).toEqual(before)
    await page.screenshot({ path: info.outputPath(preset.id + '-reader.png') })
    await page.getByRole('button', { name: '파일 목록 열기' }).click()
    const fileDialog = page.getByRole('dialog', { name: 'files', exact: true })
    await expect(fileDialog.getByRole('article')).toHaveCount(1)
    const surfaces = await page.evaluate(() =>
      Object.fromEntries(
        [
          '.titlebar',
          '.reader',
          '.translation-panel',
          '.file-button',
          '.file-dialog',
          '.library-add',
        ].map((selector) => [
          selector,
          getComputedStyle(document.querySelector(selector)!).backgroundColor,
        ]),
      ),
    )
    expect(surfaces['.reader']).toBe(surfaces['.file-button'])
    colors.push(surfaces)
    await page.screenshot({ path: info.outputPath(preset.id + '-files.png') })
    await page.getByRole('button', { name: '파일 목록 닫기' }).click()
    expect(await page.evaluate(() => window.desktop.translationSettings())).toEqual(translations)
    expect(await page.evaluate(() => window.desktop.listDocuments())).toEqual(documents)
    expect(await count()).toBe(calls)
  }
  expect(new Set(colors.map((value) => value['.titlebar'])).size).toBe(5)
  expect(new Set(colors.map((value) => value['.file-dialog'])).size).toBe(5)
  await app.close()
  await launch()
  expect(await stored()).toBe('lavender')
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page
    .getByRole('dialog', { name: 'files', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(page.getByTestId('live-translation')).toContainText('가짜 번역 2')
  expect(await count()).toBe(0)
  expect((await page.evaluate(() => window.desktop.listDocuments()))[0].done).toBe(4)
})
