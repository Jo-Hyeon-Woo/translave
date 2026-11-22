import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PDFDocument } from 'pdf-lib'
import {
  PresentationImporter,
  PresentationError,
  presentationSource,
  runLibreOffice,
  validatePresentationPdf,
} from '../../src/main/presentationImport'
const spawn = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawn }))
const paths: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'translave-ppt-'))
  paths.push(root)
  const original = join(root, '한글 ; $().PPTX')
  await writeFile(original, 'own fake presentation bytes')
  const pdf = await PDFDocument.create()
  pdf.addPage([200, 100])
  pdf.addPage([200, 100])
  return { root, source: await presentationSource(original), bytes: Buffer.from(await pdf.save()) }
}
it('isolates source bytes, profile, hidden-slide export and owned PDF while retaining original identity', async () => {
  const { root, source, bytes } = await setup()
  const run = vi.fn(async (_exe: string, args: string[], work: string) => {
    expect(args).toContain('--headless')
    expect(args).toContain('--norestore')
    expect(args.some((arg) => arg.startsWith('--infilter='))).toBe(true)
    expect(args.some((arg) => arg.startsWith('-env:UserInstallation=file:'))).toBe(true)
    const fonts = await readFile(join(work, 'fonts.conf'), 'utf8')
    expect(fonts).toContain('/System/Library/Fonts')
    expect(fonts).toContain('font-cache')
    const options = JSON.parse(
      args[args.indexOf('--convert-to') + 1].split('pdf:impress_pdf_Export:')[1],
    )
    expect(options.ExportHiddenSlides.value).toBe('true')
    expect(options.ExportNotesPages.value).toBe('false')
    const profile = await readFile(join(work, 'profile/user/registrymodifications.xcu'), 'utf8')
    for (const name of [
      'DisableMacrosExecution',
      'DisableActiveContent',
      'BlockUntrustedRefererLinks',
    ])
      expect(profile).toContain(name)
    expect(await readFile(args.at(-1)!)).toEqual(source.bytes)
    await writeFile(join(args[args.indexOf('--outdir') + 1], 'input.pdf'), bytes)
  })
  const importer = new PresentationImporter(root, {
    find: async () => '/fake/soffice',
    run,
    validate: validatePresentationPdf,
  })
  const output = await importer.convert(source)
  expect(output.total).toBe(2)
  expect(output.pdfHash).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(source.id).toBe(createHash('sha256').update(source.bytes).digest('hex'))
  expect(await readFile(source.path)).toEqual(source.bytes)
  expect((await stat(output.path)).mode & 0o777).toBe(0o600)
  expect(await readdir(importer.directory)).toEqual([output.path.split('/').at(-1)])
  await importer.remove('wrong-id', output.path)
  expect(await readFile(output.path)).toEqual(bytes)
  await importer.remove(source.id, source.path)
  expect(await readFile(source.path)).toEqual(source.bytes)
  await importer.remove(source.id, output.path)
  expect(await readdir(importer.directory)).toEqual([])
})
it.each(['missing', 'failed', 'no-output', 'bad-output', 'invalid-pages'])(
  'cleans every partial resource on %s conversion failure',
  async (mode) => {
    const { root, source } = await setup()
    const importer = new PresentationImporter(root, {
      find: async () => {
        if (mode === 'missing') throw new PresentationError('install required')
        return '/fake'
      },
      run: async (_exe, args) => {
        if (mode === 'failed') throw new Error('not logged')
        if (mode !== 'no-output')
          await writeFile(join(args[args.indexOf('--outdir') + 1], 'input.pdf'), '%PDF-1.7 invalid')
      },
      validate: validatePresentationPdf,
    })
    await expect(importer.convert(source)).rejects.toThrow()
    expect(await readdir(importer.directory).catch(() => [])).toEqual([])
    expect(await readFile(source.path)).toEqual(source.bytes)
  },
)
it('rejects overlapping conversion and aborts/shuts down only the owned operation', async () => {
  const { root, source } = await setup()
  let started!: () => void
  const ready = new Promise<void>((r) => {
    started = r
  })
  const importer = new PresentationImporter(root, {
    find: async () => '/fake',
    run: async (_exe, _args, _work, signal) => {
      started()
      await new Promise<void>((_r, reject) =>
        signal.addEventListener('abort', () => reject(new Error('canceled')), { once: true }),
      )
    },
    validate: validatePresentationPdf,
  })
  const pending = expect(importer.convert(source)).rejects.toThrow()
  await ready
  await expect(importer.convert(source)).rejects.toThrow('다른 자료')
  await importer.shutdown()
  await pending
  expect(await readdir(importer.directory)).toEqual([])
})
it('passes an argument array to a restricted process and kills its process group on timeout without logs', async () => {
  vi.useFakeTimers()
  const child = Object.assign(new EventEmitter(), { pid: 987654321 })
  spawn.mockReturnValue(child)
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    queueMicrotask(() => child.emit('close', null))
    return true
  })
  const pending = expect(
    runLibreOffice(
      '/fake office/soffice',
      ['--headless', 'own file.ppt'],
      '/tmp/own-job',
      new AbortController().signal,
      50,
    ),
  ).rejects.toThrow('초과')
  const [exe, args, options] = spawn.mock.calls.at(-1)!
  expect(exe).toBe('/usr/bin/sandbox-exec')
  expect(args).toContain('/fake office/soffice')
  expect(args[1]).toContain('(deny network*)')
  expect(args[1]).toContain('(deny file-write*')
  expect(options).toMatchObject({ shell: false, stdio: 'ignore', detached: true })
  expect(options.env.HOME).toBe('/tmp/own-job')
  expect(options.env).not.toHaveProperty('OPENAI_API_KEY')
  await vi.advanceTimersByTimeAsync(60)
  await pending
  expect(kill).toHaveBeenCalledWith(-987654321, 'SIGTERM')
})
it('startup cleanup preserves registered derivatives and unrelated/original files', async () => {
  const { root, source } = await setup()
  const importer = new PresentationImporter(root)
  await mkdir(importer.directory)
  const kept = join(importer.directory, source.id + '-11111111-1111-1111-1111-111111111111.pdf')
  const orphan = join(importer.directory, source.id + '-22222222-2222-2222-2222-222222222222.pdf')
  const other = join(importer.directory, 'unrelated.pdf')
  for (const p of [kept, orphan, other]) await writeFile(p, 'own fixture')
  await mkdir(join(importer.directory, '.import-old'))
  await importer.prune(new Set([kept]))
  expect((await readdir(importer.directory)).sort()).toEqual(
    [kept.split('/').at(-1)!, 'unrelated.pdf'].sort(),
  )
  expect(await readFile(source.path)).toEqual(source.bytes)
})
