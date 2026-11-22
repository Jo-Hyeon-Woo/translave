// Loaded before fake/provider/main initialization: never show then hide a window.
const { resolve, relative, basename } = require('node:path')
const { tmpdir } = require('node:os')
const profile = process.env.TRANSLAVE_TEST_USER_DATA
const inside = profile && relative(resolve(tmpdir()), resolve(profile))
const mode = process.env.TRANSLAVE_TEST_MODE
if (
  !inside ||
  inside.startsWith('..') ||
  !basename(profile).startsWith('translave-') ||
  !['quiet', 'screen'].includes(mode)
)
  throw new Error('Test runtime requires an isolated profile and explicit mode')

const { app } = require('electron')
if (mode === 'quiet' && process.platform === 'darwin') {
  // accessory permits real hidden BrowserWindows; prohibited does not support
  // windows. This runs before ready (and before the fake's crypto initialization).
  app.setActivationPolicy('accessory')
}
const state = { mode, created: 0, shown: 0, focused: 0, activated: 0, native: 0 }
global.__testWindowState = state
app.on('did-become-active', () => state.activated++)
app.on('browser-window-created', (_event, window) => {
  state.created++
  if (window.isVisible()) state.shown++
  if (window.isFocused()) state.focused++
  window.on('show', () => state.shown++)
  window.on('focus', () => state.focused++)
  window.on('maximize', () => state.native++)
  window.on('enter-full-screen', () => state.native++)
})
