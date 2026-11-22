import { test, createTestProfile, closeTestApp, launchTestApp } from './helpers'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { THEME_PALETTE } from '../../src/shared/themes'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { checkInlineTitleWidth } from './readerLayout'

let app: ElectronApplication, page: Page, profile: string, errors: number, external: number
async function launch() {
  ;({ app, page } = await launchTestApp(profile, (p) => {
    p.on('pageerror', () => errors++)
    p.on('request', (r) => {
      if (/^https?:/.test(r.url())) external++
    })
  }))
}
test.beforeEach(async () => {
  errors = 0
  external = 0
  profile = await createTestProfile('memos')
  await launch()
})
test.afterEach(async () => {
  await closeTestApp(app, profile)
  expect(errors).toBe(0)
  expect(external).toBe(0)
})
const editor = () => page.getByRole('textbox', { name: '메모 본문', exact: true })
const library = () => page.getByRole('dialog', { name: 'memos', exact: true })
async function memoTab() {
  await page.getByRole('tab', { name: '메모', exact: true }).click()
}
async function list() {
  await page.getByRole('button', { name: /^메모 선택:/ }).click()
  await page.getByRole('menuitem', { name: '별도 메모', exact: true }).click()
  await expect(library()).toBeVisible()
}
async function create(title: string) {
  await library().getByRole('button', { name: '새 메모', exact: true }).click()
  const input = library().getByRole('textbox', { name: '메모 제목', exact: true })
  await input.fill(title)
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await expect(library().getByRole('button', { name: title, exact: true })).toBeVisible()
}
async function open(title: string) {
  await library().getByRole('button', { name: title, exact: true }).click()
  await expect(library()).toHaveCount(0)
  await expect(editor()).toBeVisible()
}
async function write(body: string) {
  await editor().click()
  await editor().press('Meta+A')
  await page.keyboard.insertText(body)
  await expect.poll(() => rows().some((row) => row.body === body)).toBe(true)
  await expect(page.locator('.language-bar').getByRole('status')).toHaveText('저장됨')
  await expect(page.locator('.memo-panel .memo-save-status')).toHaveCount(0)
}
function db() {
  return new DatabaseSync(join(profile, 'translations/translations.sqlite'))
}
function rows() {
  const database = db()
  try {
    return database.prepare('SELECT * FROM memos ORDER BY rowid').all()
  } finally {
    database.close()
  }
}
async function mode(value: '보기 모드' | '수정 모드') {
  await page.getByLabel('메모 메뉴', { exact: true }).click()
  await page
    .locator('.translation-menu-content')
    .getByRole('button', { name: new RegExp('^' + value) })
    .click()
  await expect(page.locator('.memo-editor')).toHaveAttribute(
    'data-mode',
    value === '보기 모드' ? 'preview' : 'source',
  )
}
async function sample() {
  await page.getByRole('button', { name: '샘플 문서로 둘러보기' }).click()
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
}
async function go(n: number) {
  const field = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  await field.fill(String(n))
  await field.press('Enter')
  await expect(
    page.getByRole('button', { name: `메모 선택: ${n}페이지 메모`, exact: true }),
  ).toBeVisible()
}

const exportMenu = () => page.getByRole('menu', { name: '메모 내보내기', exact: true })
async function exportFromSidebar(scope?: '이 페이지만' | '합쳐서') {
  await page.getByLabel('메모 메뉴', { exact: true }).click()
  await expect(page.locator('.translation-menu-content button').first()).toHaveText('메모 내보내기')
  await page.getByRole('button', { name: '메모 내보내기', exact: true }).click()
  if (scope) {
    await expect(exportMenu()).toContainText('합쳐서 내보낼까요?')
    await exportMenu().getByRole('button', { name: scope, exact: true }).click()
  }
  await expect(exportMenu()).toContainText('형식을 선택하세요')
}
async function saveExport(path: string | null, held = false) {
  if (path) await mkdir(dirname(path), { recursive: true })
  await app.evaluate(
    ({ dialog }, { path, held }) => {
      const state = globalThis as any
      state.__memoSaveCount = 0
      dialog.showSaveDialog = async (_owner: unknown, options?: any) => {
        state.__memoSaveCount++
        state.__memoSaveExtension = options.filters[0].extensions[0]
        state.__memoSaveProperties = options.properties
        if (held)
          await new Promise<void>((resolve) => {
            state.__releaseMemoSave = resolve
          })
        return { canceled: !path, filePath: path ?? '' }
      }
    },
    { path, held },
  )
}
async function chooseExport(format: 'MD' | 'PDF') {
  await exportMenu().getByRole('button', { name: format, exact: true }).click()
  await expect(exportMenu()).toHaveCount(0)
}
async function pdfPages(path: string) {
  const task = getDocument({ data: Uint8Array.from(await readFile(path)) })
  const pdf = await task.promise
  try {
    const result: string[] = []
    for (let n = 1; n <= pdf.numPages; n++) {
      const p = await pdf.getPage(n),
        content = await p.getTextContent()
      // Verify exported text stays inside the physical page, including repeated headers.
      for (const item of content.items)
        if ('str' in item && item.str.trim()) {
          expect(item.transform[4]).toBeGreaterThanOrEqual(0)
          expect(item.transform[4] + item.width).toBeLessThan(p.view[2] + 2)
          expect(item.transform[5]).toBeGreaterThanOrEqual(0)
          expect(item.transform[5]).toBeLessThanOrEqual(p.view[3])
        }
      result.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .replace(/\s+/g, ' '),
      )
    }
    return result
  } finally {
    await task.destroy()
  }
}

test('memo export branches, dismissals and Markdown preserve original source, ordered nonempty pages and inactive list ownership', async ({}, info) => {
  await sample()
  await memoTab()
  const raw = '# 원문\n\n한글 **강조** $2^{-1}$ \\Rightarrow\n\n```txt\n$not math$ \\n\n```\n'
  await write(raw)
  await go(3)
  await write('third-page')
  await go(2)
  await write(' \n\t ')
  await go(1)
  await page.getByLabel('메모 메뉴', { exact: true }).click()
  await page.getByRole('button', { name: '메모 내보내기', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(exportMenu()).toHaveCount(0)
  await exportFromSidebar('이 페이지만')
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await expect(exportMenu()).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await page.getByRole('button', { name: '파일 목록 닫기', exact: true }).click()
  const single = info.outputPath('single.md'),
    combined = info.outputPath('combined.md')
  const before = rows()
  await saveExport(single)
  await exportFromSidebar('이 페이지만')
  await chooseExport('MD')
  expect(await readFile(single, 'utf8')).toBe(raw)
  expect(rows()).toEqual(before)
  await saveExport(combined)
  await exportFromSidebar('합쳐서')
  await chooseExport('MD')
  expect(await readFile(combined, 'utf8')).toBe(
    `## 1페이지 메모\n\n${raw}\n\n## 3페이지 메모\n\nthird-page`,
  )
  expect(rows()).toEqual(before)
  await list()
  await create('open-note')
  await create('other-note')
  await open('open-note')
  await write('opened memo unchanged')
  await page.evaluate(async () => {
    const notes = await window.desktop.memoList()
    if (notes.status !== 'ok') throw new Error('fixture unavailable')
    const note = notes.value.find((n) => n.title === 'other-note')!
    await window.desktop.memoSave({ ...note, body: 'inactive memo body' })
  })
  await list()
  await library().getByRole('button', { name: 'other-note 메모 메뉴', exact: true }).click()
  await page.getByRole('menuitem', { name: '메모 내보내기', exact: true }).click()
  await expect(exportMenu()).not.toContainText('합쳐서 내보낼까요?')
  const standalone = info.outputPath('standalone.md')
  await saveExport(standalone)
  await chooseExport('MD')
  expect(await readFile(standalone, 'utf8')).toBe('inactive memo body')
  await expect(library()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(
    page.getByRole('button', { name: '메모 선택: open-note', exact: true }),
  ).toBeVisible()
  await expect(editor()).toContainText('opened memo unchanged')
})

test('memo PDF export repeats original-page headers across long notes, separates pages and prints Korean tables code and safe math locally', async ({}, info) => {
  await sample()
  await memoTab()
  const long =
    '# 한글 내보내기\n\n- 첫 목록\n- 둘째 목록\n\n| 이름 | 값 |\n|---|---|\n| 한글 표 | 128 |\n\n```js\nconst answer = 128;\n```\n\n$4 \\times 128$\n\n$$\n\\frac{1}{2}+\\sqrt{4}\n$$\n\n' +
    Array.from(
      { length: 95 },
      (_, i) => `긴 메모 본문 ${i + 1} - 원문 페이지 표기는 계속 유지됩니다.`,
    ).join('\n\n') +
    '\n\n<script>window.MEMO_EXPORT_UNSAFE=1</script>\n\n![blocked](https://invalid.test/image.png)\n\n[blocked](javascript:alert(1))'
  await write(long)
  await go(2)
  await write(' \n ')
  await go(3)
  await write('# 마지막 원본\n\nTHIRD_SOURCE_CONTENT')
  const combined = info.outputPath('combined.pdf')
  await app.evaluate(({ app }) => {
    app.once('browser-window-created', (_event, output) => {
      const print = output.webContents.printToPDF.bind(output.webContents)
      output.webContents.printToPDF = async (options) => {
        ;(globalThis as any).__memoExportSafety = await output.webContents.executeJavaScript(`({
          unsafe: window.MEMO_EXPORT_UNSAFE === 1,
          images: document.querySelectorAll('img').length,
          links: document.querySelectorAll('a[href]').length,
          controls: document.querySelectorAll('button,input,textarea').length,
          math: document.querySelectorAll('.katex').length,
          accessibleMath: document.querySelectorAll('math').length
        })`)
        return print(options)
      }
    })
  })
  await saveExport(combined)
  await exportFromSidebar('합쳐서')
  await exportMenu().screenshot({ path: info.outputPath('format-popover.png') })
  await chooseExport('PDF')
  const pages = await pdfPages(combined)
  const safety = await app.evaluate(() => (globalThis as any).__memoExportSafety)
  expect(safety).toMatchObject({ unsafe: false, images: 0, links: 0, controls: 0 })
  expect(safety.math).toBeGreaterThan(0)
  expect(safety.accessibleMath).toBeGreaterThan(0)
  expect(pages.length).toBeGreaterThan(3)
  expect(pages.at(-1)).toContain('3페이지 메모')
  expect(pages.at(-1)).toContain('THIRD_SOURCE_CONTENT')
  for (const text of pages.slice(0, -1)) {
    expect(text).toContain('1페이지 메모')
    expect(text).not.toContain('3페이지 메모')
  }
  expect(pages.join(' ')).toContain('긴 메모 본문 95')
  expect(pages.join(' ')).toContain('한글 표')
  expect(pages.join(' ')).toContain('const answer = 128;')
  expect(pages.join(' ')).not.toContain('2페이지 메모')
  expect(pages.join(' ')).not.toContain('메모 내보내기')
  const single = info.outputPath('single.pdf')
  await saveExport(single)
  await exportFromSidebar('이 페이지만')
  await chooseExport('PDF')
  expect(await pdfPages(single)).toHaveLength(1)
  await list()
  await create('독립 출력')
  await open('독립 출력')
  await write('# 별도 메모\n\n독립 본문 $2^{-1}$')
  const standalone = info.outputPath('standalone.pdf')
  await saveExport(standalone)
  await exportFromSidebar()
  await chooseExport('PDF')
  const separate = await pdfPages(standalone)
  expect(separate.join(' ')).toContain('독립 본문')
  expect(separate.join(' ')).not.toContain('페이지 메모')
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
})

test('memo export includes failed-save drafts, freezes pending targets, blocks duplicate dialogs and handles empty, canceled and failed output without memo writes', async ({}, info) => {
  await sample()
  await memoTab()
  await expect(editor()).toBeVisible()
  await saveExport(info.outputPath('empty.md'))
  await exportFromSidebar('합쳐서')
  await exportMenu().getByRole('button', { name: 'MD', exact: true }).click()
  await expect(exportMenu().getByRole('alert')).toContainText('내용이 없어요')
  expect(await app.evaluate(() => (globalThis as any).__memoSaveCount)).toBe(0)
  await page.keyboard.press('Escape')
  await write('stored body')
  const database = db()
  try {
    database.exec(
      "CREATE TRIGGER export_save_fail BEFORE UPDATE ON memos BEGIN SELECT RAISE(FAIL,'fixture'); END",
    )
    await editor().click()
    await editor().press('Meta+A')
    await page.keyboard.insertText('latest unsaved body')
    await expect(page.getByRole('button', { name: '다시 저장', exact: true })).toBeVisible()
    const before = rows(),
      path = info.outputPath('frozen.md')
    await saveExport(path, true)
    await exportFromSidebar('이 페이지만')
    const bounds = (await exportMenu()
      .getByRole('button', { name: 'MD', exact: true })
      .boundingBox())!
    await page.mouse.click(bounds.x + 5, bounds.y + 5)
    await page.mouse.click(bounds.x + 5, bounds.y + 5)
    await expect.poll(() => app.evaluate(() => (globalThis as any).__memoSaveCount)).toBe(1)
    await go(2)
    await app.evaluate(() => (globalThis as any).__releaseMemoSave())
    await expect.poll(() => readFile(path, 'utf8').catch(() => '')).toBe('latest unsaved body')
    expect(rows().find((r) => r.page === 1)).toEqual(before.find((r) => r.page === 1))
    database.exec('DROP TRIGGER export_save_fail')
    await write('second page body')
    await saveExport(null)
    await exportFromSidebar('이 페이지만')
    await chooseExport('MD')
    const wrong = info.outputPath('wrong.pdf')
    await saveExport(wrong)
    await exportFromSidebar('이 페이지만')
    await exportMenu().getByRole('button', { name: 'MD', exact: true }).click()
    await expect(exportMenu().getByRole('alert')).toContainText('.md 확장자')
    await expect(readFile(wrong)).rejects.toMatchObject({ code: 'ENOENT' })
    await page.keyboard.press('Escape')
    const failed = info.outputPath('missing-parent', 'failed.md')
    await saveExport(null)
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path })
    }, failed)
    await exportFromSidebar('이 페이지만')
    await exportMenu().getByRole('button', { name: 'MD', exact: true }).click()
    await expect(exportMenu().getByRole('alert')).toContainText('내보내지 못했어요')
    await page.keyboard.press('Escape')
    const failedPdf = info.outputPath('failed.pdf')
    await saveExport(failedPdf)
    await writeFile(failedPdf, 'existing output remains intact')
    await app.evaluate(({ app }) => {
      app.once('browser-window-created', (_event, output) => {
        output.webContents.printToPDF = async () => {
          throw new Error('fake generation failure')
        }
      })
    })
    await exportFromSidebar('이 페이지만')
    await exportMenu().getByRole('button', { name: 'PDF', exact: true }).click()
    await expect(exportMenu().getByRole('alert')).toContainText('내보내지 못했어요')
    expect(await readFile(failedPdf, 'utf8')).toBe('existing output remains intact')
    expect(await app.evaluate(() => (globalThis as any).__memoSaveProperties)).toContain(
      'showOverwriteConfirmation',
    )
    await page.keyboard.press('Escape')
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(
      (await readdir(dirname(info.outputPath('frozen.md')))).some((name) =>
        name.startsWith('.translave-'),
      ),
    ).toBe(false)
  } finally {
    database.close()
  }
})

for (const kind of ['page', 'standalone'] as const)
  test(`memo selector hover stays unobscured above the body fade and preserves dropdown navigation for ${kind} memos`, async ({}, info) => {
    await sample()
    await memoTab()
    if (kind === 'standalone') {
      await list()
      await create('hover memo')
      await open('hover memo')
    }
    await write(Array.from({ length: 60 }, (_, n) => `Memo line ${n + 1}`).join('\n\n'))
    const selector = page.getByRole('button', { name: /^메모 선택:/ })
    const title = await selector.getAttribute('aria-label')
    const box = await selector.boundingBox()
    const radius = await selector.evaluate((node) =>
      parseFloat(getComputedStyle(node).borderRadius),
    )
    const fade = () =>
      page.locator('.language-bar').evaluate((node) => {
        const color = getComputedStyle(node, '::after'),
          blur = getComputedStyle(node, '::before')
        return {
          height: color.height,
          top: color.top,
          color: color.backgroundColor,
          mask: color.maskImage,
          blur: blur.backdropFilter,
          blurMask: blur.maskImage,
        }
      })
    const originalFade = await fade()
    expect(originalFade.height).toBe('22px')
    expect(originalFade.blur).toBe('blur(6px)')
    expect(originalFade.mask).toContain('0.98')
    const scroller = page.locator('.memo-editor .cm-scroller')
    await scroller.hover()
    await page.mouse.wheel(0, 900)
    await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await selector.hover()
    const actual = await selector.screenshot({
      path: info.outputPath('hover-button.png'),
      scale: 'css',
    })
    await page.locator('.translation-panel').screenshot({ path: info.outputPath('memo-hover.png') })
    // A fixed button should paint identically with or without the body-only overlay.
    const referenceStyle = await page.addStyleTag({
      content:
        '.language-bar:has(.memo-selector)::before, .language-bar:has(.memo-selector)::after { visibility: hidden !important; }',
    })
    const reference = await selector.screenshot({
      path: info.outputPath('reference-button.png'),
      scale: 'css',
    })
    await referenceStyle.evaluate((node) => node.parentNode?.removeChild(node))
    const changed = await app.evaluate(
      ({ nativeImage }, { shots, radius }) => {
        const images = shots.map((bytes) => nativeImage.createFromBuffer(Buffer.from(bytes)))
        const [actual, reference] = images.map((image) => image.toBitmap())
        if (actual.length !== reference.length) return -1
        const { width, height } = images[0].getSize()
        let changed = 0
        // Fractional screenshot clipping plus the antialiased contour occupies up to 2px.
        for (let y = 2; y < height - 2; y++)
          for (let x = 2; x < width - 2; x++) {
            // Outside/antialiased round edges legitimately reveal the body overlay.
            const dx = Math.max(radius - (x + 0.5), x + 0.5 - (width - radius), 0)
            const dy = Math.max(radius - (y + 0.5), y + 0.5 - (height - radius), 0)
            if ((dx || dy) && dx * dx + dy * dy >= (radius - 1) ** 2) continue
            const offset = (y * width + x) * 4
            for (let channel = 0; channel < 4; channel++)
              if (actual[offset + channel] !== reference[offset + channel]) changed++
          }
        return changed
      },
      { shots: [Array.from(actual), Array.from(reference)], radius },
    )
    expect(
      changed,
      'hover background, corners, text and arrow must not be covered by the body fade',
    ).toBe(0)
    expect(await selector.boundingBox()).toEqual(box)
    expect(await fade()).toEqual(originalFade)
    await selector.click()
    const menu = page.getByRole('menu', { name: '메모 종류', exact: true })
    await expect(menu).toBeVisible()
    await selector.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: '페이지별 메모', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await selector.click()
    await menu.getByRole('menuitem', { name: '별도 메모', exact: true }).click()
    await expect(library()).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(library()).toHaveCount(0)
    await expect(selector).toHaveAttribute('aria-label', title!)
    await page.keyboard.press('Tab')
    await expect(page.getByRole('tab', { name: '번역', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

for (const editingMode of ['보기 모드', '수정 모드'] as const)
  test(`Control main commands preserve ${editingMode} content, selection, autosave and memo menu/dialog exceptions`, async () => {
    await sample()
    await memoTab()
    await list()
    await create('shortcut memo')
    await open('shortcut memo')
    const id = rows().find((row) => row.title === 'shortcut memo')!.id
    const body = () => rows().find((row) => row.id === id)?.body
    await mode(editingMode)
    await write('memo draft')
    await editor().press('Shift+ArrowLeft')
    const selection = await page.evaluate(() => window.getSelection()?.toString())
    for (const [key, title] of [
      ['Control+f', 'files'],
      ['Control+s', 'settings'],
    ]) {
      await page.keyboard.press(key)
      await expect(page.getByRole('dialog', { name: title, exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByRole('dialog', { name: title, exact: true })).not.toBeVisible()
      // The files dialog unmounts on close; resume editing without changing its selection.
      await editor().focus()
      await expect(editor()).toBeFocused()
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selection)
      expect(body()).toBe('memo draft')
    }
    await page.getByRole('button', { name: /^메모 선택:/ }).click()
    await expect(page.getByRole('menu', { name: '메모 종류', exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^메모 선택:/ }).press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: '페이지별 메모', exact: true })).toBeFocused()
    for (const key of ['Control+f', 'Control+s', 'Control+w']) await page.keyboard.press(key)
    await expect(page.getByRole('menu', { name: '메모 종류', exact: true })).toBeVisible()
    await expect(page.locator('.document-tab')).toHaveCount(1)
    await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
    await expect(page.getByRole('dialog', { name: 'settings', exact: true })).not.toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu', { name: '메모 종류', exact: true })).toHaveCount(0)
    await list()
    for (const key of ['Control+f', 'Control+s', 'Control+w']) await page.keyboard.press(key)
    await expect(library()).toBeVisible()
    await expect(page.locator('.document-tab')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(library()).toHaveCount(0)
    await editor().click()
    await editor().press('Meta+A')
    await page.keyboard.insertText('pending memo survives closing PDF')
    await page.keyboard.press('Control+w')
    await expect(page.locator('.document-tab')).toHaveCount(0)
    await expect(editor()).toContainText('pending memo survives closing PDF')
    await expect.poll(body).toBe('pending memo survives closing PDF')
    await expect(page.getByRole('status').filter({ hasText: /^저장됨$/ })).toBeVisible()
    await app.close()
    await launch()
    await memoTab()
    await expect(editor()).toContainText('pending memo survives closing PDF')
    await expect(page.locator('.document-tab')).toHaveCount(0)
  })

test('standalone memos work without a PDF, retain Markdown through live/source editing and restore selection/body after restart', async ({}, info) => {
  await memoTab()
  await list()
  await create('공통으로 쓰는 아주 긴 메모 제목')
  await open('공통으로 쓰는 아주 긴 메모 제목')
  const body =
    '# 제목\n\n**강조** 와 *기울임*\n\n- 목록\n\n> 인용\n\n[링크](https://invalid.test)\n\n```js\nconst x = 1\n```\n\n| A | B |\n|---|---|\n|1|2|\n\n$4 \\times 128$\n\n$$\n\\frac{1}{2}\n$$'
  await write(body)
  await page.locator('.language-bar').click()
  await expect(page.locator('.memo-heading-1')).toHaveText('제목')
  await expect(page.locator('.memo-strong')).toHaveText('강조')
  await expect(page.locator('.memo-rendered table')).toHaveCount(1)
  await expect(page.locator('.memo-rendered .katex')).toHaveCount(2)
  expect(rows()[0].body).toBe(body)
  const selector = page.getByRole('button', { name: /^메모 선택:/ })
  await expect(selector).toHaveAttribute('title', '공통으로 쓰는 아주 긴 메모 제목')
  await expect(selector).toContainText('…')
  await mode('수정 모드')
  await expect(editor()).toContainText('# 제목')
  await expect(editor()).toContainText('**강조**')
  await mode('보기 모드')
  expect(rows()[0].body).toBe(body)
  await page.screenshot({ path: info.outputPath('memo-live-preview.png') })
  await app.close()
  await launch()
  await memoTab()
  await expect(editor()).toBeVisible()
  expect(rows()[0].body).toBe(body)
  await expect(page.getByRole('button', { name: /^메모 선택:/ })).toHaveAttribute(
    'title',
    '공통으로 쓰는 아주 긴 메모 제목',
  )
  expect(
    await app.evaluate(() => ({
      translation: (globalThis as any).__activeFake.calls.length,
      chat: (globalThis as any).__activeFake.chatCalls.length,
    })),
  ).toEqual({ translation: 0, chat: 0 })
})

test('page memo owners follow pages and duplicate document tabs, while standalone selection stays fixed through PDF navigation', async () => {
  await sample()
  await memoTab()
  await expect(editor()).toBeVisible()
  await write('page-one')
  const pageOne = rows()[0]
  await go(2)
  await expect(editor()).toBeVisible()
  await write('page-two')
  await go(1)
  await expect(editor()).toContainText('page-one')
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page
    .getByRole('article', { name: 'reading-notes.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await memoTab()
  await go(1)
  await expect(editor()).toContainText('page-one')
  expect(rows().filter((r) => r.document_id === pageOne.document_id && r.page === 1)).toHaveLength(
    1,
  )
  await list()
  await create('global')
  await open('global')
  await write('shared-global')
  await page.getByRole('textbox', { name: '현재 페이지', exact: true }).fill('3')
  await page.getByRole('textbox', { name: '현재 페이지', exact: true }).press('Enter')
  await expect(editor()).toContainText('shared-global')
  await page.locator('.document-tab').first().getByRole('tab').click()
  await expect(editor()).toContainText('shared-global')
  await list()
  await page.getByRole('button', { name: '메모 목록 닫기' }).click()
  await expect(editor()).toContainText('shared-global')
  await page.getByRole('button', { name: /^메모 선택:/ }).click()
  await page.getByRole('menuitem', { name: '페이지별 메모', exact: true }).click()
  await go(1)
  await expect(editor()).toContainText('page-one')
})

test('memo list edits titles inline with IME, sorts deterministically and consumes dismissal clicks before opening a row', async ({}, info) => {
  await memoTab()
  await list()
  const hint = library()
    .locator('.library-toolbar')
    .getByText('+ 버튼으로 메모를 만들어 보세요.', { exact: true })
  await expect(hint).toBeVisible()
  await library().screenshot({ path: info.outputPath('memos-empty-toolbar.png') })
  await library().getByRole('button', { name: '새 메모' }).click()
  await expect(hint).toHaveCount(0)
  const input = library().getByRole('textbox', { name: '메모 제목' })
  await checkInlineTitleWidth(page, input)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await checkInlineTitleWidth(page, input)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  )
  await input.press('Enter')
  await expect(library().getByRole('alert')).toContainText('제목')
  await input.fill('한글 제목')
  await input.dispatchEvent('compositionstart')
  await input.press('Enter')
  await expect(input).toBeVisible()
  await input.dispatchEvent('compositionend')
  await input.press('Enter')
  await expect(input).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveCount(0)
  await library().locator('.dialog-header').click()
  expect(rows()).toHaveLength(1)
  await create('note10')
  await create('note2')
  await expect(hint).toHaveCount(0)
  await library()
    .getByRole('button', { name: /^메모 정렬:/ })
    .click()
  await page
    .getByRole('menu', { name: '메모 목록 메뉴', exact: true })
    .screenshot({ path: info.outputPath('memos-sort-menu.png') })
  await page.getByRole('menuitemradio', { name: /이름순/ }).click()
  await expect(library().locator('.memo-row-open')).toHaveText(['note2', 'note10', '한글 제목'])
  await library().getByRole('button', { name: 'note2 메모 메뉴' }).click()
  await library().getByRole('button', { name: 'note10', exact: true }).click()
  await expect(library()).toBeVisible()
  await expect(page.getByRole('menu', { name: '메모 목록 메뉴' })).toHaveCount(0)
  await library().getByRole('button', { name: 'note2 메모 메뉴' }).click()
  await page.getByRole('menuitem', { name: '메모 제목 변경' }).click()
  await checkInlineTitleWidth(page, input)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await checkInlineTitleWidth(page, input)
  await input.fill('renamed')
  await library().locator('.dialog-header').click()
  await expect(input).toHaveCount(0)
  await expect(library().getByRole('button', { name: 'renamed', exact: true })).toBeVisible()
  await library().getByRole('button', { name: 'renamed 메모 메뉴' }).click()
  await page.getByRole('menuitem', { name: '메모 삭제', exact: true }).click()
  const confirm = page.getByRole('menu', { name: '메모 삭제 확인' })
  await expect(confirm).toContainText('메모를 삭제하시겠습니까?')
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await library().getByRole('button', { name: 'renamed 메모 메뉴' }).click()
  await page.getByRole('menuitem', { name: '메모 삭제', exact: true }).click()
  await page.getByRole('menuitem', { name: '취소', exact: true }).click()
  await library().getByRole('button', { name: 'renamed 메모 메뉴' }).click()
  await page.getByRole('menuitem', { name: '메모 삭제', exact: true }).click()
  await expect(confirm).toContainText('메모를 삭제하시겠습니까?')
  await page.screenshot({ path: info.outputPath('memos-list-confirm.png') })
  await page.getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(library().getByRole('button', { name: 'renamed', exact: true })).toHaveCount(0)
  expect(rows()).toHaveLength(2)
  await open('note10')
  await write('body-to-delete')
  await list()
  await library().getByRole('button', { name: 'note10 메모 메뉴' }).click()
  await page.getByRole('menuitem', { name: '메모 삭제', exact: true }).click()
  await page.getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(library().getByRole('button', { name: 'note10', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '메모 목록 닫기' }).click()
  await expect(editor()).toHaveCount(0)
  await expect(page.getByRole('tabpanel')).not.toContainText('body-to-delete')
})

test('failed body/title/delete writes preserve drafts and records through switching, then save explicitly and restore after restart', async () => {
  await memoTab()
  await list()
  await create('A')
  await create('B')
  await open('A')
  await write('saved-A')
  const database = db()
  try {
    database.exec(
      "CREATE TRIGGER memo_fail BEFORE UPDATE ON memos BEGIN SELECT RAISE(FAIL,'PRIVATE_MEMO_DIAGNOSTIC'); END",
    )
    await editor().click()
    await editor().press('Meta+A')
    await page.keyboard.insertText('unsaved-A')
    await expect(page.getByRole('button', { name: '다시 저장' })).toBeVisible()
    await expect(page.locator('.language-bar').getByRole('status')).toHaveText(
      '저장하지 못한 초안을 유지하고 있어요.',
    )
    expect(rows().find((r) => r.title === 'A')!.body).toBe('saved-A')
    await list()
    await open('B')
    await list()
    await open('A')
    await expect(editor()).toContainText('unsaved-A')
    database.exec('DROP TRIGGER memo_fail')
    await page.getByRole('button', { name: '다시 저장' }).click()
    await expect(page.getByRole('status').filter({ hasText: /^저장됨$/ })).toBeVisible()
    expect(rows().find((r) => r.title === 'A')!.body).toBe('unsaved-A')
    await list()
    database.exec(
      "CREATE TRIGGER memo_title_fail BEFORE UPDATE ON memos BEGIN SELECT RAISE(FAIL,'PRIVATE_TITLE_DIAGNOSTIC'); END; CREATE TRIGGER memo_delete_fail BEFORE DELETE ON memos BEGIN SELECT RAISE(FAIL,'PRIVATE_DELETE_DIAGNOSTIC'); END",
    )
    await library().getByRole('button', { name: 'A 메모 메뉴' }).click()
    await page.getByRole('menuitem', { name: '메모 제목 변경' }).click()
    const input = library().getByRole('textbox', { name: '메모 제목' })
    await input.fill('failed-title')
    await input.press('Enter')
    await expect(library().getByRole('alert')).toContainText('메모')
    await expect(input).toHaveValue('failed-title')
    expect(rows().find((r) => r.title === 'A')).toBeTruthy()
    await input.press('Escape')
    await library().getByRole('button', { name: 'A 메모 메뉴' }).click()
    await page.getByRole('menuitem', { name: '메모 삭제' }).click()
    await page.getByRole('menuitem', { name: '삭제', exact: true }).click()
    await expect(
      page.getByRole('menu', { name: '메모 삭제 확인' }).getByRole('alert'),
    ).toContainText('메모')
    expect(rows()).toHaveLength(2)
    database.exec('DROP TRIGGER memo_title_fail; DROP TRIGGER memo_delete_fail')
  } finally {
    database.close()
  }
  await app.close()
  await launch()
  await memoTab()
  await expect(editor()).toContainText('unsaved-A')
})

test('live editor preserves caret/selection/IME and sidebar shortcuts, and safely renders narrow themed Markdown without external requests', async ({}, info) => {
  await sample()
  await memoTab()
  await expect(editor()).toBeVisible()
  const body =
    '# Safe\n\n**bold** $2^{-1}$\n\n<script>window.MEMO_UNSAFE=1</script>\n\n![x](https://invalid.test/image.png)\n\n[bad](javascript:alert(1))\n\n| A | B |\n|---|---|\n|1|2|'
  await write(body)
  await editor().press('End')
  await page.keyboard.insertText('\n한글')
  await editor().press('ArrowLeft')
  await page.keyboard.insertText('중')
  await expect.poll(() => String(rows()[0].body)).toContain('한중글')
  await editor().dispatchEvent('compositionstart')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: '메모', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await editor().dispatchEvent('compositionend')
  await editor().click()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('tab', { name: '채팅', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Tab')
  await expect(editor()).toBeVisible()
  await page.locator('.language-bar').click()
  await expect(
    page.locator('.memo-panel script,.memo-panel img:not(.cm-widgetBuffer),.memo-panel a[href]'),
  ).toHaveCount(0)
  expect(
    await page
      .locator('.memo-panel img.cm-widgetBuffer')
      .evaluateAll((nodes) =>
        nodes.every((n) => !n.getAttribute('src') && n.getAttribute('aria-hidden') === 'true'),
      ),
  ).toBe(true)
  expect(await page.evaluate(() => (window as any).MEMO_UNSAFE)).toBeUndefined()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  for (const theme of THEME_PALETTE) {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    await page.getByRole('button', { name: '테마 선택', exact: true }).click()
    await page.getByRole('button', { name: `${theme.name} 테마`, exact: true }).click()
    await page.getByRole('button', { name: '테마 적용', exact: true }).click()
    await page.getByRole('button', { name: '설정 닫기' }).click()
    await expect(editor()).toBeInViewport()
    await page.screenshot({ path: info.outputPath(`${theme.id}-memo.png`) })
  }
  expect(rows()[0].body).toContain('한중글')
})

test('delayed real save replies stay with their page or standalone owner through rapid switches and restart', async () => {
  await sample()
  await memoTab()
  await expect(editor()).toBeVisible()
  await app.evaluate(() => {
    ;(globalThis as any).__activeFake.holdMemoReplies = true
  })
  await editor().click()
  await page.keyboard.insertText('page-one-older')
  await expect.poll(() => app.evaluate(() => (globalThis as any).__activeFake.memoHeld)).toBe(1)
  await expect(page.locator('.language-bar').getByRole('status')).toHaveText('저장 중…')
  await go(2)
  await expect(editor()).toBeVisible()
  await editor().click()
  await page.keyboard.insertText('page-two-only')
  await expect.poll(() => app.evaluate(() => (globalThis as any).__activeFake.memoHeld)).toBe(2)
  await go(1)
  await expect(editor()).toContainText('page-one-older')
  await editor().click()
  await editor().press('Meta+A')
  await page.keyboard.insertText('page-one-newest')
  await list()
  await create('global-delayed')
  await open('global-delayed')
  await editor().click()
  await page.keyboard.insertText('global-only')
  await expect.poll(() => app.evaluate(() => (globalThis as any).__activeFake.memoHeld)).toBe(3)
  const currentPage = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  await currentPage.click()
  await app.evaluate(() => (globalThis as any).__activeFake.releaseMemoReplies())
  await expect.poll(() => rows().find((row) => row.page === 1)?.body).toBe('page-one-newest')
  expect(rows().find((row) => row.page === 2)?.body).toBe('page-two-only')
  await expect(editor()).toContainText('global-only')
  await expect(currentPage).toBeFocused()
  await app.close()
  await launch()
  await memoTab()
  await expect(editor()).toContainText('global-only')
  await page.getByRole('button', { name: /^메모 선택:/ }).click()
  await page.getByRole('menuitem', { name: '페이지별 메모', exact: true }).click()
  await go(1)
  await expect(editor()).toContainText('page-one-newest')
})

for (const editorMode of ['보기 모드', '수정 모드'] as const)
  test(`memo entry restores owner-specific selection, scroll and history without reverting newer content in ${editorMode}`, async () => {
    await memoTab()
    await list()
    await create('first editor owner')
    await create('second editor owner')
    await open('first editor owner')
    await mode(editorMode)
    await memoTab()
    await expect(editor()).toBeFocused()
    const body = Array.from(
      { length: 140 },
      (_, n) => `line-${String(n).padStart(4, '0')} body`,
    ).join('\n')
    await page.keyboard.insertText(body)
    await expect.poll(() => rows().find((r) => r.title === 'first editor owner')?.body).toBe(body)
    await editor().press('Meta+A')
    await editor().press('ArrowRight')
    for (let n = 0; n < 30; n++) await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Meta+ArrowLeft')
    for (let n = 0; n < 9; n++) await page.keyboard.press('Shift+ArrowRight')
    const selected = await page.evaluate(() => window.getSelection()!.toString())
    expect(selected).toMatch(/^line-\d{4}$/)
    const scroller = page.locator('.memo-editor .cm-scroller')
    const scroll = await scroller.evaluate((n) => n.scrollTop)
    expect(scroll).toBeGreaterThan(0)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(editor()).toBeFocused()
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
    await expect.poll(() => scroller.evaluate((n) => n.scrollTop)).toBeCloseTo(scroll, 0)
    await page.keyboard.insertText('RESTORED')
    const edited = body.replace(selected, 'RESTORED')
    await expect.poll(() => rows().find((r) => r.title === 'first editor owner')?.body).toBe(edited)
    await page.keyboard.press('Meta+z')
    await expect.poll(() => rows().find((r) => r.title === 'first editor owner')?.body).toBe(body)
    await list()
    await open('second editor owner')
    await expect(editor()).toBeFocused()
    await page.keyboard.insertText('second memo')
    await list()
    await open('first editor owner')
    await expect(editor()).toBeFocused()
    await page.keyboard.press('Meta+Shift+z')
    await expect.poll(() => rows().find((r) => r.title === 'first editor owner')?.body).toBe(edited)
    expect(rows().find((r) => r.title === 'second editor owner')?.body).toBe('second memo')
    await editor().press('Meta+A')
    await editor().press('ArrowRight')
    await page.keyboard.press('Tab')
    const id = String(rows().find((r) => r.title === 'first editor owner')!.id)
    await page.evaluate(
      async ({ id, revision }) => {
        const result = await window.desktop.memoSave({ id, revision, body: 'new' })
        if (result.status !== 'ok') throw new Error('fixture update failed')
      },
      { id, revision: Number(rows().find((r) => r.id === id)!.revision) },
    )
    await page.keyboard.press('Shift+Tab')
    await expect(editor()).toBeFocused()
    await expect(editor()).toHaveText('new')
    await page.keyboard.insertText(' tail')
    await expect.poll(() => rows().find((r) => r.id === id)?.body).toBe('new tail')
  })

test('delayed memo entry cannot take focus from an open menu or settings dialog', async () => {
  await memoTab()
  await list()
  await create('menu delayed owner')
  await create('dialog delayed owner')
  const fixtures = await page.evaluate(
    async (ids) => {
      return Promise.all(ids.map((id) => window.desktop.memoLoad({ kind: 'standalone', id })))
    },
    rows().map((r) => String(r.id)),
  )
  await app.evaluate(({ ipcMain }, fixtures) => {
    ipcMain.removeHandler('memos:load')
    ipcMain.handle(
      'memos:load',
      (_event, target) =>
        new Promise((resolve) => {
          ;(globalThis as any).__releaseMemoLoad = () =>
            resolve(fixtures.find((r) => r.status === 'ok' && r.value.id === target.id))
        }),
    )
  }, fixtures)
  for (const overlay of ['menu', 'dialog']) {
    await app.evaluate(() => {
      delete (globalThis as any).__releaseMemoLoad
    })
    await library()
      .getByRole('button', { name: `${overlay} delayed owner`, exact: true })
      .click()
    await expect(editor()).toHaveCount(0)
    await expect
      .poll(() => app.evaluate(() => typeof (globalThis as any).__releaseMemoLoad))
      .toBe('function')
    if (overlay === 'menu') {
      await page.getByLabel('메모 메뉴', { exact: true }).click()
      await page.keyboard.press('Tab')
    } else await page.getByRole('button', { name: '설정', exact: true }).click()
    const focused = await page.evaluateHandle(() => document.activeElement!)
    await app.evaluate(() => (globalThis as any).__releaseMemoLoad())
    await expect(editor()).toBeVisible()
    await expect(editor()).not.toBeFocused()
    expect(await focused.evaluate((node) => document.activeElement === node)).toBe(true)
    await focused.dispose()
    await page.keyboard.press('Escape')
    await memoTab()
    await expect(editor()).toBeFocused()
    if (overlay === 'menu') await list()
  }
})

test('page memo reentry restores the matching editor across duplicate PDF tabs while menus and dialogs keep focus', async () => {
  await sample()
  await memoTab()
  await expect(editor()).toBeFocused()
  await page.keyboard.insertText('page one tail')
  await page.keyboard.press('Shift+ArrowLeft')
  await page.keyboard.press('Shift+ArrowLeft')
  const selected = await page.evaluate(() => window.getSelection()?.toString())
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await page.getByRole('button', { name: 'reading-notes.pdf 열기', exact: true }).click()
  await expect(editor()).toBeFocused()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected)
  await go(2)
  await memoTab()
  await expect(editor()).toBeFocused()
  await page.keyboard.insertText('page two')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(editor()).toBeFocused()
  await page.keyboard.insertText('IL')
  await expect.poll(() => rows().find((r) => r.page === 1)?.body).toBe('page one taIL')
  expect(rows().find((r) => r.page === 2)?.body).toBe('page two')
  await page.getByLabel('메모 메뉴', { exact: true }).click()
  await page.keyboard.press('Tab')
  await expect(page.locator('.translation-menu-content button').first()).toBeFocused()
  await expect(editor()).not.toBeFocused()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'settings', exact: true })).toBeVisible()
  await expect(editor()).not.toBeFocused()
  await page.keyboard.press('Escape')
  await list()
  await create('dialog focus')
  await expect(library()).toBeVisible()
  await expect(editor()).not.toBeFocused()
})

for (const editorMode of ['보기 모드', '수정 모드'] as const)
  test(`Option Tab edits indentation with caret, multi-line selection, list nesting, history and autosave in ${editorMode}`, async () => {
    await memoTab()
    await list()
    await create('indent fixture')
    await open('indent fixture')
    await mode(editorMode)
    const body = 'alpha\nbeta\n- item\n- next'
    await write(body)
    const saved = async (expected: string) => {
      await expect.poll(() => String(rows()[0].body)).toBe(expected)
      await expect(editor()).toBeFocused()
      await expect(page.getByRole('tab', { name: '메모', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      )
    }
    await editor().press('Meta+A')
    await editor().press('ArrowLeft')
    await page.keyboard.press('Alt+Tab')
    await saved('  ' + body)
    await page.keyboard.press('Meta+z')
    await saved(body)
    await page.keyboard.press('Meta+Shift+z')
    await saved('  ' + body)
    await page.keyboard.press('Alt+Shift+Tab')
    await saved(body)
    await editor().press('Meta+A')
    const indented = body
      .split('\n')
      .map((line) => '  ' + line)
      .join('\n')
    await page.keyboard.press('Alt+Tab')
    await saved(indented)
    await page.keyboard.press('Meta+z')
    await saved(body)
    await page.keyboard.press('Meta+Shift+z')
    await saved(indented)
    await page.keyboard.press('Alt+Shift+Tab')
    await saved(body)
    await editor().press('Meta+A')
    await editor().press('ArrowRight')
    await page.keyboard.press('Alt+Tab')
    await saved('alpha\nbeta\n- item\n  - next')
    await page.keyboard.press('Alt+Shift+Tab')
    await saved(body)
    await app.close()
    await launch()
    await memoTab()
    await expect(editor()).toBeVisible()
    expect(rows()[0].body).toBe(body)
  })

test('Option Tab belongs only to the focused memo body and preserves IME, input/menu/dialog exceptions and sidebar/document Tab shortcuts', async () => {
  await sample()
  await memoTab()
  await expect(editor()).toBeVisible()
  await write('memo draft')
  const original = String(rows()[0].body)
  await editor().dispatchEvent('compositionstart')
  await page.keyboard.press('Alt+Tab')
  expect(rows()[0].body).toBe(original)
  await expect(page.getByRole('tab', { name: '메모', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await editor().dispatchEvent('compositionend')
  await editor().click()
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByRole('tab', { name: '채팅', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  const question = page.getByRole('textbox', { name: '질문', exact: true })
  await question.fill('kept chat draft')
  await question.press('Alt+Tab')
  await question.click()
  await question.press('Alt+Shift+Tab')
  await expect(question).toHaveValue('kept chat draft')
  expect(rows()[0].body).toBe(original)
  await question.click()
  await page.keyboard.press('Tab')
  await expect(editor()).toBeVisible()
  const current = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  await current.click()
  const pageBefore = await current.inputValue()
  await current.press('Alt+Tab')
  await expect(current).toHaveValue(pageBefore)
  await page.getByLabel('메모 메뉴', { exact: true }).click()
  await page.keyboard.press('Alt+Tab')
  expect(rows()[0].body).toBe(original)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.keyboard.press('Alt+Tab')
  await expect(page.getByRole('dialog', { name: 'settings', exact: true })).toBeVisible()
  expect(rows()[0].body).toBe(original)
  await page.getByRole('button', { name: '설정 닫기', exact: true }).click()
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await page.keyboard.press('Alt+Tab')
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toBeVisible()
  expect(rows()[0].body).toBe(original)
  await page.getByRole('button', { name: 'reading-notes.pdf 열기', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
  await expect(page.locator('.document-tab')).toHaveCount(2)
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  const active = () => page.locator('.document-tab[data-active="true"]').getAttribute('data-tab-id')
  const before = await active()
  await editor().click()
  await page.keyboard.press('Control+Tab')
  await expect.poll(active).not.toBe(before)
  await page.keyboard.press('Control+Shift+Tab')
  await expect.poll(active).toBe(before)
  expect(rows()[0].body).toBe(original)
  await editor().click()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('tab', { name: '번역', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Shift+Tab')
  await expect(editor()).toBeVisible()
  await list()
  await library().getByRole('button', { name: '새 메모', exact: true }).click()
  const title = library().getByRole('textbox', { name: '메모 제목', exact: true })
  await title.fill('title fixture')
  await title.press('Alt+Tab')
  // Native focus traversal commits this inline title on blur, without editing it.
  await expect(library().getByRole('button', { name: 'title fixture', exact: true })).toBeVisible()
  expect(rows().find((row) => row.document_id !== null)?.body).toBe(original)
})
