import { test as base, expect, _electron as electron } from '@playwright/test'
import type { Page, ElectronApplication } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ownedProfiles = new Set<string>()
const liveApps = new Set<ElectronApplication>()
export const test = base.extend<{ isolatedResources: void }>({
  isolatedResources: [
    async ({}, use) => {
      try {
        await use()
      } finally {
        const failures: unknown[] = []
        for (const app of liveApps) {
          try {
            await app.close()
          } catch (error) {
            failures.push(error)
          }
        }
        for (const profile of ownedProfiles) {
          try {
            await removeTestProfile(profile)
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) throw failures[0]
      }
    },
    { auto: true, timeout: 15_000 },
  ],
})

async function quietWindows(app: ElectronApplication) {
  const state = await app.evaluate(({ BrowserWindow }) => ({
    ...(globalThis as any).__testWindowState,
    visible: BrowserWindow.getAllWindows().some((w) => w.isVisible()),
    focusedNow: BrowserWindow.getAllWindows().some((w) => w.isFocused()),
  }))
  if (state.mode !== 'quiet') return
  await test
    .info()
    .attach('quiet-window-events', { body: JSON.stringify(state), contentType: 'application/json' })
  expect(state.created).toBeGreaterThan(0)
  expect(state).toMatchObject({
    shown: 0,
    focused: 0,
    activated: 0,
    native: 0,
    visible: false,
    focusedNow: false,
  })
}

// Bounded cleanup also runs after a failed setup/hook or a timed-out test. Only
// applications launched with an owned temporary profile can enter liveApps.
async function terminateApp(app: ElectronApplication, close: () => Promise<void>) {
  const child = app.process()
  if (child.exitCode !== null || child.signalCode !== null) {
    liveApps.delete(app)
    return
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      close(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Test app cleanup timed out')), 5_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGKILL')
      await exited
    }
    liveApps.delete(app)
  }
}
export async function createTestProfile(label: string) {
  if (!/^[a-z-]+$/.test(label)) throw new Error('Invalid test profile label')
  const profile = await mkdtemp(join(tmpdir(), 'translave-' + label + '-'))
  ownedProfiles.add(profile)
  return profile
}
export async function removeTestProfile(profile: string) {
  if (!ownedProfiles.has(profile)) throw new Error('Refusing non-test profile cleanup')
  await rm(profile, { recursive: true, force: true })
  ownedProfiles.delete(profile)
}
// A fresh profile per scenario; restart tests may relaunch only their own profile.
// Bootstrap BEFORE main so even accidental inference/browser login stays fake.
export async function launchTestApp(profile: string, observe: (page: Page) => void) {
  if (!ownedProfiles.has(profile)) throw new Error('Refusing non-test app data')
  const env: Record<string, string> = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        !/^(?:OPENAI|GEMINI|GOOGLE|CHATGPT|TRANSLAVE)_/.test(entry[0]),
    ),
  )
  env.TRANSLAVE_TEST_USER_DATA = profile
  env.TRANSLAVE_TEST_MODE = test.info().project.name
  delete env.FORCE_COLOR
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  const app: ElectronApplication = await electron.launch({
    args: [
      '-r',
      resolve('tests/e2e/runtime.cjs'),
      '-r',
      resolve('tests/e2e/fakeChatGPT.cjs'),
      resolve('.'),
    ],
    env,
  })
  liveApps.add(app)
  const originalClose = app.close.bind(app)
  app.close = async () => {
    try {
      if (liveApps.has(app) && app.process().exitCode === null && app.process().signalCode === null)
        await quietWindows(app)
    } finally {
      await terminateApp(app, originalClose)
    }
  }
  try {
    const page = await app.firstWindow()
    observe(page)
    await expect(page.locator('.app-shell')).toHaveAttribute('data-tabs-ready', 'true')
    expect(await app.evaluate(() => !!(globalThis as any).__activeFake)).toBe(true)
    return { app, page }
  } catch (error) {
    try {
      await app.close()
    } finally {
      await removeTestProfile(profile)
    }
    throw error
  }
}

export async function closeTestApp(app: ElectronApplication, profile: string) {
  try {
    // Only counters leave main here, never request/response bodies or credentials.
    const state = await app.evaluate(() => {
      const s = (globalThis as any).__activeFake
      return {
        gemini: s.gemini,
        unknown: s.unknown,
        blocked: s.blockedNetwork,
        max: s.maxActive,
        logs: s.logSites,
      }
    })
    expect(state.gemini).toBe(0)
    expect(state.unknown).toBe(0)
    expect(state.blocked).toBe(0)
    expect(state.max).toBeLessThanOrEqual(1)
    expect(state.logs).toEqual([])
  } finally {
    try {
      await app.close()
    } finally {
      await removeTestProfile(profile)
    }
  }
}

// Requires the pre-main fakeChatGPT.cjs bootstrap; no actual login or inference.
export async function connectFakeChatGPT(page: Page) {
  await page.getByRole('button', { name: '설정', exact: true }).click()
  await page.getByRole('button', { name: 'ChatGPT 연결', exact: true }).click()
  await expect(page.getByRole('button', { name: 'ChatGPT 연결', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await expect(page.getByRole('button', { name: 'ChatGPT로 로그인' })).toBeEnabled()
  await page.getByRole('button', { name: 'ChatGPT로 로그인' }).click()
  await expect(page.getByRole('heading', { name: 'ChatGPT 플랜을 사용합니다' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'ChatGPT 번역 모델' })).toHaveValue('gpt-6.1-sol')
  await page.getByRole('button', { name: '설정 닫기' }).click()
}
