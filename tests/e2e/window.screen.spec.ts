import { expect } from '@playwright/test'
import { test, createTestProfile, launchTestApp, closeTestApp } from './helpers'
import { prepareReaderLayout, dragPanel } from './readerLayout'

test('native macOS focus, maximize, fullscreen and restoration preserve reader and traffic-light alignment', async ({}, info) => {
  test.skip(process.platform !== 'darwin', 'Native macOS window behavior')
  test.setTimeout(65_000)
  const profile = await createTestProfile('native-window')
  let errors = 0,
    external = 0
  const { app, page } = await launchTestApp(profile, (page) => {
    page.on('pageerror', () => errors++)
    page.on('request', (request) => {
      if (/^https?:/.test(request.url())) external++
    })
  })
  try {
    const { aligned, headerFits } = await prepareReaderLayout(app, page, profile, info)
    await headerFits(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      )
      .toBe(true)
    await aligned('maximized')
    await headerFits(true)
    await page.screenshot({ path: info.outputPath('maximized.png') })
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].unmaximize())
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()),
      )
      .toBe(false)
    await aligned('unmaximized')
    await headerFits(true)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 680))
    const handle = page.getByRole('separator', { name: '번역 패널 너비' })
    await dragPanel(page, 48)
    await expect(handle).toHaveAttribute('aria-valuenow', '48')
    await aligned('minimum-before-fullscreen')
    await headerFits(true)
    const nativeFullscreen = async (enabled: boolean) => {
      await app.evaluate(({ BrowserWindow, app }) => {
        const window = BrowserWindow.getAllWindows()[0]
        window.show()
        app.focus({ steal: true })
        window.focus()
      })
      // macOS activation is asynchronous. Await the real focus prerequisite, rather than
      // sending a fullscreen request in the same task and hanging on a missing event.
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()),
        )
        .toBe(true)
      await app.evaluate(({ BrowserWindow }, value) => {
        const window = BrowserWindow.getAllWindows()[0]
        ;(globalThis as any).__fullscreenTransition = false
        const transitioned = () => {
          ;(globalThis as any).__fullscreenTransition = true
        }
        if (value) window.once('enter-full-screen', transitioned)
        else window.once('leave-full-screen', transitioned)
        window.setFullScreen(value)
      }, enabled)
      await expect
        .poll(() =>
          app.evaluate(({ BrowserWindow }) => ({
            native: BrowserWindow.getAllWindows()[0].isFullScreen(),
            event: (globalThis as any).__fullscreenTransition,
          })),
        )
        .toEqual({ native: enabled, event: true })
    }
    await nativeFullscreen(true)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-fullscreen', 'true')
    await expect
      .poll(() => page.locator('.brand').evaluate((node) => node.getBoundingClientRect().left))
      .toBe(26)
    await aligned('fullscreen')
    await headerFits(true)
    await page.screenshot({ path: info.outputPath('native-fullscreen.png') })
    await page.locator('.titlebar').screenshot({ path: info.outputPath('header-fullscreen.png') })
    await nativeFullscreen(false)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-fullscreen', 'false')
    await expect
      .poll(() => page.locator('.brand').evaluate((node) => node.getBoundingClientRect().left))
      .toBe(98)
    await aligned('restored')
    await headerFits(true)
    await page.screenshot({ path: info.outputPath('restored-window.png') })
    expect(errors).toBe(0)
    expect(external).toBe(0)
  } finally {
    await closeTestApp(app, profile)
  }
})
