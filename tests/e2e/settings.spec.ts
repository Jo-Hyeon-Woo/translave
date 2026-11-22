import { test, createTestProfile, closeTestApp, launchTestApp } from './helpers'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { writeFile } from 'node:fs/promises'
import { DEFAULT_IMAGE_SETTINGS } from '../../src/shared/contracts'

let app: ElectronApplication, page: Page, profile: string, errors: number, remote: number
const titles = ['ChatGPT 연결', '번역 이미지 설정', '테마 선택']
const header = (name: string) => page.getByRole('button', { name, exact: true })
const section = (id: string) => page.locator('[data-section="' + id + '"]')
const snapshot = () => page.evaluate(() => window.desktop.translationSettings())
test.beforeEach(async () => {
  errors = remote = 0
  profile = await createTestProfile('settings')
  ;({ app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', () => errors++)
    page.on('request', (r) => {
      if (/^https?:/.test(r.url())) remote++
    })
  }))
})
test.afterEach(async () => {
  const s = await app.evaluate(() => (globalThis as any).__activeFake)
  await closeTestApp(app, profile)
  expect(s.calls).toHaveLength(0)
  expect(s.gemini + s.unknown + s.models + s.registration).toBe(0)
  expect(s.logSites).toEqual([])
  expect(errors + remote).toBe(0)
})
async function open() {
  await header('설정').click()
  await expect(header(titles[1])).toContainText('해상도')
}
async function expectMenu(index: number | null) {
  for (const [i, name] of titles.entries())
    await expect(header(name)).toHaveAttribute('aria-expanded', String(i === index))
  await expect(page.locator('.settings-section-trigger[aria-expanded="true"]')).toHaveCount(
    index === null ? 0 : 1,
  )
  await expect(page.locator('.settings-section-panel[data-open="true"]')).toHaveCount(
    index === null ? 0 : 1,
  )
}
test('content-sized settings use equal expanded rows, aligned right actions and the original DPI font, with accessible constrained scrolling', async ({}, info) => {
  await open()
  const dialog = page.getByRole('dialog', { name: 'settings', exact: true })
  const settle = () =>
    dialog.evaluate(async (n) => {
      await Promise.all(n.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})))
    })
  const initial = (await dialog.boundingBox())!
  const measurements: any[] = []
  for (const [id, title] of [
    ['chatgpt', titles[0]],
    ['images', titles[1]],
    ['theme', titles[2]],
  ] as const) {
    await header(title).click()
    await settle()
    const row = section(id).locator('.settings-control-row')
    await expect(row).toBeVisible()
    const layout = await section(id).evaluate((node) => {
      const box = (s: string) => node.querySelector(s)!.getBoundingClientRect()
      const content = box('.settings-section-content'),
        inner = box('.settings-section-inner'),
        refresh = box('.settings-refresh'),
        confirm = box('.settings-confirm')
      const style = getComputedStyle(node.querySelector('.settings-section-content')!)
      return {
        contentHeight: content.height,
        padding: [style.paddingTop, style.paddingBottom],
        clipped: content.bottom > inner.bottom,
        right: [refresh.right, confirm.right],
        gap: confirm.left - refresh.right,
        centers: [...node.querySelector('.settings-control-row')!.children].map((c) => {
          const r = c.getBoundingClientRect()
          return r.top + r.height / 2
        }),
        heights: [refresh.height, confirm.height],
        widths: [refresh.width, confirm.width],
      }
    })
    expect(layout.clipped).toBe(false)
    expect(Math.max(...layout.centers) - Math.min(...layout.centers)).toBeLessThan(1)
    expect(layout.heights).toEqual(layout.widths)
    expect(layout.gap).toBe(8)
    expect(layout.padding).toEqual(id === 'theme' ? ['12px', '12px'] : ['6px', '18px'])
    const frame = (await dialog.boundingBox())!
    expect(frame.width).toBe(initial.width)
    expect(frame.x).toBe(initial.x)
    expect(frame.height).toBeGreaterThan(initial.height)
    expect(Math.abs(frame.y + frame.height / 2 - initial.y - initial.height / 2)).toBeLessThan(1)
    if (measurements.length) {
      expect(frame.height).toBe(measurements[0].frame.height)
      expect(layout.contentHeight).toBe(measurements[0].contentHeight)
      expect(layout.right).toEqual(measurements[0].right)
    }
    const bottomGap = await dialog.evaluate(
      (n) =>
        n.getBoundingClientRect().bottom -
        n.querySelector('.settings-section:last-child')!.getBoundingClientRect().bottom,
    )
    expect(bottomGap).toBeLessThanOrEqual(10)
    measurements.push({ id, frame, ...layout, bottomGap })
    for (const button of await row.locator('.settings-icon-button').all())
      await expect(button).toHaveAttribute('title', (await button.getAttribute('aria-label')) ?? '')
    if (id === 'images') {
      const label = page.locator('label[for="settings-image-dpi"]')
      await expect(label).toHaveText('이미지 해상도 (DPI)')
      await label.click()
      await expect(page.getByLabel('이미지 해상도 (DPI)')).toBeFocused()
      const font = await label.evaluate((n) => {
        const field = (n as HTMLLabelElement).control!,
          a = getComputedStyle(n),
          b = getComputedStyle(field)
        const names = ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight'] as const
        return {
          label: names.map((k) => a[k]),
          input: names.map((k) => b[k]),
          width: field.getBoundingClientRect().width,
        }
      })
      expect(font.input).toEqual(font.label)
      expect(font.input.slice(1, 3)).toEqual(['12px', '400'])
      expect(font.width).toBe(72)
      await writeFile(info.outputPath('dpi-font.json'), JSON.stringify(font, null, 2))
    }
    await page.screenshot({ path: info.outputPath(id + '-row.png') })
  }
  await header(titles[2]).click()
  await settle()
  expect(await dialog.boundingBox()).toEqual(initial)
  await header(titles[0]).click()
  await settle()
  const top = await page.evaluate(() => ({
    header: document.querySelector('.settings-dialog .dialog-header')!.getBoundingClientRect()
      .bottom,
    first: document.querySelector('.settings-section')!.getBoundingClientRect().top,
  }))
  expect(top.first - top.header).toBe(0)
  await page.getByRole('button', { name: 'ChatGPT 연결 확인', exact: true }).focus()
  await page.keyboard.press('Space')
  await expectMenu(null)
  await settle()
  expect(await dialog.boundingBox()).toEqual(initial)
  await expect(dialog).toBeVisible()
  await header(titles[1]).click()
  await page.getByLabel('이미지 해상도 (DPI)').fill('1')
  await header('이미지 설정 적용').click()
  const alert = section('images').getByRole('alert')
  await expect(alert).toBeVisible()
  await settle()
  expect((await dialog.boundingBox())!.height).toBeGreaterThan(measurements[0].frame.height)
  const error = await alert.evaluate((n) => ({
    bottom: n.getBoundingClientRect().bottom,
    limit: n.closest('.settings-section-inner')!.getBoundingClientRect().bottom,
  }))
  expect(error.bottom).toBeLessThanOrEqual(error.limit)
  await page.screenshot({ path: info.outputPath('visible-error.png') })
  await header('이미지 기본값으로 복귀').click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1000, 680),
  )
  await header(titles[2]).click()
  await settle()
  await page.screenshot({ path: info.outputPath('minimum.png') })
  // Constrain the content without claiming a native window below Electron's minimum.
  await page.addStyleTag({ content: '.settings-dialog { max-width:330px; max-height:230px; }' })
  await header('테마 기본값으로 복귀').focus()
  await page.keyboard.press('Enter')
  expect(
    await page.locator('.settings-body').evaluate((n) => n.scrollHeight > n.clientHeight),
  ).toBe(true)
  const strip = section('theme').locator('.settings-row-scroll')
  expect(await strip.evaluate((n) => n.scrollWidth > n.clientWidth)).toBe(true)
  await page.keyboard.press('Tab')
  await expect(header('테마 적용')).toBeFocused()
  await expect.poll(() => strip.evaluate((n) => n.scrollLeft)).toBeGreaterThan(0)
  await expect(header('테마 적용')).toBeInViewport()
  await page.screenshot({ path: info.outputPath('constrained-scroll.png') })
  await writeFile(
    info.outputPath('layout.json'),
    JSON.stringify({ collapsed: initial, expanded: measurements }, null, 2),
  )
})
test('single accordion preserves keyboard, status, animation and reduced motion without a connection probe', async ({}, info) => {
  await open()
  expect(await page.locator('.settings-section-title').allTextContents()).toEqual(titles)
  await expectMenu(null)
  await expect(page.locator('.settings-section-trigger button')).toHaveCount(0)
  await expect(header(titles[0])).toContainText('연결 대기')
  await expect(header(titles[1])).toContainText('해상도 144 DPI')
  const panel = section('images').locator('.settings-section-panel')
  await header(titles[0]).click()
  await expectMenu(0)
  await header(titles[1]).focus()
  await header(titles[1]).press('Enter')
  await expectMenu(1)
  await header(titles[2]).focus()
  await header(titles[2]).press('Space')
  await expectMenu(2)
  await header(titles[2]).press('Space')
  await expectMenu(null)
  await expect.poll(() => panel.evaluate((n) => n.getBoundingClientRect().height)).toBe(0)
  expect(await panel.getAttribute('inert')).not.toBeNull()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  expect(await panel.evaluate((n) => getComputedStyle(n).transitionDuration)).toBe('0s')
  await header(titles[1]).click()
  await page.getByLabel('이미지 해상도 (DPI)').fill('200')
  await expect(header(titles[1])).toContainText('144 DPI')
  // Retained from the consolidated settings/reader scenario: minimum-window access.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
  await page.getByLabel('이미지 해상도 (DPI)').scrollIntoViewIfNeeded()
  await expect(header('이미지 설정 적용')).toBeInViewport()
  await page.screenshot({ path: info.outputPath('settings-images.png') })
})
test('rapid animation switches and batched clicks keep at most one menu and preserve drafts', async () => {
  await open()
  const before = await snapshot()
  await header(titles[1]).click()
  await page.getByLabel('이미지 해상도 (DPI)').fill('200')
  const max = await page.evaluate(async () => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.settings-section-trigger'),
    )
    let max = 0
    const check = () => {
      max = Math.max(
        max,
        document.querySelectorAll('.settings-section-trigger[aria-expanded="true"]').length,
      )
    }
    const observer = new MutationObserver(check)
    observer.observe(document.querySelector('.settings-dialog')!, {
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-expanded'],
    })
    for (let i = 0; i < 36; i++) {
      buttons[i % 3].click()
      await new Promise<void>((r) =>
        requestAnimationFrame(() => {
          check()
          r()
        }),
      )
    }
    observer.disconnect()
    return max
  })
  expect(max).toBe(1)
  await page.evaluate(() => {
    const b = document.querySelectorAll<HTMLButtonElement>('.settings-section-trigger')
    for (const i of [2, 0, 1, 1, 2]) b[i].click()
  })
  await expectMenu(2)
  await header(titles[1]).click()
  await expect(page.getByLabel('이미지 해상도 (DPI)')).toHaveValue('200')
  expect(await snapshot()).toEqual(before)
})
test('DPI defaults change only the draft; validation stays open and successful save collapses', async () => {
  await open()
  await header(titles[1]).click()
  const field = page.getByLabel('이미지 해상도 (DPI)')
  await field.fill('1')
  await header('이미지 설정 적용').click()
  await expect(section('images').getByRole('alert')).toBeVisible()
  await expectMenu(1)
  await field.fill('200')
  await section('images').getByRole('button', { name: '이미지 기본값으로 복귀' }).click()
  await expect(field).toHaveValue(String(DEFAULT_IMAGE_SETTINGS.dpi))
  await field.fill('200')
  await header(titles[0]).click()
  await header(titles[1]).click()
  await expect(field).toHaveValue('200')
  expect((await snapshot()).images.dpi).toBe(144)
  await header('이미지 설정 적용').click()
  await expectMenu(null)
  expect((await snapshot()).images.dpi).toBe(200)
  await header('설정 닫기').click()
  await open()
  await expect(header(titles[1])).toContainText('200 DPI')
  await expectMenu(null)
})
test('SQLite save failure preserves the applied image settings and visible error', async () => {
  await open()
  const before = await snapshot()
  const db = new DatabaseSync(join(profile, 'translations/translations.sqlite'))
  db.exec('DROP TABLE image_settings')
  db.close()
  await header(titles[1]).click()
  await page.getByLabel('이미지 해상도 (DPI)').fill('200')
  await header('이미지 설정 적용').click()
  await expect(section('images').getByRole('alert')).toContainText('적용하지 못했어요')
  await expectMenu(1)
  await header(titles[2]).click()
  await header(titles[1]).click()
  await expect(section('images').getByRole('alert')).toBeVisible()
  await expect(page.getByLabel('이미지 해상도 (DPI)')).toHaveValue('200')
  expect(await snapshot()).toEqual(before)
})
for (const outcome of ['success', 'error'] as const)
  test('delayed image apply ' + outcome + ' after switching respects the active menu', async () => {
    await open()
    const applied = await snapshot()
    await app.evaluate(
      ({ ipcMain }, { applied, outcome }) => {
        ipcMain.removeHandler('translation:images')
        ;(globalThis as any).__applyStarted = false
        ipcMain.handle(
          'translation:images',
          (_e, images) =>
            new Promise((resolve) => {
              ;(globalThis as any).__applyStarted = true
              ;(globalThis as any).__finishApply = () =>
                resolve(
                  outcome === 'success'
                    ? {
                        status: 'configured',
                        settings: { ...applied, images, revision: applied.revision + 1 },
                      }
                    : { status: 'error', message: '테스트 저장 실패' },
                )
            }),
        )
      },
      { applied, outcome },
    )
    await header(titles[1]).click()
    await page.getByLabel('이미지 해상도 (DPI)').fill('200')
    await header('이미지 설정 적용').click()
    await expect.poll(() => app.evaluate(() => (globalThis as any).__applyStarted)).toBe(true)
    await header(titles[2]).click()
    await expectMenu(2)
    await app.evaluate(() => (globalThis as any).__finishApply())
    if (outcome === 'success') {
      await expect(header(titles[1])).toContainText('200 DPI')
      await expectMenu(2)
    } else {
      await expect(section('images').getByRole('alert')).toContainText('테스트 저장 실패')
      await expectMenu(1)
    }
    await expect(page.getByLabel('이미지 해상도 (DPI)')).toHaveValue('200')
  })
