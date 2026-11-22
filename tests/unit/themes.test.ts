import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranslationStore } from '../../src/main/store'
import {
  DEFAULT_BATCH_BUDGET,
  DEFAULT_IMAGE_SETTINGS,
  TRANSLATION_VERSION,
} from '../../src/shared/contracts'
import {
  DEFAULT_THEME,
  THEME_PALETTE,
  themeColors,
  themePreset,
  validTheme,
} from '../../src/shared/themes'
import { content } from './fakes'

export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a)
  return (values[0] + 0.05) / (values[1] + 0.05)
}
describe('persistent preset themes', () => {
  it('allows only the five presets and preserves existing default colors and meaning colors', () => {
    expect(DEFAULT_THEME).toBe('sage')
    for (const value of ['unknown', '', null, 1, {}, 'BLUE']) expect(validTheme(value)).toBe(false)
    const base = themeColors(DEFAULT_THEME)
    expect(base).toMatchObject({
      frame: '#e9ede8',
      'reader-background': '#f5f7f3',
      surface: '#ffffff',
      accent: '#246d5c',
      ink: '#243a36',
      'file-name-text': '#52605b',
      'primary-button-background': '#2b6e56',
    })
    for (const preset of THEME_PALETTE) {
      expect(validTheme(preset.id)).toBe(true)
      const colors = themeColors(preset.id)
      expect(colors.frame).toBe(preset.color)
      for (const role of [
        'status-success',
        'error',
        'translation-error',
        'error-background',
        'stopped-text',
        'unclear-background',
      ])
        expect(colors[role]).toBe(base[role])
      for (const [foreground, background] of [
        ['ink', 'surface'],
        ['translated-text-text', 'surface'],
        ['secondary-button-text', 'secondary-button-background'],
        ['on-accent', 'primary-button-background'],
      ]) {
        expect(
          contrast(colors[foreground], colors[background]),
          `${preset.id} ${foreground}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(
        contrast(colors['input-focus'], colors.surface),
        preset.id + ' focus',
      ).toBeGreaterThanOrEqual(3)
    }
    expect(themePreset('unknown').id).toBe('sage')
  })
  it('adds theme storage to an old DB, restores across restarts, and preserves all existing data and cache versions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'translave-theme-'))
    const file = join(directory, 'test.sqlite')
    const document = 'a'.repeat(64)
    let store: TranslationStore | undefined
    try {
      // Existing application schema and records before the additive theme migration.
      const previous = new DatabaseSync(file)
      previous.exec(
        "CREATE TABLE documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, total INTEGER NOT NULL, last_page INTEGER DEFAULT 1, paused INTEGER DEFAULT 0, pause_reason TEXT DEFAULT ''); INSERT INTO documents VALUES('" +
          document +
          "','existing.pdf',4,3,1,'user');",
      )
      previous.close()
      store = new TranslationStore(file, TRANSLATION_VERSION)
      store.saveBudgetSettings({ inputTokens: 14000, outputTokens: 12000 })
      store.saveImageSettings({ ...DEFAULT_IMAGE_SETTINGS, dpi: 200 })
      store.pauseAll(true)
      store.save(document, 1, {
        status: 'done',
        text: '저장된 번역',
        content: content('저장된 번역'),
      })
      expect(store.themeSettings()).toBe('sage')
      const before = store.load(document)
      for (const { id } of THEME_PALETTE) {
        store.saveThemeSettings(id)
        expect(store.themeSettings()).toBe(id)
        expect(store.version).toBe(TRANSLATION_VERSION)
        expect(store.load(document)).toEqual(before)
      }
      store.saveThemeSettings('blue')
      store.close()
      store = new TranslationStore(file, TRANSLATION_VERSION)
      expect(store.themeSettings()).toBe('blue')
      expect(store.load(document)).toEqual(before)
      expect(store.budgetSettings()).toEqual({ inputTokens: 14000, outputTokens: 12000 })
      expect(store.imageSettings()).toMatchObject({ dpi: 200 })
      expect(store.queuePaused()).toBe(true)
      const db = new DatabaseSync(file)
      expect(db.prepare('SELECT last_page,paused FROM documents').get()).toMatchObject({
        last_page: 3,
        paused: 1,
      })
      db.prepare("UPDATE theme_settings SET theme='unsupported'").run()
      expect(store.themeSettings()).toBe('sage')
      expect(() => store!.saveThemeSettings('unsupported' as any)).toThrow('Invalid theme')
      db.prepare("UPDATE theme_settings SET theme='blue'").run()
      db.exec(
        "CREATE TRIGGER reject_theme BEFORE UPDATE ON theme_settings BEGIN SELECT RAISE(ABORT,'test failure'); END;",
      )
      expect(() => store!.saveThemeSettings('rose')).toThrow()
      expect(store.themeSettings()).toBe('blue')
      expect(store.budgetSettings()).not.toEqual(DEFAULT_BATCH_BUDGET)
      expect(store.load(document)).toEqual(before)
      db.close()
    } finally {
      store?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
