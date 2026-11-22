import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, delimiter, dirname, extname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

export class PresentationError extends Error {}
export const presentationFile = (path: string) =>
  ['.ppt', '.pptx'].includes(extname(path).toLowerCase())
export async function presentationSource(path: string) {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 150 * 1024 * 1024)
      throw new PresentationError('PPT/PPTX는 150MB 이하의 파일을 선택해 주세요.')
    const bytes = await file.readFile()
    return { path, bytes, id: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    await file.close()
  }
}
export async function findLibreOffice(): Promise<string> {
  const paths = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
    ...['/opt/homebrew/bin', '/usr/local/bin', ...(process.env.PATH ?? '').split(delimiter)]
      .filter(Boolean)
      .map((path) => join(path, 'soffice')),
  ]
  for (const path of paths) {
    try {
      await access(path, constants.X_OK)
      if ((await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()) return resolve(path)
    } catch {
      /* Try the next installed location. */
    }
  }
  throw new PresentationError(
    'PPT/PPTX를 가져오려면 LibreOffice를 설치해 주세요. PDF는 그대로 추가할 수 있어요.',
  )
}
// No shell, console output, network access, or writes outside this isolated job.
export function runLibreOffice(
  executable: string,
  args: string[],
  work: string,
  signal: AbortSignal,
  timeoutMs = 120000,
): Promise<void> {
  if (process.platform !== 'darwin')
    throw new PresentationError('현재 PPT/PPTX 가져오기는 macOS의 LibreOffice를 지원해요.')
  const policy = `(version 1)(allow default)(deny network*)(deny file-write* (require-not (subpath ${JSON.stringify(work)})))`
  return new Promise((accept, reject) => {
    signal.throwIfAborted()
    const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, executable, ...args], {
      cwd: work,
      detached: true,
      stdio: 'ignore',
      shell: false,
      env: {
        PATH: process.env.PATH,
        HOME: work,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        TMPDIR: work,
        SAL_LOG: '-WARN-INFO',
        SAL_USE_VCLPLUGIN: 'svp',
        FONTCONFIG_FILE: join(work, 'fonts.conf'),
      },
    })
    let failure: Error | undefined, killTimer: ReturnType<typeof setTimeout> | undefined
    const kill = (reason: Error) => {
      failure ??= reason
      const send = (kind: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, kind)
        } catch {
          /* Already closed. */
        }
      }
      send('SIGTERM')
      killTimer ??= setTimeout(() => send('SIGKILL'), 1000)
    }
    const abort = () => kill(new PresentationError('PPT/PPTX 가져오기가 취소됐어요.'))
    const timer = setTimeout(
      () => kill(new PresentationError('PPT/PPTX 변환 시간이 초과됐어요.')),
      timeoutMs,
    )
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', () => {
      failure = new PresentationError(
        'LibreOffice를 실행하지 못했어요. 설치와 실행 권한을 확인해 주세요.',
      )
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      clearTimeout(killTimer)
      signal.removeEventListener('abort', abort)
      if (failure && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          /* No owned descendants remain. */
        }
      }
      if (failure) reject(failure)
      else if (code !== 0)
        reject(
          new PresentationError(
            'PPT/PPTX를 변환하지 못했어요. 손상되거나 암호로 보호된 자료인지 확인해 주세요.',
          ),
        )
      else accept()
    })
  })
}
export async function validatePresentationPdf(bytes: Uint8Array): Promise<number> {
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from('%PDF-')))
    throw new PresentationError('LibreOffice가 올바른 PDF를 만들지 못했어요.')
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = getDocument({
    data: Uint8Array.from(bytes),
    verbosity: 0,
    stopAtErrors: true,
  })
  try {
    const pdf = await task.promise
    if (!Number.isSafeInteger(pdf.numPages) || pdf.numPages < 1 || pdf.numPages > 100000)
      throw new Error('pages')
    await pdf.getPage(1)
    await pdf.getPage(pdf.numPages)
    return pdf.numPages
  } catch {
    throw new PresentationError(
      '변환 PDF를 열 수 없어요. 손상되거나 암호로 보호된 자료인지 확인해 주세요.',
    )
  } finally {
    await task.destroy()
  }
}
const profile = `<?xml version="1.0" encoding="UTF-8"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting">
${['DisableMacrosExecution', 'DisableActiveContent', 'BlockUntrustedRefererLinks'].map((name) => `<prop oor:name="${name}" oor:op="fuse"><value>true</value></prop>`).join('')}
<prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item></oor:items>`
export class PresentationImporter {
  readonly directory: string
  private controller?: AbortController
  private finished = Promise.resolve()
  get busy() {
    return !!this.controller
  }
  constructor(
    root: string,
    private deps = {
      find: findLibreOffice,
      run: runLibreOffice,
      validate: validatePresentationPdf,
    },
  ) {
    this.directory = join(root, 'presentations')
  }
  cancel() {
    this.controller?.abort()
  }
  async shutdown() {
    this.cancel()
    await this.finished
  }
  async convert(source: Awaited<ReturnType<typeof presentationSource>>) {
    if (this.controller)
      throw new PresentationError('다른 자료를 가져오고 있어요. 잠시 기다려 주세요.')
    const controller = (this.controller = new AbortController())
    let finish!: () => void
    this.finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    let work: string | undefined, output: string | undefined
    try {
      const executable = await this.deps.find()
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      work = await realpath(await mkdtemp(join(this.directory, '.import-')))
      const user = join(work, 'profile'),
        converted = join(work, 'output'),
        input = join(work, 'input' + extname(source.path).toLowerCase())
      await mkdir(join(user, 'user'), { recursive: true })
      await mkdir(converted)
      const xml = (value: string) =>
        value.replace(
          /[&<>"']/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
        )
      // Headless builds may omit macOS fonts from their own fontconfig. Use only
      // already-installed local fonts, with a cache owned by this job.
      await writeFile(
        join(work, 'fonts.conf'),
        `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd"><fontconfig>${['/System/Library/Fonts', '/Library/Fonts', join(homedir(), 'Library/Fonts')].map((path) => `<dir>${xml(path)}</dir>`).join('')}<cachedir>${xml(join(work, 'font-cache'))}</cachedir></fontconfig>`,
        { mode: 0o600 },
      )
      await writeFile(join(user, 'user/registrymodifications.xcu'), profile, { mode: 0o600 })
      await writeFile(input, source.bytes, { mode: 0o600 })
      const options = Object.fromEntries(
        Object.entries({
          ExportHiddenSlides: true,
          ExportNotes: false,
          ExportNotesPages: false,
          ExportOnlyNotesPages: false,
        }).map(([name, value]) => [name, { type: 'boolean', value: String(value) }]),
      )
      await this.deps.run(
        executable,
        [
          `-env:UserInstallation=${pathToFileURL(user).href}`,
          '--headless',
          '--nologo',
          '--nodefault',
          '--norestore',
          `--infilter=${extname(source.path).toLowerCase() === '.ppt' ? 'MS PowerPoint 97' : 'Impress MS PowerPoint 2007 XML'}`,
          '--convert-to',
          `pdf:impress_pdf_Export:${JSON.stringify(options)}`,
          '--outdir',
          converted,
          input,
        ],
        work,
        controller.signal,
      )
      controller.signal.throwIfAborted()
      const pdf = join(converted, 'input.pdf'),
        info = await lstat(pdf)
      if (!info.isFile() || info.size === 0 || info.size > 150 * 1024 * 1024)
        throw new Error('output')
      const bytes = await readFile(pdf),
        total = await this.deps.validate(bytes)
      const hash = createHash('sha256').update(bytes).digest('hex')
      controller.signal.throwIfAborted()
      output = join(this.directory, `${source.id}-${randomUUID()}.pdf`)
      await rename(pdf, output)
      await chmod(output, 0o600)
      controller.signal.throwIfAborted()
      const path = output
      output = undefined
      return { path, pdfHash: hash, total }
    } catch (error) {
      if (error instanceof PresentationError) throw error
      throw new PresentationError(
        'PPT/PPTX를 가져오지 못했어요. 자료의 암호·손상 여부와 저장 공간을 확인해 주세요.',
      )
    } finally {
      if (output) await rm(output, { force: true }).catch(() => {})
      if (work) await rm(work, { recursive: true, force: true }).catch(() => {})
      this.controller = undefined
      finish()
    }
  }
  async remove(id: string, path: string) {
    if (
      dirname(path) !== this.directory ||
      basename(path).slice(0, 64) !== id ||
      !/^[a-f0-9]{64}-[a-f0-9-]{36}\.pdf$/.test(basename(path))
    )
      return
    await rm(path, { force: true })
  }
  async prune(kept: Set<string>) {
    const names = await readdir(this.directory).catch(() => [] as string[])
    for (const name of names) {
      const path = join(this.directory, name)
      if (
        name.startsWith('.import-') ||
        (/^[a-f0-9]{64}-[a-f0-9-]{36}\.pdf$/.test(name) && !kept.has(path))
      )
        await rm(path, { recursive: name.startsWith('.import-'), force: true })
    }
  }
}
