import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './styles.css'
import { startTranslationWorker } from './translationWorker'
import { DEFAULT_THEME, validTheme } from '../../shared/themes'
import { applyTheme } from './theme'

startTranslationWorker()

// Restore before mounting the UI; UI settings do not start or alter translation work.
void window.desktop
  .themeSettings()
  .catch(() => DEFAULT_THEME)
  .then((stored) => {
    const theme = validTheme(stored) ? stored : DEFAULT_THEME
    applyTheme(theme)
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <App initialTheme={theme} />
      </React.StrictMode>,
    )
  })
