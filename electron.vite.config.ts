import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [
      react(),
      {
        name: 'development-csp',
        apply: 'serve',
        // React's development refresh preamble is inline. Production remains self-only.
        transformIndexHtml: (html) =>
          html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';"),
      },
    ],
    build: {
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          main: 'src/renderer/index.html',
          memoExport: 'src/renderer/memo-export.html',
        },
      },
    },
  },
})
