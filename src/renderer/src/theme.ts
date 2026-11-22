import { themeColors } from '../../shared/themes'
import type { ThemeId } from '../../shared/themes'

export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement
  for (const [role, color] of Object.entries(themeColors(theme))) {
    root.style.setProperty('--' + role, color)
  }
  root.dataset.theme = theme
}
