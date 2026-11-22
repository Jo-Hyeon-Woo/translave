import { BrowserWindow, dialog } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import type { MemoExportInput, MemoExportResult, MemoExportSnapshot } from '../shared/memos'
import { MemoError } from './memos'

export function memoMarkdown(snapshot: MemoExportSnapshot, combined: boolean): string {
  return combined
    ? snapshot.sections.map((s) => `## ${s.page}페이지 메모\n\n${s.body}`).join('\n\n')
    : snapshot.sections[0].body
}

async function printMemo(snapshot: MemoExportSnapshot, owner: BrowserWindow): Promise<Buffer> {
  const renderer = join(__dirname, '../renderer/memo-export.html')
  const url = process.env.ELECTRON_RENDERER_URL
    ? new URL('memo-export.html', process.env.ELECTRON_RENDERER_URL).href
    : pathToFileURL(renderer).href
  const output = new BrowserWindow({
    show: false,
    focusable: false,
    width: 794,
    height: 1123,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
      partition: `memo-export-${randomUUID()}`,
    },
  })
  const session = output.webContents.session
  session.setPermissionRequestHandler((_contents, _permission, respond) => respond(false))
  session.setPermissionCheckHandler(() => false)
  session.webRequest.onBeforeRequest((request, respond) => {
    let allowed = false
    try {
      const resource = new URL(request.url),
        trusted = new URL(url)
      allowed =
        trusted.protocol === 'file:'
          ? resource.protocol === 'file:' &&
            fileURLToPath(resource).startsWith(dirname(renderer) + '/')
          : resource.origin === trusted.origin
    } catch {
      /* Block unsupported URLs. */
    }
    respond({ cancel: !allowed })
  })
  output.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  output.webContents.on('will-navigate', (event) => event.preventDefault())
  const close = () => {
    if (!output.isDestroyed()) output.destroy()
  }
  owner.once('closed', close)
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        await output.loadURL(url)
        await output.webContents.executeJavaScript(
          `window.renderMemoExport(${JSON.stringify(snapshot)})`,
        )
        return output.webContents.printToPDF({
          printBackground: true,
          preferCSSPageSize: true,
          displayHeaderFooter: false,
          pageSize: 'A4',
          generateTaggedPDF: true,
        })
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('export timeout')), 120000)
      }),
    ])
  } finally {
    clearTimeout(timeout)
    owner.removeListener('closed', close)
    close()
    session.webRequest.onBeforeRequest(null)
    await session.closeAllConnections().catch(() => {})
    await session.clearStorageData().catch(() => {})
    await session.clearCache().catch(() => {})
  }
}

// One save dialog/generation at a time across both entry points. No memo writes.
let busy = false
export async function exportMemo(
  input: MemoExportInput,
  source: () => MemoExportSnapshot,
  owner: BrowserWindow,
): Promise<MemoExportResult> {
  if (busy) return { status: 'error', message: '메모를 내보내고 있어요. 잠시 기다려 주세요.' }
  busy = true
  let temporary: string | undefined
  try {
    const snapshot = source()
    const name = snapshot.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || '메모'
    const chosen = await dialog.showSaveDialog(owner, {
      title: '메모 내보내기',
      defaultPath: `${name}.${input.format}`,
      filters: [{ name: input.format === 'pdf' ? 'PDF' : 'Markdown', extensions: [input.format] }],
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    })
    if (chosen.canceled || !chosen.filePath) return { status: 'canceled' }
    if (!chosen.filePath.toLowerCase().endsWith(`.${input.format}`))
      throw new MemoError(`.${input.format} 확장자로 저장해 주세요.`)
    const bytes =
      input.format === 'md'
        ? Buffer.from(memoMarkdown(snapshot, input.scope === 'document'), 'utf8')
        : await printMemo(snapshot, owner)
    temporary = join(dirname(chosen.filePath), `.translave-${randomUUID()}.tmp`)
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temporary, chosen.filePath)
    return { status: 'saved' }
  } catch (error) {
    return {
      status: 'error',
      message:
        error instanceof MemoError
          ? error.message
          : '메모를 내보내지 못했어요. 저장 위치와 내용을 확인해 주세요.',
    }
  } finally {
    if (temporary) await unlink(temporary).catch(() => {})
    busy = false
  }
}
