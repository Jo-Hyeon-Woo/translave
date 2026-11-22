import { test, createTestProfile, closeTestApp, launchTestApp, connectFakeChatGPT } from './helpers'
import { prepareReaderLayout, dragPanel, checkInlineTitleWidth } from './readerLayout'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import type { OpenDialogOptions } from 'electron'
import { copyFile, readFile, writeFile, mkdir, rm, readdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { basename, join, resolve } from 'node:path'
import { THEME_PALETTE } from '../../src/shared/themes'

let app: ElectronApplication
let page: Page
let profile: string
let errors: string[]
let remoteRequests: string[]

test.beforeEach(async () => {
  errors = []
  remoteRequests = []
  profile = await createTestProfile('reader')
  await launchApp()
})

async function launchApp() {
  ;({ app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) remoteRequests.push(request.url())
    })
  }))
}

test.afterEach(async () => {
  await closeTestApp(app, profile)
  expect(errors).toEqual([])
  expect(remoteRequests).toEqual([])
})

async function sample() {
  await page.getByRole('button', { name: '샘플 문서로 둘러보기' }).click()
  await ready()
}

async function ready() {
  await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
}

async function addFile(path: string | null) {
  await app.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async (_window: unknown, options?: OpenDialogOptions) => {
        const state = globalThis as any
        ;(state.__pdfPickerStarts ??= []).push(options?.defaultPath ?? null)
        if (state.__pdfPickerRejectPath && options?.defaultPath) {
          state.__pdfPickerRejectPath = false
          throw new Error('fake directory became unavailable')
        }
        return { canceled: !file, filePaths: file ? [file] : [] }
      }
    },
    path ? resolve(path) : null,
  )
  if (!(await page.getByRole('dialog', { name: 'files', exact: true }).isVisible()))
    await page
      .locator('.titlebar')
      .getByRole('button', { name: '파일 목록 열기', exact: true })
      .click()
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '파일', exact: true }).click()
  await expect(page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true })).toBeEnabled()
}

async function selectFile(path: string | null) {
  await addFile(path)
  let library = page.getByRole('dialog', { name: 'files', exact: true })
  if (!path || (await library.getByRole('alert').count())) {
    await page.getByRole('button', { name: '파일 목록 닫기' }).click()
    return
  }
  await library
    .getByRole('article', { name: basename(path), exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(library).toHaveCount(0)
}

test('sample PDF renders, text is selectable, and all four pages follow the side panel', async ({}, info) => {
  await page.screenshot({ path: info.outputPath('welcome.png') })
  await sample()
  await expect(page.getByRole('heading', { name: '언어의 경계를 넘어, 읽기' })).toBeVisible()
  await expect(page.locator('.connection-badge')).toContainText('예시 번역')
  await expect(page.getByTestId('sample-translation')).not.toContainText('설정에서 ChatGPT')
  const line = page.locator('.textLayer span').filter({ hasText: 'Good writing deserves' }).first()
  await line.scrollIntoViewIfNeeded()
  const bounds = await line.evaluate((node) => {
    const range = document.createRange()
    range.setStart(node.firstChild!, 0)
    range.setEnd(node.firstChild!, 'Good writing'.length)
    const rect = range.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  })
  expect(bounds).toBeTruthy()
  await page.mouse.move(bounds!.x + 1, bounds!.y + bounds!.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + bounds!.width + 2, bounds!.y + bounds!.height / 2, {
    steps: 15,
  })
  await page.mouse.up()
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toContain('Good writing')
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page.screenshot({ path: info.outputPath('reader.png') })
  await page.getByRole('button', { name: '다음 페이지' }).click()
  await ready()
  await expect(page.getByRole('heading', { name: '문서에는 읽는 순서가 있습니다' })).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await ready()
  await expect(page.getByRole('heading', { name: '구조를 보존하며 읽기' })).toBeVisible()
  await page.getByRole('textbox', { name: '현재 페이지' }).fill('4')
  await page.getByRole('textbox', { name: '현재 페이지' }).press('Enter')
  await ready()
  await expect(page.locator('.pdf-surface canvas')).toBeVisible()
  await expect(page.getByRole('tablist', { name: '사이드 패널' }).getByRole('tab')).toHaveCount(3)
  await expect(page.getByRole('tab', { name: '추출 텍스트' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '다음 페이지' })).toBeDisabled()
})

test('native file selection, cancellation, broken PDFs, and recovery', async () => {
  await selectFile('resources/reading-notes.pdf')
  await ready()
  await expect(page.getByText('설정에서 ChatGPT를 연결해 주세요.')).toBeVisible()
  await expect(page.getByTestId('sample-translation')).toHaveCount(0)
  await selectFile(null)
  await expect(page.getByText('설정에서 ChatGPT를 연결해 주세요.')).toBeVisible()
  await selectFile('tests/fixtures/broken.pdf')
  await expect(page.getByRole('alert')).toContainText('PDF를 열 수 없어요')
  await expect(page.locator('.pdf-surface canvas')).toBeVisible()
  await selectFile('tests/fixtures/not-a-pdf.pdf')
  await expect(page.getByRole('alert')).toContainText('올바른 PDF 파일이 아니에요')
  await selectFile('resources/reading-notes.pdf')
  await ready()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.textLayer')).toContainText('Good writing deserves')
})

test('PDF chooser remembers successful source folders across restart while cancellation, parsing and registration failures preserve it', async () => {
  const one = join(profile, 'source-one'),
    two = join(profile, 'source-two')
  await mkdir(one)
  await mkdir(two)
  const a = join(one, 'A.pdf'),
    b = join(two, 'B.pdf'),
    broken = join(two, 'broken.pdf')
  await copyFile('tests/fixtures/other.pdf', a)
  await copyFile('resources/reading-notes.pdf', b)
  await copyFile('tests/fixtures/broken.pdf', broken)
  const start = () => app.evaluate(() => (globalThis as any).__pdfPickerStarts.at(-1))
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await makeFolder('분류')
  await libraryFolder('분류').getByRole('button', { name: '분류 폴더 열기' }).click()
  await addFile(a)
  expect(await start()).toBeNull()
  const before = await page.evaluate(() => window.desktop.librarySnapshot())
  const folder = before.folders.find((entry) => entry.name === '분류')!.id
  expect(before.documents[0].folderId).toBe(folder)
  for (const file of [null, broken, join(two, 'missing.pdf'), null]) {
    await addFile(file)
    expect(await start()).toBe(one)
    expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toEqual(
      before.documents,
    )
  }
  const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER reject_new_pdf BEFORE INSERT ON documents WHEN NEW.name='B.pdf' BEGIN SELECT RAISE(ABORT,'fake registration failure'); END;",
    )
    await addFile(b)
    await expect(page.getByRole('alert')).toBeVisible()
    expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toEqual(
      before.documents,
    )
    expect(
      db.prepare('SELECT last_pdf_directory FROM library_settings WHERE id=1').get()
        ?.last_pdf_directory,
    ).toBe(one)
    db.exec('DROP TRIGGER reject_new_pdf')
  } finally {
    db.close()
  }
  await addFile(b)
  expect(await start()).toBe(one)
  const duplicate = join(two, 'A.pdf')
  await copyFile(a, duplicate)
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as any)._invokeHandlers
    const add = handlers.get('library:add'),
      read = handlers.get('library:open')
    ipcMain.removeHandler('library:add')
    ipcMain.handle('library:add', async (event, input) => {
      ipcMain.removeHandler('library:add')
      ipcMain.handle('library:add', add)
      // Reproduce a background read of the old source before registration.
      await read(event, input.id, false)
      return add(event, input)
    })
  })
  await addFile(duplicate)
  expect(await start()).toBe(two)
  const saved = await page.evaluate(() => window.desktop.librarySnapshot())
  expect(saved.documents).toHaveLength(2)
  expect(saved.documents.every((doc) => doc.folderId === folder && doc.lastOpened === null)).toBe(
    true,
  )
  await expect(page.getByRole('navigation', { name: '폴더 경로' })).toHaveText('Home분류')
  await expect(page.locator('.document-tab-list > .document-tab')).toHaveCount(0)
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await app.close()
  await launchApp()
  await addFile(null)
  expect(await start()).toBe(two)
  expect(await page.evaluate(() => window.desktop.librarySnapshot())).toEqual(saved)
  await expect(page.locator('.document-tab-list > .document-tab')).toHaveCount(0)
  expect((await app.evaluate(() => (globalThis as any).__activeFake)).calls).toHaveLength(0)
})

test('PDF chooser falls back for missing, non-directory, denied and stale paths without overwriting them on cancellation', async () => {
  const one = join(profile, 'source-one'),
    two = join(profile, 'source-two')
  await mkdir(one)
  await mkdir(two)
  const a = join(one, 'A.pdf'),
    b = join(two, 'B.pdf')
  await copyFile('tests/fixtures/other.pdf', a)
  await copyFile('resources/reading-notes.pdf', b)
  await addFile(a)
  await rm(one, { recursive: true })
  const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  const start = () => app.evaluate(() => (globalThis as any).__pdfPickerStarts.at(-1))
  try {
    for (const invalid of [one, b, 'relative/path']) {
      db.prepare('UPDATE library_settings SET last_pdf_directory=? WHERE id=1').run(invalid)
      await addFile(null)
      expect(await start()).toBeNull()
      expect(
        db.prepare('SELECT last_pdf_directory FROM library_settings WHERE id=1').get()
          ?.last_pdf_directory,
      ).toBe(invalid)
    }
    db.prepare('UPDATE library_settings SET last_pdf_directory=? WHERE id=1').run(two)
    await app.evaluate((_, directory) => {
      const fs = process.getBuiltinModule('fs')!.promises,
        original = fs.access
      ;(globalThis as any).__pdfOriginalAccess = original
      fs.access = async (path, mode) => {
        if (path === directory)
          throw Object.assign(new Error('fake directory permission'), { code: 'EACCES' })
        return original(path, mode)
      }
    }, two)
    try {
      await addFile(null)
      expect(await start()).toBeNull()
    } finally {
      await app.evaluate(() => {
        process.getBuiltinModule('fs')!.promises.access = (globalThis as any).__pdfOriginalAccess
      })
    }
    await app.evaluate(() => {
      ;(globalThis as any).__pdfPickerRejectPath = true
    })
    await addFile(null)
    expect(await app.evaluate(() => (globalThis as any).__pdfPickerStarts.slice(-2))).toEqual([
      two,
      null,
    ])
    expect(
      db.prepare('SELECT last_pdf_directory FROM library_settings WHERE id=1').get()
        ?.last_pdf_directory,
    ).toBe(two)
    db.prepare('UPDATE library_settings SET last_pdf_directory=? WHERE id=1').run(one)
    await addFile(b)
    expect(await start()).toBeNull()
    await addFile(null)
    expect(await start()).toBe(two)
    expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toHaveLength(2)
    expect((await app.evaluate(() => (globalThis as any).__activeFake)).calls).toHaveLength(0)
  } finally {
    db.close()
  }
})

test('PDF Ctrl wheel uses one bounded zoom path from fit, preserves ordinary scrolling and ignores other UI', async () => {
  const viewer = page.locator('.viewer-scroll'),
    label = page.getByTestId('zoom-value')
  const dispatch = (selector = '.viewer-scroll', count = 1, deltaY = -20, deltaMode = 0) =>
    page.locator(selector).evaluate(
      (node, input) => {
        const bounds = node.getBoundingClientRect()
        let prevented = false
        for (let n = 0; n < input.count; n++) {
          const event = new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: input.deltaY,
            deltaMode: input.deltaMode,
            clientX: bounds.x + bounds.width / 2,
            clientY: bounds.y + bounds.height / 2,
          })
          node.dispatchEvent(event)
          prevented = event.defaultPrevented
        }
        return prevented
      },
      { count, deltaY, deltaMode },
    )
  expect(await dispatch()).toBe(false)
  await expect(label).toHaveText('—')
  await sample()
  const initial = Number(await page.locator('.pdf-surface').getAttribute('data-scale'))
  const box = (await viewer.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -20)
  await page.keyboard.up('Control')
  await expect(label).toHaveText(`${Math.round(initial * Math.exp(0.2) * 100)}%`)
  await ready()
  expect(Number(await page.locator('.pdf-surface').getAttribute('data-scale'))).toBeCloseTo(
    initial * Math.exp(0.2),
    5,
  )
  await expect(page.getByRole('button', { name: '너비에 맞추기' })).not.toHaveClass(/is-active/)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, 20)
  await page.keyboard.up('Control')
  await expect(label).toHaveText(`${Math.round(initial * 100)}%`)
  await ready()
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await ready()
  await expect(label).toHaveText(`${Math.round((Math.round((initial + 0.15) * 100) / 100) * 100)}%`)
  expect(await dispatch('.viewer-scroll', 30, -30)).toBe(true)
  await expect(label).toHaveText('300%')
  await ready()
  await expect(page.getByRole('button', { name: '확대', exact: true })).toBeDisabled()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, 160)
  await expect.poll(() => viewer.evaluate((n) => n.scrollTop)).toBeGreaterThan(0)
  await expect(label).toHaveText('300%')
  await page.keyboard.down('Meta')
  await page.mouse.wheel(0, -20)
  await page.keyboard.up('Meta')
  await expect(label).toHaveText('300%')
  expect(await dispatch('.viewer-scroll', 30, 30)).toBe(true)
  await expect(label).toHaveText('25%')
  await ready()
  await expect(page.getByRole('button', { name: '축소', exact: true })).toBeDisabled()
  expect(await dispatch('.viewer-scroll', 1, -1, 1)).toBe(true)
  await expect(label).toHaveText('29%')
  await ready()
  const unchanged = await label.textContent()
  expect(await dispatch('.translation-panel')).toBe(false)
  await page.getByLabel('번역 메뉴', { exact: true }).click()
  expect(await dispatch()).toBe(false)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  expect(await dispatch()).toBe(false)
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: '채팅', exact: true }).click()
  expect(await dispatch('textarea[aria-label="질문"]')).toBe(false)
  await expect(label).toHaveText(unchanged!)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
  ).toBe(1)
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1)
})

test('trackpad pinch and continuous wheel keep the PDF pointer anchor and independent tab reading state through restart', async ({}, info) => {
  await sample()
  const viewer = page.locator('.viewer-scroll'),
    label = page.getByTestId('zoom-value')
  for (let n = 0; n < 7; n++) {
    await page.getByRole('button', { name: '확대', exact: true }).click()
    await ready()
  }
  const box = (await viewer.boundingBox())!,
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const position = () =>
    page.locator('.pdf-surface').evaluate((surface, p) => {
      const r = surface.getBoundingClientRect(),
        scale = Number((surface as HTMLElement).dataset.scale)
      return { x: (p.x - r.left) / scale, y: (p.y - r.top) / scale, scale }
    }, point)
  await page.mouse.move(point.x, point.y)
  await page.mouse.wheel(150, 300)
  await expect.poll(() => viewer.evaluate((n) => n.scrollTop)).toBeGreaterThan(0)
  const before = await position()
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -10)
  await page.keyboard.up('Control')
  await expect(label).toHaveText(`${Math.round(before.scale * Math.exp(0.1) * 100)}%`)
  await ready()
  const after = await position()
  expect(Math.abs(after.x - before.x) * after.scale).toBeLessThan(2)
  expect(Math.abs(after.y - before.y) * after.scale).toBeLessThan(2)
  const session = await page.context().newCDPSession(page)
  await session.send('Input.synthesizePinchGesture', {
    ...point,
    scaleFactor: 0.9,
    gestureSourceType: 'mouse',
  })
  await expect.poll(async () => (await position()).scale).toBeLessThan(after.scale)
  await ready()
  const contracted = await position()
  expect(contracted.scale).toBeCloseTo(after.scale * 0.9, 3)
  await session.send('Input.synthesizePinchGesture', {
    ...point,
    scaleFactor: 1.05,
    gestureSourceType: 'mouse',
  })
  await expect.poll(async () => (await position()).scale).toBeGreaterThan(contracted.scale)
  await ready()
  await session.detach()
  const pinched = await position()
  expect(pinched.scale).toBeCloseTo(contracted.scale * 1.05, 3)
  expect(Math.abs(pinched.x - after.x) * pinched.scale).toBeLessThan(2)
  expect(Math.abs(pinched.y - after.y) * pinched.scale).toBeLessThan(2)
  await page.keyboard.down('Control')
  for (const delta of [-3, -4, 2, -2, 1]) await page.mouse.wheel(0, delta)
  await page.keyboard.up('Control')
  await expect(label).toHaveText(`${Math.round(pinched.scale * Math.exp(0.06) * 100)}%`)
  await ready()
  const first = (await readingWorkspace()).tabs[0]
  await page.screenshot({ path: info.outputPath('anchored-pdf-zoom.png') })
  await reopen('reading-notes.pdf')
  await expect(page.getByRole('button', { name: '너비에 맞추기' })).toHaveClass(/is-active/)
  await documentTabs().first().getByRole('tab').click()
  await ready()
  await expect(label).toHaveText(`${Math.round(Number(first.zoom) * 100)}%`)
  const scroll = await viewer.evaluate((n) => ({ x: n.scrollLeft, y: n.scrollTop }))
  expect(scroll.x).toBeCloseTo(first.scrollLeft, 0)
  expect(scroll.y).toBeCloseTo(first.scrollTop, 0)
  await app.close()
  await launchApp()
  await ready()
  const restored = await readingWorkspace()
  expect(restored.tabs[0]).toEqual(first)
  await expect(page.getByTestId('zoom-value')).toHaveText(
    `${Math.round(Number(first.zoom) * 100)}%`,
  )
  const restoredScroll = await page
    .locator('.viewer-scroll')
    .evaluate((n) => ({ x: n.scrollLeft, y: n.scrollTop }))
  expect(restoredScroll.x).toBeCloseTo(first.scrollLeft, 0)
  expect(restoredScroll.y).toBeCloseTo(first.scrollTop, 0)
  expect(
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomFactor(),
    ),
  ).toBe(1)
  expect(await page.evaluate(() => visualViewport?.scale)).toBe(1)
})

test('zoom, page bounds, rapid navigation, and resizable panel', async ({}, info) => {
  await sample()
  const canvas = page.locator('.pdf-surface canvas')
  const before = await canvas.boundingBox()
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await ready()
  expect((await canvas.boundingBox())!.width).toBeGreaterThan(before!.width)
  await page.getByRole('button', { name: '축소', exact: true }).click()
  await ready()
  await page.getByRole('button', { name: '너비에 맞추기' }).click()
  await ready()
  const divider = page.getByRole('separator', { name: '번역 패널 너비' })
  const initialWidth = Number(await divider.getAttribute('aria-valuenow'))
  const dividerBox = (await divider.boundingBox())!
  await page.mouse.move(dividerBox.x + 2, dividerBox.y + 100)
  await page.mouse.down()
  await page.mouse.move(dividerBox.x - 100, dividerBox.y + 100, { steps: 10 })
  await page.mouse.up()
  expect(Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(initialWidth)
  const draggedWidth = await divider.getAttribute('aria-valuenow')
  await divider.click()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('2')
  await expect(divider).toHaveAttribute('aria-valuenow', draggedWidth!)
  const input = page.getByRole('textbox', { name: '현재 페이지' })
  await input.fill('999')
  await input.press('Enter')
  await expect(input).toHaveValue('4')
  await input.fill('0')
  await input.press('Enter')
  await expect(input).toHaveValue('1')
  await input.fill('abc')
  await input.press('Enter')
  await expect(input).toHaveValue('1')
  for (const index of [2, 3, 1, 4, 2, 1]) {
    await input.fill(String(index))

    await input.press('Enter')
  }
  await ready()
  await expect(page.getByRole('heading', { name: '언어의 경계를 넘어, 읽기' })).toBeVisible()
  await expect(page.locator('.textLayer')).toContainText('Good writing deserves')
  const zoomBeforeResize = await page.getByTestId('zoom-value').textContent()
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await expect(page.getByTestId('zoom-value')).not.toHaveText(zoomBeforeResize!)
  await ready()
  await expect(page.getByRole('button', { name: '설정', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('compact.png') })
})

test('PDF text layer retains columns and table values after removing the extracted-text screen', async () => {
  await sample()
  await page.getByRole('button', { name: '다음 페이지' }).click()
  await ready()
  const text = page.locator('.textLayer')
  await expect(text).toContainText('LEFT COLUMN - END')
  await expect(text).toContainText('RIGHT COLUMN - CONTINUE HERE')
  await page.getByRole('button', { name: '다음 페이지' }).click()
  await ready()
  await expect(text).toContainText('Document A')
  await expect(text).toContainText('12')
  await expect(text).toContainText('Done')
  await expect(text).toContainText('Document B')
  await expect(text).toContainText('28')
  await expect(text).toContainText('Waiting')
  await expect(text).toContainText('E = mc')
  await page.getByRole('button', { name: '다음 페이지' }).click()
  await ready()
  await expect(text.locator('span')).toHaveCount(0)
  await expect(page.locator('.pdf-surface canvas')).toBeVisible()
  await expect(page.getByRole('tab', { name: '추출 텍스트' })).toHaveCount(0)
})

test('settings opens from the header and ChatGPT connection wait with mouse, Enter, and Space', async () => {
  const wait = page.getByRole('button', { name: 'ChatGPT 연결 설정 열기', exact: true })
  const dialog = page.getByRole('dialog', { name: 'settings' })
  for (const key of ['click', 'Enter', 'Space']) {
    if (key === 'click') await wait.click()
    else {
      await wait.focus()

      await wait.press(key)
    }

    await expect(dialog).toBeVisible()

    await expect(page.getByRole('button', { name: 'ChatGPT 연결', exact: true })).toHaveAttribute(
      'aria-expanded',
      'true',
    )

    await expect(dialog.getByRole('button', { name: 'ChatGPT로 로그인' })).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(dialog).not.toBeVisible()
  }
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(page.locator('.settings-section-trigger[aria-expanded="true"]')).toHaveCount(0)
  expect(
    await page.evaluate(() => typeof (window as unknown as { require?: unknown }).require),
  ).toBe('undefined')
})

test('file library checks changed originals and relinks the matching PDF without losing the viewer', async () => {
  await sample()
  const row = page.getByRole('article', { name: 'reading-notes.pdf', exact: true })
  // A changed source must not inherit the original document's cached translation.
  const second = join(profile, 'second.pdf')
  await copyFile(resolve('tests/fixtures/other.pdf'), second)
  await addFile(second)
  await copyFile(resolve('resources/reading-notes.pdf'), second)
  const secondRow = page.getByRole('article', { name: 'second.pdf', exact: true })
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, second)
  await secondRow.click({ position: { x: 2, y: 3 } })
  await expect(page.getByRole('alert')).toContainText('원래 PDF와 달라요')
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('reading-notes.pdf')
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] })
  }, resolve('tests/fixtures/other.pdf'))
  await secondRow.getByRole('button', { name: /열기$/ }).click()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('other.pdf')
  await ready()
  await page
    .locator('.titlebar')
    .getByRole('button', { name: '파일 목록 열기', exact: true })
    .click()
  await expect(row).toBeVisible()
  await expect(page.getByTestId('library-row')).toHaveCount(2)
  await page
    .getByRole('article', { name: 'other.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await ready()
})

test('card frame centers short pages and keeps tall pages scrollable after zoom, resize and panel drag', async ({}, info) => {
  const { fileButton, filename, headerFits, aligned, alignment, captureAlignment } =
    await prepareReaderLayout(app, page, profile, info)
  await captureAlignment('initial')
  await page.screenshot({ path: info.outputPath('initial-position.png') })
  await aligned('normal-fit')
  expect((await alignment()).scroll).toBe(0)
  await page.getByRole('button', { name: '다음 페이지' }).click()
  await aligned('near-controls')
  const nearControls = await alignment()
  expect(nearControls.centered).toBe(false)
  expect(nearControls.pdfHeight).toBeLessThan(nearControls.cardHeight - nearControls.scrollOffset)
  await headerFits()
  await page.screenshot({ path: info.outputPath('near-controls.png') })
  await page.getByRole('button', { name: '이전 페이지' }).click()
  await aligned('page-return')
  const frame = await page.evaluate(() => {
    const style = (selector: string) => getComputedStyle(document.querySelector(selector)!)
    const reader = document.querySelector('.reader')!.getBoundingClientRect()
    const panel = document.querySelector('.translation-panel')!.getBoundingClientRect()
    return {
      colors: ['.titlebar', '.workspace', '.panel-divider'].map((s) => style(s).backgroundColor),
      borders: ['.titlebar', '.panel-divider'].map((s) => [
        style(s).borderTopWidth,
        style(s).borderBottomWidth,
        style(s).borderLeftWidth,
        style(s).borderRightWidth,
      ]),
      gap: panel.left - reader.right,
      corners: ['.reader', '.translation-panel'].map((s) => [
        style(s).borderTopLeftRadius,
        style(s).borderTopRightRadius,
        style(s).borderBottomLeftRadius,
        style(s).borderBottomRightRadius,
      ]),
    }
  })
  expect(new Set(frame.colors).size).toBe(1)
  expect(frame.borders.flat().every((value) => value === '0px')).toBe(true)
  expect(frame.corners.flat().every((value) => value === '16px')).toBe(true)
  expect(frame.gap).toBe(16)
  await headerFits()
  await page.screenshot({ path: info.outputPath('normal-centered.png') })
  await page.locator('.titlebar').screenshot({ path: info.outputPath('header-normal.png') })
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await aligned('zoom-in')
  await page.getByRole('button', { name: '축소', exact: true }).click()
  await aligned('zoom-out')
  await page.getByRole('button', { name: '너비에 맞추기' }).click()
  await aligned('fit-again')
  const handle = page.getByRole('separator', { name: '번역 패널 너비' })
  const originalWidth = Number(await handle.getAttribute('aria-valuenow'))
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x - 70, box.y + box.height / 2, { steps: 10 })
  await page.mouse.up()
  expect(Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(originalWidth)
  await aligned('panel-drag')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await aligned('minimum-window')
  await headerFits()
  expect(
    await page
      .locator('.document-tab[data-active="true"] .file-name, .document-add .file-name')
      .evaluate((node) => node.scrollWidth > node.clientWidth),
  ).toBe(true)
  await filename.click()
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
  await fileButton.click()
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await page.screenshot({ path: info.outputPath('compact-centered.png') })
  await page.locator('.titlebar').screenshot({ path: info.outputPath('header-compact.png') })
  await dragPanel(page, 48)
  await expect(handle).toHaveAttribute('aria-valuenow', '48')
  await aligned('narrow-panel')
  await headerFits()
  await page.screenshot({ path: info.outputPath('narrow-reader.png') })
  await page.getByRole('textbox', { name: '현재 페이지' }).fill('3')
  await page.getByRole('textbox', { name: '현재 페이지' }).press('Enter')
  await aligned('tall-page')
  expect((await alignment()).scroll).toBeGreaterThan(100)
  const fixedControls = await page.locator('.reader-controls').boundingBox()
  await page.locator('.viewer-scroll').evaluate((node) => {
    node.scrollTop = node.scrollHeight
  })
  expect(await page.locator('.viewer-scroll').evaluate((node) => node.scrollTop)).toBeGreaterThan(
    100,
  )
  expect(await page.locator('.reader-controls').boundingBox()).toEqual(fixedControls)
  await headerFits()
  await page.locator('.viewer-scroll').evaluate((node) => {
    node.scrollTop = 0
  })
  await aligned()
  await page.screenshot({ path: info.outputPath('tall-top.png') })
  await page.getByRole('textbox', { name: '현재 페이지' }).fill('1')
  await page.getByRole('textbox', { name: '현재 페이지' }).press('Enter')
  await aligned('small-page-return')
  expect(await page.locator('.brand').evaluate((node) => node.getBoundingClientRect().left)).toBe(
    98,
  )
})

const libraryFolder = (name: string) =>
  page.getByRole('article', { name: `폴더 ${name}`, exact: true })
async function makeFolder(name: string) {
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '폴더', exact: true }).press('Enter')
  await expect(page.getByRole('textbox', { name: '폴더 이름', exact: true })).toBeFocused()
  await page.getByRole('textbox', { name: '폴더 이름', exact: true }).fill(name)
  await page.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Enter')
  await expect(libraryFolder(name)).toBeVisible()
}
async function rootFolder() {
  await page
    .getByRole('navigation', { name: '폴더 경로', exact: true })
    .getByRole('button', { name: '최상위', exact: true })
    .click()
}
async function destinationFolder(name: string) {
  await page
    .getByLabel('이동 가능한 하위 폴더', { exact: true })
    .getByRole('button', { name, exact: true })
    .press('Enter')
}

test('internal folders create nested paths, move PDFs and subtrees, deduplicate additions, and restore after restart', async ({}, info) => {
  await sample()
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  const existing = await page.evaluate(async () =>
    (await window.desktop.listDocuments()).map((d) => ({ id: d.id, folderId: d.folderId })),
  )
  expect(existing[0].folderId).toBeNull()
  await makeFolder('학교')
  await expect(libraryFolder('학교').locator('.library-metadata')).toHaveText('0개 항목')
  await libraryFolder('학교')
    .getByRole('button', { name: '학교 폴더 열기', exact: true })
    .press('Enter')
  await makeFolder('과목')
  await expect(libraryFolder('과목').locator('.library-metadata')).toHaveText('0개 항목')
  await libraryFolder('과목')
    .getByRole('button', { name: '과목 폴더 열기', exact: true })
    .press('Space')
  await makeFolder('강의')
  await libraryFolder('강의').getByRole('button', { name: '강의 폴더 열기', exact: true }).click()
  await expect(page.getByRole('navigation', { name: '폴더 경로' })).toHaveText('Home학교과목강의')
  await expect(page.getByText('빈 폴더예요', { exact: true })).toBeVisible()
  const source = join(profile, 'folder-source.pdf')
  await copyFile(resolve('tests/fixtures/other.pdf'), source)
  const digest = createHash('sha256')
    .update(await readFile(source))
    .digest('hex')
  await addFile(source)
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('reading-notes.pdf')
  const pdf = page.getByRole('article', { name: 'folder-source.pdf', exact: true })
  await expect(pdf.getByRole('button', { name: /열기$/ })).toBeVisible()
  await expect(pdf.getByRole('progressbar')).toBeVisible()
  const registered = await page.evaluate(async () => {
    const snapshot = await window.desktop.librarySnapshot(),
      doc = snapshot.documents.find((d) => d.name === 'folder-source.pdf')!
    return {
      id: doc.id,
      folder: doc.folderId,
      count: snapshot.documents.length,
      leaf: snapshot.folders.find((f) => f.name === '강의')!.id,
    }
  })
  expect(registered.folder).toBe(registered.leaf)
  expect(registered.count).toBe(2)
  await rootFolder()
  // One direct child folder; its nested folder/PDF must not inflate this count.
  await expect(libraryFolder('학교').locator('.library-metadata')).toHaveText('1개 항목')
  await addFile(source)
  await expect(page.getByTestId('library-row')).toHaveCount(1)
  expect(await page.evaluate(async () => (await window.desktop.listDocuments()).length)).toBe(2)
  await libraryFolder('학교').getByRole('button', { name: '학교 폴더 열기', exact: true }).click()
  await libraryFolder('과목').getByRole('button', { name: '과목 폴더 열기', exact: true }).click()
  await libraryFolder('강의').getByRole('button', { name: '강의 폴더 열기', exact: true }).click()
  await pdf.getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '파일 위치 이동', exact: true }).click()
  await destinationFolder('학교')
  await page.getByRole('button', { name: '이 위치로 이동', exact: true }).click()
  await expect(pdf).toHaveCount(0)
  await rootFolder()
  await makeFolder('보관')
  await expect(libraryFolder('학교').locator('.library-metadata')).toHaveText('2개 항목')
  await expect(libraryFolder('보관').locator('.library-metadata')).toHaveText('0개 항목')
  await libraryFolder('학교').getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '폴더 위치 이동', exact: true }).click()
  await expect(
    page.getByLabel('이동 가능한 하위 폴더').getByRole('button', { name: '학교', exact: true }),
  ).toHaveCount(0)
  await destinationFolder('보관')
  await page.getByRole('button', { name: '이 위치로 이동', exact: true }).click()
  await expect(libraryFolder('학교')).toHaveCount(0)
  await expect(libraryFolder('보관').locator('.library-metadata')).toHaveText('1개 항목')
  const rejected = await page.evaluate(async () => {
    const { folders } = await window.desktop.librarySnapshot()
    return window.desktop.changeLibrary({
      kind: 'moveFolder',
      id: folders.find((f) => f.name === '학교')!.id,
      parentId: folders.find((f) => f.name === '강의')!.id,
    })
  })
  expect(rejected.status).toBe('error')
  await libraryFolder('보관').getByRole('button', { name: '보관 폴더 열기', exact: true }).click()
  await libraryFolder('학교').getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '폴더 이름 변경', exact: true }).click()
  await page.getByRole('textbox', { name: '폴더 이름' }).fill('학교 자료')
  await page.getByRole('textbox', { name: '폴더 이름' }).press('Enter')
  await expect(libraryFolder('학교 자료')).toBeVisible()
  await expect(libraryFolder('학교 자료').locator('.library-metadata')).toHaveText('2개 항목')
  await expect(libraryFolder('학교 자료').getByRole('button', { name: /메뉴$/ })).toBeFocused()
  await page.screenshot({ path: info.outputPath('folders-nested.png') })
  expect(
    createHash('sha256')
      .update(await readFile(source))
      .digest('hex'),
  ).toBe(digest)
  await app.close()
  await launchApp()
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await libraryFolder('보관').getByRole('button', { name: '보관 폴더 열기', exact: true }).click()
  await libraryFolder('학교 자료')
    .getByRole('button', { name: '학교 자료 폴더 열기', exact: true })
    .click()
  const restoredPdf = page.getByRole('article', { name: 'folder-source.pdf', exact: true })
  await expect(restoredPdf).toBeVisible()
  await expect(libraryFolder('과목')).toBeVisible()
  const restored = await page.evaluate(
    async () =>
      (await window.desktop.listDocuments()).find((d) => d.name === 'folder-source.pdf')!.id,
  )
  expect(restored).toBe(registered.id)
  await restoredPdf.getByRole('button', { name: /열기$/ }).click()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('folder-source.pdf')
  await ready()
})

test('folder titles edit inside unchanged rows with IME, cancellation and outside-click confirmation at minimum width', async ({}, info) => {
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await makeFolder('기존 폴더')
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  const input = files.getByRole('textbox', { name: '폴더 이름', exact: true })
  const beginCreate = async () => {
    await files.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
    await page.getByRole('menuitem', { name: '폴더', exact: true }).click()
    await expect(input).toBeFocused()
    await expect(files.getByRole('article', { name: '새 폴더', exact: true })).toBeVisible()
    await expect(files.locator('form')).toHaveCount(0)
  }
  await beginCreate()
  await checkInlineTitleWidth(page, input)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await checkInlineTitleWidth(page, input)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960),
  )
  await input.fill('취소할 이름')
  expect((await page.evaluate(() => window.desktop.librarySnapshot())).folders).toHaveLength(1)
  await input.press('Escape')
  await expect(files.getByRole('article', { name: '새 폴더', exact: true })).toHaveCount(0)
  await beginCreate()
  await input.dispatchEvent('compositionstart')
  await input.fill('한글 폴더')
  await input.press('Enter')
  await expect(input).toBeFocused()
  await input.dispatchEvent('compositionend')
  await input.press('Enter')
  await expect(input).toHaveCount(1)
  await input.press('Enter')
  await expect(libraryFolder('한글 폴더')).toBeVisible()
  const original = (await page.evaluate(() => window.desktop.librarySnapshot())).folders.find(
    (f) => f.name === '한글 폴더',
  )!
  const geometry = () =>
    libraryFolder('한글 폴더').evaluate((row) => {
      const title =
          row.querySelector('.library-title-input') ?? row.querySelector('.library-title')!,
        style = getComputedStyle(title)
      return {
        height: row.getBoundingClientRect().height,
        x:
          title.getBoundingClientRect().left +
          parseFloat(style.paddingLeft) +
          parseFloat(style.borderLeftWidth),
        y: title.getBoundingClientRect().top,
        font: [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight],
        icon: row.querySelector('.library-thumbnail')!.getBoundingClientRect().toJSON(),
        metadata: row.querySelector('.library-metadata')!.getBoundingClientRect().toJSON(),
      }
    })
  const before = await geometry()
  const rename = async () => {
    await libraryFolder('한글 폴더').getByRole('button', { name: /메뉴$/ }).click()
    await page.getByRole('menuitem', { name: '폴더 이름 변경', exact: true }).click()
    await expect(input).toBeFocused()
    await expect(input).toHaveValue('한글 폴더')
    expect(
      await input.evaluate((n: HTMLInputElement) => [n.selectionStart, n.selectionEnd]),
    ).toEqual([0, '한글 폴더'.length])
  }
  await rename()
  await checkInlineTitleWidth(page, input)
  expect(await geometry()).toEqual(before)
  await input.fill('다른 초안')
  await input.press('Escape')
  await expect(libraryFolder('한글 폴더')).toBeVisible()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await rename()
  await checkInlineTitleWidth(page, input)
  await input.fill('긴 폴더 이름 '.repeat(18))
  await expect(input).toBeInViewport()
  expect(await files.evaluate((n) => n.scrollWidth <= n.clientWidth + 1)).toBe(true)
  await files.screenshot({ path: info.outputPath('inline-folder-name.png') })
  await input.fill('정리한 폴더')
  await libraryFolder('기존 폴더')
    .getByRole('button', { name: /폴더 열기$/ })
    .click()
  await expect(libraryFolder('정리한 폴더')).toBeVisible()
  await expect(files.getByRole('navigation', { name: '폴더 경로', exact: true })).not.toContainText(
    '기존 폴더',
  )
  expect(
    (await page.evaluate(() => window.desktop.librarySnapshot())).folders.find(
      (f) => f.id === original.id,
    )?.name,
  ).toBe('정리한 폴더')
  await libraryFolder('기존 폴더')
    .getByRole('button', { name: /폴더 열기$/ })
    .click()
  await expect(files.getByText('빈 폴더예요', { exact: true })).toBeVisible()
})

test('inline folder Enter and blur submit once while delayed replies and failed creation retain the unsaved row', async () => {
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await app.evaluate(({ ipcMain }) => {
    const original = (ipcMain as any)._invokeHandlers.get('library:change')
    const control = ((globalThis as any).__folderEdit = {
      count: 0,
      hold: true,
      fail: false,
      release: () => {},
    })
    ipcMain.removeHandler('library:change')
    ipcMain.handle('library:change', async (...args) => {
      control.count++
      if (control.fail) return { status: 'error', message: '저장하지 못했어요.' }
      const result = await original(...args)
      if (control.hold)
        await new Promise<void>((resolve) => {
          control.release = resolve
        })
      return result
    })
  })
  const input = page.getByRole('textbox', { name: '폴더 이름', exact: true })
  const create = async () => {
    await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
    await page.getByRole('menuitem', { name: '폴더', exact: true }).click()
  }
  await create()
  await input.fill('한 번만 저장')
  await input.press('Enter')
  await expect.poll(() => app.evaluate(() => (globalThis as any).__folderEdit.count)).toBe(1)
  await page.keyboard.down('Enter')
  await page.keyboard.down('Enter')
  await page.keyboard.up('Enter')
  await page.locator('.file-dialog .dialog-header').click()
  await expect(input).toBeDisabled()
  expect(await app.evaluate(() => (globalThis as any).__folderEdit.count)).toBe(1)
  await app.evaluate(() => {
    ;(globalThis as any).__folderEdit.hold = false
    ;(globalThis as any).__folderEdit.release()
  })
  await expect(libraryFolder('한 번만 저장')).toBeVisible()
  await expect(input).toHaveCount(0)
  await libraryFolder('한 번만 저장').getByRole('button', { name: /메뉴$/ }).click()
  await page.getByRole('menuitem', { name: '폴더 이름 변경', exact: true }).click()
  await input.fill('새 이름')
  await input.press('Enter')
  await page.locator('.file-dialog .dialog-header').click()
  await expect(libraryFolder('새 이름')).toBeVisible()
  expect(await app.evaluate(() => (globalThis as any).__folderEdit.count)).toBe(2)
  await app.evaluate(() => {
    ;(globalThis as any).__folderEdit.fail = true
  })
  await create()
  await input.fill('보존할 생성 초안')
  await input.press('Enter')
  await expect(page.getByRole('alert')).toContainText('저장하지 못했어요')
  await expect(input).toBeFocused()
  await expect(input).toHaveValue('보존할 생성 초안')
  expect(
    (await page.evaluate(() => window.desktop.librarySnapshot())).folders.map((f) => f.name),
  ).toEqual(['새 이름'])
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(page.getByRole('article', { name: '새 폴더', exact: true })).toHaveCount(0)
})

test('folder validation and SQLite failure preserve the tree and drafts; long deep paths remain keyboard accessible at minimum size', async ({}, info) => {
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '폴더', exact: true }).press('Enter')
  await page.getByRole('textbox', { name: '폴더 이름' }).fill('   ')
  await page.getByRole('textbox', { name: '폴더 이름' }).press('Enter')
  await expect(page.getByRole('alert')).toContainText('1–200자')
  await expect(page.getByRole('textbox', { name: '폴더 이름' })).toHaveValue('   ')
  await page.getByRole('textbox', { name: '폴더 이름' }).press('Escape')
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toBeVisible()
  await makeFolder('자료')
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await page.getByRole('menuitem', { name: '폴더', exact: true }).press('Enter')
  await page.getByRole('textbox', { name: '폴더 이름' }).fill('자료')
  await page.getByRole('textbox', { name: '폴더 이름' }).press('Enter')
  await expect(page.getByRole('alert')).toContainText('같은 이름')
  await page.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Escape')
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER fake_folder_failure BEFORE UPDATE ON library_folders BEGIN SELECT RAISE(ABORT,'fake storage failure'); END;",
    )
    await libraryFolder('자료').getByRole('button', { name: /메뉴$/ }).click()
    await page.getByRole('menuitem', { name: '폴더 이름 변경', exact: true }).click()

    await page.getByRole('textbox', { name: '폴더 이름' }).fill('저장 실패 이름')

    await page.getByRole('textbox', { name: '폴더 이름' }).press('Enter')

    await expect(page.getByRole('alert')).toContainText('저장하지 못했어요')

    await expect(page.getByRole('textbox', { name: '폴더 이름' })).toHaveValue('저장 실패 이름')

    await expect(page.getByRole('textbox', { name: '폴더 이름' })).toBeFocused()

    await expect(libraryFolder('자료')).toBeVisible()
    expect(
      Number(db.prepare("SELECT COUNT(*) AS n FROM library_folders WHERE name='자료'").get()!.n),
    ).toBe(1)
    db.exec('DROP TRIGGER fake_folder_failure')

    await page.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Escape')
  } finally {
    db.close()
  }
  const long = '<img src=x onerror=alert(1)> ' + 'Very long folder name '.repeat(5)
  for (let level = 0; level < 8; level++) {
    const name = long + level

    await makeFolder(name)

    await libraryFolder(name)
      .getByRole('button', { name: `${name} 폴더 열기`, exact: true })
      .click()
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await expect
    .poll(() =>
      page.getByRole('navigation', { name: '폴더 경로', exact: true }).evaluate((node) => {
        const current = node.querySelector('[aria-current="page"]')!.getBoundingClientRect(),
          box = node.getBoundingClientRect()
        return {
          left: Math.max(0, box.left - current.left),
          right: Math.max(0, current.right - box.right),
        }
      }),
    )
    .toEqual({ left: 0, right: 0 })
  await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).press('Enter')
  await page.getByRole('menuitem', { name: '폴더', exact: true }).press('Enter')
  await expect(page.getByRole('textbox', { name: '폴더 이름' })).toBeFocused()
  await expect(page.locator('.file-dialog img')).toHaveCount(0)
  expect(
    await page
      .getByRole('navigation', { name: '폴더 경로', exact: true })
      .evaluate((node) => node.scrollHeight <= node.clientHeight + 1),
  ).toBe(true)
  expect(
    await page.locator('.file-dialog').evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  ).toBe(true)
  await expect(page.getByRole('textbox', { name: '폴더 이름' })).toBeInViewport()
  await page.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Escape')
  await expect(page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true })).toBeFocused()
  await page.screenshot({ path: info.outputPath('folders-minimum-deep.png') })
  await rootFolder()
  await expect(libraryFolder('자료')).toBeVisible()
})

test('compact files dialog aligns rows, keeps its bottom path fixed, and separates keyboard menus from opening', async ({}, info) => {
  await sample()
  const headerStyle = (selector: string) =>
    page.locator(selector).evaluate((header) => {
      const title = header.querySelector('h2')!,
        style = getComputedStyle(title),
        box = getComputedStyle(header)
      return {
        height: header.getBoundingClientRect().height,
        padding: box.padding,
        font: style.fontFamily,
        size: style.fontSize,
        weight: style.fontWeight,
        spacing: style.letterSpacing,
      }
    })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const settingsHeader = await headerStyle('.settings-dialog .dialog-header')
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  expect(await headerStyle('.file-dialog .dialog-header')).toEqual(settingsHeader)
  await expect(files.locator('.dialog-header button')).toHaveCount(1)
  await expect(files.getByText('YOUR LIBRARY')).toHaveCount(0)
  const plus = files.getByRole('button', { name: '파일 또는 폴더 추가', exact: true })
  await plus.press('Enter')
  const menu = files.getByRole('menu', { name: '파일 창 메뉴', exact: true })
  await expect(menu.getByRole('menuitem')).toHaveText(['파일', '폴더'])
  await expect(menu.getByRole('menuitem', { name: '파일', exact: true })).toBeFocused()
  await page.keyboard.press('End')
  await expect(menu.getByRole('menuitem', { name: '폴더', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByRole('menuitem', { name: '파일', exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(plus).toBeFocused()
  await expect(files).toBeVisible()
  await makeFolder('정렬 자료')
  const longName = 'Very long document title '.repeat(6) + '.pdf'
  const source = join(profile, longName)
  await copyFile(resolve('tests/fixtures/other.pdf'), source)
  await addFile(source)
  const pdf = files.getByRole('article', { name: longName, exact: true })
  const folder = libraryFolder('정렬 자료')
  await expect(pdf.locator('.library-metadata')).toHaveText('1페이지 · 아직 열지 않음')
  const openedMetadata = await page.evaluate(async () => {
    const entry = (await window.desktop.listDocuments()).find(
      (d) => d.name === 'reading-notes.pdf',
    )!
    return `${entry.total}페이지 · 최근 열람 ${new Date(entry.lastOpened!).toLocaleDateString('ko-KR')}`
  })
  await expect(
    files
      .getByRole('article', { name: 'reading-notes.pdf', exact: true })
      .locator('.library-metadata'),
  ).toHaveText(openedMetadata)
  await expect(folder.locator('.library-metadata')).toHaveText('0개 항목')
  await expect(pdf.locator('.library-count')).toHaveText('0/1')
  await expect(pdf.locator('.library-state')).toHaveText('대기 중')
  await expect(pdf.getByText('페이지 번역')).toHaveCount(0)
  await expect(pdf.getByRole('button', { name: '열기', exact: true })).toHaveCount(0)
  await pdf.getByRole('progressbar').click()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('reading-notes.pdf')
  const pdfMenu = pdf.getByRole('button', { name: /메뉴$/ })
  await pdfMenu.press('Space')
  await expect(menu.getByRole('menuitem')).toHaveText([
    '파일 위치 이동',
    '실패한 페이지 재번역',
    '파일 삭제',
  ])
  await expect(menu.getByRole('menuitem', { name: '실패한 페이지 재번역' })).toBeDisabled()
  await menu.getByRole('menuitem', { name: '파일 위치 이동' }).press('Enter')
  await expect(page.getByRole('form', { name: '이동 위치 선택' })).toBeVisible()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('reading-notes.pdf')
  await page.getByRole('button', { name: '취소', exact: true }).click()
  await expect(pdfMenu).toBeFocused()
  const folderMenu = folder.getByRole('button', { name: /메뉴$/ })
  await folderMenu.press('ArrowUp')
  await expect(menu.getByRole('menuitem')).toHaveText([
    '폴더 이름 변경',
    '폴더 위치 이동',
    '폴더 삭제',
  ])
  await expect(menu.getByRole('menuitem', { name: '폴더 삭제' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(menu.getByRole('menuitem', { name: '폴더 위치 이동' })).toBeFocused()
  // Clicking elsewhere closes a menu without opening its owner.
  await files.getByRole('heading', { name: 'files', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(files.getByRole('navigation', { name: '폴더 경로' })).toHaveText('Home')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  const geometry = await files.evaluate((dialog) => {
    const rows = Array.from(dialog.querySelectorAll<HTMLElement>('.library-row'))
    const boxes = rows.map((row) => {
      const box = row.getBoundingClientRect(),
        thumb = row.querySelector('.library-thumbnail')!.getBoundingClientRect(),
        title = row.querySelector('.library-title')!.getBoundingClientRect(),
        description = row.querySelector('.library-description')!.getBoundingClientRect(),
        metadata = row.querySelector('.library-metadata')!.getBoundingClientRect(),
        menu = row.querySelector('.library-menu-trigger')!.getBoundingClientRect()
      return {
        height: box.height,
        thumbLeft: thumb.left,
        titleLeft: title.left,
        titleOffset: title.top - box.top,
        metadataOffset: metadata.top - box.top,
        metadataLeft: metadata.left,
        center: Math.abs((description.top + description.bottom - box.top - box.bottom) / 2),
        contentOverflow: description.height > box.height,
        overlap: Math.max(
          0,
          title.right -
            (row.querySelector('.library-progress')?.getBoundingClientRect().left ?? menu.left),
        ),
        menuRight: menu.right,
      }
    })
    const thumbnail = dialog
      .querySelector('.library-row:not(.library-folder) .library-thumbnail')!
      .getBoundingClientRect()
    const heading = dialog.querySelector('.library-progress-heading')!,
      count = heading.querySelector('.library-count')!.getBoundingClientRect(),
      state = heading.querySelector('.library-state')!.getBoundingClientRect()
    return {
      boxes,
      thumbnail: { width: thumbnail.width, height: thumbnail.height },
      countOverlap: Math.max(0, count.right - state.left),
      countLine: Math.abs((count.top + count.bottom - state.top - state.bottom) / 2),
      overflow: dialog.scrollWidth > dialog.clientWidth + 1,
    }
  })
  expect(new Set(geometry.boxes.map((b) => b.height)).size).toBe(1)
  expect(new Set(geometry.boxes.map((b) => b.thumbLeft)).size).toBe(1)
  expect(new Set(geometry.boxes.map((b) => b.titleLeft)).size).toBe(1)
  for (const field of ['titleOffset', 'metadataOffset'] as const)
    expect(
      Math.max(...geometry.boxes.map((b) => b[field])) -
        Math.min(...geometry.boxes.map((b) => b[field])),
    ).toBeLessThan(1)
  expect(geometry.boxes.every((b) => b.metadataLeft === b.titleLeft && !b.contentOverflow)).toBe(
    true,
  )
  expect(new Set(geometry.boxes.map((b) => b.menuRight)).size).toBe(1)
  expect(geometry.boxes.every((b) => b.center < 1 && b.overlap === 0)).toBe(true)
  expect(geometry.thumbnail.width).toBeGreaterThan(geometry.thumbnail.height)
  expect(geometry.countOverlap).toBe(0)
  expect(geometry.countLine).toBeLessThan(1)
  expect(geometry.overflow).toBe(false)
  await expect(pdf.getByRole('button', { name: `${longName} 열기`, exact: true })).toHaveAttribute(
    'title',
    longName,
  )
  await page.screenshot({ path: info.outputPath('files-minimum-rows.png') })
  await info.attach('files-layout', {
    body: JSON.stringify(geometry),
    contentType: 'application/json',
  })
  // Real metadata IPC adds enough own folders to scroll, without opening PDFs.
  await page.evaluate(async () => {
    for (let n = 0; n < 18; n++)
      await window.desktop.changeLibrary({
        kind: 'create',
        parentId: null,
        name: `스크롤 폴더 ${n}`,
      })
  })
  await expect(files.locator('.library-folder')).toHaveCount(19)
  const path = files.getByRole('navigation', { name: '폴더 경로', exact: true })
  const beforePath = await path.boundingBox()
  await pdfMenu.click()
  await expect(menu).toBeVisible()
  await files.locator('.library-list').evaluate((node) => {
    node.scrollTop = 0
  })
  expect(await path.boundingBox()).toEqual(beforePath)
  // Navigation closes an open menu, never changes the currently read PDF.
  await folder.getByRole('button', { name: '정렬 자료 폴더 열기', exact: true }).press('Enter')
  await expect(menu).toHaveCount(0)
  await expect(path).toHaveText('Home정렬 자료')
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('reading-notes.pdf')
  await rootFolder()
  await pdf.getByRole('button', { name: `${longName} 열기`, exact: true }).press('Enter')
  await expect(files).toHaveCount(0)
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText(longName)
  await ready()
})

test('file dropdowns consume the dismissing pointer gesture before PDF or folder rows execute', async () => {
  await sample()
  const source = join(profile, 'dismiss-target.pdf')
  await copyFile(resolve('tests/fixtures/other.pdf'), source)
  await addFile(source)
  await makeFolder('대상 폴더')
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  const menu = files.getByRole('menu', { name: '파일 창 메뉴', exact: true })
  const pdf = files.getByRole('article', { name: 'dismiss-target.pdf', exact: true })
  const folder = libraryFolder('대상 폴더')
  const triggers = [
    files.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }),
    pdf.getByRole('button', { name: 'dismiss-target.pdf 파일 메뉴', exact: true }),
    folder.getByRole('button', { name: '대상 폴더 폴더 메뉴', exact: true }),
  ]
  await page.evaluate(() => {
    ;(window as any).__libraryRowClicks = 0
    document.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('.library-entry-open'))
        (window as any).__libraryRowClicks++
    })
  })
  const dismissOnRow = async (target: ReturnType<Page['locator']>) => {
    const clicks = await page.evaluate(() => (window as any).__libraryRowClicks)
    const bounds = (await target.boundingBox())!
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    // React has already removed the menu before pointerup/click is delivered.
    await expect(menu).toHaveCount(0)
    await page.mouse.up()
    expect(await page.evaluate(() => (window as any).__libraryRowClicks)).toBe(clicks)
  }
  for (const trigger of triggers) {
    const reading = await page
      .locator('.document-tab[data-active="true"] .file-name, .document-add .file-name')
      .textContent()
    await trigger.click()
    await expect(menu).toBeVisible()
    await dismissOnRow(pdf.getByRole('button', { name: 'dismiss-target.pdf 열기', exact: true }))
    await expect(files).toBeVisible()
    await expect(
      page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
    ).toHaveText(reading!)
    await pdf.getByRole('button', { name: 'dismiss-target.pdf 열기', exact: true }).click()
    await expect(files).toHaveCount(0)
    await expect(
      page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
    ).toHaveText('dismiss-target.pdf')
    await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
    await trigger.click()
    await expect(menu).toBeVisible()
    const openFolder = folder.getByRole('button', { name: '대상 폴더 폴더 열기', exact: true })
    await dismissOnRow(openFolder)
    await expect(files.getByRole('navigation', { name: '폴더 경로', exact: true })).toHaveText(
      'Home',
    )
    await expect(folder).toBeVisible()
    await openFolder.click()
    await expect(files.getByRole('navigation', { name: '폴더 경로', exact: true })).toHaveText(
      'Home대상 폴더',
    )
    await rootFolder()
    await trigger.click()
    await expect(menu).toBeVisible()
    await trigger.click()
    await expect(menu).toHaveCount(0)
  }
  const plus = triggers[0]
  await plus.click()
  await files.getByRole('heading', { name: 'files', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(files).toBeVisible()
  await plus.click()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(plus).toBeFocused()
  await plus.click()
  await menu.getByRole('menuitem', { name: '폴더', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '폴더 이름', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Escape')
  await triggers[1].click()
  await menu.getByRole('menuitem', { name: '파일 위치 이동', exact: true }).click()
  await expect(page.getByRole('form', { name: '이동 위치 선택', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '취소', exact: true }).click()
})

test('file sorting applies only to PDFs, keeps folders above them, navigates parents and restores one common preference', async ({}, info) => {
  await sample()
  for (const name of ['File 2.pdf', 'File 10.pdf', 'Alpha.pdf']) {
    const fixture = await PDFDocument.create(),
      font = await fixture.embedFont(StandardFonts.Helvetica)
    fixture.addPage([300, 400]).drawText('SORT_FIXTURE ' + name, { x: 20, y: 300, size: 12, font })
    const source = join(profile, name)
    await writeFile(source, await fixture.save())
    await addFile(source)
  }
  await makeFolder('Zeta')
  await makeFolder('Alpha')
  const dbPath = join(profile, 'translations', 'translations.sqlite')
  const db = new DatabaseSync(dbPath)
  try {
    for (const [name, added, opened] of [
      ['reading-notes.pdf', 100, 50],
      ['File 2.pdf', 300, null],
      ['File 10.pdf', 400, 200],
      ['Alpha.pdf', 200, 300],
    ] as const)
      db.prepare('UPDATE documents SET added_at=?,last_opened=? WHERE name=?').run(
        added,
        opened,
        name,
      )
  } finally {
    db.close()
  }
  const before = await page.evaluate(() => window.desktop.librarySnapshot())
  let files = page.getByRole('dialog', { name: 'files', exact: true })
  const sortButton = () => files.getByRole('button', { name: /^정렬 기준:/ })
  let menu = files.getByRole('menu', { name: '파일 창 메뉴', exact: true })
  const order = () =>
    files.locator('.library-row:not(.library-folder) .library-title').allTextContents()
  const choose = async (label: string) => {
    await sortButton().click()
    await menu.getByRole('menuitemradio', { name: label, exact: true }).click()
    await expect(menu).toHaveCount(0)
    await expect(sortButton()).toHaveAttribute('aria-label', `정렬 기준: ${label}`)
  }
  const up = files.getByRole('button', { name: '상위 폴더로', exact: true })
  await expect(up).toBeDisabled()
  await expect.poll(order).toEqual(['Alpha.pdf', 'File 10.pdf', 'reading-notes.pdf', 'File 2.pdf'])
  await choose('추가된 날짜 순')
  await expect.poll(order).toEqual(['File 10.pdf', 'File 2.pdf', 'Alpha.pdf', 'reading-notes.pdf'])
  await choose('이름순')
  await expect.poll(order).toEqual(['Alpha.pdf', 'File 2.pdf', 'File 10.pdf', 'reading-notes.pdf'])
  await expect(files.locator('.library-folder .library-title')).toHaveText(['Alpha', 'Zeta'])
  expect(
    (await files.locator('.library-row .library-title').allTextContents()).slice(0, 2),
  ).toEqual(['Alpha', 'Zeta'])
  // New sort popover reuses the first-click-only dismissal rule for either row kind.
  await sortButton().click()
  await files
    .getByRole('article', { name: 'Alpha.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(menu).toHaveCount(0)
  await expect(files).toBeVisible()
  await expect(
    page.locator('.document-tab[data-active="true"] .file-name, .document-add .file-name'),
  ).toHaveText('reading-notes.pdf')
  await sortButton().click()
  await libraryFolder('Alpha').getByRole('button', { name: 'Alpha 폴더 열기', exact: true }).click()
  await expect(menu).toHaveCount(0)
  await expect(files.getByRole('navigation', { name: '폴더 경로' })).toHaveText('Home')
  await choose('추가된 날짜 순')
  await libraryFolder('Alpha').getByRole('button', { name: 'Alpha 폴더 열기', exact: true }).click()
  await makeFolder('Child')
  await libraryFolder('Child').getByRole('button', { name: 'Child 폴더 열기', exact: true }).click()
  await makeFolder('Leaf')
  await libraryFolder('Leaf').getByRole('button', { name: 'Leaf 폴더 열기', exact: true }).click()
  await up.click()
  await expect(files.getByRole('navigation', { name: '폴더 경로' })).toHaveText('HomeAlphaChild')
  await libraryFolder('Leaf').getByRole('button', { name: 'Leaf 폴더 열기', exact: true }).click()
  await files
    .getByRole('navigation', { name: '폴더 경로' })
    .getByRole('button', { name: 'Alpha', exact: true })
    .click()
  await up.click()
  await expect(files.getByRole('navigation', { name: '폴더 경로' })).toHaveText('Home')
  await expect(up).toBeDisabled()
  await expect(sortButton()).toHaveAttribute('aria-label', '정렬 기준: 추가된 날짜 순')
  const after = await page.evaluate(() => window.desktop.librarySnapshot())
  expect(after.documents).toEqual(before.documents)
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await expect(sortButton()).toHaveAttribute('aria-label', '정렬 기준: 추가된 날짜 순')
  await app.close()
  await launchApp()
  files = page.getByRole('dialog', { name: 'files', exact: true })
  menu = files.getByRole('menu', { name: '파일 창 메뉴', exact: true })
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await expect(sortButton()).toHaveAttribute('aria-label', '정렬 기준: 추가된 날짜 순')
  await sortButton().press('ArrowDown')
  await expect(menu.getByRole('menuitemradio')).toHaveText([
    '최근 열어본 순',
    '추가된 날짜 순',
    '이름순',
  ])
  await expect(
    menu.getByRole('menuitemradio', { name: '추가된 날짜 순', exact: true }),
  ).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await expect(sortButton()).toHaveAttribute('aria-label', '정렬 기준: 이름순')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  const layout = await files.locator('.library-toolbar').evaluate((n) => {
    const buttons = [...n.querySelectorAll('button')].map((b) => b.getBoundingClientRect())
    return {
      height: n.getBoundingClientRect().height,
      sortWidth: buttons[1].width,
      addWidth: buttons[2].width,
      sortHeight: buttons[1].height,
      addHeight: buttons[2].height,
      gap: buttons[2].left - buttons[1].right,
      overflow: n.scrollWidth > n.clientWidth,
    }
  })
  expect(layout).toEqual({
    height: 42,
    sortWidth: 40,
    addWidth: 40,
    sortHeight: 26,
    addHeight: 26,
    gap: 8,
    overflow: false,
  })
  await page.screenshot({ path: info.outputPath('sort-minimum.png') })
})

test('sort persistence failures and unsupported saved values keep records and the applied order intact', async () => {
  await sample()
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  let files = page.getByRole('dialog', { name: 'files', exact: true })
  const button = () => files.getByRole('button', { name: /^정렬 기준:/ })
  const menu = files.getByRole('menu', { name: '파일 창 메뉴', exact: true })
  await button().click()
  await menu.getByRole('menuitemradio', { name: '추가된 날짜 순', exact: true }).click()
  await expect(button()).toHaveAttribute('aria-label', '정렬 기준: 추가된 날짜 순')
  const before = await page.evaluate(() => window.desktop.librarySnapshot())
  const db = new DatabaseSync(join(profile, 'translations', 'translations.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER reject_sort BEFORE UPDATE ON library_settings BEGIN SELECT RAISE(ABORT,'fake sort failure'); END;",
    )
    await button().click()
    await menu.getByRole('menuitemradio', { name: '이름순', exact: true }).click()
    await expect(files.getByRole('alert')).toContainText('정렬 기준을 저장하지 못했어요')
    await expect(button()).toHaveAttribute('aria-label', '정렬 기준: 추가된 날짜 순')
    expect(db.prepare('SELECT sort_order FROM library_settings').get()?.sort_order).toBe('added')
    expect(await page.evaluate(() => window.desktop.librarySnapshot())).toEqual(before)
    expect(
      (await page.evaluate(() => window.desktop.configureLibrarySort('unsupported' as any))).status,
    ).toBe('error')
    db.exec('DROP TRIGGER reject_sort')
    db.prepare('UPDATE library_settings SET sort_order=?').run('unsupported')
  } finally {
    db.close()
  }
  await app.close()
  await launchApp()
  files = page.getByRole('dialog', { name: 'files', exact: true })
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await expect(button()).toHaveAttribute('aria-label', '정렬 기준: 최근 열어본 순')
  await ready()
  const restored = await page.evaluate(() => window.desktop.librarySnapshot())
  expect(restored.folders).toEqual(before.folders)
  expect(restored.documents.map(({ lastOpened, ...row }) => row)).toEqual(
    before.documents.map(({ lastOpened, ...row }) => row),
  )
  expect(restored.documents[0].lastOpened).toBeGreaterThan(before.documents[0].lastOpened!)
  const stats = await app.evaluate(() => (globalThis as any).__activeFake)
  expect(stats.calls).toHaveLength(0)
  expect(stats.chatCalls).toHaveLength(0)
})

test('main Tab shortcut cycles sidebar tabs without focus traversal while editing and reading arrows preserve menu/dialog exceptions', async () => {
  const current = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  const question = page.getByRole('textbox', { name: '질문', exact: true })
  const checkTabOrder = async (key: 'Tab' | 'Shift+Tab', count: number) => {
    const chrome = () =>
      page.locator('.panel-tabs, .panel-header, .translation-panel').evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node)
          return [style.outlineStyle, style.borderColor, style.boxShadow]
        }),
      )
    const before = await chrome()
    for (let i = 0; i < count; i++) {
      const selected = await page.locator('.panel-tabs [aria-selected="true"]').getAttribute('id')
      const focused = await page.evaluateHandle(() => document.activeElement!)
      await page.keyboard.press(key)
      await expect(page.locator('.panel-tabs [aria-selected="true"]')).toHaveAttribute(
        'id',
        ['translation-tab', 'chat-tab', 'memo-tab'][
          (['translation-tab', 'chat-tab', 'memo-tab'].indexOf(selected!) +
            (key === 'Tab' ? 1 : 2)) %
            3
        ],
      )
      const selectedEditor =
        (await page.locator('#chat-tab').getAttribute('aria-selected')) === 'true'
          ? question
          : page.getByRole('textbox', { name: '메모 본문', exact: true })
      if ((await selectedEditor.isVisible()) && (await selectedEditor.isEnabled()))
        await expect(selectedEditor).toBeFocused()
      else
        expect(
          await focused.evaluate((node) =>
            node.isConnected
              ? document.activeElement === node
              : document.activeElement === document.body,
          ),
        ).toBe(true)
      await focused.dispose()
      expect(await chrome()).toEqual(before)
      expect(
        await page
          .locator('.panel-tabs button')
          .evaluateAll((nodes) =>
            nodes.every((node) => getComputedStyle(node).outlineStyle === 'none'),
          ),
      ).toBe(true)
    }
  }
  const expectNeutralFocus = async () => {
    const styles = await page.evaluate(() => {
      const result = []
      let node = document.activeElement
      while (node && !node.matches('.app-shell')) {
        const style = getComputedStyle(node)
        result.push({
          outline: style.outlineStyle,
          shadow: node.matches('button, input, textarea, summary, [tabindex], .chat-input-shell')
            ? style.boxShadow
            : 'none',
        })
        node = node.parentElement
      }
      return result
    })
    expect(styles.every((s) => s.outline === 'none' && s.shadow === 'none')).toBe(true)
  }
  const expectKeyboardFocus = async () => {
    const width = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement!)
      return style.outlineStyle === 'none' ? 0 : parseFloat(style.outlineWidth)
    })
    expect(width).toBeGreaterThan(0)
  }
  for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp'])
    await page.keyboard.press(key)
  await expect(current).toHaveValue('—')
  await checkTabOrder('Tab', 4)
  await checkTabOrder('Shift+Tab', 4)
  await sample()
  await current.click()
  await expect(current).toBeFocused()
  await expectNeutralFocus()
  await checkTabOrder('Tab', 6)
  await current.click()
  await checkTabOrder('Shift+Tab', 6)
  const chatTab = page.getByRole('tab', { name: '채팅', exact: true })
  const translationTab = page.getByRole('tab', { name: '번역', exact: true })
  await chatTab.click()
  await page.keyboard.press('ArrowRight')
  await expectNeutralFocus()
  await expect(question).toBeFocused()
  await expect(current).toHaveValue('1')
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await translationTab.click()
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('2')
  await page.keyboard.press('ArrowLeft')
  await expect(current).toHaveValue('1')
  await chatTab.click()
  await current.click()
  await checkTabOrder('Tab', 9)
  await question.click()
  await expect(question).toBeFocused()
  await expectNeutralFocus()
  await checkTabOrder('Shift+Tab', 9)
  // Real cursor/selection keys must stay in their input instead of moving the PDF.
  await current.fill('1')
  await current.press('ArrowLeft')
  await expectNeutralFocus()
  await current.press('Shift+ArrowRight')
  expect(
    await current.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd]),
  ).toEqual([0, 1])
  await current.press('ArrowLeft')
  await current.press('PageDown')
  await expect(current).toHaveValue('1')
  await question.fill('abc\ndef')
  for (let i = 0; i < 4; i++) await question.press('ArrowLeft')
  await expectNeutralFocus()
  await question.press('Shift+ArrowLeft')
  expect(
    await question.evaluate((input: HTMLTextAreaElement) => [
      input.selectionStart,
      input.selectionEnd,
    ]),
  ).toEqual([2, 3])
  await expect(current).toHaveValue('1')
  await question.fill('')
  await dragPanel(page, 42)
  const divider = page.getByRole('separator', { name: '번역 패널 너비' })
  await page.keyboard.press('ArrowRight')
  await expectNeutralFocus()
  await expect(current).toHaveValue('2')
  await expect(divider).toHaveAttribute('aria-valuenow', '42')
  await page.keyboard.press('PageDown')
  await expect(current).toHaveValue('3')
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('4')
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('4')
  await expect(page.getByRole('button', { name: '다음 페이지', exact: true })).toBeDisabled()
  await page.keyboard.press('PageUp')
  await expect(current).toHaveValue('3')
  await translationTab.click()
  await page.keyboard.press('ArrowLeft')
  await expectNeutralFocus()
  await expect(current).toHaveValue('2')
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('ArrowLeft')
  await expect(current).toHaveValue('1')
  await expect(page.getByRole('button', { name: '이전 페이지', exact: true })).toBeDisabled()
  await page.getByLabel('번역 메뉴', { exact: true }).click()
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('1')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: '다시 번역', exact: true })).toBeFocused()
  await expectKeyboardFocus()
  await page.keyboard.press('ArrowLeft')
  await expect(current).toHaveValue('1')
  await page.keyboard.press('Escape')
  await expect(page.locator('.translation-menu')).not.toHaveAttribute('open', '')
  await expectNeutralFocus()
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('2')
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  await page.keyboard.press('Tab')
  expect(await files.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await expectKeyboardFocus()
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('2')
  const selectedBeforeMenu = await page
    .locator('.panel-tabs [aria-selected="true"]')
    .getAttribute('id')
  await files.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await expect(files.getByRole('menu', { name: '파일 창 메뉴', exact: true })).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(files.getByRole('menu')).toHaveCount(0)
  await expect(page.locator('.panel-tabs [aria-selected="true"]')).toHaveAttribute(
    'id',
    selectedBeforeMenu!,
  )
  expect(await files.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(files).toHaveCount(0)
  await expectNeutralFocus()
  await checkTabOrder('Tab', 4)
  await translationTab.click()
  await page.keyboard.press('ArrowRight')
  await expect(current).toHaveValue('3')
  await page.getByRole('button', { name: '설정', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'settings', exact: true })
  await page.keyboard.press('Tab')
  expect(await settings.evaluate((node) => node.contains(document.activeElement))).toBe(true)
  await expectKeyboardFocus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.settings-section-trigger[aria-expanded="true"]')).toHaveCount(1)
  await page.keyboard.press('ArrowLeft')
  await expect(current).toHaveValue('3')
  await page.keyboard.press('Escape')
  await expect(settings).not.toBeVisible()
  await expectNeutralFocus()
  await checkTabOrder('Shift+Tab', 4)
  await translationTab.click()
  await page.keyboard.press('ArrowLeft')
  await expect(current).toHaveValue('2')
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click()
  await expect(current).toHaveValue('3')
  await page.keyboard.press('ArrowLeft')
  await expect(current).toHaveValue('2')
  await expectNeutralFocus()
  await ready()
})

test('fixed files dialog keeps its frame through loading, errors, folder contents and editors while small windows scroll inside', async ({}, info) => {
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1440, 960)
    // Only this temporary process: hold/fail the snapshot, then forward the real
    // handler so folder/file operations below still use their normal IPC/DB path.
    const original = (ipcMain as any)._invokeHandlers.get('library:snapshot')
    if (!original) throw new Error('Snapshot handler missing')
    const control = { mode: 'hold', held: false, release: () => {}, restore: () => {} }
    ;(globalThis as any).__filesSize = control
    ipcMain.removeHandler('library:snapshot')
    ipcMain.handle('library:snapshot', async (event) => {
      if (control.mode === 'hold')
        await new Promise<void>((resolve) => {
          control.release = resolve
          control.held = true
        })
      // An invalid fake snapshot exercises the existing renderer error path
      // without logging an IPC exception or touching the user's storage.
      if (control.mode === 'error') return null
      return original(event)
    })
    control.restore = () => {
      ipcMain.removeHandler('library:snapshot')
      ipcMain.handle('library:snapshot', original)
    }
  })
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  const frame = () =>
    files.evaluate((node) => {
      const rect = (element: Element) => {
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }
      return {
        outer: rect(node),
        header: rect(node.querySelector('.dialog-header')!),
        toolbar: rect(node.querySelector('.library-toolbar')!),
        footer: rect(node.querySelector('.library-footer')!),
      }
    })
  await expect(files.getByText('파일 목록을 불러오는 중이에요.', { exact: true })).toBeVisible()
  await expect.poll(() => app.evaluate(() => (globalThis as any).__filesSize.held)).toBe(true)
  const normal = await frame()
  expect(normal.outer.width).toBe(980)
  expect(normal.outer.height).toBe(680)
  const stable = async (expected = normal) => {
    expect(await frame()).toEqual(expected)
    const layout = await files.evaluate((node) => {
      const list = node.querySelector('.library-list')!.getBoundingClientRect(),
        footer = node.querySelector('.library-footer')!.getBoundingClientRect()
      return {
        bottom: Math.abs(list.bottom - footer.top),
        inside:
          node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1,
      }
    })
    expect(layout.bottom).toBeLessThan(1)
    expect(layout.inside).toBe(true)
  }
  await app.evaluate(() => {
    const control = (globalThis as any).__filesSize
    control.mode = 'normal'
    control.release()
  })
  await expect(files.getByText('읽을 문서를 모아두세요', { exact: true })).toBeVisible()
  await stable()
  await app.evaluate(() => {
    ;(globalThis as any).__filesSize.mode = 'error'
  })
  await expect(files.getByRole('alert')).toBeVisible()
  await stable()
  await app.evaluate(() => {
    ;(globalThis as any).__filesSize.mode = 'normal'
  })
  await makeFolder('빈 분류')
  await stable()
  await libraryFolder('빈 분류')
    .getByRole('button', { name: '빈 분류 폴더 열기', exact: true })
    .click()
  await expect(files.getByText('빈 폴더예요', { exact: true })).toBeVisible()
  await stable()
  await rootFolder()
  await addFile(resolve('tests/fixtures/other.pdf'))
  await stable()
  await page.evaluate(async () => {
    for (let n = 0; n < 25; n++)
      await window.desktop.changeLibrary({
        kind: 'create',
        parentId: null,
        name: `분류 ${String(n).padStart(2, '0')}`,
      })
  })
  await expect(files.locator('.library-folder')).toHaveCount(26)
  await stable()
  const list = files.locator('.library-list')
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
  await list.hover()
  await page.mouse.wheel(0, 500)
  await expect.poll(() => list.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
  await stable()
  await libraryFolder('빈 분류').getByRole('button', { name: /메뉴$/ }).click()
  await expect(files.getByRole('menu')).toBeInViewport()
  await files.getByRole('menuitem', { name: '폴더 이름 변경', exact: true }).click()
  await expect(files.getByRole('textbox', { name: '폴더 이름', exact: true })).toBeInViewport()
  await stable()
  await files.getByRole('textbox', { name: '폴더 이름', exact: true }).fill('빈 분류 새 이름')
  await files.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Enter')
  await expect(libraryFolder('빈 분류 새 이름')).toBeVisible()
  await stable()
  const pdf = files.getByRole('article', { name: 'other.pdf', exact: true })
  const openMove = async () => {
    await pdf.getByRole('button', { name: /메뉴$/ }).click()
    await expect(files.getByRole('menu')).toBeInViewport()
    await files.getByRole('menuitem', { name: '파일 위치 이동', exact: true }).click()
    await expect(files.getByRole('form', { name: '이동 위치 선택', exact: true })).toBeVisible()
  }
  await openMove()
  await stable()
  const editor = files.getByRole('form', { name: '이동 위치 선택', exact: true })
  expect(await editor.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true)
  await editor.getByRole('button', { name: '이 위치로 이동', exact: true }).scrollIntoViewIfNeeded()
  await expect(editor.getByRole('button', { name: '이 위치로 이동', exact: true })).toBeInViewport()
  await stable()
  await page.screenshot({ path: info.outputPath('fixed-files-move.png') })
  await editor.getByRole('button', { name: '취소', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  const small = await frame(),
    viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  expect(small.outer.width).toBe(Math.min(980, viewport.width - 64))
  expect(small.outer.height).toBe(Math.min(680, viewport.height - 80))
  expect(small.outer.x).toBe((viewport.width - small.outer.width) / 2)
  expect(small.outer.y).toBe((viewport.height - small.outer.height) / 2)
  await stable(small)
  await openMove()
  await editor.getByRole('button', { name: '이 위치로 이동', exact: true }).scrollIntoViewIfNeeded()
  await expect(editor.getByRole('button', { name: '이 위치로 이동', exact: true })).toBeInViewport()
  await stable(small)
  await editor.getByRole('button', { name: '취소', exact: true }).click()
  await libraryFolder('빈 분류 새 이름')
    .getByRole('button', { name: '빈 분류 새 이름 폴더 열기', exact: true })
    .click()
  await expect(files.getByText('빈 폴더예요', { exact: true })).toBeVisible()
  await stable(small)
  await files.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
  await files.getByRole('menuitem', { name: '폴더', exact: true }).click()
  await files.getByRole('textbox', { name: '폴더 이름', exact: true }).fill('   ')
  await files.getByRole('textbox', { name: '폴더 이름', exact: true }).press('Enter')
  await expect(files.getByRole('alert')).toBeVisible()
  await expect(files.getByRole('textbox', { name: '폴더 이름', exact: true })).toBeInViewport()
  await stable(small)
  await page.screenshot({ path: info.outputPath('fixed-files-small-error.png') })
  await app.evaluate(() => {
    ;(globalThis as any).__filesSize.restore()
  })
  await info.attach('fixed-files-frames', {
    body: JSON.stringify({ normal, small }),
    contentType: 'application/json',
  })
})

const documentTabs = () => page.locator('.document-tab-list > .document-tab')
async function expectTabSpace(index: number) {
  const space = page.locator('.document-tab[data-drag-source="true"]')
  await expect(space).toHaveCount(1)
  await expect(space).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(space.locator('.document-tab-title')).toHaveCSS('visibility', 'hidden')
  await expect(page.locator('.document-tab-floating')).toHaveCount(1)
  await expect
    .poll(() =>
      documentTabs().evaluateAll((nodes, target) => {
        const source = nodes.findIndex((node) => node.getAttribute('data-drag-source') === 'true')
        const order = nodes.filter((_, i) => i !== source)
        order.splice(target, 0, nodes[source])
        const list = nodes[0].parentElement!,
          left = list.getBoundingClientRect().left
        const width = nodes[0].getBoundingClientRect().width,
          step = width + parseFloat(getComputedStyle(list).columnGap)
        return order.every(
          (node, i) =>
            Math.abs(node.getBoundingClientRect().left - left - i * step) < 0.5 &&
            getComputedStyle(node, '::before').opacity ===
              (i > 0 &&
              node.getAttribute('data-active') !== 'true' &&
              order[i - 1].getAttribute('data-active') !== 'true'
                ? '1'
                : '0'),
        )
      }, index),
    )
    .toBe(true)
  await expect(page.locator('.document-tab-drop')).toHaveCount(0)
}
const readingWorkspace = async () => {
  const result = await page.evaluate(() => window.desktop.readingWorkspace())
  if (result.status !== 'loaded') throw new Error('fake workspace unavailable')
  return result.workspace
}

test('Control F S W reuse main actions from reading, page and chat inputs without losing drafts or closing the app', async () => {
  await app.evaluate(({ dialog }) => {
    ;(globalThis as any).__shortcutPickerCalls = 0
    dialog.showOpenDialog = async () => {
      ;(globalThis as any).__shortcutPickerCalls++
      return { canceled: true, filePaths: [] }
    }
  })
  await sample()
  await reopen('reading-notes.pdf')
  await reopen('reading-notes.pdf')
  await documentTabs().first().getByRole('tab').click()
  await ready()
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  const settings = page.getByRole('dialog', { name: 'settings', exact: true })
  const current = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  for (const context of ['reading', 'page', 'chat']) {
    const before = await readingWorkspace()
    let input = current
    if (context === 'chat') {
      await page.getByRole('tab', { name: '채팅', exact: true }).click()
      input = page.getByRole('textbox', { name: '질문', exact: true })
      await input.fill('kept question draft')
    }
    if (context === 'reading')
      await page.locator('.reader-controls').click({ position: { x: 300, y: 5 } })
    else {
      await input.click()
      await input.press('End')
      await input.press('Shift+ArrowLeft')
    }
    const value = await input.inputValue()
    const caret = () =>
      input.evaluate((node: HTMLInputElement | HTMLTextAreaElement) => [
        node.selectionStart,
        node.selectionEnd,
      ])
    const selected = await caret()
    await page.keyboard.press('Control+f')
    await expect(files).toBeVisible()
    await expect(settings).not.toBeVisible()
    for (const key of ['Control+f', 'Control+s', 'Control+w']) await page.keyboard.press(key)
    await expect(files).toHaveCount(1)
    expect(await readingWorkspace()).toEqual(before)
    await page.keyboard.press('Escape')
    await expect(files).toHaveCount(0)
    await expect(input).toHaveValue(value)
    if (context !== 'reading') expect(await caret()).toEqual(selected)
    await page.keyboard.press('Control+s')
    await expect(settings).toBeVisible()
    for (const key of ['Control+s', 'Control+f', 'Control+w']) await page.keyboard.press(key)
    await expect(settings).toHaveCount(1)
    await expect(files).toHaveCount(0)
    expect(await readingWorkspace()).toEqual(before)
    await page.keyboard.press('Escape')
    await expect(settings).not.toBeVisible()
    await expect(input).toHaveValue(value)
    if (context !== 'reading') expect(await caret()).toEqual(selected)
    await page.keyboard.press('Control+w')
    const remaining = before.tabs.filter((t) => t.id !== before.activeId)
    await expect(documentTabs()).toHaveCount(remaining.length)
    await expect
      .poll(readingWorkspace)
      .toEqual({ tabs: remaining, activeId: remaining[0]?.id ?? null })
    expect(page.isClosed()).toBe(false)
    if (remaining.length) await ready()
  }
  await page.keyboard.press('Control+w')
  await page.keyboard.press('Control+w')
  await expect(page.getByRole('button', { name: '샘플 문서로 둘러보기' })).toBeVisible()
  expect(await app.evaluate(() => (globalThis as any).__shortcutPickerCalls)).toBe(0)
  await app.close()
  await launchApp()
  await expect(page.locator('.app-shell')).toHaveAttribute('data-tabs-ready', 'true')
  await expect(documentTabs()).toHaveCount(0)
})

test('Control main commands ignore menus and IME, consume held close repeats and restore after dismissal', async () => {
  await sample()
  await page.getByRole('tab', { name: '채팅', exact: true }).click()
  const question = page.getByRole('textbox', { name: '질문', exact: true })
  await question.fill('surviving first tab draft')
  await reopen('reading-notes.pdf')
  const before = await readingWorkspace()
  const files = page.getByRole('dialog', { name: 'files', exact: true })
  const settings = page.getByRole('dialog', { name: 'settings', exact: true })
  await page.getByRole('tab', { name: '채팅', exact: true }).click()
  await question.click()
  const session = await page.context().newCDPSession(page)
  try {
    for (const key of ['Control+f', 'Control+s', 'Control+w']) {
      await session.send('Input.imeSetComposition', {
        text: '한',
        selectionStart: 1,
        selectionEnd: 1,
      })
      await page.keyboard.press(key)
      await expect(files).toHaveCount(0)
      await expect(settings).not.toBeVisible()
      expect(await readingWorkspace()).toEqual(before)
      await question.click()
      await session.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      })
    }
  } finally {
    await session.detach()
  }
  await page.getByLabel('채팅 메뉴', { exact: true }).click()
  for (const key of ['Control+f', 'Control+s', 'Control+w']) await page.keyboard.press(key)
  await expect(page.locator('.translation-menu')).toHaveAttribute('open', '')
  await expect(files).toHaveCount(0)
  await expect(settings).not.toBeVisible()
  expect(await readingWorkspace()).toEqual(before)
  await page.keyboard.press('Escape')
  await question.fill('draft before repeated close')
  await page.keyboard.down('Control')
  await page.keyboard.down('w')
  await expect(documentTabs()).toHaveCount(1)
  await ready()
  await page.keyboard.down('w')
  await page.keyboard.down('w')
  await expect(documentTabs()).toHaveCount(1)
  await expect(question).toHaveValue('surviving first tab draft')
  await page.keyboard.up('w')
  await page.keyboard.up('Control')
  expect(await question.evaluate((node) => getComputedStyle(node).outlineStyle)).toBe('none')
  await page.keyboard.press('Control+w')
  await expect(documentTabs()).toHaveCount(0)
  expect(page.isClosed()).toBe(false)
})

async function reopen(name: string) {
  const count = await documentTabs().count()
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await page
    .getByRole('article', { name, exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
  await expect(documentTabs()).toHaveCount(count + 1)
  await expect.poll(async () => (await readingWorkspace()).tabs.length).toBe(count + 1)
  await ready()
}

test('document tabs keep duplicate PDF page, zoom and scroll independent through switching, closing and restart', async ({}, info) => {
  await sample()
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click()
  await ready()
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await ready()
  const firstZoom = await page.getByTestId('zoom-value').textContent()
  const firstId = await documentTabs().first().getAttribute('data-tab-id')
  await reopen('reading-notes.pdf')
  await expect(documentTabs()).toHaveCount(2)
  await page.getByRole('textbox', { name: '현재 페이지', exact: true }).fill('3')
  await page.getByRole('textbox', { name: '현재 페이지', exact: true }).press('Enter')
  for (let n = 0; n < 6; n++) await page.getByRole('button', { name: '확대', exact: true }).click()
  await ready()
  const secondZoom = await page.getByTestId('zoom-value').textContent()
  const viewer = page.locator('.viewer-scroll')
  await viewer.hover()
  await page.mouse.wheel(0, 280)
  await expect.poll(async () => (await readingWorkspace()).tabs[1].scrollTop).toBeGreaterThan(50)
  const scroll = await viewer.evaluate((n) => ({ top: n.scrollTop, left: n.scrollLeft }))
  await documentTabs().first().getByRole('tab').click()
  await ready()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('2')
  await expect(page.getByTestId('zoom-value')).toHaveText(firstZoom!)
  expect(await viewer.evaluate((n) => n.scrollTop)).toBe(0)
  await documentTabs().nth(1).getByRole('tab').click()
  await ready()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('3')
  await expect(page.getByTestId('zoom-value')).toHaveText(secondZoom!)
  await expect.poll(() => viewer.evaluate((n) => n.scrollTop)).toBeCloseTo(scroll.top, 0)
  await selectFile('tests/fixtures/other.pdf')
  await ready()
  await expect(documentTabs()).toHaveCount(3)
  await documentTabs().first().getByRole('tab').click()
  await ready()
  // Closing the active first tab chooses its right neighbor, not the most recent tab.
  await documentTabs()
    .first()
    .getByRole('button', { name: /탭 닫기$/ })
    .click()
  await ready()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('3')
  expect((await readingWorkspace()).tabs.some((t) => t.id === firstId)).toBe(false)
  // Closing an inactive tab does not move the current reader.
  const activeId = (await readingWorkspace()).activeId
  await documentTabs()
    .last()
    .getByRole('button', { name: /탭 닫기$/ })
    .click()
  expect((await readingWorkspace()).activeId).toBe(activeId)
  await reopen('reading-notes.pdf')
  await documentTabs().first().getByRole('tab').click()
  await ready()
  const before = await readingWorkspace()
  await page.screenshot({ path: info.outputPath('duplicate-tabs.png') })
  await app.close()
  await launchApp()
  await ready()
  expect(await readingWorkspace()).toEqual(before)
  await expect(documentTabs()).toHaveCount(2)
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('3')
  await expect
    .poll(() => page.locator('.viewer-scroll').evaluate((n) => n.scrollTop))
    .toBeCloseTo(scroll.top, 0)
  await documentTabs()
    .first()
    .getByRole('button', { name: /탭 닫기$/ })
    .click()
  await ready()
  await documentTabs()
    .first()
    .getByRole('button', { name: /탭 닫기$/ })
    .click()
  await expect(documentTabs()).toHaveCount(0)
  await expect(page.getByRole('button', { name: '파일 목록 열기' })).toHaveText('파일 선택')
  await expect.poll(async () => (await readingWorkspace()).tabs.length).toBe(0)
  await app.close()
  await launchApp()
  expect(await readingWorkspace()).toEqual({ tabs: [], activeId: null })
  await expect(page.getByRole('heading', { name: /원문 곁에 번역/ })).toBeVisible()
  expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toHaveLength(2)
  const fake = await app.evaluate(() => (globalThis as any).__activeFake)
  expect(fake.calls).toHaveLength(0)
})

test('document tabs overflow at fixed width, reveal selection, keep settings clear and do not create tabs on cancellation', async ({}, info) => {
  await addFile(null)
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await expect(documentTabs()).toHaveCount(0)
  await sample()
  const edges = () =>
    page.evaluate(() => {
      const box = (selector: string) => document.querySelector(selector)!.getBoundingClientRect()
      const left = box('.document-tab-edge[data-side="left"]'),
        right = box('.document-tab-edge[data-side="right"]'),
        first = box('.document-tab-list > .document-tab'),
        active = box('.document-tab-list > .document-tab[data-active="true"]')
      return {
        left: [left.left, left.right, left.width],
        right: [right.left, right.right, right.width],
        divider: box('.brand-divider').right,
        settings: box('.settings-trigger').left,
        first: first.left,
        active: [active.left, active.right],
      }
    })
  const few = await edges()
  expect(few.first - few.divider).toBe(13)
  expect(few.left[0]).toBe(few.divider)
  expect(few.right[1]).toBe(few.settings)
  await page.locator('.titlebar').screenshot({ path: info.outputPath('edges-few-tabs.png') })
  for (let n = 0; n < 7; n++) await reopen('reading-notes.pdf')
  await expect(documentTabs()).toHaveCount(8)
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  const measure = () =>
    page.evaluate(() => {
      const strip = document.querySelector('.document-tabs')!,
        settings = document.querySelector('.settings-trigger')!,
        nodes = [...document.querySelectorAll('.document-tab')]
      return {
        overflow: strip.scrollWidth > strip.clientWidth,
        scroll: strip.scrollLeft,
        widths: nodes.map((n) => n.getBoundingClientRect().width),
        heights: nodes.map((n) => n.getBoundingClientRect().height),
        overlap: strip.getBoundingClientRect().right > settings.getBoundingClientRect().left,
      }
    })
  const layout = await measure()
  expect(layout.overflow).toBe(true)
  expect(layout.scroll).toBeGreaterThan(0)
  expect(new Set(layout.widths).size).toBe(1)
  expect(new Set(layout.heights)).toEqual(new Set([36]))
  expect(layout.overlap).toBe(false)
  await expect(documentTabs().last()).toBeInViewport()
  await page.locator('.document-tabs').evaluate((n) => {
    n.scrollLeft = 0
  })
  await page.locator('.reader-controls').hover()
  const appearance = () =>
    documentTabs().evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        return {
          background: style.backgroundColor,
          shadow: style.boxShadow,
          divider: getComputedStyle(node, '::before').opacity,
          dividerWidth: getComputedStyle(node, '::before').width,
          close: getComputedStyle(node.querySelector('.document-tab-close')!).opacity,
        }
      }),
    )
  const plain = await appearance()
  expect(plain[0].background).toBe('rgba(0, 0, 0, 0)')
  expect(plain[0].close).toBe('0')
  expect(plain[1].divider).toBe('1')
  expect(plain[2].divider).toBe('1')
  expect(plain[1].dividerWidth).toBe('1px')
  expect(plain.at(-1)!.close).toBe('1')
  expect(plain.every((state) => state.shadow === 'none')).toBe(true)
  const gap = await documentTabs()
    .nth(1)
    .evaluate(
      (node) =>
        node.getBoundingClientRect().left -
        node.previousElementSibling!.getBoundingClientRect().right,
    )
  expect(gap).toBe(3)
  await documentTabs().nth(1).hover()
  await expect
    .poll(async () => {
      const state = await appearance()
      return [state[1].divider, state[2].divider, state[1].close]
    })
    .toEqual(['0', '0', '1'])
  expect((await appearance())[1].background).not.toBe(plain[1].background)
  await page.locator('.reader-controls').hover()
  await expect
    .poll(async () => {
      const state = await appearance()
      return [state[1].divider, state[2].divider, state[1].close]
    })
    .toEqual(['1', '1', '0'])
  await documentTabs().first().getByRole('tab').click()
  await ready()
  await expect(documentTabs().first()).toBeInViewport()
  await documentTabs().nth(1).hover()
  await expect.poll(async () => (await appearance())[1].close).toBe('1')
  await expect.poll(async () => (await appearance())[2].divider).toBe('0')
  await page.screenshot({ path: info.outputPath('styled-tabs.png') })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(
    await documentTabs()
      .nth(1)
      .evaluate((node) => getComputedStyle(node, '::before').transitionDuration),
  ).toBe('0s')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'settings', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '설정 닫기' }).click()
  await page.locator('.document-tabs').evaluate((n) => {
    n.scrollLeft = n.scrollWidth
  })
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await expect(documentTabs()).toHaveCount(8)
  await documentTabs()
    .last()
    .getByRole('button', { name: /탭 닫기$/ })
    .click()
  await expect(documentTabs()).toHaveCount(7)
  await page.screenshot({ path: info.outputPath('overflow-tabs.png') })
  for (const theme of THEME_PALETTE) {
    await page.getByRole('button', { name: '설정', exact: true }).click()
    await page.getByRole('button', { name: '테마 선택', exact: true }).click()
    await page.getByRole('button', { name: `${theme.name} 테마`, exact: true }).click()
    await page.getByRole('button', { name: '테마 적용', exact: true }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id)
    await page.getByRole('button', { name: '설정 닫기' }).click()
    for (const position of [0, 0.5, 1]) {
      await page.locator('.document-tabs').evaluate((node, fraction) => {
        node.scrollLeft = (node.scrollWidth - node.clientWidth) * fraction
      }, position)
      const layout = await edges()
      expect(layout.left).toEqual([layout.divider, layout.divider + 13, 13])
      expect(layout.right).toEqual([layout.settings - 14, layout.settings, 14])
      expect(
        await page.locator('.document-tab-edge').evaluateAll((nodes) => {
          const sidebar = document.querySelector('.language-bar')!
          const curve = (node: Element, pseudo: string) =>
            getComputedStyle(node, pseudo).maskImage.replace(/to (right|left|bottom), /, '')
          const frame = getComputedStyle(document.querySelector('.titlebar')!).backgroundColor
          return nodes.map((node) => {
            const rect = node.getBoundingClientRect()
            return {
              blurCurve: curve(node, '::before') === curve(sidebar, '::before'),
              fadeCurve: curve(node, '::after') === curve(sidebar, '::after'),
              strength:
                getComputedStyle(node, '::before').backdropFilter ===
                getComputedStyle(sidebar, '::before').backdropFilter,
              color: getComputedStyle(node, '::after').backgroundColor === frame,
              input: !!document
                .elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
                ?.closest('.document-tabs'),
            }
          })
        }),
      ).toEqual(
        Array(2).fill({
          blurCurve: true,
          fadeCurve: true,
          strength: true,
          color: true,
          input: true,
        }),
      )
      await page.locator('.titlebar').screenshot({
        path: info.outputPath(`edges-${theme.id}-${position}.png`),
      })
    }
  }
  await page.locator('.document-tabs').evaluate((node) => {
    node.scrollLeft = 0
  })
  await page.locator('.document-tabs').hover()
  await page.mouse.wheel(90, 0)
  await expect
    .poll(() => page.locator('.document-tabs').evaluate((node) => node.scrollLeft))
    .toBeGreaterThan(0)
  await documentTabs().last().getByRole('tab').click()
  await ready()
  const revealed = await edges()
  expect(revealed.active[0]).toBeGreaterThanOrEqual(revealed.left[1] - 0.5)
  expect(revealed.active[1]).toBeLessThanOrEqual(revealed.right[0] + 0.5)
})

test('document tabs show save and missing-original failures without replacing stored state or opening a picker', async () => {
  const original = join(profile, 'tabs-original.pdf')
  await copyFile(resolve('tests/fixtures/other.pdf'), original)
  await selectFile(original)
  await ready()
  await expect.poll(async () => (await readingWorkspace()).tabs.length).toBe(1)
  const before = await readingWorkspace()
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  db.exec(
    "CREATE TRIGGER reject_tabs BEFORE UPDATE ON reading_workspace BEGIN SELECT RAISE(ABORT,'fake save failure'); END;",
  )
  await page.getByRole('button', { name: '확대', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('저장하지 못했어요')
  expect(await readingWorkspace()).toEqual(before)
  db.exec('DROP TRIGGER reject_tabs')
  db.close()
  await app.close()
  await import('node:fs/promises').then(({ rm }) => rm(original))
  await launchApp()
  await expect(documentTabs()).toHaveCount(1)
  await expect(page.getByRole('alert')).toContainText('원본 PDF에 접근할 수 없어요')
  expect(await readingWorkspace()).toEqual(before)
  // Reconnect is still an explicit library action; cancel must not add a tab.
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
  })
  await page.getByRole('button', { name: '파일 목록 열기' }).click()
  await page
    .getByRole('article', { name: 'tabs-original.pdf', exact: true })
    .getByRole('button', { name: /열기$/ })
    .click()
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toBeVisible()
  await expect(documentTabs()).toHaveCount(1)
  expect(await readingWorkspace()).toEqual(before)
})

test('sidebar Tab shortcut consumes held repeats, preserves input caret and ignores active IME composition', async ({}, info) => {
  await sample()
  const current = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  const translation = page.getByRole('tab', { name: '번역', exact: true })
  const chatTab = page.getByRole('tab', { name: '채팅', exact: true })
  const memoTab = page.getByRole('tab', { name: '메모', exact: true })
  await current.click()
  await current.press('ArrowLeft')
  const caret = await current.evaluate((node: HTMLInputElement) => [
    node.selectionStart,
    node.selectionEnd,
  ])
  await page.keyboard.press('Tab')
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: '질문', exact: true })).toBeFocused()
  expect(
    await current.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd]),
  ).toEqual(caret)
  await page.keyboard.down('Tab')
  await expect(memoTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.down('Tab')
  await expect(memoTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.up('Tab')
  await page.keyboard.down('Shift')
  await page.keyboard.down('Tab')
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.down('Tab')
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.up('Tab')
  await page.keyboard.up('Shift')
  await expect(page.getByRole('textbox', { name: '질문', exact: true })).toBeFocused()
  const question = page.getByRole('textbox', { name: '질문', exact: true })
  await question.click()
  await page.evaluate(() => {
    const events: unknown[] = []
    ;(window as any).__tabImeEvents = events
    for (const type of ['compositionstart', 'compositionend', 'focusout', 'keydown'])
      window.addEventListener(type, (event) => {
        const key = event as globalThis.KeyboardEvent
        if (type === 'keydown' && key.key !== 'Tab') return
        events.push({
          type,
          target: (event.target as HTMLElement).tagName,
          composing: key.isComposing ?? false,
          prevented: event.defaultPrevented,
        })
      })
  })
  const session = await page.context().newCDPSession(page)
  try {
    // Chromium composition with real keyboard Tab, without changing the OS IME.
    await session.send('Input.imeSetComposition', {
      text: '한',
      selectionStart: 1,
      selectionEnd: 1,
    })
    await expect(question).toHaveValue('한')
    await page.keyboard.press('Tab')
    await expect(chatTab).toHaveAttribute('aria-selected', 'true')
    await expect(question).toHaveValue('한')
    // Native Tab may move focus out while Chromium's injected IME remains active.
    // The CDP cancel command must target the focused editor to end composition.
    await question.click()
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (window as any).__tabImeEvents.some(
            (event: { type: string }) => event.type === 'compositionend',
          ),
        ),
      )
      .toBe(true)
  } finally {
    await info.attach('ime-event-types', {
      body: JSON.stringify(await page.evaluate(() => (window as any).__tabImeEvents)),
      contentType: 'application/json',
    })
    await session.detach()
  }
  await question.click()
  await page.keyboard.press('Shift+Tab')
  await expect(translation).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('Tab')
  await expect(chatTab).toHaveAttribute('aria-selected', 'true')
  await expect(current).toHaveValue('1')
  expect((await app.evaluate(() => (globalThis as any).__activeFake)).chatCalls).toHaveLength(0)
})

test('dragging the second document tab to the front preserves active duplicate reading states and restores the order', async ({}, info) => {
  await sample()
  await page.getByRole('button', { name: '다음 페이지', exact: true }).click()
  await ready()
  await reopen('reading-notes.pdf')
  await page.getByRole('textbox', { name: '현재 페이지' }).fill('3')
  await page.getByRole('textbox', { name: '현재 페이지' }).press('Enter')
  for (let n = 0; n < 6; n++) await page.getByRole('button', { name: '확대', exact: true }).click()
  await ready()
  await page.locator('.viewer-scroll').hover()
  await page.mouse.wheel(0, 240)
  await expect.poll(async () => (await readingWorkspace()).tabs[1].scrollTop).toBeGreaterThan(50)
  await selectFile('tests/fixtures/other.pdf')
  await ready()
  await documentTabs().nth(1).getByRole('tab').click()
  await ready()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('3')
  const before = await readingWorkspace()
  const first = (await documentTabs().nth(1).getByRole('tab').boundingBox())!
  const target = (await documentTabs().first().boundingBox())!
  await page.mouse.move(first.x + first.width / 2, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(target.x + 4, target.y + target.height / 2, { steps: 15 })
  await expectTabSpace(0)
  expect(await readingWorkspace()).toEqual(before)
  await page.screenshot({ path: info.outputPath('tab-space-front.png') })
  await page.mouse.up()
  const expected = { ...before, tabs: [before.tabs[1], before.tabs[0], before.tabs[2]] }
  await expect.poll(readingWorkspace).toEqual(expected)
  await expect(page.locator('.document-tab[data-drag-source="true"]')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('3')
  await expect
    .poll(() => page.locator('.viewer-scroll').evaluate((node) => node.scrollTop))
    .toBeCloseTo(before.tabs[1].scrollTop, 0)
  await app.close()
  await launchApp()
  await ready()
  expect(await readingWorkspace()).toEqual(expected)
  expect(
    await documentTabs().evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.tabId),
    ),
  ).toEqual(expected.tabs.map((tab) => tab.id))
  await page.keyboard.press('Control+Tab')
  await expect(documentTabs().nth(1)).toHaveAttribute('data-active', 'true')
  await ready()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('2')
  await page.keyboard.press('Control+Shift+Tab')
  await expect(documentTabs().first()).toHaveAttribute('data-active', 'true')
  await ready()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toHaveValue('3')
  expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toHaveLength(2)
  expect((await app.evaluate(() => (globalThis as any).__activeFake)).calls).toHaveLength(0)
})

test('overflow document tab drag scrolls to the end while Escape and invalid drops never select, close or add tabs', async ({}, info) => {
  await sample()
  for (let n = 0; n < 7; n++) await reopen('reading-notes.pdf')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1000)
  const strip = page.locator('.document-tabs')
  await strip.evaluate((node) => {
    node.scrollLeft = 0
  })
  const before = await readingWorkspace()
  const source = (await documentTabs().first().getByRole('tab').boundingBox())!
  const bounds = (await strip.boundingBox())!
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 4, source.y + source.height / 2, { steps: 15 })
  try {
    await expect
      .poll(() => strip.evaluate((node) => node.scrollWidth - node.clientWidth - node.scrollLeft))
      .toBeLessThan(2)
  } catch (error) {
    await info.attach('tab-scroll-geometry', {
      contentType: 'application/json',
      body: JSON.stringify(
        await strip.evaluate((node) => ({
          bounds: node.getBoundingClientRect().toJSON(),
          scroll: node.scrollLeft,
          width: node.scrollWidth,
          client: node.clientWidth,
          dragging: node.getAttribute('data-dragging'),
          focused: document.activeElement?.className,
          floating: document
            .querySelector('.document-tab-floating')
            ?.getBoundingClientRect()
            .toJSON(),
        })),
      ),
    })
    throw error
  }
  const last = (await documentTabs().last().boundingBox())!
  await page.mouse.move(last.x + last.width - 8, last.y + last.height / 2)
  await expectTabSpace(7)
  await page.screenshot({ path: info.outputPath('overflow-drag.png') })
  await page.mouse.up()
  const reordered = { ...before, tabs: [...before.tabs.slice(1), before.tabs[0]] }
  await expect.poll(readingWorkspace).toEqual(reordered)
  for (const cancel of ['Escape', 'outside', 'add'] as const) {
    const button = documentTabs().last().getByRole('tab')
    const box = (await button.boundingBox())!
    const previous = (await documentTabs().nth(6).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(previous.x + previous.width / 2, box.y + box.height / 2, { steps: 8 })
    await expectTabSpace(6)
    if (cancel === 'Escape') await page.keyboard.press('Escape')
    else if (cancel === 'outside') {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height + 40)
      await expect(page.locator('.document-tab-floating')).toBeVisible()
      const floating = (await page.locator('.document-tab-floating').boundingBox())!
      expect(floating.y).toBeGreaterThan(bounds.y + bounds.height)
      await page.screenshot({ path: info.outputPath('floating-outside-strip.png') })
    } else {
      const add = (await page
        .getByRole('button', { name: '파일 목록 열기', exact: true })
        .boundingBox())!
      await page.mouse.move(add.x + add.width / 2, add.y + add.height / 2)
      await expect(page.locator('.document-tab-floating')).toBeVisible()
    }
    await page.mouse.up()
    await expect(page.locator('.document-tab-floating')).toHaveCount(0)
    expect(await readingWorkspace()).toEqual(reordered)
    await expect(documentTabs()).toHaveCount(8)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(strip).toHaveAttribute('data-dragging', 'false')
  }
  // The canceled drag leaves no click shield behind.
  await documentTabs().last().getByRole('tab').click()
  await ready()
  await expect.poll(async () => (await readingWorkspace()).activeId).toBe(before.tabs[0].id)
  const selected = await readingWorkspace()
  const reverse = (await documentTabs().last().getByRole('tab').boundingBox())!
  await page.mouse.move(reverse.x + reverse.width / 2, reverse.y + reverse.height / 2)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 4, reverse.y + reverse.height / 2, { steps: 15 })
  await expect.poll(() => strip.evaluate((node) => node.scrollLeft)).toBeLessThan(1)
  await expectTabSpace(0)
  await page.screenshot({ path: info.outputPath('scrolled-tab-space-front.png') })
  await page.mouse.up()
  await expect.poll(readingWorkspace).toEqual({
    ...selected,
    tabs: [selected.tabs.at(-1)!, ...selected.tabs.slice(0, -1)],
  })
  await documentTabs()
    .last()
    .getByRole('button', { name: /탭 닫기$/ })
    .click()
  await expect(documentTabs()).toHaveCount(7)
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'files', exact: true })).toBeVisible()
})

test('last tab reaches the first slot and rapid reversals keep one stable space until drop or cancellation', async ({}, info) => {
  await sample()
  for (let n = 0; n < 3; n++) await reopen('reading-notes.pdf')
  const before = await readingWorkspace()
  const boxes = await documentTabs().evaluateAll((nodes) =>
    nodes.map((node) => {
      const rect = node.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }),
  )
  const last = (await documentTabs().last().getByRole('tab').boundingBox())!
  const y = last.y + last.height / 2
  await page.mouse.move(last.x + last.width / 2, y)
  await page.mouse.down()
  for (const index of [0, 2, 0, 1]) {
    await page.mouse.move(boxes[index].x + boxes[index].width / 2, y)
  }
  await expectTabSpace(1)
  // Stationary pointer: animations must not feed back into candidate selection.
  const stable = await documentTabs().evaluateAll((nodes) =>
    nodes.map((node) => node.getBoundingClientRect().left),
  )
  await page.mouse.move(boxes[1].x + boxes[1].width / 2 + 1, y)
  await expectTabSpace(1)
  const step = boxes[1].x - boxes[0].x
  const boundary = boxes[0].x + (last.x + last.width / 2 - boxes[3].x) + 1.5 * step
  for (const dx of [1, -1, 1, -1]) {
    await page.mouse.move(boundary + dx, y)
    await expectTabSpace(1)
  }
  expect(
    await documentTabs().evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().left),
    ),
  ).toEqual(stable)
  await page.screenshot({ path: info.outputPath('tab-space-middle.png') })
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await readingWorkspace()).toEqual(before)
  await expect(page.locator('.document-tab[data-drag-source="true"]')).toHaveCount(0)
  // Reduced motion still reserves the full first slot with no translation animation.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.mouse.move(last.x + last.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(boxes[0].x + 4, y, { steps: 10 })
  await expectTabSpace(0)
  expect(
    await documentTabs()
      .first()
      .evaluate((node) => getComputedStyle(node).transitionDuration),
  ).toBe('0s')
  await page.mouse.up()
  await expect
    .poll(readingWorkspace)
    .toEqual({ ...before, tabs: [before.tabs[3], ...before.tabs.slice(0, 3)] })
  await expect(page.locator('.document-tab[data-drag-source="true"]')).toHaveCount(0)
  expect(
    await documentTabs().evaluateAll((nodes) =>
      nodes.every((node) => getComputedStyle(node).transform === 'none'),
    ),
  ).toBe(true)
})

for (const activeDrag of [true, false])
  test(`${activeDrag ? 'active' : 'inactive'} floating tab tracks its grab point and projected-order dividers at front, middle and end`, async ({}, info) => {
    await sample()
    for (let n = 0; n < 3; n++) await reopen('reading-notes.pdf')
    await documentTabs().nth(1).getByRole('tab').click()
    await ready()
    const initial = await readingWorkspace(),
      id = initial.tabs[activeDrag ? 1 : 2].id
    const source = page.locator(`.document-tab-list > [data-tab-id="${id}"]`)
    const floating = page.locator('.document-tab-floating')
    const dividers = async (tabs: typeof initial.tabs) => {
      await expect
        .poll(() =>
          documentTabs().evaluateAll((nodes) =>
            nodes.map((node) => getComputedStyle(node, '::before').opacity),
          ),
        )
        .toEqual(
          (await readingWorkspace()).tabs.map((tab) => {
            const index = tabs.findIndex((item) => item.id === tab.id)
            return index > 0 &&
              tab.id !== initial.activeId &&
              tabs[index - 1].id !== initial.activeId
              ? '1'
              : '0'
          }),
        )
    }
    await page.evaluate(() => {
      ;(window as any).__nativeTabDrags = 0
      document.addEventListener('dragstart', (event) => {
        if (!event.defaultPrevented) (window as any).__nativeTabDrags++
      })
    })
    for (const target of [0, 2, 3]) {
      const before = await readingWorkspace()
      await source.getByRole('tab').hover()
      await expect
        .poll(() => source.evaluate((node) => node.getAnimations({ subtree: true }).length))
        .toBe(0)
      const original = await source.evaluate((node) => {
        const rect = node.getBoundingClientRect(),
          style = getComputedStyle(node)
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          background: style.backgroundColor,
          radius: style.borderRadius,
        }
      })
      const button = (await source.getByRole('tab').boundingBox())!
      const x = button.x + 17,
        y = button.y + 11
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 8, y + 3)
      await expect(floating).toHaveCount(1)
      const tracks = async (pointerX: number, pointerY: number) => {
        await expect
          .poll(async () => {
            const rect = (await floating.boundingBox())!
            return (
              Math.abs(rect.x - (pointerX - x + original.x)) < 0.5 &&
              Math.abs(rect.y - (pointerY - y + original.y)) < 0.5
            )
          })
          .toBe(true)
      }
      await tracks(x + 8, y + 3)
      await expect(floating).toHaveCSS(
        'background-image',
        `linear-gradient(${original.background}, ${original.background}), none`,
      )
      await expect(floating).toHaveCSS('border-radius', original.radius)
      await expect(floating.locator('.file-name')).toHaveText(initial.tabs[0].name)
      await expect(floating.locator('.document-tab-close')).toHaveCSS('opacity', '1')
      await expect(source.locator('.file-name')).toHaveCSS('visibility', 'hidden')
      expect((await floating.boundingBox())!.width).toBe(original.width)
      expect((await floating.boundingBox())!.height).toBe(original.height)
      expect(await floating.evaluate((node) => node.closest('.document-tabs') === null)).toBe(true)
      const destination =
        (await documentTabs()
          .nth(target)
          .evaluate((node) => {
            // offsetLeft is the fixed slot, independent of animation transforms.
            return (
              node.parentElement!.getBoundingClientRect().left + (node as HTMLElement).offsetLeft
            )
          })) +
        x -
        original.x
      await page.mouse.move(destination, y + 7, { steps: 8 })
      await tracks(destination, y + 7)
      await expectTabSpace(target)
      const expected = before.tabs.filter((tab) => tab.id !== id)
      expected.splice(
        target,
        0,
        before.tabs.find((tab) => tab.id === id)!,
      )
      await dividers(expected)
      expect(await readingWorkspace()).toEqual(before)
      await page.screenshot({ path: info.outputPath(`floating-slot-${target}.png`) })
      await page.mouse.up()
      await expect(floating).toHaveCount(0)
      await expect.poll(readingWorkspace).toEqual({ ...before, tabs: expected })
      await page.locator('.reader-controls').click({ position: { x: 350, y: 5 } })
      await dividers(expected)
    }
    // Cancel restores the committed order, including the active tab's dividers.
    const committed = await readingWorkspace(),
      button = (await source.getByRole('tab').boundingBox())!
    const first = (await documentTabs().first().boundingBox())!
    await page.mouse.move(button.x + 17, button.y + 11)
    await page.mouse.down()
    await page.mouse.move(first.x + 4, button.y + 11, { steps: 5 })
    await expectTabSpace(0)
    await page.keyboard.press('Escape')
    await page.mouse.up()
    await expect(floating).toHaveCount(0)
    expect(await readingWorkspace()).toEqual(committed)
    await page.locator('.reader-controls').click({ position: { x: 350, y: 5 } })
    await dividers(committed.tabs)
    expect(await page.evaluate(() => (window as any).__nativeTabDrags)).toBe(0)
    expect((await app.evaluate(() => (globalThis as any).__activeFake)).calls).toHaveLength(0)
  })

test('Ctrl Tab cycles document order once per press from inputs and preserves sidebar, menu and IME exceptions', async ({}, info) => {
  const current = page.getByRole('textbox', { name: '현재 페이지', exact: true })
  const chat = page.getByRole('tab', { name: '채팅', exact: true })
  const translation = page.getByRole('tab', { name: '번역', exact: true })
  await page.keyboard.press('Control+Tab')
  await expect(documentTabs()).toHaveCount(0)
  await sample()
  await current.click()
  await page.keyboard.press('Control+Shift+Tab')
  await expect(current).toBeFocused()
  const one = await readingWorkspace()
  expect(one.tabs).toHaveLength(1)
  await reopen('reading-notes.pdf')
  await reopen('reading-notes.pdf')
  const tabs = (await readingWorkspace()).tabs
  const active = async () =>
    documentTabs().evaluateAll((nodes) =>
      nodes
        .find((node) => (node as HTMLElement).dataset.active === 'true')
        ?.getAttribute('data-tab-id'),
    )
  await current.click()
  await current.press('ArrowLeft')
  const caret = await current.evaluate((node: HTMLInputElement) => [
    node.selectionStart,
    node.selectionEnd,
  ])
  for (const [key, id] of [
    ['Control+Tab', tabs[0].id],
    ['Control+Tab', tabs[1].id],
    ['Control+Shift+Tab', tabs[0].id],
    ['Control+Shift+Tab', tabs[2].id],
  ]) {
    await page.keyboard.press(key)
    await expect.poll(active).toBe(id)
    await ready()
    await expect(current).toBeFocused()
    expect(
      await current.evaluate((node: HTMLInputElement) => [node.selectionStart, node.selectionEnd]),
    ).toEqual(caret)
    await expect(translation).toHaveAttribute('aria-selected', 'true')
  }
  await page.keyboard.down('Control')
  await page.keyboard.down('Tab')
  await expect.poll(active).toBe(tabs[0].id)
  await ready()
  await page.keyboard.down('Tab')
  await expect.poll(active).toBe(tabs[0].id)
  await page.keyboard.up('Tab')
  await page.keyboard.up('Control')
  await page.keyboard.press('Tab')
  await expect(chat).toHaveAttribute('aria-selected', 'true')
  const question = page.getByRole('textbox', { name: '질문', exact: true })
  await question.fill('draft')
  await question.press('ArrowLeft')
  await page.keyboard.press('Control+Tab')
  await expect.poll(active).toBe(tabs[1].id)
  await ready()
  await expect(question).toBeFocused()
  await expect(question).toHaveValue('')
  await page.keyboard.insertText('second tab draft')
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Input.imeSetComposition', {
      text: '한',
      selectionStart: 1,
      selectionEnd: 1,
    })
    const composing = await question.inputValue()
    await page.keyboard.press('Control+Tab')
    await expect.poll(active).toBe(tabs[1].id)
    await expect(question).toHaveValue(composing)
    await question.click()
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  } finally {
    await session.detach()
  }
  await question.click()
  await page.keyboard.press('Control+Shift+Tab')
  await expect.poll(active).toBe(tabs[0].id)
  await ready()
  await expect(question).toHaveValue('draft')
  await page.keyboard.press('Shift+Tab')
  await expect(translation).toHaveAttribute('aria-selected', 'true')
  await page.locator('.translation-menu summary').click()
  await page.keyboard.press('Control+Tab')
  await expect.poll(active).toBe(tabs[0].id)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await page.keyboard.press('Control+Tab')
  await expect.poll(active).toBe(tabs[0].id)
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.keyboard.press('Control+Shift+Tab')
  await expect.poll(active).toBe(tabs[0].id)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+Tab')
  await expect.poll(active).toBe(tabs[1].id)
  await ready()
  await page.screenshot({ path: info.outputPath('document-keyboard.png') })
  expect((await app.evaluate(() => (globalThis as any).__activeFake)).chatCalls).toHaveLength(0)
})

const deleteFiles = () => page.getByRole('dialog', { name: 'files', exact: true })
async function showDeleteFiles() {
  if (!(await deleteFiles().isVisible()))
    await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
}
async function deleteConfirmation(name: string, kind: '파일' | '폴더' = '파일') {
  await page.getByRole('button', { name: `${name} ${kind} 메뉴`, exact: true }).click()
  await page.getByRole('menuitem', { name: `${kind} 삭제`, exact: true }).click()
  await expect(page.getByRole('menu', { name: '파일 삭제 확인', exact: true })).toBeVisible()
}
function libraryDB() {
  return new DatabaseSync(join(profile, 'translations/translations.sqlite'))
}

test('file deletion confirms in the same menu, consumes dismissal clicks, rolls back failure, closes all duplicate tabs and preserves original and unrelated records after restart', async ({}, info) => {
  const originals: Record<string, Uint8Array> = {}
  for (const name of ['delete-A', 'keep-B']) {
    const pdf = await PDFDocument.create()
    pdf.addPage([400, 300])
    pdf.setTitle(name)
    originals[name] = await pdf.save()
    const path = join(profile, name + '.pdf')
    await writeFile(path, originals[name])
    await addFile(path)
  }
  const snapshot = await page.evaluate(() => window.desktop.librarySnapshot())
  const a = snapshot.documents.find((d) => d.name === 'delete-A.pdf')!.id,
    b = snapshot.documents.find((d) => d.name === 'keep-B.pdf')!.id
  const openRow = async (name: string) => {
    await showDeleteFiles()
    await deleteFiles()
      .getByRole('button', { name: name + '.pdf 열기', exact: true })
      .click()
    await expect(deleteFiles()).toHaveCount(0)
    await expect(page.locator('.document-tab[data-active="true"] .file-name')).toHaveText(
      name + '.pdf',
    )
    await ready()
  }
  await openRow('delete-A')
  await openRow('keep-B')
  await openRow('delete-A')
  const keptBefore = await page.evaluate(() => window.desktop.readingWorkspace())
  await showDeleteFiles()
  await makeFolder('keep-folder')
  const common = await page.evaluate(
    async ({ a }) => {
      const note = await window.desktop.memoCreate('keep common')
      await window.desktop.memoLoad({ kind: 'page', documentId: a, page: 1 })
      return note.status === 'ok' ? note.value.id : ''
    },
    { a },
  )
  const db = libraryDB()
  db.prepare(
    'INSERT INTO translations(document_id,page,version,status,text) VALUES(?,1,?, ?,?)',
  ).run(a, 'legacy', 'done', 'fake')
  db.prepare(
    'INSERT INTO translation_history(document_id,page,version,status,text) VALUES(?,1,?, ?,?)',
  ).run(a, 'legacy', 'done', 'fake')
  db.prepare('INSERT INTO translation_overrides(document_id,page) VALUES(?,1)').run(a)
  db.prepare('INSERT INTO page_chats(id,document_id,page) VALUES(?,?,1)').run('fake-chat', a)
  db.prepare(
    "INSERT INTO chat_turns(id,conversation_id,ordinal,request_id,question,answer,status,model,attachment_json) VALUES('fake-turn','fake-chat',1,'fake-request','fake','fake','complete','fake','{}')",
  ).run()
  const before = () =>
    [
      'documents',
      'translations',
      'translation_history',
      'translation_overrides',
      'memos',
      'page_chats',
      'chat_turns',
      'reading_workspace',
      'library_folders',
    ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
  await deleteConfirmation('delete-A.pdf')
  const popup = page.getByRole('menu', { name: '파일 삭제 확인', exact: true })
  await popup.getByRole('menuitem', { name: '취소', exact: true }).click()
  await deleteConfirmation('delete-A.pdf')
  await page.keyboard.press('Escape')
  await expect(popup).toHaveCount(0)
  await deleteConfirmation('delete-A.pdf')
  await deleteFiles().getByRole('button', { name: 'keep-B.pdf 열기', exact: true }).click()
  await expect(popup).toHaveCount(0)
  await expect(deleteFiles()).toBeVisible()
  await deleteFiles().getByRole('button', { name: 'keep-folder 폴더 열기', exact: true }).click()
  await expect(
    deleteFiles().getByRole('navigation', { name: '폴더 경로', exact: true }),
  ).toHaveText('Homekeep-folder')
  await rootFolder()
  const saved = before()
  db.exec(
    "CREATE TRIGGER reject_library_delete BEFORE DELETE ON documents BEGIN SELECT RAISE(FAIL,'PRIVATE_DELETE_DIAGNOSTIC'); END",
  )
  await deleteFiles().evaluate((dialog) => {
    dialog.style.height = '280px'
  })
  await deleteConfirmation('delete-A.pdf')
  await popup.getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(popup.getByRole('alert')).toBeVisible()
  const popupBounds = (await popup.boundingBox())!,
    dialogBounds = (await deleteFiles().boundingBox())!
  expect(popupBounds.y).toBeGreaterThanOrEqual(dialogBounds.y)
  expect(popupBounds.y + popupBounds.height).toBeLessThanOrEqual(
    dialogBounds.y + dialogBounds.height,
  )
  expect(before()).toEqual(saved)
  await expect(page.locator('.document-tab')).toHaveCount(3)
  db.exec('DROP TRIGGER reject_library_delete')
  await page.screenshot({ path: info.outputPath('file-delete-confirm-failure.png') })
  await popup.getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(
    deleteFiles().getByRole('article', { name: 'delete-A.pdf', exact: true }),
  ).toHaveCount(0)
  await expect(page.locator('.document-tab')).toHaveCount(1)
  await expect(page.locator('.document-tab[data-active="true"] .file-name')).toHaveText(
    'keep-B.pdf',
  )
  for (const t of [
    'translations',
    'translation_history',
    'translation_overrides',
    'page_chats',
    'memos',
  ])
    expect(db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE document_id=?`).get(a)?.n).toBe(0)
  expect(db.prepare('SELECT COUNT(*) n FROM chat_turns').get()?.n).toBe(0)
  expect(db.prepare('SELECT id FROM memos WHERE id=?').get(common)?.id).toBe(common)
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  db.close()
  expect(new Uint8Array(await readFile(join(profile, 'delete-A.pdf')))).toEqual(
    originals['delete-A'],
  )
  await page.getByRole('button', { name: '파일 목록 닫기' }).click()
  await ready()
  const kept = await page.evaluate(() => window.desktop.readingWorkspace())
  if (kept.status === 'loaded' && keptBefore.status === 'loaded')
    expect(kept.workspace.tabs).toEqual(keptBefore.workspace.tabs.filter((t) => t.documentId === b))
  await app.close()
  await launchApp()
  await ready()
  await showDeleteFiles()
  await expect(
    deleteFiles().getByRole('article', { name: 'delete-A.pdf', exact: true }),
  ).toHaveCount(0)
  await expect(
    deleteFiles().getByRole('article', { name: 'keep-B.pdf', exact: true }),
  ).toBeVisible()
})

test('recursive folder deletion removes the current subtree and empty folders, preserves outside data, updates counts and fits the constrained dialog', async ({}, info) => {
  await sample()
  await showDeleteFiles()
  await makeFolder('remove-root')
  const setup = await page.evaluate(async () => {
    let snapshot = await window.desktop.librarySnapshot()
    const root = snapshot.folders.find((f) => f.name === 'remove-root')!.id
    await window.desktop.changeLibrary({ kind: 'create', parentId: root, name: 'child' })
    snapshot = await window.desktop.librarySnapshot()
    const child = snapshot.folders.find((f) => f.parentId === root)!.id
    await window.desktop.changeLibrary({ kind: 'create', parentId: child, name: 'deep' })
    await window.desktop.changeLibrary({ kind: 'create', parentId: null, name: 'outside' })
    snapshot = await window.desktop.librarySnapshot()
    const deep = snapshot.folders.find((f) => f.parentId === child)!.id
    await window.desktop.changeLibrary({
      kind: 'moveDocument',
      id: snapshot.documents[0].id,
      folderId: deep,
    })
    return { root, child, deep, documentId: snapshot.documents[0].id }
  })
  await expect(libraryFolder('remove-root')).toContainText('1개 항목')
  await page.setViewportSize({ width: 1000, height: 680 })
  await deleteConfirmation('remove-root', '폴더')
  const popup = page.getByRole('menu', { name: '파일 삭제 확인', exact: true })
  await expect(popup).toContainText('내부 파일·하위 폴더')
  const box = (await popup.boundingBox())!,
    bounds = (await deleteFiles().boundingBox())!
  expect(box.x).toBeGreaterThanOrEqual(bounds.x)
  expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1)
  await page.screenshot({ path: info.outputPath('folder-delete-confirm-narrow.png') })
  await popup.getByRole('menuitem', { name: '삭제', exact: true }).press('Enter')
  await expect(libraryFolder('remove-root')).toHaveCount(0)
  await expect(libraryFolder('outside')).toBeVisible()
  const after = await page.evaluate(() => window.desktop.librarySnapshot())
  expect(after.documents).toEqual([])
  expect(after.folders.map((f) => f.name)).toEqual(['outside'])
  await expect(page.locator('.document-tab')).toHaveCount(0)
  await makeFolder('empty')
  await deleteConfirmation('empty', '폴더')
  await popup.getByRole('menuitem', { name: '삭제', exact: true }).click()
  await expect(libraryFolder('empty')).toHaveCount(0)
  await app.close()
  await launchApp()
  await showDeleteFiles()
  const restored = await page.evaluate(() => window.desktop.librarySnapshot())
  expect(restored.documents).toEqual([])
  expect(restored.folders.map((f) => f.name)).toEqual(['outside'])
})

async function fakePresentation(bytes: Uint8Array, mode = 'success') {
  await app.evaluate(
    async (_, { bytes, mode }) => {
      const state = globalThis as any,
        fs = process.getBuiltinModule('fs/promises') as any,
        path = process.getBuiltinModule('path') as any
      const bin = path.join(process.env.TRANSLAVE_TEST_USER_DATA!, 'fake-office')
      await fs.mkdir(bin, { recursive: true })
      await fs.writeFile(path.join(bin, 'soffice'), 'own fake executable', { mode: 0o700 })
      if (!state.__ppt) {
        const childProcess = process.getBuiltinModule('child_process') as any,
          realSpawn = childProcess.spawn,
          realAccess = fs.access,
          realKill = process.kill.bind(process),
          realTimer = globalThis.setTimeout
        state.__ppt = { calls: 0, mode, bytes, finish: null }
        process.env.PATH = bin + ':' + process.env.PATH
        fs.access = async (...args: any[]) => {
          if (state.__ppt.mode === 'missing' && String(args[0]).endsWith('/soffice'))
            throw new Error('fake missing tool')
          return realAccess(...args)
        }
        childProcess.spawn = (exe: string, args: string[], options: any) => {
          if (exe !== '/usr/bin/sandbox-exec') return realSpawn(exe, args, options)
          const child = Object.assign(new (process.getBuiltinModule('events')!.EventEmitter)(), {
            pid: 987654321,
          })
          state.__ppt.calls++
          state.__ppt.args = args
          const finish = async () => {
            if (state.__ppt.mode === 'timeout') return
            if (state.__ppt.mode === 'exit') {
              child.emit('close', 1)
              return
            }
            if (state.__ppt.mode !== 'no-output')
              await fs.writeFile(
                path.join(args[args.indexOf('--outdir') + 1], 'input.pdf'),
                state.__ppt.mode === 'corrupt'
                  ? Buffer.from('bad output')
                  : Buffer.from(state.__ppt.bytes),
              )
            child.emit('close', 0)
          }
          state.__ppt.child = child
          if (state.__ppt.mode === 'hold') state.__ppt.finish = finish
          else realTimer(() => void finish(), 0)
          return child
        }
        process.kill = ((pid: number, signal: any) => {
          if (pid === -987654321) {
            state.__ppt.killed = signal
            realTimer(() => state.__ppt.child.emit('close', null), 0)
            return true
          }
          return realKill(pid, signal)
        }) as any
        globalThis.setTimeout = ((fn: any, ms: number, ...args: any[]) =>
          realTimer(fn, state.__ppt.mode === 'timeout' && ms === 120000 ? 30 : ms, ...args)) as any
      }
      Object.assign(state.__ppt, { bytes, mode })
    },
    { bytes: Array.from(bytes), mode },
  )
}

test('PPT/PPTX import shares PDF reading, image translation/chat and page memo owners; duplicate sources and restart reuse derivatives, deletion preserves originals', async () => {
  const doc = await PDFDocument.create(),
    font = await doc.embedFont(StandardFonts.Helvetica)
  for (let n = 1; n <= 2; n++) {
    const p = doc.addPage([400, 300])
    p.drawText('SOURCE_SLIDE_' + n, { x: 30, y: 200, size: 20, font })
  }
  const pdf = await doc.save(),
    pptx = join(profile, '원본.pptx'),
    ppt = join(profile, '다른.ppt')
  await writeFile(pptx, 'own pptx source')
  await writeFile(ppt, 'own ppt source')
  const id = createHash('sha256')
    .update(await readFile(pptx))
    .digest('hex')
  await fakePresentation(pdf)
  await connectFakeChatGPT(page)
  await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
  await makeFolder('슬라이드')
  await libraryFolder('슬라이드').getByRole('button', { name: '슬라이드 폴더 열기' }).click()
  await addFile(pptx)
  await addFile(ppt)
  let snapshot = await page.evaluate(() => window.desktop.librarySnapshot())
  const targetFolder = snapshot.folders.find((f) => f.name === '슬라이드')!.id
  expect(snapshot.documents).toHaveLength(2)
  expect(snapshot.documents.every((d) => d.folderId === targetFolder)).toBe(true)
  expect(snapshot.documents.find((d) => d.id === id)?.name).toBe('원본.pptx')
  expect(await page.getByRole('tablist', { name: '문서 탭' }).count()).toBe(0)
  await addFile(pptx)
  expect(await app.evaluate(() => (globalThis as any).__ppt.calls)).toBe(2)
  snapshot = await page.evaluate(() => window.desktop.librarySnapshot())
  expect(snapshot.documents).toHaveLength(2)
  const database = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  const derived = String(database.prepare('SELECT path FROM documents WHERE id=?').get(id)!.path)
  try {
    expect(
      database.prepare('SELECT original_path FROM documents WHERE id=?').get(id)!.original_path,
    ).toBe(pptx)
    await expect
      .poll(() =>
        Number(
          database
            .prepare("SELECT count(*) AS n FROM translations WHERE document_id=? AND status='done'")
            .get(id)!.n,
        ),
      )
      .toBe(2)
    await page
      .getByRole('article', { name: '원본.pptx', exact: true })
      .getByRole('button', { name: /열기$/ })
      .click()
    await ready()
    await expect(page.locator('.textLayer')).toContainText('SOURCE_SLIDE_1')
    await page.getByRole('tab', { name: '채팅', exact: true }).click()
    const input = page.getByRole('textbox', { name: '질문', exact: true })
    await input.fill('own question')
    await input.press('Enter')
    await expect
      .poll(() => app.evaluate(() => (globalThis as any).__activeFake.chatCalls.length))
      .toBe(1)
    await expect(page.getByRole('button', { name: '응답 중지', exact: true })).toHaveCount(0)
    await page.getByRole('tab', { name: '메모', exact: true }).click()
    const editor = page.getByRole('textbox', { name: '메모 본문', exact: true })
    await editor.click()
    await page.keyboard.insertText('own memo body')
    await expect
      .poll(
        () =>
          database.prepare('SELECT body FROM memos WHERE document_id=? AND page=1').get(id)?.body,
      )
      .toBe('own memo body')
    expect(await readFile(pptx, 'utf8')).toBe('own pptx source')
    await app.close()
    await launchApp()
    await fakePresentation(pdf, 'exit')
    await ready()
    await expect(page.locator('.document-tab[data-active="true"] .file-name')).toHaveText(
      '원본.pptx',
    )
    expect(await app.evaluate(() => (globalThis as any).__ppt.calls)).toBe(0)
    await page.getByRole('tab', { name: '메모', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '메모 본문', exact: true })).toContainText(
      'own memo body',
    )
    await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
    await libraryFolder('슬라이드').getByRole('button', { name: '슬라이드 폴더 열기' }).click()
    await page
      .getByRole('article', { name: '원본.pptx', exact: true })
      .getByRole('button', { name: /열기$/ })
      .click()
    await ready()
    await expect(page.getByRole('tablist', { name: '문서 탭' }).getByRole('tab')).toHaveCount(2)
    const deletion = await page.evaluate(
      (id) => window.desktop.deleteLibrary({ kind: 'document', id }),
      id,
    )
    expect(deletion.status).toBe('deleted')
    await expect
      .poll(() =>
        readFile(derived).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false)
    expect(await readFile(pptx, 'utf8')).toBe('own pptx source')
    expect(await readFile(ppt, 'utf8')).toBe('own ppt source')
    expect(database.prepare('SELECT id FROM documents WHERE id=?').get(id)).toBeUndefined()
    expect(database.prepare('SELECT id FROM memos WHERE document_id=?').get(id)).toBeUndefined()
    expect(database.prepare('SELECT id FROM documents').all()).toHaveLength(1)
    expect(await page.evaluate(() => window.desktop.readingWorkspace())).toMatchObject({
      status: 'loaded',
      workspace: { tabs: [] },
    })
  } finally {
    database.close()
  }
})

test('presentation import failures, cancellation, duplicate clicks and failed registration leave no document, queue work or partial resources', async () => {
  const doc = await PDFDocument.create()
  doc.addPage([200, 100])
  const pdf = await doc.save(),
    pptx = join(profile, 'failure.pptx')
  await writeFile(pptx, 'own fixture')
  for (const mode of ['missing', 'exit', 'no-output', 'corrupt', 'timeout']) {
    await fakePresentation(pdf, mode)
    await addFile(pptx)
    await expect(page.getByRole('alert')).toBeVisible()
    expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toHaveLength(0)
    expect(await readdir(join(profile, 'translations/presentations')).catch(() => [])).toEqual([])
  }
  await fakePresentation(pdf)
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  try {
    db.exec(
      "CREATE TRIGGER reject_ppt BEFORE INSERT ON documents BEGIN SELECT RAISE(ABORT,'own failure'); END",
    )
    await addFile(pptx)
    await expect(page.getByRole('alert')).toBeVisible()
    expect(await readdir(join(profile, 'translations/presentations'))).toEqual([])
    expect(db.prepare('SELECT id FROM documents').all()).toEqual([])
    db.exec('DROP TRIGGER reject_ppt')
  } finally {
    db.close()
  }
  await makeFolder('고정 대상')
  await libraryFolder('고정 대상').getByRole('button', { name: '고정 대상 폴더 열기' }).click()
  const target = (await page.evaluate(() => window.desktop.librarySnapshot())).folders.find(
    (f) => f.name === '고정 대상',
  )!.id
  await fakePresentation(pdf, 'hold')
  const importing = addFile(pptx)
  await expect
    .poll(() => app.evaluate(() => typeof (globalThis as any).__ppt.finish))
    .toBe('function')
  expect(await page.evaluate(() => window.desktop.openPdf())).toMatchObject({ status: 'canceled' })
  await page.evaluate((id) => window.desktop.deleteLibrary({ kind: 'folder', id }), target)
  await app.evaluate(async () => {
    const s = (globalThis as any).__ppt
    s.mode = 'success'
    await s.finish()
  })
  await importing
  await expect(page.getByRole('alert')).toBeVisible()
  expect((await page.evaluate(() => window.desktop.librarySnapshot())).documents).toHaveLength(0)
  expect(await readdir(join(profile, 'translations/presentations'))).toEqual([])
  const calls = await app.evaluate(() => (globalThis as any).__ppt.calls)
  await addFile(null)
  expect(await app.evaluate(() => (globalThis as any).__ppt.calls)).toBe(calls)
  expect(await app.evaluate(() => (globalThis as any).__activeFake.calls)).toHaveLength(0)
  expect(await readFile(pptx, 'utf8')).toBe('own fixture')
})
