import { test, createTestProfile, closeTestApp, launchTestApp, connectFakeChatGPT } from './helpers'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  richMath,
  basicMath,
  moneyAndCode,
  visualMath,
  unsafeMath,
  longBlock,
  longInline,
} from '../fixtures/math'
import { THEME_PALETTE } from '../../src/shared/themes'
import { TRANSLATION_VERSION } from '../../src/shared/contracts'

const pageOne =
  richMath + '\n\n' + moneyAndCode + '\n\n긴 인라인 ' + longInline + '\n\n' + longBlock
const sampleContent = (body: string) => ({
  contentType: 'text',
  translationMarkdown: body,
  visualElements: [
    { id: 'diagram-1', type: 'diagram', location: '중앙', descriptionMarkdown: visualMath },
  ],
  readingNotes: ['$2^{-1}$ 읽기 메모'],
  unclearRegions: ['$x^2$ 판독 메모'],
})
let app: ElectronApplication, page: Page, profile: string, pdfPath: string
let errors: number, external: number, rendererLeaks: number
let fakeBody: string
async function launch() {
  ;({ app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', () => errors++)
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) external++
    })
    page.on('console', (message) => {
      if (
        /KaTeX|katex|기밀수식|수식로그비밀|No character metrics|LaTeX-incompatible|\\(?:frac|times|notSupported|privateMacro)/.test(
          message.text(),
        )
      )
        rendererLeaks++
    })
  }))
}
test.beforeEach(async () => {
  errors = 0
  external = 0
  rendererLeaks = 0
  fakeBody = pageOne
  profile = await createTestProfile('math')
  pdfPath = join(profile, 'math-test.pdf')
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 1; i <= 2; i++)
    pdf.addPage([400, 300]).drawText('MATH FIXTURE ' + i, { x: 30, y: 240, font, size: 14 })
  await writeFile(pdfPath, await pdf.save())
  await launch()
})
test.afterEach(async () => {
  const counters = await app.evaluate(() => (globalThis as any).__activeFake)
  await closeTestApp(app, profile)
  expect(counters.logSites).toEqual([])
  expect(counters.gemini).toBe(0)
  expect(counters.unknown).toBe(0)
  expect(errors).toBe(0)
  expect(external).toBe(0)
  expect(rendererLeaks).toBe(0)
})
async function calls() {
  return (await app.evaluate(() => (globalThis as any).__activeFake)).calls.length as number
}
async function settings() {
  await page.getByRole('button', { name: '설정', exact: true }).click()
}
async function addAndOpen() {
  await app.evaluate(
    (_e, input) => {
      Object.assign((globalThis as any).__activeFake, {
        content: input.content,
        bodies: [input.body, input.second],
      })
    },
    { body: fakeBody, second: basicMath, content: sampleContent('') },
  )
  await connectFakeChatGPT(page)
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, pdfPath)
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '파일', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.listDocuments()))[0]?.done)
    .toBe(2)
  await page
    .getByRole('article', { name: 'math-test.pdf' })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.translation-content .katex')).toHaveCount(13)
}
async function reopen() {
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page
    .getByRole('article', { name: 'math-test.pdf' })
    .getByRole('button', { name: /열기$/ })
    .click()
}

test('fake JSON equations survive storage and restart; local fonts, visual math, plain metadata and cached completions work without new requests', async ({}, info) => {
  await addAndOpen()
  await expect(page.locator('.translation-content h2 .katex')).toHaveCount(1)
  await expect(page.locator('.translation-content li .katex')).toHaveCount(4)
  await expect(page.locator('.translation-content td .katex')).toHaveCount(1)
  await expect(page.locator('.translation-content .katex-mathml math')).toHaveCount(13)
  await expect(page.locator('.translation-content code')).toContainText([
    '$4 \\times 128$',
    '2^{-1}',
    '$4 \\times 128$',
  ])
  await expect(page.locator('.translation-content')).toContainText(
    '금액 $5와 $10, 달러 $1,200.50, 금액 $20.00.',
  )
  await page.getByTestId('translation-metadata').locator('summary').click()
  await expect(page.locator('.visual-description .katex')).toHaveCount(2)
  await expect(page.getByTestId('translation-metadata').locator('li')).toHaveText(
    '$2^{-1}$ 읽기 메모',
  )
  await page.getByTestId('unclear-regions').locator('summary').click()
  await expect(page.getByTestId('unclear-regions').locator('li')).toHaveText('$x^2$ 판독 메모')
  await page.evaluate(() => document.fonts.ready)
  expect(await page.evaluate(() => document.fonts.check('16px KaTeX_Main'))).toBe(true)
  await page.screenshot({ path: info.outputPath('math-normal.png') })
  const before = await calls()
  expect(before).toBe(1)
  await app.close()
  const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  const rows = db
    .prepare('SELECT page,text,result_json,version FROM translations ORDER BY page')
    .all()
  expect(rows.length).toBe(2)
  expect(rows[0].text === pageOne).toBe(true)
  expect(JSON.parse(String(rows[0].result_json)).translationMarkdown === pageOne).toBe(true)
  expect(rows.every((row) => String(row.version).startsWith('auto:ko:chatgpt:'))).toBe(true)
  db.close()
  await launch()
  await reopen()
  await expect(page.locator('.translation-content .katex')).toHaveCount(13)
  expect(await calls()).toBe(0)
  const after = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  expect(
    after.prepare('SELECT page,text,result_json,version FROM translations ORDER BY page').all(),
  ).toEqual(rows)
  after.close()
})

test('existing prompt4 completion renders read-only; malformed and malicious math cannot log, fetch or break surrounding content', async ({}, info) => {
  await app.close()
  const id = createHash('sha256')
    .update(await readFile(pdfPath))
    .digest('hex')
  const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  db.prepare(
    "INSERT INTO documents(id,name,total,path,added_at) VALUES(?, 'math-test.pdf',2,?,1)",
  ).run(id, pdfPath)
  const body = unsafeMath + '\n\n$$\n\\frac{1}{2}\n\n## 복구된 제목\n\n다음 문장 $2^{-1}$.'
  const result = sampleContent(body),
    json = JSON.stringify(result)
  db.prepare(
    "INSERT INTO translations(document_id,page,version,status,text,result_json) VALUES(?,1,?,'done',?,?)",
  ).run(id, TRANSLATION_VERSION, body, json)
  db.prepare(
    "INSERT INTO translations(document_id,page,version,status,text,result_json) VALUES(?,2,?,'done',?,?)",
  ).run(id, TRANSLATION_VERSION, basicMath, JSON.stringify(sampleContent(basicMath)))
  const before = db.prepare('SELECT * FROM translations').all()
  db.close()
  await launch()
  await reopen()
  await expect(page.getByTestId('live-translation')).toContainText('정상 앞')
  await expect(page.getByTestId('live-translation')).toContainText('정상 뒤')
  await expect(page.locator('.translation-content h2')).toHaveText('복구된 제목')
  expect(await page.locator('.math-literal').count()).toBeGreaterThan(5)
  await expect(
    page.locator(
      '.translation-content img,.translation-content script,.translation-content a,.translation-content iframe',
    ),
  ).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).mathUnsafe)).toBeUndefined()
  expect(await calls()).toBe(0)
  await page.screenshot({ path: info.outputPath('math-fallback-security.png') })
  const after = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  expect(after.prepare('SELECT * FROM translations').all()).toEqual(before)
  after.close()
})

test('math fits normal and narrow panels in every theme with local horizontal scrolling and unchanged reader/queue state', async ({}, info) => {
  test.setTimeout(90_000)
  await addAndOpen()
  const original = await calls()
  const normal = await page.locator('.translation-panel').boundingBox()
  for (const preset of THEME_PALETTE) {
    await settings()
    await page.getByRole('button', { name: '테마 선택', exact: true }).click()
    await page.getByRole('button', { name: preset.name + ' 테마', exact: true }).click()
    await page.getByRole('button', { name: '테마 적용', exact: true }).click()
    await page.getByRole('button', { name: '설정 닫기' }).click()
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960))
    await expect
      .poll(async () => (await page.locator('.translation-panel').boundingBox())!.width)
      .toBeGreaterThan(400)
    await page.locator('.panel-scroll').evaluate((node) => {
      node.scrollTop = 0
    })
    await page.screenshot({ path: info.outputPath(preset.id + '-normal.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    await expect
      .poll(async () => (await page.locator('.translation-panel').boundingBox())!.width)
      .toBeLessThan(normal!.width)
    const states = await page
      .locator('.translation-content .app-math-inline,.translation-content .app-math-block')
      .evaluateAll((nodes) =>
        nodes.map((node) => ({
          width: node.clientWidth,
          scroll: node.scrollWidth,
          overflow: getComputedStyle(node).overflowX,
          right: node.getBoundingClientRect().right,
          card: node.closest('.translation-panel')!.getBoundingClientRect().right,
        })),
      )
    expect(states.every((node) => node.right <= node.card + 1)).toBe(true)
    expect(states.filter((node) => node.scroll > node.width + 10).length).toBeGreaterThanOrEqual(2)
    expect(
      states
        .filter((node) => node.scroll > node.width + 10)
        .every((node) => node.overflow === 'auto'),
    ).toBe(true)
    // Chromium can add overflowing code/table/math regions to sequential focus.
    // Keep their mouse scrolling while the reading Tab order stays input-only.
    await page.getByRole('textbox', { name: '현재 페이지', exact: true }).click()
    for (const key of ['Tab', 'Shift+Tab']) {
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press(key)
        const focus = await page.evaluate(() => ({
          tag: document.activeElement?.tagName,
          className: document.activeElement?.getAttribute('class'),
        }))
        expect(['BODY', 'INPUT']).toContain(focus.tag)
      }
    }
    const scrolling = page.locator('.translation-content .app-math-block').last()
    await scrolling.scrollIntoViewIfNeeded()
    await scrolling.evaluate((node) => {
      node.scrollLeft = 100
    })
    expect(await scrolling.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0)
    await page.screenshot({ path: info.outputPath(preset.id + '-narrow-scroll.png') })
    await page.locator('.panel-scroll').evaluate((node) => {
      node.scrollTop = 0
    })
    const sameColor = await page
      .locator('.translation-content p .katex')
      .first()
      .evaluate(
        (node) => getComputedStyle(node).color === getComputedStyle(node.closest('p')!).color,
      )
    expect(sameColor).toBe(true)
    await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('1')
    expect(await calls()).toBe(original)
  }
  expect(await calls()).toBe(1)
})
