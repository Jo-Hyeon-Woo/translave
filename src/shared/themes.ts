export const THEME_PALETTE = [
  { id: 'sage', name: '세이지', color: '#e9ede8', hue: 145 },
  { id: 'ivory', name: '아이보리', color: '#f3eee2', hue: 42 },
  { id: 'blue', name: '블루', color: '#dfeaf0', hue: 205 },
  { id: 'rose', name: '로즈', color: '#f1e2e2', hue: 350 },
  { id: 'lavender', name: '라벤더', color: '#e9e3f1', hue: 265 },
] as const
export type ThemeId = (typeof THEME_PALETTE)[number]['id']
export const DEFAULT_THEME: ThemeId = 'sage'
export function validTheme(value: unknown): value is ThemeId {
  return THEME_PALETTE.some((entry) => entry.id === value)
}
export function themePreset(value: unknown) {
  return THEME_PALETTE.find((entry) => entry.id === value) || THEME_PALETTE[0]
}

// Semantic color roles preserve the existing default exactly, including subtle variations.
const sageColors: Record<string, string> = {
  frame: '#e9ede8',
  'reader-background': '#f5f7f3',
  accent: '#246d5c',
  ink: '#243a36',
  muted: '#88918f',
  border: '#e6eae7',
  surface: '#ffffff',
  'on-accent': '#ffffff',
  line: '#dfe5dd',
  'ink-soft': '#64735e',
  'app-text': '#273c3a',
  'card-shadow-low': '#263e3010',
  'card-shadow-high': '#263e3008',
  'input-focus': '#45977f',
  'app-background': '#b9ded3',
  'app-text-2': '#173b30',
  'brand-mark-background': '#266b59',
  'brand-divider-background': '#d9dfda',
  'file-name-text': '#52605b',
  'file-button-background': '#f0f4f0',
  'icon-button-text': '#708179',
  'icon-buttonis-active-background': '#eaf2ed',
  'page-controls-input-border': '#e3e8e2',
  'page-controls-input-text': '#46594d',
  'page-controls-input-background': '#fafbf9',
  'page-total-text': '#929a91',
  'zoom-value-text': '#68786f',
  'viewer-scroll-scrollbar': '#c5cec2',
  'page-loading-border': '#e2e8df',
  'page-loading-shadow': '#18392e12',
  'page-loading-background': '#fffffff0',
  'panel-divider-span-background': '#c0ccc1',
  'panel-tabs-border': '#eaf0e7',
  'panel-tabs-button-text': '#97a194',
  'panel-icon-text': '#a9b4a5',
  'language-bar-text': '#879385',
  'target-language-text': '#415846',
  'language-bar-svg-text': '#afb9a9',
  'connection-badge-text': '#8b9686',
  'panel-scroll-scrollbar': '#e0e6db',
  'panel-glyph-border': '#e2eade',
  'panel-glyph-text': '#86a18b',
  'panel-glyph-background': '#f5f8f1',
  'panel-welcome-h2-text': '#50634e',
  'panel-welcome-p-text': '#9aa391',
  'steps-border': '#edf0e7',
  'steps-div-text': '#8b9882',
  'steps-div-span-text': '#a6b49d',
  'steps-div-span-border': '#e9eee2',
  'steps-div-span-background': '#fafcf7',
  'content-meta-text': '#a1ac97',
  'sample-status-text': '#6e9577',
  'translation-content-h2-text': '#314c3d',
  'translation-content-p-text': '#64735e',
  'sample-disclaimer-border': '#edf1e7',
  'sample-disclaimer-text': '#a3ac98',
  'source-help-text': '#99a28f',
  'source-help-border': '#ecf0e5',
  'source-content-pre-text': '#596c52',
  'no-text-text': '#9baa92',
  'no-text-h3-text': '#718265',
  'no-text-p-text': '#9aa68e',
  'panel-message-text': '#94a386',
  'secondary-button-background': '#f1f6eb',
  'secondary-button-border': '#e5eddb',
  'secondary-button-text': '#59724b',
  'secondary-button-background-2': '#e7f0de',
  'reader-empty-background': '#fafcf6',
  'reader-empty-background-2': '#f0f4ed',
  'reader-empty-background-3': '#eef2ec',
  'art-page-border': '#e2e9db',
  'art-back-background': '#e2ebe0',
  'art-front-background': '#fffffc',
  'art-front-shadow': '#526b4c13',
  'art-label-text': '#97a58f',
  'art-title-text': '#385441',
  'art-stamp-background': '#53876b',
  'art-stamp-border': '#f2f6ed',
  'art-stamp-shadow': '#4f765a14',
  'art-spark-text': '#a0b795',
  'eyebrow-text': '#7d9678',
  'welcome-h1-text': '#304d3b',
  'welcome-p-text': '#8c9c83',
  'primary-button-background': '#2b6e56',
  'primary-button-shadow': '#204e3b15',
  'primary-button-background-2': '#235c47',
  'sample-link-text': '#7e9474',
  'sample-link-text-2': '#3b7553',
  'local-note-text': '#a3b09b',
  'opening-overlay-background': '#fffffff5',
  'opening-overlay-shadow': '#163d2820',
  'settings-dialog-border': '#e0e7da',
  'settings-dialog-shadow': '#142d2340',
  'settings-dialog-background': '#19372735',
  'dialog-header-border': '#ecf0e6',
  'settings-body-p-text': '#88987d',
  'milestone-row-text': '#637d54',
  'milestone-tag-background': '#edf5e6',
  'settings-body-privacy-note-text': '#9aaa8d',
  'muted-text': '#a5af9b',
  'key-label-span-text': '#71816a',
  'gemini-key-border': '#d9dfd5',
  'translated-text-text': '#39443d',
  'queue-summary-border': '#e3e9e2',
  'queue-summary-background': '#f9fbf7',
  'queue-counts-span-text': '#6f7e71',
  'queue-summary-progress-accent-color': '#337a62',
  'queue-note-text': '#6c7f70',
  'file-dialog-border': '#dce4dc',
  'file-dialog-background': '#fbfcf9',
  'file-dialog-shadow': '#173d3433',
  'file-dialog-background-2': '#233d3547',
  'library-add-background': '#1c594b',
  'library-description-text': '#818e86',
  'library-description-span-text': '#536a5c',
  'library-row-border': '#e6eae3',
  'library-title-span-text': '#879389',
  'library-count-text': '#718177',
  'library-progress-progress-background': '#e5ebe2',
  'library-progress-progress-background-2': '#639782',
  'library-open-border': '#d8e2d7',
  'library-open-background': '#edf3eb',
  'library-empty-text': '#859489',
  'library-empty-h3-text': '#4e6658',
  'library-footer-border': '#e5eae1',
  'library-footer-text': '#869487',
  'translation-menu-summary-text': '#738779',
  'translation-menu-open-summary-background': '#eef4ed',
  'translation-menu-content-border': '#e0e7de',
  'translation-menu-content-shadow': '#1e3f2d1a',
  'translation-menu-content-button-text': '#41584a',
  'translation-menu-content-button-background': '#f0f5ee',
  'translation-menu-content-menu-progress-border': '#edf1ea',
  'translation-menu-content-menu-progress-text': '#8a9687',
  'translation-state-text': '#83907f',
  'markdown-content-pre-background': '#f3f5f0',
  'markdown-content-td-border': '#dfe5dd',
  'settings-section-summary-text': '#7a897d',
  'settings-form-select-border': '#d7dfd6',
  'theme-applied-dot-border': '#c6cec2',
  'thumbnail-border': '#e0e5dc',
  'thumbnail-shadow': '#263c3510',
  'thumbnail-text': '#9bad9e',
  'theme-swatch-shadow': '#243a3618',
}
const statusColors = {
  'status-success': '#246d5c',
  error: '#ae5542',
  'translation-error': '#a14035',
  'error-background': '#fff0e9',
  'error-border': '#f3d9c9',
  'error-text': '#945d48',
  'stopped-text': '#8a826b',
  'library-error-background': '#fff1e8',
  'library-error-text': '#985b35',
  'unclear-background': '#faf8f0',
}

// Fixed light palettes share tonal roles; text is darkened for readable non-default themes.
function tint(hex: string, hue: number, text: boolean): string {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const high = Math.max(...rgb),
    low = Math.min(...rgb),
    delta = high - low
  let light = (high + low) / 2
  const saturation = delta ? delta / (1 - Math.abs(2 * light - 1)) : 0.16
  if (text) light = Math.min(light, 0.42)
  else if (light === 1) light = 0.995
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation
  const sector = hue / 60
  const x = chroma * (1 - Math.abs((sector % 2) - 1))
  const channels =
    sector < 1
      ? [chroma, x, 0]
      : sector < 2
        ? [x, chroma, 0]
        : sector < 3
          ? [0, chroma, x]
          : sector < 4
            ? [0, x, chroma]
            : sector < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  return (
    '#' +
    channels
      .map((c) =>
        Math.round((c + light - chroma / 2) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('') +
    hex.slice(7)
  )
}
export function themeColors(theme: ThemeId): Record<string, string> {
  const preset = themePreset(theme)
  const colors =
    theme === DEFAULT_THEME
      ? { ...sageColors }
      : Object.fromEntries(
          Object.entries(sageColors).map(([role, value]) => [
            role,
            role === 'on-accent'
              ? value
              : tint(
                  value,
                  preset.hue,
                  role.endsWith('-text') || ['ink', 'ink-soft', 'muted'].includes(role),
                ),
          ]),
        )
  return { ...colors, frame: preset.color, ...statusColors }
}
export type ThemeConfigurationResult =
  { status: 'configured'; theme: ThemeId } | { status: 'error'; message: string }
