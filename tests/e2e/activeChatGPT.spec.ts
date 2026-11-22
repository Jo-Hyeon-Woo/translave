import { test, createTestProfile, closeTestApp, launchTestApp, connectFakeChatGPT } from './helpers'
import { createHash } from 'node:crypto'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib'
import { writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
let app: ElectronApplication, page: Page, profile: string, rendererErrors: number, external: number
async function launch() {
  ;({ app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', () => rendererErrors++)
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) external++
    })
  }))
}
const state = () =>
  app.evaluate(() => {
    const { release, ...s } = (globalThis as any).__activeFake
    return s
  })
const set = async (value: Record<string, unknown>) =>
  app.evaluate((_e, v) => Object.assign((globalThis as any).__activeFake, v), value)
const connect = () => connectFakeChatGPT(page)
async function add(name: string) {
  await app.evaluate(
    ({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    },
    join(profile, name + '.pdf'),
  )
  if (!(await page.getByRole('dialog', { name: 'files', exact: true }).isVisible()))
    await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '파일', exact: true }).click()
  await expect(page.getByRole('article', { name: name + '.pdf', exact: true })).toBeVisible()
}
async function open(name: string) {
  await page
    .getByRole('article', { name: name + '.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText(name + '.pdf')
}
function rows() {
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  try {
    return db.prepare('SELECT document_id,page,version,status FROM translations').all()
  } finally {
    db.close()
  }
}
test.beforeEach(async () => {
  rendererErrors = 0
  external = 0
  profile = await createTestProfile('activechatgpt')
  const colors = { A: [1, 0.8, 0.8], B: [0.8, 0.9, 1], C: [0.8, 1, 0.8], D: [1, 0.9, 0.6] }
  for (const [name, color] of Object.entries(colors)) {
    const doc = await PDFDocument.create(),
      font = await doc.embedFont(StandardFonts.Helvetica)
    for (let n = 1; n <= (name === 'A' || name === 'C' ? 1 : 3); n++) {
      const p = doc.addPage([400, 400])
      p.drawRectangle({
        x: 0,
        y: 0,
        width: 400,
        height: 400,
        color: rgb(...(color as [number, number, number])),
      })
      p.drawText('EXTRACTED_SECRET ' + name + ' ' + n, { x: 30, y: 330, size: 18, font })
    }
    await writeFile(join(profile, name + '.pdf'), await doc.save())
  }
  await launch()
})
test.afterEach(async () => {
  const s = await state()
  await closeTestApp(app, profile)
  expect(s.gemini).toBe(0)
  expect(s.unknown).toBe(0)
  expect(s.logSites).toEqual([])
  expect(s.maxActive).toBeLessThanOrEqual(1)
  expect(rendererErrors).toBe(0)
  expect(external).toBe(0)
})
test('active settings and manual login prepare the sole ChatGPT route', async ({}, info) => {
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(page.locator('.settings-section-trigger')).toHaveCount(3)
  await expect(page.getByText('Gemini API 키 설정', { exact: true })).toHaveCount(0)
  await expect(page.getByText('묶음 번역 예산', { exact: true })).toHaveCount(0)
  await expect(page.getByText('이미지 판독 수준', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await connect()
  expect((await state()).calls).toHaveLength(0)
  await settings()
  const before = await state()
  await expect(page.getByRole('button', { name: 'ChatGPT 로그아웃', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'ChatGPT 계정' })).toHaveCount(0)
  await expect(page.locator('.chatgpt-plan-dialog,.chatgpt-response-diagnostic')).toHaveCount(0)
  await page.getByRole('button', { name: '모델 목록 확인', exact: true }).click()
  await expect.poll(async () => (await state()).models).toBe(before.models + 1)
  const refreshed = await state()
  await page.getByRole('button', { name: 'ChatGPT 연결 확인', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ChatGPT 연결', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  await expect(page.getByRole('dialog', { name: 'settings', exact: true })).toBeVisible()
  expect((await state()).models).toBe(refreshed.models)
  expect((await state()).registration).toBe(refreshed.registration)
  expect((await state()).calls).toHaveLength(0)
  await page.getByRole('button', { name: 'ChatGPT 연결', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ChatGPT 연결', exact: true })).toContainText(
    'ChatGPT 로그인됨',
  )
  await page.locator('.settings-dialog').evaluate(async (node) => {
    await Promise.all(node.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})))
  })
  const fit = await page
    .locator('.chatgpt-connection .settings-row-scroll')
    .evaluate((n) => ({ width: n.clientWidth, content: n.scrollWidth }))
  expect(fit.content).toBeLessThanOrEqual(fit.width)
  await page.screenshot({ path: info.outputPath('chatgpt-compact.png') })
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click()
  await add('A')
  await expect.poll(() => rows().length).toBe(1)
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('파일 선택')
  await open('A')
  await expect(page.getByTestId('live-translation')).toContainText('문서 A · 1페이지')
  await expect(page.locator('.katex-mathml')).toHaveCount(2)
  await expect(page.getByTestId('live-translation').locator('img,a,script')).toHaveCount(0)
  expect(await state()).toMatchObject({ imageOK: true, promptOK: true, inputOK: true })
  await page.screenshot({ path: info.outputPath('active-sidebar.png') })
})

async function menuAction(name: string) {
  await page.getByLabel('번역 메뉴', { exact: true }).click()
  await page.locator('.translation-menu').getByRole('button', { name, exact: true }).click()
}
async function settings() {
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.getByRole('button', { name: 'ChatGPT 연결', exact: true }).click()
}

test('background FIFO and current-page preemption preserve documents and serial requests', async ({}, info) => {
  await connect()
  await add('A')
  await expect.poll(() => rows().length).toBe(1)
  await open('A')
  await set({ holdDoc: 'B' })
  await add('B')
  await expect.poll(async () => (await state()).calls.length).toBe(2)
  await add('C')
  await add('D')
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('A.pdf')
  await expect(
    page.getByRole('article', { name: 'B.pdf', exact: true }).getByText('번역 중', { exact: true }),
  ).toBeVisible()
  await open('D')
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click()
  await expect(page.getByLabel('현재 페이지', { exact: true })).toHaveValue('2')
  expect((await state()).calls).toHaveLength(2)
  await app.evaluate(() => {
    ;(globalThis as any).__activeFake.release()
  })
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(8)
  expect((await state()).calls.map((c: any) => [c.doc, c.pages])).toEqual([
    ['A', [1]],
    ['B', [1, 2, 3]],
    ['D', [1, 2, 3]],
    ['C', [1]],
  ])
  await expect(page.getByTestId('live-translation')).toContainText('문서 D · 2페이지')
  await expect(page.getByTestId('live-translation')).not.toContainText('문서 B')
  await page.screenshot({ path: info.outputPath('priority-result.png') })
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  const list = page.getByRole('dialog', { name: 'files', exact: true })
  await expect(list.getByText('번역 완료', { exact: true })).toHaveCount(4)
  await add('B')
  expect((await state()).calls).toHaveLength(4)
})

test('pause/logout cancel work, saved connection refreshes on restart, resume and completed cache survive', async () => {
  await connect()
  await set({ holdDoc: 'B' })
  await add('B')
  await open('B')
  await expect.poll(async () => (await state()).calls.length).toBe(1)
  await menuAction('자동 번역 일시정지')
  await settings()
  await page.getByRole('button', { name: 'ChatGPT 로그아웃', exact: true }).click()
  await expect
    .poll(async () => (await page.evaluate(() => window.desktop.chatgptSnapshot())).status)
    .toBe('disconnected')
  expect(rows()).toHaveLength(0)
  await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
  await expect(page.getByRole('combobox', { name: 'ChatGPT 번역 모델' })).toHaveValue('gpt-6.1-sol')
  await app.close()
  await launch()
  await expect.poll(async () => (await state()).refreshes).toBe(1)
  expect((await state()).calls).toHaveLength(0)
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('B')
  await menuAction('자동 번역 재개')
  await expect.poll(() => rows().length).toBe(3)
  expect((await state()).calls.map((c: any) => c.pages)).toEqual([[1, 2, 3]])
  await app.close()
  await launch()
  await expect.poll(async () => (await state()).refreshes).toBe(1)
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('B')
  await expect(page.getByTestId('live-translation')).toContainText('문서 B · 1페이지')
  expect((await state()).calls).toHaveLength(0)
})

test('model switch cancels old inference and single-account re-login reuses its context without duplicate cache calls', async () => {
  await connect()
  await set({ holdDoc: 'B' })
  await add('B')
  await open('B')
  await expect.poll(async () => (await state()).calls.length).toBe(1)
  await settings()
  await page.getByRole('combobox', { name: 'ChatGPT 번역 모델' }).selectOption('gpt-6-sol')
  await expect.poll(() => rows().length).toBe(3)
  expect(rows().every((r) => String(r.version).includes(':gpt-6-sol:'))).toBe(true)
  const before = await page.evaluate(() => window.desktop.chatgptSnapshot())
  const calls = (await state()).calls.length
  await expect(page.getByRole('combobox', { name: 'ChatGPT 계정' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '다른 계정 추가' })).toHaveCount(0)
  await page.getByRole('button', { name: 'ChatGPT 로그아웃', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ChatGPT로 로그인', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'ChatGPT로 로그인', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'ChatGPT 번역 모델' })).toHaveValue('gpt-6-sol')
  const after = await page.evaluate(() => window.desktop.chatgptSnapshot())
  expect(after.activeId).toBe(before.activeId)
  expect(after.profiles).toHaveLength(1)
  expect((await state()).registration).toBe(1)
  expect(rows()).toHaveLength(3)
  expect((await state()).calls).toHaveLength(calls)
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await expect(page.getByTestId('live-translation')).toContainText('문서 B')
})

for (const mode of ['invalid', 'incomplete', 'unreadable'])
  test(
    'page failure ' + mode + ' is isolated and manual retranslation replaces only that page',
    async () => {
      await connect()
      await set({ mode })
      await add('A')
      await open('A')
      await expect.poll(() => rows().filter((r) => r.status === 'error').length).toBe(1)
      await expect(page.getByRole('alert')).toBeVisible()
      await set({ mode: 'normal' })
      await add('C')
      await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(1)
      if (mode === 'invalid') {
        const failed = page.getByRole('article', { name: 'A.pdf', exact: true })
        await expect(failed.locator('.library-count')).toHaveText('0/1')
        await expect(failed.locator('.library-state')).toHaveText('실패 1')
        await failed.getByRole('button', { name: 'A.pdf 파일 메뉴', exact: true }).click()
        await page
          .getByRole('menuitem', { name: '실패한 페이지 재번역', exact: true })
          .press('Enter')
      } else {
        await page.getByRole('button', { name: '파일 목록 닫기' }).click()
        await menuAction('다시 번역')
      }
      await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(2)
      await expect(page.getByTestId('live-translation')).toContainText('문서 A')
      expect((await state()).calls).toHaveLength(3)
    },
  )

for (const mode of ['quota', 'auth'])
  test(
    'global ' + mode + ' holds pending documents and resumes only through the user flow',
    async () => {
      await connect()
      await set({ mode })
      await add('B')
      await open('B')
      await expect.poll(async () => (await state()).calls.length).toBe(1)
      await expect
        .poll(
          async () => (await page.evaluate(() => window.desktop.translationSettings())).configured,
        )
        .toBe(false)
      await add('C')
      await page.getByRole('button', { name: '파일 목록 닫기' }).click()
      expect(rows()).toHaveLength(0)
      expect((await state()).calls).toHaveLength(1)
      const badge = page.locator('.language-bar .connection-badge')
      await expect(badge).toHaveAttribute('data-state', mode === 'quota' ? 'ready' : 'error')
      await set({ mode: 'normal' })
      if (mode === 'auth') {
        await badge.getByRole('button', { name: 'ChatGPT 연결 설정 열기' }).click()
        await expect(
          page.getByRole('button', { name: 'ChatGPT 연결', exact: true }),
        ).toHaveAttribute('aria-expanded', 'true')
        await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
        await expect(page.getByRole('combobox', { name: 'ChatGPT 번역 모델' })).toHaveValue(
          'gpt-6.1-sol',
        )
        await page.getByRole('button', { name: '설정 닫기' }).click()
      } else await menuAction('자동 번역 재개')
      await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(4)
      expect((await state()).calls).toHaveLength(3)
    },
  )

test('legacy Gemini rows/settings remain read-only, explicit ChatGPT retranslation preserves provenance and saved cache', async ({}, info) => {
  await app.close()
  const path = join(profile, 'translations/translations.sqlite'),
    db = new DatabaseSync(path)
  const id = createHash('sha256')
    .update(await readFile(join(profile, 'A.pdf')))
    .digest('hex')
  const version =
    'auto:ko:gemini:gemini-3.5-flash-lite:image1:prompt4:schema1:render1:144:jpeg:0.9:high'
  db.prepare('INSERT INTO documents(id,name,total,path) VALUES(?,?,?,?)').run(
    id,
    'A.pdf',
    1,
    join(profile, 'A.pdf'),
  )
  db.prepare(
    "INSERT INTO translations(document_id,page,version,status,text,result_json) VALUES(?,1,?,'done',?,?)",
  ).run(
    id,
    version,
    '기존 Gemini 번역',
    JSON.stringify({
      contentType: 'text',
      translationMarkdown: '기존 Gemini 번역',
      visualElements: [],
      readingNotes: [],
      unclearRegions: [],
    }),
  )
  db.prepare('UPDATE budget_settings SET input_tokens=12345,output_tokens=9876 WHERE id=1').run()
  db.prepare('INSERT INTO image_settings(id,value) VALUES(1,?)').run(
    JSON.stringify({
      dpi: 180,
      format: 'png',
      quality: 0.85,
      mediaResolution: 'low',
      maxRequestBytes: 8 * 1024 * 1024,
    }),
  )
  db.close()
  await launch()
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('A')
  await expect(page.getByTestId('live-translation')).toContainText('기존 Gemini 번역')
  await page.getByTestId('translation-provenance').getByText('번역 출처', { exact: true }).click()
  await expect(page.getByTestId('translation-provenance')).toContainText('Gemini')
  await connect()
  expect((await state()).calls).toHaveLength(0)
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.getByRole('button', { name: '번역 이미지 설정', exact: true }).click()
  await expect(page.getByLabel('이미지 해상도 (DPI)')).toHaveValue('180')
  await page.getByLabel('이미지 해상도 (DPI)').fill('200')
  await page.getByRole('button', { name: '이미지 설정 적용' }).click()
  await page.getByRole('button', { name: '설정 닫기' }).click()
  expect((await state()).calls).toHaveLength(0)
  await menuAction('다시 번역')
  await expect
    .poll(() => rows().filter((r) => String(r.version).startsWith('auto:ko:chatgpt:')).length)
    .toBe(1)
  await expect(page.getByTestId('live-translation')).toContainText('교착 상태(Deadlock)')
  const verify = new DatabaseSync(path)
  expect(verify.prepare('SELECT text FROM translations WHERE version=?').get(version)?.text).toBe(
    '기존 Gemini 번역',
  )
  expect(verify.prepare('SELECT input_tokens FROM budget_settings').get()?.input_tokens).toBe(12345)
  expect(
    JSON.parse(String(verify.prepare('SELECT value FROM image_settings').get()?.value)),
  ).toMatchObject({
    dpi: 200,
    format: 'png',
    quality: 0.85,
    mediaResolution: 'low',
    maxRequestBytes: 8 * 1024 * 1024,
  })
  verify.close()
  await page.screenshot({ path: info.outputPath('legacy-retranslated.png') })
  await app.close()
  await launch()
  await expect.poll(async () => (await state()).refreshes).toBe(1)
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('A')
  await expect(page.getByTestId('live-translation')).toContainText('교착 상태(Deadlock)')
  expect((await state()).calls).toHaveLength(0)
})

async function longFixture(name: 'B' | 'D', total = 8) {
  const pdf = await PDFDocument.create(),
    font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= total; n++) {
    const p = pdf.addPage([400, 400])
    p.drawRectangle({
      x: 0,
      y: 0,
      width: 400,
      height: 400,
      color: name === 'B' ? rgb(0.8, 0.9, 1) : rgb(1, 0.9, 0.6),
    })
    p.drawText('EXTRACTED_SECRET ' + name + ' ' + n, { x: 30, y: 330, font, size: 18 })
  }
  await writeFile(join(profile, name + '.pdf'), await pdf.save())
}
test('multiple page requests preempt at batch boundaries, preserve remaining work and map reverse results', async ({}, info) => {
  await longFixture('B')
  await longFixture('D')
  await connect()
  await add('A')
  await expect.poll(() => rows().length).toBe(1)
  await open('A')
  await set({ holdDoc: 'B' })
  await add('B')
  await expect.poll(async () => (await state()).calls.length).toBe(2)
  await add('C')
  await add('D')
  await open('D')
  await page.getByLabel('현재 페이지', { exact: true }).fill('7')
  await page.getByLabel('현재 페이지', { exact: true }).press('Enter')
  await app.evaluate(() => {
    ;(globalThis as any).__activeFake.release()
  })
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(18)
  const calls = (await state()).calls
  expect(calls.map((c: any) => [c.doc, c.pages])).toEqual([
    ['A', [1]],
    ['B', [1, 2, 3, 4, 5]],
    ['D', [6, 7, 8]],
    ['D', [1, 2, 3, 4, 5]],
    ['B', [6, 7, 8]],
    ['C', [1]],
  ])
  await expect(page.getByTestId('live-translation')).toContainText('문서 D · 7페이지')
  expect(await state()).toMatchObject({
    inputOK: true,
    imageOK: true,
    promptOK: true,
    maxActive: 1,
  })
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await expect(page.getByText('번역 완료', { exact: true })).toHaveCount(4)
  await page.screenshot({ path: info.outputPath('batch-library.png') })
})
test('a failed batch yields before shrink retries and then finishes both documents without duplicate saved pages', async () => {
  await connect()
  await add('A')
  await expect.poll(() => rows().length).toBe(1)
  await open('A')
  await set({ holdDoc: 'B', mode: 'shrink' })
  await add('B')
  await expect.poll(async () => (await state()).calls.length).toBe(2)
  await add('D')
  await open('D')
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click()
  await app.evaluate(() => {
    ;(globalThis as any).__activeFake.release()
  })
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(7)
  const calls = (await state()).calls
  expect(calls[2]).toMatchObject({ doc: 'D', pages: [1, 2, 3] })
  expect(
    calls
      .filter((c: any) => c.doc === 'D' && c.pages.length === 1)
      .flatMap((c: any) => c.pages)
      .sort(),
  ).toEqual([1, 2, 3])
  expect(
    calls
      .filter((c: any) => c.doc === 'B' && c.pages.length === 1)
      .flatMap((c: any) => c.pages)
      .sort(),
  ).toEqual([1, 2, 3])
  await expect(page.getByTestId('live-translation')).toContainText('문서 D · 2페이지')
})
test('restart after a partially completed document calls only pages outside the saved batch', async ({}, info) => {
  await longFixture('B')
  await connect()
  await set({ holdDoc: 'B', holdPage: 6 })
  await add('B')
  await open('B')
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(5)
  await expect.poll(async () => (await state()).calls.length).toBe(2)
  await menuAction('자동 번역 일시정지')
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await expect(page.getByRole('article', { name: 'B.pdf', exact: true })).toContainText('5/8')
  await page.screenshot({ path: info.outputPath('batch-paused-progress.png') })
  await app.close()
  await launch()
  await expect.poll(async () => (await state()).refreshes).toBe(1)
  expect((await state()).calls).toHaveLength(0)
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('B')
  await menuAction('자동 번역 재개')
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(8)
  expect((await state()).calls.map((c: any) => c.pages)).toEqual([[6, 7, 8]])
  await expect(page.getByTestId('live-translation')).toContainText('문서 B · 1페이지')
})

test('file status refresh closes stale row menus and failed-page retry keeps the original document', async ({}, info) => {
  await connect()
  await set({ holdDoc: 'B' })
  await add('B')
  const row = page.getByRole('article', { name: 'B.pdf', exact: true })
  await expect(row.locator('.library-state')).toHaveText('번역 중')
  await expect(row.getByLabel('번역 진행 중', { exact: true })).toBeVisible()
  await expect(row.locator('.library-count')).toHaveText('0/3')
  await row.getByRole('button', { name: 'B.pdf 파일 메뉴', exact: true }).press('Enter')
  await expect(page.getByRole('menuitem', { name: '실패한 페이지 재번역' })).toBeDisabled()
  await app.evaluate(() => {
    ;(globalThis as any).__activeFake.release()
  })
  await expect(row.locator('.library-state')).toHaveText('번역 완료')
  await expect(row.locator('.library-count')).toHaveText('3/3')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('파일 선택')
  await set({ mode: 'invalid' })
  await add('A')
  const failed = page.getByRole('article', { name: 'A.pdf', exact: true })
  await expect(failed.locator('.library-state')).toHaveText('실패 1')
  await expect(failed.getByText('실패 1', { exact: true })).toHaveCount(1)
  await expect(failed.getByText('중단됨', { exact: true })).toHaveCount(0)
  await failed.getByRole('progressbar').click()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('파일 선택')
  await failed.getByRole('button', { name: 'A.pdf 파일 메뉴', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: '실패한 페이지 재번역' })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('files-failed-menu.png') })
  await set({ mode: 'normal' })
  await page.getByRole('menuitem', { name: '실패한 페이지 재번역', exact: true }).press('Space')
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('A.pdf')
  await expect(page.getByTestId('live-translation')).toContainText('문서 A')
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(4)
  expect((await state()).calls.map((c: any) => c.doc)).toEqual(['B', 'A', 'A'])
})

test('closing all duplicate tabs keeps the single in-flight background translation and completed cache', async () => {
  await connect()
  await set({ holdDoc: 'B', holdPage: 1 })
  await add('B')
  await expect.poll(async () => (await state()).calls.length).toBe(1)
  await open('B')
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('B')
  await expect(page.locator('.document-tab')).toHaveCount(2)
  const docId = (await page.evaluate(() => window.desktop.listDocuments()))[0].id
  for (let i = 0; i < 2; i++)
    await page
      .locator('.document-tab')
      .last()
      .getByRole('button', { name: /탭 닫기$/ })
      .click()
  await expect(page.locator('.document-tab')).toHaveCount(0)
  expect((await state()).calls).toHaveLength(1)
  expect(await app.evaluate(() => typeof (globalThis as any).__activeFake.release)).toBe('function')
  await app.evaluate(() => (globalThis as any).__activeFake.release())
  await expect.poll(() => rows().filter((r) => r.status === 'done').length).toBe(3)
  expect((await state()).calls).toHaveLength(1)
  expect(await page.evaluate(() => window.desktop.listDocuments())).toHaveLength(1)
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await open('B')
  await expect(page.getByTestId('live-translation')).toBeVisible()
  expect((await state()).calls).toHaveLength(1)
  expect(rows().every((r) => r.document_id === docId)).toBe(true)
})

async function deleteRegistered(name: string) {
  await page.getByRole('button', { name: name + '.pdf 파일 메뉴', exact: true }).click()
  await page.getByRole('menuitem', { name: '파일 삭제', exact: true }).click()
  await page
    .getByRole('menu', { name: '파일 삭제 확인', exact: true })
    .getByRole('menuitem', { name: '삭제', exact: true })
    .click()
  await expect(page.getByRole('article', { name: name + '.pdf', exact: true })).toHaveCount(0)
}
test('library deletion removes only queued and running translation owners; aborted late work cannot recreate cache and the remaining document finishes', async () => {
  await connect()
  await set({ holdDoc: 'A' })
  await add('A')
  await expect.poll(async () => (await state()).calls.some((c: any) => c.doc === 'A')).toBe(true)
  await add('B')
  await add('C')
  const registered = await page.evaluate(() => window.desktop.librarySnapshot()),
    a = registered.documents.find((d) => d.name === 'A.pdf')!.id,
    c = registered.documents.find((d) => d.name === 'C.pdf')!.id
  await deleteRegistered('C')
  expect((await state()).calls.filter((c: any) => c.doc === 'B')).toHaveLength(0)
  await deleteRegistered('A')
  await app.evaluate(() => (globalThis as any).__activeFake.release?.())
  await expect.poll(() => rows().filter((r) => r.document_id !== a).length).toBe(3)
  expect(rows().some((r) => r.document_id === a || r.document_id === c)).toBe(false)
  expect((await state()).calls.some((c: any) => c.doc === 'C')).toBe(false)
  expect(
    (await page.evaluate(() => window.desktop.librarySnapshot())).documents.map((d) => d.name),
  ).toEqual(['B.pdf'])
  expect(
    (await page.evaluate((id) => window.desktop.deleteLibrary({ kind: 'document', id }), a)).status,
  ).toBe('error')
  expect(new Uint8Array(await readFile(join(profile, 'A.pdf'))).length).toBeGreaterThan(0)
})
test('deleting during translation source preparation cancels the owned renderer lifetime without sending an image or blocking other documents', async () => {
  await connect()
  await set({ holdSourceChannel: 'queue:source' })
  await add('A')
  await expect.poll(async () => (await state()).sourceHeld).toBe(1)
  await deleteRegistered('A')
  await app.evaluate(() => (globalThis as any).__activeFake.releaseSourceReplies())
  await add('B')
  await expect.poll(() => rows().length).toBe(3)
  expect((await state()).calls.some((c: any) => c.doc === 'A')).toBe(false)
  expect((await state()).calls.every((c: any) => c.doc === 'B')).toBe(true)
})
