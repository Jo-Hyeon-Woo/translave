import { expect } from '@playwright/test'
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

export async function checkInlineTitleWidth(page: Page, input: Locator) {
  const original = await input.inputValue()
  const metrics = () =>
    input.evaluate((node: HTMLInputElement) => {
      const style = getComputedStyle(node),
        rect = node.getBoundingClientRect()
      const text = document.createElement('span')
      Object.assign(text.style, {
        position: 'absolute',
        visibility: 'hidden',
        whiteSpace: 'pre',
        font: style.font,
        letterSpacing: style.letterSpacing,
      })
      text.textContent = node.value
      document.body.append(text)
      const textWidth = text.getBoundingClientRect().width
      text.remove()
      const row = node.closest('article')!,
        available = node.parentElement!.getBoundingClientRect().right - rect.left
      const padding =
        parseFloat(style.paddingLeft) +
        parseFloat(style.paddingRight) +
        parseFloat(style.borderLeftWidth) +
        parseFloat(style.borderRightWidth)
      return {
        width: rect.width,
        expected: Math.max(32, Math.min(available, textWidth + padding + 1)),
        available,
        fixed: {
          height: rect.height,
          font: style.font,
          textX: rect.left + parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth),
          row: row.getBoundingClientRect().toJSON(),
          anchors: [
            ...row.querySelectorAll(
              '.library-thumbnail, .library-metadata, .library-menu-trigger, time, .memo-row-menu',
            ),
          ].map((n) => n.getBoundingClientRect().toJSON()),
        },
      }
    })
  const before = await metrics()
  const check = async () => {
    const value = await metrics()
    expect(Math.abs(value.width - value.expected)).toBeLessThan(2)
    expect(value.width).toBeLessThanOrEqual(value.available + 0.1)
    expect(value.fixed).toEqual(before.fixed)
    return value.width
  }
  for (const value of ['', 'i', 'WWW', '한글 이름', 'W'.repeat(190)]) {
    await input.fill(value)
    await check()
  }
  await input.press('End')
  expect(await input.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0)
  await input.press('Meta+A')
  await input.press('Backspace')
  expect(await check()).toBe(32)
  const session = await page.context().newCDPSession(page)
  try {
    await session.send('Input.imeSetComposition', {
      text: '한글 조합',
      selectionStart: 5,
      selectionEnd: 5,
    })
    await check()
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
    await page.keyboard.up('Enter')
  } finally {
    await session.detach()
  }
  await input.fill(original)
}

export async function dragPanel(page: Page, percentage = 37) {
  const divider = page.getByRole('separator', { name: '번역 패널 너비' })
  const box = (await divider.boundingBox())!
  const x = await page.locator('.workspace').evaluate((node, ratio) => {
    const bounds = node.getBoundingClientRect(),
      style = getComputedStyle(node),
      gap = node.querySelector('.panel-divider')!.getBoundingClientRect().width,
      left = parseFloat(style.paddingLeft),
      right = parseFloat(style.paddingRight)
    return bounds.right - right - gap / 2 - ((bounds.width - left - right - gap) * ratio) / 100
  }, percentage)
  const y = box.y + box.height / 2
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down()
  await page.mouse.move(x, y, { steps: 8 })
  await page.mouse.up()
  await expect(divider).toHaveAttribute('aria-valuenow', String(Math.round(percentage)))
}

export async function prepareReaderLayout(
  app: ElectronApplication,
  page: Page,
  profile: string,
  info: TestInfo,
) {
  const ready = async () => {
    await expect(page.getByTestId('page-stage')).toHaveAttribute('data-status', 'ready')
  }
  const selectFile = async (file: string) => {
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
    }, file)

    await page.getByRole('button', { name: '파일 목록 열기', exact: true }).click()
    await page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }).click()
    await page.getByRole('menuitem', { name: '파일', exact: true }).click()

    await expect(
      page.getByRole('button', { name: '파일 또는 폴더 추가', exact: true }),
    ).toBeEnabled()

    await page
      .getByRole('article', { name: basename(file), exact: true })
      .getByRole('button', { name: /열기$/ })
      .click()

    await expect(page.getByRole('dialog', { name: 'files', exact: true })).toHaveCount(0)
  }
  const fileButton = page
    .locator('.titlebar')
    .getByRole('button', { name: '파일 목록 열기', exact: true })
  const filename = page.locator(
    '.document-tab[data-active="true"] .file-name, .document-add .file-name',
  )
  await expect(filename).toHaveText('파일 선택')
  for (const name of ['다음 페이지', '이전 페이지', '확대', '축소', '너비에 맞추기'])
    await expect(page.getByRole('button', { name, exact: true })).toBeDisabled()
  await expect(page.getByRole('textbox', { name: '현재 페이지' })).toBeDisabled()
  await expect(page.locator('.connection-badge')).toHaveAttribute('data-state', 'error')
  await expect(
    page.locator(
      '.toolbar, .frame-rule, .reader-heading, .reader-footer, .statusbar, .panel-footer',
    ),
  ).toHaveCount(0)
  const headerFits = async (checkNative = false) => {
    const layout = await page.evaluate(() => {
      const rect = (s: string) => document.querySelector(s)!.getBoundingClientRect()
      const shell = rect('.app-shell'),
        title = rect('.document-tab[data-active="true"], .document-add'),
        controls = rect('.header-actions')
      const reader = rect('.reader'),
        panel = rect('.translation-panel'),
        viewer = rect('.viewer-scroll'),
        content = rect('.panel-scroll'),
        pdfControls = rect('.reader-controls'),
        pages = rect('.page-controls'),
        zoom = rect('.zoom-controls')
      const center = (shell.top + reader.top) / 2
      return {
        cardTopDifference: Math.abs(reader.top - panel.top),
        headerCenter: center,
        overlap: Math.max(0, title.right - controls.left),
        centers: [
          '.brand',
          '.brand-divider',
          '.header-actions',
          '.document-tab[data-active="true"], .document-add',
          '.settings-trigger',
        ].map((s) => Math.abs((rect(s).top + rect(s).bottom) / 2 - center)),
        pdfCenters: ['.page-controls', '.zoom-controls', '.page-controls input'].map((s) =>
          Math.abs((rect(s).top + rect(s).bottom - pages.top - pages.bottom) / 2),
        ),
        pdfInsets: [
          pages.left - reader.left,
          pages.top - reader.top,
          reader.right - zoom.right,
          zoom.top - reader.top,
        ],
        groupHeights: [pages.height, zoom.height],
        headerGaps: [
          rect('.brand-name').left - rect('.brand-mark').right,
          rect('.brand-divider').left - rect('.brand-name').right,
          rect('.document-tab[data-active="true"], .document-add').left -
            rect('.brand-divider').right,
        ],
        pdfOverlap: Math.max(0, pages.right - zoom.left),
        pdfTop: pdfControls.top - reader.top,
        viewerTop: viewer.top - pdfControls.bottom,
        bottomGaps: [innerHeight - reader.bottom, innerHeight - panel.bottom],
        sideGaps: [reader.left, innerWidth - panel.right],
        extraPdfRows: reader.height - viewer.height - pdfControls.height,
        extraPanelFooter: panel.bottom - content.bottom,
      }
    })
    expect(layout.cardTopDifference).toBe(0)
    expect(layout.overlap).toBe(0)
    expect(layout.centers.every((v) => v < 1)).toBe(true)
    expect(layout.pdfCenters.every((v) => v < 1)).toBe(true)
    expect(new Set(layout.pdfInsets).size).toBe(1)
    expect(layout.pdfInsets[0]).toBeGreaterThan(0)
    expect(layout.groupHeights[0]).toBe(layout.groupHeights[1])
    expect(new Set(layout.headerGaps).size).toBe(1)
    expect(layout.headerGaps[0]).toBeGreaterThan(0)
    expect(layout.pdfOverlap).toBe(0)
    expect(layout.pdfTop).toBe(0)
    expect(layout.viewerTop).toBe(0)
    expect(layout.bottomGaps).toEqual(layout.sideGaps)
    expect(layout.extraPdfRows).toBe(0)
    expect(layout.extraPanelFooter).toBe(0)
    for (const name of ['다음 페이지', '이전 페이지', '확대', '축소', '너비에 맞추기'])
      await expect(
        page.locator('.reader-controls').getByRole('button', { name, exact: true }),
      ).toBeInViewport()
    for (const name of ['파일 목록 열기', '설정']) {
      const button = page.locator('.titlebar').getByRole('button', { name, exact: true })

      await expect(button).toBeInViewport()
      expect(
        await button.evaluate((node) =>
          getComputedStyle(node).getPropertyValue('-webkit-app-region'),
        ),
      ).toBe('no-drag')
    }

    await expect(page.locator('.titlebar .page-controls, .titlebar .zoom-controls')).toHaveCount(0)
    if (!checkNative) return
    const native = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      return { fullscreen: window.isFullScreen(), position: window.getWindowButtonPosition() }
    })
    if (!native.fullscreen) {
      expect(native.position).not.toBeNull()
      expect(Math.abs(native.position!.y + 7 - layout.headerCenter)).toBeLessThan(1)
      expect(native.position!.x + 54).toBeLessThan(98)
    }
  }
  await headerFits()
  await page.screenshot({ path: info.outputPath('empty-no-key.png') })
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (const [width, height] of [
    [800, 450],
    // Just below the control row's remaining height, but too tall for whole-card
    // centering with today's header height: preserve the collision boundary check.
    [800, 760],
    [500, 1100],
  ]) {
    const sheet = pdf.addPage([width, height])
    sheet.drawText('Reading space', { x: 45, y: height - 70, size: 30, font })
    sheet.drawText('Page boundaries stay reachable.', { x: 45, y: 40, size: 14, font })
  }
  const longName = 'Layout and reading notes - '.repeat(6) + 'color pages.pdf'
  const file = join(profile, longName)
  await writeFile(file, await pdf.save())
  await selectFile(file)
  await ready()
  await expect(filename).toHaveAttribute('title', longName)
  await expect(page.getByText('설정에서 ChatGPT를 연결해 주세요.', { exact: true })).toBeVisible()
  const alignment = async () =>
    page.evaluate(() => {
      const viewer = document.querySelector<HTMLElement>('.viewer-scroll')!
      const pdf = document.querySelector<HTMLElement>('.pdf-surface')!
      const card = document.querySelector<HTMLElement>('.reader')!
      const cardRect = card.getBoundingClientRect()
      const pdfRect = pdf.getBoundingClientRect()
      const scrollOffset = viewer.getBoundingClientRect().top - cardRect.top
      const centeredTop = (cardRect.height - pdfRect.height) / 2
      const top = pdfRect.top - cardRect.top + viewer.scrollTop
      return {
        top,
        expected: centeredTop >= scrollOffset ? centeredTop : scrollOffset + 24,
        centered: centeredTop >= scrollOffset,
        cardHeight: cardRect.height,
        pdfHeight: pdfRect.height,
        scrollOffset,
        cardCenter: cardRect.height / 2,
        pdfCenter: pdfRect.top - cardRect.top + pdfRect.height / 2,
        scrollTop: viewer.scrollTop,
        scroll: viewer.scrollHeight - viewer.clientHeight,
      }
    })
  const measurements: Array<Awaited<ReturnType<typeof alignment>> & { label: string }> = []
  const captureAlignment = async (label: string) => {
    measurements.push({ label, ...(await alignment()) })

    await writeFile(info.outputPath('alignment.json'), JSON.stringify(measurements, null, 2))
  }
  const aligned = async (label?: string) => {
    await ready()

    await expect
      .poll(async () => {
        const a = await alignment()
        return Math.abs(a.top - a.expected)
      })
      .toBeLessThan(1)
    const current = await alignment()
    expect(current.top).toBeGreaterThanOrEqual(current.scrollOffset)
    if (current.centered) {
      expect(current.scrollTop).toBe(0)
      expect(Math.abs(current.pdfCenter - current.cardCenter)).toBeLessThan(1)
    }
    if (label) await captureAlignment(label)
  }
  return { fileButton, filename, headerFits, aligned, alignment, captureAlignment }
}
