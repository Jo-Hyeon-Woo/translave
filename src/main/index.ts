import { createActiveTranslation } from './activeTranslation'
import { MemoError } from './memos'
import { exportMemo } from './memoExport'
import {
  PresentationError,
  PresentationImporter,
  presentationFile,
  presentationSource,
} from './presentationImport'
import { FileAuthVault } from './chatgpt/vault'
import { ChatGPTService } from './chatgpt/service'
import { ChatGPTError } from './chatgpt/errors'
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, safeStorage } from 'electron'
import { ImageBridge } from './imageBridge'
import { validSourcePage } from './batching'
import { ConfigurationError, TranslationService } from './translation'
import { createHash } from 'node:crypto'
import { open, mkdir, stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { TranslationStore, LibraryError } from './store'
import { TranslationQueue } from './queue'
import { MAX_PLAN_PAGES, TRANSLATION_VERSION, validLibrarySort } from '../shared/contracts'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { IpcMainInvokeEvent, OpenDialogOptions } from 'electron'
import type {
  ConfigurationResult,
  OpenResult,
  LibrarySortResult,
  LibraryDeleteResult,
} from '../shared/contracts'
import { DEFAULT_THEME, themePreset, validTheme } from '../shared/themes'
import type { ThemeId, ThemeConfigurationResult } from '../shared/themes'
import { PageChatService } from './chat/service'
import { PageChatImages } from './chat/images'
import { ChatInputError } from './chat/request'
import { CHAT_LIMITS } from '../shared/chat'
import type { ChatActionResult, ChatTarget } from '../shared/chat'

app.setName('Translave')
// Only the isolated test launcher sets this before Electron starts. Normal windows
// retain their native activation, ready-to-show and fullscreen behavior.
const quietTest =
  process.env.TRANSLAVE_TEST_MODE === 'quiet' && !!process.env.TRANSLAVE_TEST_USER_DATA
// Tests isolate Electron's own cache/settings from the user's normal app data.
if (process.env.TRANSLAVE_TEST_USER_DATA) {
  app.setPath('userData', process.env.TRANSLAVE_TEST_USER_DATA)
}

// One process owns rotating OAuth credentials for a userData directory.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  if (quietTest) return
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
})
let mainWindow: BrowserWindow | null = null
let opening = false
const imageBridge = new ImageBridge((request) => {
  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('renderer unavailable')
  mainWindow.webContents.send('image:render', request)
})
const translation = new TranslationService(undefined, (source, images, signal) =>
  imageBridge.request({ ...activeQueue().imageJob(source.page), source, images }, signal),
)
let store: TranslationStore | undefined
let theme: ThemeId = DEFAULT_THEME
let chatgpt: ChatGPTService | undefined
let provider: ReturnType<typeof createActiveTranslation> | undefined
let queue: TranslationQueue | undefined
let pageChat: PageChatService | undefined
let pageChatImages: PageChatImages | undefined
const openedIds = new Set<string>()
type SelectedSource = {
  path: string
  name: string
  sample: boolean
  derived?: { originalPath: string; pdfHash: string }
}
const selectedSources = new Map<string, SelectedSource>()
let addition: (SelectedSource & { id: string; total?: number; transient?: boolean }) | undefined
const presentations = new PresentationImporter(join(app.getPath('userData'), 'translations'))
let deletionGeneration = 0
const deletedGenerations = new Map<string, number>()
function activeQueue(): TranslationQueue {
  if (!queue) throw new Error('로컬 번역 DB를 열 수 없습니다.')
  return queue
}
function chatSnapshot() {
  return { ...chatgpt!.snapshot(), selectedModel: provider?.selectedModel() ?? '' }
}
async function updateChat(action: () => Promise<unknown>) {
  pageChat?.cancelAll()
  queue?.budgetChanged()
  await chatgpt!.stopInference()
  await action()
  const snapshot = chatgpt!.snapshot()
  if (
    (snapshot.status === 'signed_in' || snapshot.status === 'restored') &&
    snapshot.planAllowed &&
    !snapshot.models.length &&
    !snapshot.error
  )
    await chatgpt!.discoverModels()
  provider?.sync()
  queue?.credentialsChanged()
  return chatSnapshot()
}
const rendererFile = join(__dirname, '../renderer/index.html')

function checkSender(event: IpcMainInvokeEvent): void {
  if (
    !mainWindow ||
    event.sender !== mainWindow.webContents ||
    event.senderFrame !== mainWindow.webContents.mainFrame
  ) {
    throw new Error('Untrusted sender')
  }
  const expected = process.env.ELECTRON_RENDERER_URL || pathToFileURL(rendererFile).href
  const actual = new URL(event.senderFrame.url)
  const trusted = new URL(expected)
  if (actual.origin !== trusted.origin || actual.pathname !== trusted.pathname) {
    throw new Error('Untrusted origin')
  }
}

async function readPdf(
  path: string,
  sample: boolean,
  maxBytes = 150 * 1024 * 1024,
  identity?: { id: string; name: string; originalPath: string; pdfHash: string },
): Promise<OpenResult> {
  const generation = deletionGeneration
  try {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile()) return { status: 'error', message: 'PDF 파일을 선택해 주세요.' }
      if (info.size > maxBytes) {
        return {
          status: 'error',
          message:
            maxBytes === CHAT_LIMITS.pdfBytes
              ? '전체 PDF 첨부는 10 MiB 이하만 지원해요.'
              : '현재는 150MB 이하의 PDF를 열 수 있어요.',
        }
      }
      const bytes = await handle.readFile()
      if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) {
        return {
          status: 'error',
          message: '올바른 PDF 파일이 아니에요. 다른 파일을 선택해 주세요.',
        }
      }
      const hash = createHash('sha256').update(bytes).digest('hex')
      if (identity && hash !== identity.pdfHash)
        return {
          status: 'error',
          message: '앱의 변환 PDF가 변경되었어요. 저장된 자료를 확인해 주세요.',
        }
      const id = identity?.id ?? hash
      if ((deletedGenerations.get(id) ?? 0) > generation)
        return { status: 'error', message: '앱에서 삭제된 문서의 요청이에요.' }
      openedIds.add(id)
      const name = identity?.name ?? basename(path)
      selectedSources.set(id, {
        path,
        name,
        sample,
        ...(identity
          ? { derived: { originalPath: identity.originalPath, pdfHash: identity.pdfHash } }
          : {}),
      })
      return {
        status: 'opened',
        document: {
          id,
          name,
          bytes,
          sample,
        },
      }
    } finally {
      await handle.close()
    }
  } catch {
    return {
      status: 'error',
      message: '파일을 읽을 수 없어요. 파일 위치와 접근 권한을 확인해 주세요.',
    }
  }
}

function readStoredPdf(id: string, maxBytes?: number): Promise<OpenResult> {
  const source = store?.source(id)
  if (!source?.path)
    return Promise.resolve({ status: 'error', message: 'PDF 위치를 확인해 주세요.' })
  return readPdf(
    source.path,
    source.sample,
    maxBytes,
    source.derived ? { id, ...source.derived } : undefined,
  )
}
async function discardAddition(id?: string) {
  const pending = addition
  if (!pending || (id !== undefined && id !== pending.id)) return
  addition = undefined
  if (pending.transient && store?.source(pending.id)?.path !== pending.path) {
    await presentations.remove(pending.id, pending.path)
    openedIds.delete(pending.id)
    selectedSources.delete(pending.id)
  }
}

function createWindow(): void {
  queue?.restore()
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1000,
    minHeight: 680,
    title: 'Translave',
    backgroundColor: themePreset(theme).color,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 24 },
    show: false,
    ...(quietTest ? { focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !quietTest,
    },
  })
  const window = mainWindow
  const alignWindowButtons = () => {
    if (process.platform !== 'darwin' || window.isFullScreen()) return
    // Match the full 62px header space in styles.css.
    // macOS native button frames are 14px tall; keep their existing x inset.
    const headerHeight = 62
    window.setWindowButtonPosition({ x: 20, y: headerHeight / 2 - 7 })
  }
  const publishFullscreen = () =>
    window.webContents.send(
      'window:fullscreen-changed',
      process.platform === 'darwin' && window.isFullScreen(),
    )
  window.on('enter-full-screen', publishFullscreen)
  window.on('leave-full-screen', () => {
    alignWindowButtons()
    publishFullscreen()
  })
  window.on('resize', alignWindowButtons)
  window.on('maximize', alignWindowButtons)
  window.on('unmaximize', alignWindowButtons)
  alignWindowButtons()
  mainWindow.once('ready-to-show', () => {
    alignWindowButtons()
    if (!quietTest) window.show()
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())
  mainWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  )
  mainWindow.on('closed', () => {
    presentations.cancel()
    void discardAddition().catch(() => {})
    pageChat?.cancelAll()
    chatgpt?.dispose()
    queue?.detach()
    translation.configure({ apiKey: '' })
    mainWindow = null
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(rendererFile)
  }
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  chatgpt = new ChatGPTService({
    vault: new FileAuthVault(join(app.getPath('userData'), 'chatgpt'), safeStorage),
    openBrowser: (url) => shell.openExternal(url),
    render: async (target, ticket, signal) => {
      const cancel = () => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('chatgpt:render-canceled', ticket)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        return await imageBridge.request(
          {
            session: 'chatgpt-trial',
            token: ticket,
            source: {
              page: target.page,
              part: 1,
              width: 1,
              height: 1,
              outputTokens: 2048,
              region: { x: 0, y: 0, width: 1, height: 1 },
              order: [],
            },
            images: { ...translation.settings().images },
          },
          signal,
        )
      } catch {
        throw new ChatGPTError('image')
      } finally {
        signal.removeEventListener('abort', cancel)
      }
    },
  })
  await chatgpt.initialize()
  ipcMain.handle('chatgpt:snapshot', (event) => {
    checkSender(event)
    return chatSnapshot()
  })
  ipcMain.handle('chatgpt:signin', (event, id) => {
    checkSender(event)
    if (id !== undefined && (typeof id !== 'string' || id.length > 100)) return chatSnapshot()
    return updateChat(() => chatgpt!.signIn(id))
  })
  ipcMain.handle('chatgpt:cancel', (event) => {
    checkSender(event)
    return chatgpt!.cancel()
  })
  ipcMain.handle('chatgpt:logout', (event) => {
    checkSender(event)
    return updateChat(() => chatgpt!.logout())
  })
  ipcMain.handle('chatgpt:models', (event) => {
    checkSender(event)
    if (chatgpt!.snapshot().busy) return chatSnapshot()
    return updateChat(() => chatgpt!.discoverModels())
  })
  ipcMain.handle('chatgpt:model', (event, model) => {
    checkSender(event)
    return updateChat(async () => {
      if (typeof model !== 'string' || model.length > 200 || !provider)
        throw new ChatGPTError('model')
      provider.chooseModel(model)
    })
  })
  // Phase-one trial UI is retired. All user-facing translation is scheduled through the queue.
  ipcMain.handle('chatgpt:translate', (event) => {
    checkSender(event)
    return chatSnapshot()
  })
  ipcMain.handle('chatgpt:source', async (event, ticket): Promise<OpenResult> => {
    checkSender(event)
    const target = typeof ticket === 'string' ? chatgpt!.source(ticket) : undefined
    const source = target ? selectedSources.get(target.documentId) : undefined
    if (!source) return { status: 'error', message: '시험 문서를 찾을 수 없어요.' }
    const result = await readStoredPdf(target!.documentId)
    if (result.status !== 'opened' || result.document.id !== target!.documentId)
      return { status: 'error', message: '원본 PDF가 변경되었어요.' }
    return result
  })
  ipcMain.handle('chatgpt:usage', async (event) => {
    checkSender(event)
    await shell.openExternal('https://chatgpt.com/settings/usage')
  })
  try {
    const directory = join(app.getPath('userData'), 'translations')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    store = new TranslationStore(join(directory, 'translations.sqlite'), TRANSLATION_VERSION)
    await presentations
      .prune(new Set(store.derivedSources().map((source) => source.path)))
      .catch(() => {})
    theme = store.themeSettings()
    translation.configureBudget(store.budgetSettings())
    const images = store.imageSettings()
    if (images) {
      try {
        translation.configureImages(images)
      } catch {
        /* Use safe defaults. */
      }
    }
    store.useChatGPT()
    provider = createActiveTranslation(chatgpt, store, (source, images, signal) =>
      imageBridge.request({ ...activeQueue().imageJob(source.page), source, images }, signal),
    )
    provider.setImages(translation.settings().images)
    provider.sync()
    store.version = provider.cacheVersion()
    queue = new TranslationQueue(store, provider)
    queue.restore()
    pageChatImages = new PageChatImages({
      bridge: imageBridge,
      images: () => translation.settings().images,
      read: async (target) => {
        const source = store!.source(target.documentId)
        if (!source?.path) return { status: 'error', message: '원본 PDF 위치를 확인해 주세요.' }
        return readStoredPdf(target.documentId)
      },
      cancel: (ticket) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('page-chat:image-canceled', ticket)
      },
    })
    pageChat = new PageChatService({
      store: store.chats,
      auth: chatgpt,
      target: (target) => {
        const doc = store!.scheduled().find((d) => d.id === target.documentId)
        if (!doc || !openedIds.has(doc.id) || target.page > doc.total)
          throw new ChatInputError('열린 PDF의 페이지를 선택해 주세요.')
        return doc
      },
      model: () => provider!.selectedModel(),
      image: (target, signal) => pageChatImages!.render(target, signal),
      translation: (target) => store!.load(target.documentId).get(target.page),
      pdf: async (target, signal) => {
        signal.throwIfAborted()
        const source = store!.source(target.documentId)
        if (!source?.path)
          throw new ChatInputError('원본 PDF 위치를 확인해 주세요. 파일 목록에서 다시 열어 주세요.')
        const result = await readStoredPdf(target.documentId, CHAT_LIMITS.pdfBytes)
        signal.throwIfAborted()
        if (result.status !== 'opened')
          throw new ChatInputError(
            result.status === 'error' ? result.message : '원본 PDF를 읽을 수 없어요.',
          )
        if (result.document.id !== target.documentId)
          throw new ChatInputError('원본 PDF가 변경되었어요. 파일을 다시 확인해 주세요.')
        return result.document.bytes
      },
      notify: (update) => {
        if (mainWindow && !mainWindow.isDestroyed())
          mainWindow.webContents.send('page-chat:event', update)
      },
      failure: (error) => provider!.chatFailure(error),
      waitingReason: () => provider!.chatWaitingReason(),
    })
  } catch {
    // Keep PDF reading available; activation reports the storage failure without exposing content.
    dialog.showErrorBox(
      '번역 저장소 오류',
      '로컬 DB를 열 수 없어요. 디스크 여유 공간과 앱 데이터 폴더 권한을 확인해 주세요. PDF 읽기는 계속 사용할 수 있습니다.',
    )
  }
  const chatAction = (target: ChatTarget, clear = false): ChatActionResult => {
    try {
      if (!pageChat) throw new Error('unavailable')
      return { status: 'ok', snapshot: clear ? pageChat.clear(target) : pageChat.snapshot(target) }
    } catch {
      return {
        status: 'error',
        message: '페이지 대화를 읽거나 저장하지 못했어요. PDF와 로컬 저장소를 확인해 주세요.',
      }
    }
  }
  ipcMain.handle('memos:export', (event, input) => {
    checkSender(event)
    return exportMemo(
      input,
      () => {
        if (!store) throw new MemoError('메모 저장소를 열 수 없어요.')
        return store.memos.exportSource(input)
      },
      mainWindow!,
    )
  })
  for (const method of [
    'list',
    'load',
    'create',
    'save',
    'rename',
    'delete',
    'preferences',
  ] as const) {
    ipcMain.handle(`memos:${method}`, (event, input) => {
      checkSender(event)
      try {
        if (!store) throw new Error('unavailable')
        const value = (store.memos[method] as (input: any) => any).call(store.memos, input)
        if (['create', 'save', 'rename', 'delete'].includes(method))
          mainWindow?.webContents.send('memos:changed', {
            id: method === 'delete' ? input.id : value.id,
            deleted: method === 'delete',
          })
        return { status: 'ok', value }
      } catch (error) {
        return {
          status: 'error',
          message:
            error instanceof MemoError
              ? error.message
              : '메모를 저장하거나 읽지 못했어요. 다시 시도해 주세요.',
          ...(error instanceof MemoError && error.current ? { current: error.current } : {}),
        }
      }
    })
  }
  ipcMain.handle('page-chat:load', (event, target) => {
    checkSender(event)
    return chatAction(target)
  })
  ipcMain.handle('page-chat:image-source', (event, ticket) => {
    checkSender(event)
    if (typeof ticket !== 'string' || ticket.length > 100 || !pageChatImages)
      return { status: 'error', message: '페이지 이미지 요청을 확인해 주세요.' }
    return pageChatImages.source(ticket)
  })
  ipcMain.handle('page-chat:clear', (event, target) => {
    checkSender(event)
    return chatAction(target, true)
  })
  ipcMain.handle('page-chat:delete-turn', (event, target) => {
    checkSender(event)
    return (
      pageChat?.deleteTurn(target) ?? {
        status: 'error',
        message: '로컬 대화 저장소를 열 수 없어요.',
      }
    )
  })
  ipcMain.handle('page-chat:send', (event, input) => {
    checkSender(event)
    return pageChat?.send(input) ?? { status: 'error', message: '로컬 대화 저장소를 열 수 없어요.' }
  })
  ipcMain.handle('page-chat:stop', (event, requestId) => {
    checkSender(event)
    if (typeof requestId === 'string' && requestId.length <= 100) pageChat?.stop(requestId)
  })
  ipcMain.handle('window:fullscreen', (event) => {
    checkSender(event)
    return process.platform === 'darwin' && mainWindow!.isFullScreen()
  })
  ipcMain.handle('theme:settings', (event) => {
    checkSender(event)
    return theme
  })
  ipcMain.handle('theme:configure', (event, input): ThemeConfigurationResult => {
    checkSender(event)
    if (!validTheme(input)) return { status: 'error', message: '지원하는 테마를 선택해 주세요.' }
    try {
      if (!store) throw new Error('storage unavailable')
      store.saveThemeSettings(input)
    } catch {
      return { status: 'error', message: '테마를 저장하지 못했어요. 다시 시도해 주세요.' }
    }
    theme = input
    mainWindow?.setBackgroundColor(themePreset(theme).color)
    return { status: 'configured', theme }
  })
  ipcMain.handle('queue:activate', (event, input) => {
    checkSender(event)
    if (
      !input ||
      !openedIds.has(input.documentId) ||
      !store?.source(input.documentId) ||
      typeof input.name !== 'string' ||
      input.name.length > 1024 ||
      !Number.isInteger(input.total) ||
      input.total < 1 ||
      input.total > 100000 ||
      (input.page !== undefined &&
        (!Number.isInteger(input.page) || input.page < 1 || input.page > input.total))
    )
      throw new Error('문서 정보가 올바르지 않습니다.')
    const session = activeQueue().activate(input.documentId, input.name, input.total)
    if (input.page !== undefined) {
      activeQueue().focus(session.session, input.page)
      session.page = input.page
    }
    store!.opened(input.documentId)
    return session
  })
  ipcMain.handle('library:list', (event) => {
    checkSender(event)
    return activeQueue().library()
  })
  ipcMain.handle('library:sort-settings', (event) => {
    checkSender(event)
    return store!.librarySortSettings()
  })
  ipcMain.handle('library:sort-configure', (event, input): LibrarySortResult => {
    checkSender(event)
    if (!validLibrarySort(input))
      return { status: 'error', message: '지원하는 정렬 기준을 선택해 주세요.' }
    try {
      store!.saveLibrarySort(input)
      return { status: 'saved', sort: input }
    } catch {
      return { status: 'error', message: '정렬 기준을 저장하지 못했어요. 다시 시도해 주세요.' }
    }
  })
  ipcMain.handle('library:snapshot', (event) => {
    checkSender(event)
    return { documents: activeQueue().library(), folders: store!.folders() }
  })
  ipcMain.handle('library:change', (event, input) => {
    checkSender(event)
    try {
      if (!store) throw new Error('store unavailable')
      store.changeLibrary(input)
      return { status: 'saved' }
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof LibraryError
            ? error.message
            : '저장하지 못했어요. 저장 공간과 접근 권한을 확인한 뒤 다시 시도해 주세요.',
      }
    }
  })
  ipcMain.handle('library:delete', async (event, input): Promise<LibraryDeleteResult> => {
    checkSender(event)
    let deletion
    const derived = store?.derivedSources() ?? []
    try {
      if (!store) throw new Error('storage unavailable')
      deletion = store.deleteLibrary(input)
    } catch (error) {
      return {
        status: 'error',
        message:
          error instanceof LibraryError
            ? error.message
            : '삭제하지 못했어요. 저장 공간과 접근 권한을 확인한 뒤 다시 시도해 주세요.',
      }
    }
    // No await between commit and invalidation: late completions cannot recreate owners.
    deletionGeneration++
    for (const id of deletion.documentIds) {
      deletedGenerations.set(id, deletionGeneration)
      openedIds.delete(id)
      selectedSources.delete(id)
      if (addition?.id === id) addition = undefined
    }
    queue?.removeDocuments(deletion.documentIds)
    pageChat?.removeDocuments(deletion.documentIds)
    mainWindow?.webContents.send('library:deleted', deletion)
    const cleanup = await Promise.allSettled(
      derived
        .filter((source) => deletion.documentIds.includes(source.id))
        .map((source) => presentations.remove(source.id, source.path)),
    )
    return {
      status: 'deleted',
      deletion,
      ...(cleanup.some((result) => result.status === 'rejected')
        ? {
            warning:
              '문서는 삭제했지만 변환 PDF를 정리하지 못했어요. 다음 시작 때 다시 정리합니다.',
          }
        : {}),
    }
  })
  ipcMain.handle('library:add', async (event, input) => {
    checkSender(event)
    const chosen = input && addition?.id === input.id ? addition : undefined
    const source = chosen ? chosen : input && selectedSources.get(input.id)
    if (
      !store ||
      !source ||
      !Number.isInteger(input.total) ||
      input.total < 1 ||
      input.total > 100000 ||
      typeof input.thumbnail !== 'string' ||
      input.thumbnail.length > 250000 ||
      (input.thumbnail !== '' &&
        !/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(input.thumbnail)) ||
      (chosen?.total !== undefined && chosen.total !== input.total)
    )
      throw new Error('문서 목록에 저장할 수 없습니다.')
    try {
      store.add(
        input.id,
        source.name,
        input.total,
        source.path,
        input.thumbnail,
        source.sample,
        input.folderId === undefined ? null : input.folderId,
        !source.sample,
        source.derived,
      )
      if (chosen) addition = undefined
      activeQueue().enqueue(input.id, source.name, input.total)
    } catch {
      await discardAddition(input.id).catch(() => {})
      return {
        status: 'error',
        message: '문서 목록에 저장하지 못했어요. 저장 공간과 폴더를 확인해 주세요.',
      }
    }
  })
  ipcMain.handle('reading:load', (event) => {
    checkSender(event)
    try {
      return { status: 'loaded', workspace: store!.readingWorkspace() }
    } catch {
      return {
        status: 'error',
        message: '문서 탭을 복원하지 못했어요. 로컬 저장소를 확인해 주세요.',
      }
    }
  })
  ipcMain.handle('reading:save', (event, workspace) => {
    checkSender(event)
    try {
      store!.saveReadingWorkspace(workspace)
      return { status: 'saved' }
    } catch {
      return { status: 'error', message: '문서 탭과 읽던 위치를 저장하지 못했어요.' }
    }
  })
  ipcMain.handle('library:open', async (event, id, reconnect = true): Promise<OpenResult> => {
    checkSender(event)
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id))
      return { status: 'error', message: '문서 정보가 올바르지 않습니다.' }
    const source = store?.source(id)
    if (!source) return { status: 'error', message: '목록에서 문서를 찾을 수 없어요.' }
    if (source.path) {
      const result = await readStoredPdf(id)
      if (result.status === 'opened' && result.document.id === id) return result
      if (source.derived)
        return {
          status: 'error',
          message: '앱의 변환 PDF를 읽을 수 없어요. 원본 PPT/PPTX는 변경하지 않았어요.',
        }
    }
    if (reconnect !== true)
      return {
        status: 'error',
        message: '원본 PDF에 접근할 수 없어요. 파일 목록에서 같은 PDF를 다시 연결해 주세요.',
      }
    if (opening) return { status: 'canceled' }
    opening = true
    try {
      const selected = await dialog.showOpenDialog(mainWindow!, {
        title: '원본 PDF를 다시 선택해 주세요',
        message:
          '원본 위치가 없거나 파일이 변경되었습니다. 같은 PDF를 선택하면 저장된 번역을 복원합니다.',
        properties: ['openFile'],
        filters: [{ name: 'PDF 문서', extensions: ['pdf'] }],
      })
      if (selected.canceled || !selected.filePaths[0]) return { status: 'canceled' }
      const result = await readPdf(selected.filePaths[0], source.sample)
      if (result.status === 'opened' && result.document.id !== id)
        return {
          status: 'error',
          message: '선택한 파일이 원래 PDF와 달라요. 같은 PDF를 선택해 주세요.',
        }
      if (result.status === 'opened') {
        try {
          store!.reconnectSource(id, selected.filePaths[0], result.document.name)
        } catch {
          return {
            status: 'error',
            message: '원본 PDF 위치를 저장하지 못했어요. 다시 시도해 주세요.',
          }
        }
      }
      return result
    } finally {
      opening = false
    }
  })
  ipcMain.handle('queue:snapshot', (event, session, page) => {
    checkSender(event)
    return activeQueue().snapshot(session, page)
  })
  ipcMain.handle('queue:focus', (event, session, page) => {
    checkSender(event)
    return activeQueue().focus(session, page)
  })
  ipcMain.handle('queue:claim', (event, session) => {
    checkSender(event)
    return activeQueue().claim(session)
  })
  ipcMain.handle('queue:source', async (event, session, token): Promise<OpenResult> => {
    checkSender(event)
    const id = activeQueue().sourceJob(session, token)
    const source = id ? store?.source(id) : undefined
    if (!source?.path) return { status: 'error', message: '원본 PDF 위치를 확인해 주세요.' }
    const result = await readStoredPdf(id!)
    if (result.status !== 'opened' || result.document.id !== id)
      return {
        status: 'error',
        message: '원본 PDF가 이동되거나 변경되었어요. 파일 목록에서 다시 열어 주세요.',
      }
    return result
  })
  ipcMain.handle('queue:source-failed', (event, session, token) => {
    checkSender(event)
    activeQueue().failSource(session, token)
  })
  ipcMain.handle('queue:submit', async (event, session, token, pages) => {
    checkSender(event)
    if (
      typeof session !== 'string' ||
      typeof token !== 'string' ||
      !Array.isArray(pages) ||
      pages.length > MAX_PLAN_PAGES ||
      pages.some((p) => !validSourcePage(p))
    )
      throw new Error('추출 요청이 올바르지 않습니다.')
    await activeQueue().submit(session, token, pages)
  })
  ipcMain.handle('image:complete', (event, requestId, image) => {
    checkSender(event)
    if (typeof requestId !== 'string' || requestId.length > 100) return
    imageBridge.complete(requestId, image)
  })
  ipcMain.handle('translation:images', (event, input): ConfigurationResult => {
    checkSender(event)
    const previous = translation.settings().images
    let applied = false
    let saved = false
    try {
      const settings = translation.configureImages(input)
      if (!store) throw new Error('storage unavailable')
      store.saveImageSettings(settings.images)
      saved = true
      provider?.setImages(settings.images)
      applied = true
      queue?.imagesChanged()
      return { status: 'configured', settings: provider?.settings() ?? settings }
    } catch (error) {
      if (!(error instanceof ConfigurationError)) {
        translation.configureImages(previous)
        if (saved) {
          try {
            store?.saveImageSettings(previous)
          } catch {
            /* Report only the fixed error below. */
          }
        }
        if (applied) {
          provider?.setImages(previous)
          queue?.imagesChanged()
        }
      }
      return {
        status: 'error',
        message:
          error instanceof ConfigurationError ? error.message : '이미지 설정을 적용하지 못했어요.',
      }
    }
  })
  ipcMain.handle('queue:pause', (event, session, paused) => {
    checkSender(event)
    if (typeof paused !== 'boolean') throw new Error('일시정지 값이 올바르지 않습니다.')
    activeQueue().pause(session, paused)
  })
  ipcMain.handle('queue:retry', (event, session, page) => {
    checkSender(event)
    activeQueue().retry(session, page)
  })
  ipcMain.handle('translation:settings', (event) => {
    checkSender(event)
    return provider?.settings() ?? translation.settings()
  })
  // Keep inactive provider/settings code without exposing it as an active billing route.
  for (const channel of ['translation:budget', 'translation:configure'])
    ipcMain.handle(channel, (event): ConfigurationResult => {
      checkSender(event)
      return { status: 'error', message: '현재 번역은 ChatGPT 연결 설정을 사용합니다.' }
    })
  ipcMain.handle('translation:data-folder', async (event) => {
    checkSender(event)
    const error = await shell.openPath(join(app.getPath('userData'), 'translations'))
    if (error) throw new Error('저장 폴더를 열 수 없습니다.')
  })
  ipcMain.handle('translation:keys', async (event) => {
    checkSender(event)
    await shell.openExternal('https://aistudio.google.com/apikey')
  })
  ipcMain.handle('pdf:open', async (event): Promise<OpenResult> => {
    checkSender(event)
    if (opening || addition?.transient) return { status: 'canceled' }
    await discardAddition()
    opening = true
    try {
      let defaultPath: string | undefined
      try {
        const directory = store?.pdfDirectory()
        if (directory && (await stat(directory)).isDirectory()) {
          await access(directory, constants.R_OK | constants.X_OK)
          defaultPath = directory
        }
      } catch {
        /* An unavailable preference must not block PDF selection. */
      }
      const options: OpenDialogOptions = {
        title: '읽을 문서 선택',
        properties: ['openFile'],
        filters: [{ name: 'PDF·PowerPoint 문서', extensions: ['pdf', 'ppt', 'pptx'] }],
      }
      const selected = await dialog
        .showOpenDialog(mainWindow!, {
          ...options,
          ...(defaultPath ? { defaultPath } : {}),
        })
        .catch((error) => {
          // The directory can disappear or lose permission after the check.
          if (defaultPath) return dialog.showOpenDialog(mainWindow!, options)
          throw error
        })
      if (selected.canceled || !selected.filePaths[0]) return { status: 'canceled' }
      const path = selected.filePaths[0]
      if (presentationFile(path)) {
        const original = await presentationSource(path),
          existing = store?.source(original.id)
        if (existing?.derived) {
          const result = await readStoredPdf(original.id)
          if (result.status === 'opened')
            addition = {
              ...selectedSources.get(original.id)!,
              id: original.id,
              name: basename(path),
              derived: { ...existing.derived, originalPath: path },
            }
          return result
        }
        const converted = await presentations.convert(original)
        addition = {
          id: original.id,
          path: converted.path,
          name: basename(path),
          sample: false,
          derived: { originalPath: path, pdfHash: converted.pdfHash },
          total: converted.total,
          transient: true,
        }
        const result = await readPdf(converted.path, false, undefined, {
          id: original.id,
          name: basename(path),
          originalPath: path,
          pdfHash: converted.pdfHash,
        })
        if (result.status !== 'opened') await discardAddition(original.id)
        return result
      }
      const result = await readPdf(path, false)
      if (result.status === 'opened')
        addition = { id: result.document.id, path, name: basename(path), sample: false }
      return result
    } catch (error) {
      await discardAddition().catch(() => {})
      return {
        status: 'error',
        message:
          error instanceof PresentationError
            ? error.message
            : '자료를 가져오지 못했어요. 파일과 저장 공간을 확인해 주세요.',
      }
    } finally {
      opening = false
    }
  })
  ipcMain.handle('pdf:discard-addition', async (event, id) => {
    checkSender(event)
    try {
      if (typeof id === 'string') await discardAddition(id)
      return true
    } catch {
      return false
    }
  })
  ipcMain.handle('pdf:sample', async (event) => {
    checkSender(event)
    return readPdf(join(app.getAppPath(), 'resources/reading-notes.pdf'), true)
  })

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: '파일',
        submenu: [
          {
            label: '파일 목록…',
            accelerator: 'CmdOrCtrl+O',
            click: () => mainWindow?.webContents.send('pdf:open-requested'),
          },
          { type: 'separator' },
          { role: 'close' },
        ],
      },
      { role: 'editMenu' },
      { label: '보기', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
      { role: 'windowMenu' },
    ]),
  )
  createWindow()
  if (chatgpt.snapshot().status === 'restored' && chatgpt.snapshot().planAllowed) {
    void updateChat(() => chatgpt!.discoverModels()).catch(() => {})
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let importsStopped = false
app.on('before-quit', (event) => {
  if (!importsStopped && (presentations.busy || addition?.transient)) {
    event.preventDefault()
    importsStopped = true
    void presentations
      .shutdown()
      .then(() => discardAddition())
      .catch(() => {})
      .finally(() => app.quit())
    return
  }
  pageChat?.dispose()
  chatgpt?.dispose()
  queue?.detach()
  store?.close()
  store = undefined
})
