import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopAPI } from '../shared/contracts'

const api: DesktopAPI = {
  memoExport: (input) => ipcRenderer.invoke('memos:export', input),
  memoList: () => ipcRenderer.invoke('memos:list'),
  memoLoad: (target) => ipcRenderer.invoke('memos:load', target),
  memoCreate: (title) => ipcRenderer.invoke('memos:create', title),
  memoSave: (input) => ipcRenderer.invoke('memos:save', input),
  memoRename: (input) => ipcRenderer.invoke('memos:rename', input),
  memoDelete: (input) => ipcRenderer.invoke('memos:delete', input),
  memoPreferences: (next) => ipcRenderer.invoke('memos:preferences', next),
  onMemoChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, value: { id: string; deleted: boolean }) =>
      callback(value)
    ipcRenderer.on('memos:changed', listener)
    return () => ipcRenderer.removeListener('memos:changed', listener)
  },
  readingWorkspace: () => ipcRenderer.invoke('reading:load'),
  saveReadingWorkspace: (workspace) => ipcRenderer.invoke('reading:save', workspace),
  pageChatImageSource: (ticket) => ipcRenderer.invoke('page-chat:image-source', ticket),
  onPageChatImageCanceled: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, ticket: string) => callback(ticket)
    ipcRenderer.on('page-chat:image-canceled', listener)
    return () => ipcRenderer.removeListener('page-chat:image-canceled', listener)
  },
  pageChat: (target) => ipcRenderer.invoke('page-chat:load', target),
  sendPageChat: (input) => ipcRenderer.invoke('page-chat:send', input),
  stopPageChat: (requestId) => ipcRenderer.invoke('page-chat:stop', requestId),
  clearPageChat: (target) => ipcRenderer.invoke('page-chat:clear', target),
  deletePageChatTurn: (target) => ipcRenderer.invoke('page-chat:delete-turn', target),
  onPageChat: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      update: import('../shared/chat').ChatEvent,
    ) => callback(update)
    ipcRenderer.on('page-chat:event', listener)
    return () => ipcRenderer.removeListener('page-chat:event', listener)
  },
  chatgptChooseModel: (model) => ipcRenderer.invoke('chatgpt:model', model),
  onChatGPTRenderCanceled: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, ticket: string) => callback(ticket)
    ipcRenderer.on('chatgpt:render-canceled', listener)
    return () => ipcRenderer.removeListener('chatgpt:render-canceled', listener)
  },
  chatgptSnapshot: () => ipcRenderer.invoke('chatgpt:snapshot'),
  chatgptSignIn: (profileId) => ipcRenderer.invoke('chatgpt:signin', profileId),
  chatgptCancel: () => ipcRenderer.invoke('chatgpt:cancel'),
  chatgptLogout: () => ipcRenderer.invoke('chatgpt:logout'),
  chatgptModels: () => ipcRenderer.invoke('chatgpt:models'),
  chatgptTranslate: (input) => ipcRenderer.invoke('chatgpt:translate', input),
  chatgptSource: (ticket) => ipcRenderer.invoke('chatgpt:source', ticket),
  chatgptUsage: () => ipcRenderer.invoke('chatgpt:usage'),
  themeSettings: () => ipcRenderer.invoke('theme:settings'),
  configureTheme: (theme) => ipcRenderer.invoke('theme:configure', theme),
  librarySortSettings: () => ipcRenderer.invoke('library:sort-settings'),
  configureLibrarySort: (sort) => ipcRenderer.invoke('library:sort-configure', sort),
  windowFullscreen: () => ipcRenderer.invoke('window:fullscreen'),
  onWindowFullscreen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, fullscreen: boolean) =>
      callback(fullscreen)
    ipcRenderer.on('window:fullscreen-changed', listener)
    return () => ipcRenderer.removeListener('window:fullscreen-changed', listener)
  },
  listDocuments: () => ipcRenderer.invoke('library:list'),
  librarySnapshot: () => ipcRenderer.invoke('library:snapshot'),
  changeLibrary: (change) => ipcRenderer.invoke('library:change', change),
  deleteLibrary: (target) => ipcRenderer.invoke('library:delete', target),
  onLibraryDeleted: (callback) => {
    const listener = (_event: unknown, deletion: Parameters<typeof callback>[0]) =>
      callback(deletion)
    ipcRenderer.on('library:deleted', listener)
    return () => ipcRenderer.removeListener('library:deleted', listener)
  },
  addDocument: (input) => ipcRenderer.invoke('library:add', input),
  openLibraryDocument: (id, reconnect) => ipcRenderer.invoke('library:open', id, reconnect),
  translationSettings: () => ipcRenderer.invoke('translation:settings'),
  configureImages: (images) => ipcRenderer.invoke('translation:images', images),
  configureBudget: (budget) => ipcRenderer.invoke('translation:budget', budget),
  configureTranslation: (input) => ipcRenderer.invoke('translation:configure', input),
  activateDocument: (input) => ipcRenderer.invoke('queue:activate', input),
  queueSnapshot: (session, page) => ipcRenderer.invoke('queue:snapshot', session, page),
  focusPage: (session, page) => ipcRenderer.invoke('queue:focus', session, page),
  claimPage: (session) => ipcRenderer.invoke('queue:claim', session),
  readJobPdf: (session, token) => ipcRenderer.invoke('queue:source', session, token),
  failJobPdf: (session, token) => ipcRenderer.invoke('queue:source-failed', session, token),
  submitPage: (session, token, pages) => ipcRenderer.invoke('queue:submit', session, token, pages),
  onRenderRequested: (callback) => {
    const listener = (
      _event: Electron.IpcRendererEvent,
      request: import('../shared/contracts').RenderRequest,
    ) => callback(request)
    ipcRenderer.on('image:render', listener)
    return () => ipcRenderer.removeListener('image:render', listener)
  },
  completeRender: (requestId, image) => ipcRenderer.invoke('image:complete', requestId, image),
  pauseQueue: (session, paused) => ipcRenderer.invoke('queue:pause', session, paused),
  retryQueue: (session, page) => ipcRenderer.invoke('queue:retry', session, page),
  openApiKeys: () => ipcRenderer.invoke('translation:keys'),
  openDataFolder: () => ipcRenderer.invoke('translation:data-folder'),
  openPdf: () => ipcRenderer.invoke('pdf:open'),
  discardPdfAddition: (id) => ipcRenderer.invoke('pdf:discard-addition', id),
  openSample: () => ipcRenderer.invoke('pdf:sample'),
  onOpenRequested: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('pdf:open-requested', listener)
    return () => {
      ipcRenderer.removeListener('pdf:open-requested', listener)
    }
  },
}
contextBridge.exposeInMainWorld('desktop', api)
