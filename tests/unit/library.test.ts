import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PageChatStore } from '../../src/main/chat/store'
import { TranslationStore } from '../../src/main/store'
import { TranslationQueue } from '../../src/main/queue'
import { cycleReadingTab, moveReadingTab } from '../../src/shared/readingTabs'
import {
  DEFAULT_BATCH_BUDGET,
  DEFAULT_IMAGE_SETTINGS,
  DEFAULT_LIBRARY_SORT,
  sortLibraryDocuments,
} from '../../src/shared/contracts'
import type { LibrarySort, LibraryDocument } from '../../src/shared/contracts'
import type { TranslationRequest, TranslationResult } from '../../src/shared/contracts'

const stores: TranslationStore[] = []
const paths: string[] = []
afterEach(() => {
  stores.forEach((store) => store.close())
  stores.length = 0
  paths.forEach((path) => rmSync(path, { recursive: true, force: true }))
  paths.length = 0
})
function storeAt(path = ':memory:', version = 'v1') {
  const store = new TranslationStore(path, version)
  stores.push(store)
  return store
}
it('adds without recording a view, sorts by actual opening, and deduplicates the same content', () => {
  const store = storeAt()
  store.add('a', 'A.pdf', 3, '/a.pdf', '', false)
  store.opened('a')
  store.add('b', 'B.pdf', 2, '/b.pdf', '', false)
  expect(store.list().map((row) => row.id)).toEqual(['a', 'b'])
  expect(store.list()[1].lastOpened).toBeNull()
  store.opened('b')
  expect(store.list().map((row) => row.id)).toEqual(['b', 'a'])
  store.opened('a')
  store.add('a', 'renamed.pdf', 3, '/renamed.pdf', 'thumbnail', false)
  expect(store.list().map((row) => row.id)).toEqual(['a', 'b'])
  expect(store.source('a')?.path).toBe('/renamed.pdf')
})
it('restores a common sort preference, defaults unknown/missing values, and preserves document dates and other records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-sort-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite'),
    store = storeAt(file)
  expect(store.librarySortSettings()).toBe(DEFAULT_LIBRARY_SORT)
  store.add('sort-doc', 'File.pdf', 2, '/fake.pdf', '', false)
  store.save('sort-doc', 1, { status: 'done', text: 'fake' })
  const registered = store.list()[0].addedAt
  const folder = createFolder(store, '정렬 폴더')
  store.opened('sort-doc')
  store.changeLibrary({ kind: 'moveDocument', id: 'sort-doc', folderId: folder })
  store.saveLibrarySort('name')
  expect(store.list()[0].addedAt).toBe(registered)
  expect(registered).toBeGreaterThan(0)
  const before = store.list()
  const restored = storeAt(file)
  expect(restored.librarySortSettings()).toBe('name')
  expect(restored.list()).toEqual(before)
  expect(restored.load('sort-doc').get(1)).toEqual({ status: 'done', text: 'fake' })
  expect(restored.folders()).toEqual(store.folders())
  const db = new DatabaseSync(file)
  try {
    db.prepare('UPDATE library_settings SET sort_order=? WHERE id=1').run('unsupported')
    expect(storeAt(file).librarySortSettings()).toBe('recent')
    expect(db.prepare('SELECT sort_order FROM library_settings').get()?.sort_order).toBe(
      'unsupported',
    )
  } finally {
    db.close()
  }
})
it('keeps the applied sort on SQLite write failure and rejects unsupported choices', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-sort-fail-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite'),
    store = storeAt(file)
  store.saveLibrarySort('added')
  const db = new DatabaseSync(file)
  try {
    db.exec(
      "CREATE TRIGGER reject_sort BEFORE UPDATE ON library_settings BEGIN SELECT RAISE(ABORT,'fake save failure'); END;",
    )
    expect(() => store.saveLibrarySort('name')).toThrow('fake save failure')
    expect(() => store.saveLibrarySort('invalid' as LibrarySort)).toThrow('지원하는 정렬 기준')
    expect(store.librarySortSettings()).toBe('added')
    expect(storeAt(file).librarySortSettings()).toBe('added')
  } finally {
    db.close()
  }
})
it('restores the last successful PDF directory without replacing library sort or existing documents and settings', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-picker-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite'),
    store = storeAt(file)
  expect(store.pdfDirectory()).toBeUndefined()
  store.saveLibrarySort('name')
  store.saveBudgetSettings({ inputTokens: 20000, outputTokens: 10000 })
  store.add('a', 'A.pdf', 2, join(directory, 'one', 'A.pdf'), '', false, null, true)
  store.save('a', 1, { status: 'done', text: 'fake' })
  expect(store.pdfDirectory()).toBe(join(directory, 'one'))
  store.add('sample', 'Sample.pdf', 1, '/sample.pdf', '', true)
  expect(store.pdfDirectory()).toBe(join(directory, 'one'))
  expect(() =>
    store.add('b', 'B.pdf', 1, join(directory, 'two', 'B.pdf'), '', false, 'missing', true),
  ).toThrow()
  expect(store.pdfDirectory()).toBe(join(directory, 'one'))
  store.add('b', 'B.pdf', 1, join(directory, 'two', 'B.pdf'), '', false, null, true)
  expect(store.librarySortSettings()).toBe('name')
  store.saveLibrarySort('added')
  const restored = storeAt(file)
  expect(restored.pdfDirectory()).toBe(join(directory, 'two'))
  expect(restored.librarySortSettings()).toBe('added')
  expect(restored.budgetSettings()).toEqual({ inputTokens: 20000, outputTokens: 10000 })
  expect(restored.load('a').get(1)?.status).toBe('done')
  const db = new DatabaseSync(file)
  try {
    for (const invalid of ['relative/path', '/bad\0path']) {
      db.prepare('UPDATE library_settings SET last_pdf_directory=? WHERE id=1').run(invalid)
      expect(storeAt(file).pdfDirectory()).toBeUndefined()
      expect(
        db.prepare('SELECT hex(last_pdf_directory) AS value FROM library_settings').get()?.value,
      ).toBe(Buffer.from(invalid).toString('hex').toUpperCase())
    }
  } finally {
    db.close()
  }
})
it('rolls back PDF registration and preserves the prior directory when its setting cannot be saved', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-picker-fail-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite'),
    store = storeAt(file)
  store.saveLibrarySort('name')
  store.add('a', 'A.pdf', 1, join(directory, 'one', 'A.pdf'), '', false, null, true)
  const before = store.list(),
    db = new DatabaseSync(file)
  try {
    db.exec(
      "CREATE TRIGGER reject_directory BEFORE UPDATE OF last_pdf_directory ON library_settings BEGIN SELECT RAISE(ABORT,'fake directory save failure'); END;",
    )
    expect(() =>
      store.add('b', 'B.pdf', 1, join(directory, 'two', 'B.pdf'), '', false, null, true),
    ).toThrow('fake directory save failure')
    expect(store.list()).toEqual(before)
    expect(store.pdfDirectory()).toBe(join(directory, 'one'))
    expect(storeAt(file).librarySortSettings()).toBe('name')
  } finally {
    db.close()
  }
})
it.each([
  ['recent', ['b', 'e', 'a', 'd', 'c', 'f']],
  ['added', ['c', 'b', 'e', 'a', 'f', 'd']],
  ['name', ['c', 'b', 'e', 'a', 'f', 'd']],
] as const)(
  'orders PDFs by %s with stable ties, unknown dates, unread documents and natural names',
  (sort, expected) => {
    const base: LibraryDocument = {
      id: '',
      name: '',
      folderId: null,
      total: 1,
      done: 0,
      skipped: 0,
      failed: 0,
      thumbnail: '',
      addedAt: null,
      lastOpened: null,
      status: 'waiting',
    }
    const rows = [
      { ...base, id: 'a', name: 'File 10.pdf', addedAt: 200, lastOpened: 300 },
      { ...base, id: 'b', name: 'File 2.pdf', addedAt: 300, lastOpened: 300 },
      { ...base, id: 'c', name: 'Alpha.pdf', addedAt: 400 },
      { ...base, id: 'd', name: 'Old.pdf', lastOpened: 100 },
      { ...base, id: 'e', name: 'File 2.pdf', addedAt: 300, lastOpened: 300 },
      { ...base, id: 'f', name: 'Legacy.pdf' },
    ]
    expect(sortLibraryDocuments(rows, sort).map((d) => d.id)).toEqual(expected)
    expect(sortLibraryDocuments([...rows].reverse(), sort).map((d) => d.id)).toEqual(expected)
    expect(rows.map((d) => d.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  },
)
it('migrates an existing DB without losing translations or reading position, across restarts and versions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-library-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite')
  const legacy = new DatabaseSync(file)
  legacy.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,name TEXT NOT NULL,total INTEGER NOT NULL,
    last_page INTEGER NOT NULL DEFAULT 1,paused INTEGER NOT NULL DEFAULT 0,pause_reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE translations(document_id TEXT NOT NULL REFERENCES documents(id),page INTEGER NOT NULL,
    version TEXT NOT NULL,status TEXT NOT NULL,text TEXT,code TEXT,message TEXT,PRIMARY KEY(document_id,page,version));
    INSERT INTO documents(id,name,total,last_page) VALUES('a','A.pdf',2,2);
    INSERT INTO translations(document_id,page,version,status,text) VALUES('a',1,'v1','done','fake translation');
    INSERT INTO translations(document_id,page,version,status) VALUES('a',2,'v1','skipped');`)
  const oldChats = new PageChatStore(legacy)
  const conversation = oldChats.conversation({ documentId: 'a', page: 2 }, true)!
  const turn = oldChats.start(conversation, 'fake question', 'fake-model', {
    kind: 'page_image',
    documentId: 'a',
    documentName: 'A.pdf',
    page: 2,
  })
  oldChats.update(turn, 'fake answer', 'complete')
  legacy.exec(`CREATE TABLE budget_settings(id INTEGER PRIMARY KEY,input_tokens INTEGER,output_tokens INTEGER);
    INSERT INTO budget_settings VALUES(1,20000,10000);
    CREATE TABLE queue_settings(id INTEGER PRIMARY KEY,paused INTEGER); INSERT INTO queue_settings VALUES(1,1);
    CREATE TABLE library_settings(id INTEGER PRIMARY KEY,sort_order TEXT NOT NULL); INSERT INTO library_settings VALUES(1,'name');`)
  legacy.close()
  const migrated = storeAt(file)
  expect(migrated.pdfDirectory()).toBeUndefined()
  expect(migrated.librarySortSettings()).toBe('name')
  expect(migrated.list()[0]).toMatchObject({
    status: 'complete',
    done: 1,
    skipped: 1,
    lastOpened: null,
    thumbnail: '',
    folderId: null,
  })
  expect(migrated.register('a', 'A.pdf', 2).page).toBe(2)
  expect(migrated.load('a').get(1)).toEqual({ status: 'done', text: 'fake translation' })
  migrated.add('a', 'A.pdf', 2, '/a.pdf', 'thumbnail', false)
  migrated.opened('a')
  const folder = createFolder(migrated, '기존 자료')
  migrated.changeLibrary({ kind: 'moveDocument', id: 'a', folderId: folder })
  const reopened = storeAt(file)
  expect(reopened.list()[0]).toMatchObject({
    status: 'complete',
    thumbnail: 'thumbnail',
    folderId: folder,
  })
  expect(reopened.folders()).toEqual(migrated.folders())
  expect(reopened.chats.conversation({ documentId: 'a', page: 2 })).toBe(conversation)
  expect(reopened.chats.turns(conversation)).toMatchObject([
    { id: turn.id, answer: 'fake answer', status: 'complete' },
  ])
  expect(reopened.queuePaused()).toBe(true)
  expect(reopened.budgetSettings()).toEqual({ inputTokens: 20000, outputTokens: 10000 })
  expect(reopened.source('a')?.path).toBe('/a.pdf')
  expect(storeAt(file, 'v2').list()[0]).toMatchObject({ status: 'stopped', done: 0, skipped: 0 })
})
it('reports live queue states, pauses, errors, completion, and inactive documents accurately', async () => {
  const store = storeAt()
  const provider = {
    settings: vi.fn(() => ({
      configured: true,
      model: 'fake',
      revision: 0,
      budget: DEFAULT_BATCH_BUDGET,
      images: DEFAULT_IMAGE_SETTINGS,
    })),
    cancel: vi.fn(),
    translate: vi.fn(
      async (
        input: TranslationRequest,
        onPage: (page: number, result: Exclude<TranslationResult, { status: 'canceled' }>) => void,
      ) => {
        for (const p of input.pages) onPage(p.page, { status: 'done', text: 'fake' })
      },
    ),
  }
  const queue = new TranslationQueue(store, provider)
  store.add('a', 'A.pdf', 2, '/a', '', false)
  expect(queue.library()[0].status).toBe('stopped')
  const { session } = queue.activate('a', 'A.pdf', 2)
  expect(queue.library()[0].status).toBe('waiting')
  queue.pause(session, true)
  expect(queue.library()[0].status).toBe('waiting')
  queue.retry(session)
  for (let i = 0; i < 1; i++) {
    const job = queue.claim(session)!
    expect(queue.library()[0].status).toBe('translating')
    await queue.submit(
      session,
      job.token,
      job.pages.map((page) => ({ page, width: 612, height: 792, outputTokens: 2048 })),
    )
  }
  expect(queue.library()[0]).toMatchObject({ status: 'complete', done: 2 })
  const beforeFolder = queue.snapshot(session, 1),
    calls = provider.translate.mock.calls.length
  const folder = createFolder(store, '자동 번역 자료')
  store.changeLibrary({ kind: 'moveDocument', id: 'a', folderId: folder })
  store.changeLibrary({ kind: 'rename', id: folder, name: '이름 변경' })
  store.changeLibrary({ kind: 'moveFolder', id: folder, parentId: createFolder(store, '보관') })
  expect(queue.snapshot(session, 1)).toEqual(beforeFolder)
  expect(queue.claim(session)).toBeNull()
  expect(provider.translate).toHaveBeenCalledTimes(calls)
  expect(queue.library()[0]).toMatchObject({ id: 'a', folderId: folder, done: 2 })
  queue.retry(session, 1)
  expect(queue.library()[0].status).toBe('waiting')
  provider.settings.mockReturnValue({
    configured: false,
    model: 'fake',
    revision: 1,
    budget: DEFAULT_BATCH_BUDGET,
    images: DEFAULT_IMAGE_SETTINGS,
  })
  expect(queue.library()[0].status).toBe('waiting')
  queue.detach()
  expect(queue.library()[0].status).toBe('stopped')
})

function createFolder(store: TranslationStore, name: string, parentId: string | null = null) {
  store.changeLibrary({ kind: 'create', name, parentId })
  return store
    .folders()
    .find((f) => f.name === name.trim().normalize('NFC') && f.parentId === parentId)!.id
}
it('creates deep folders, normalizes names, rejects same-parent duplicates and cycles without changing the tree', () => {
  const store = storeAt(),
    root = createFolder(store, '  자료  '),
    other = createFolder(store, '기타')
  let deepest = root
  for (let n = 0; n < 30; n++) deepest = createFolder(store, '하위 ' + n, deepest)
  createFolder(store, '같은 이름', root)
  createFolder(store, '같은 이름', other)
  const ascii = createFolder(store, 'Notes')
  expect(() => createFolder(store, 'notes')).toThrow('같은 이름')
  createFolder(store, 'é')
  expect(() => createFolder(store, 'e\u0301')).toThrow('같은 이름')
  const before = store.folders()
  for (const parentId of [root, deepest])
    expect(() => store.changeLibrary({ kind: 'moveFolder', id: root, parentId })).toThrow(
      '자기 자신',
    )
  expect(store.folders()).toEqual(before)
  store.changeLibrary({ kind: 'rename', id: ascii, name: '새 이름' })
  expect(store.folders().find((f) => f.id === ascii)?.name).toBe('새 이름')
  expect(() => store.changeLibrary({ kind: 'rename', id: ascii, name: '기타' })).toThrow(
    '같은 이름',
  )
  expect(() =>
    store.changeLibrary({
      kind: 'moveFolder',
      id: store.folders().find((f) => f.parentId === root && f.name === '같은 이름')!.id,
      parentId: other,
    }),
  ).toThrow('같은 이름')
})
it.each([
  { kind: 'create', parentId: null, name: '   ' },
  { kind: 'create', parentId: null, name: 'x'.repeat(201) },
  { kind: 'create', parentId: null, name: 'bad\u0000name' },
  { kind: 'create', parentId: 'missing', name: '자료' },
  { kind: 'create', name: '자료' },
  { kind: 'rename', id: 'missing', name: '자료' },
  { kind: 'moveFolder', id: null, parentId: null },
  { kind: 'moveDocument', id: 'missing', folderId: null },
  { kind: 'delete', id: 'missing' },
])('rejects invalid folder operations atomically: $kind', (input) => {
  const store = storeAt()
  expect(() => store.changeLibrary(input)).toThrow()
  expect(store.folders()).toEqual([])
  expect(store.list()).toEqual([])
})
it('moves documents and folder subtrees independently of source, identities, cached results, chat and reading metadata', () => {
  const store = storeAt(),
    a = createFolder(store, 'A'),
    b = createFolder(store, 'B'),
    nested = createFolder(store, '하위', a)
  store.add('a', 'A.pdf', 2, '/original/A.pdf', 'thumb', false, nested)
  store.add('b', 'B.pdf', 2, '/original/B.pdf', '', false)
  store.save('a', 1, { status: 'done', text: 'fake translation' })
  store.position('a', 2)
  store.opened('a')
  const target = { documentId: 'a', page: 2 },
    chat = store.chats.conversation(target, true)!
  const turn = store.chats.start(chat, 'fake question', 'fake', {
    kind: 'page_image',
    documentId: 'a',
    documentName: 'A.pdf',
    page: 2,
  })
  store.chats.update(turn, 'fake answer', 'complete')
  const before = store.list(),
    results = store.load('a'),
    turns = store.chats.turns(chat)
  store.changeLibrary({ kind: 'moveFolder', id: a, parentId: b })
  expect(store.folders().find((f) => f.id === nested)?.parentId).toBe(a)
  expect(store.list()).toEqual(before)
  store.changeLibrary({ kind: 'moveDocument', id: 'a', folderId: b })
  store.add('a', 'A.pdf', 2, '/original/A.pdf', 'thumb', false, null)
  expect(store.list().find((d) => d.id === 'a')).toMatchObject({
    ...before.find((d) => d.id === 'a'),
    folderId: b,
  })
  expect(store.source('a')).toEqual({ path: '/original/A.pdf', sample: false })
  expect(store.load('a')).toEqual(results)
  expect(store.chats.conversation(target)).toBe(chat)
  expect(store.chats.turns(chat)).toEqual(turns)
  expect(store.register('a', 'A.pdf', 2).page).toBe(2)
  store.changeLibrary({ kind: 'moveDocument', id: 'a', folderId: null })
  store.changeLibrary({ kind: 'moveFolder', id: a, parentId: null })
  expect(store.list().find((d) => d.id === 'a')?.folderId).toBeNull()
  expect(store.folders().find((f) => f.id === a)?.parentId).toBeNull()
})
it('rolls back failed create/rename/move and document registration without changing saved state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'translave-folder-failure-'))
  paths.push(dir)
  const file = join(dir, 'store.sqlite'),
    store = storeAt(file)
  const folder = createFolder(store, '자료')
  store.add('a', 'A.pdf', 1, '/original/A.pdf', '', false)
  store.save('a', 1, { status: 'done', text: 'fake' })
  const before = store.list(),
    tree = store.folders(),
    db = new DatabaseSync(file)
  try {
    db.exec(`CREATE TRIGGER fail_folder_create BEFORE INSERT ON library_folders BEGIN SELECT RAISE(ABORT,'fake save failure'); END;
      CREATE TRIGGER fail_folder_change BEFORE UPDATE ON library_folders BEGIN SELECT RAISE(ABORT,'fake save failure'); END;
      CREATE TRIGGER fail_document_move BEFORE UPDATE OF folder_id ON documents BEGIN SELECT RAISE(ABORT,'fake save failure'); END;`)
    for (const change of [
      { kind: 'create', name: '실패', parentId: null },
      { kind: 'rename', id: folder, name: '실패' },
      { kind: 'moveFolder', id: folder, parentId: null },
      { kind: 'moveDocument', id: 'a', folderId: folder },
    ])
      expect(() => store.changeLibrary(change)).toThrow('fake save failure')
    expect(() => store.add('new', 'New.pdf', 1, '/new', '', false, folder)).toThrow(
      'fake save failure',
    )
    expect(() => store.add('a', 'Changed.pdf', 1, '/changed', '', false, folder)).toThrow(
      'fake save failure',
    )
    expect(store.list()).toEqual(before)
    expect(store.folders()).toEqual(tree)
    expect(store.source('a')?.path).toBe('/original/A.pdf')
    expect(store.source('new')).toBeUndefined()
    expect(store.load('a').get(1)?.status).toBe('done')
  } finally {
    db.close()
  }
})

it('stores duplicate reading tabs independently and restores empty state without changing documents, cache or chat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'translave-tabs-'))
  paths.push(dir)
  const file = join(dir, 'store.sqlite'),
    store = storeAt(file)
  store.add('a', 'A.pdf', 4, '/a.pdf', '', false)
  store.save('a', 1, { status: 'done', text: 'fake' })
  const conversation = store.chats.conversation({ documentId: 'a', page: 1 }, true)!
  store.chats.start(conversation, 'fake question', 'fake-model', {
    kind: 'page_image',
    documentId: 'a',
    documentName: 'A.pdf',
    page: 1,
  })
  const snapshot = {
    tabs: [
      {
        id: 'one',
        documentId: 'a',
        name: 'A.pdf',
        page: 1,
        zoom: 'fit' as const,
        scrollTop: 0,
        scrollLeft: 0,
      },
      {
        id: 'two',
        documentId: 'a',
        name: 'A.pdf',
        page: 3,
        zoom: 1.6,
        scrollTop: 123,
        scrollLeft: 42,
      },
    ],
    activeId: 'two',
  }
  expect(store.readingWorkspace()).toEqual({ tabs: [], activeId: null })
  store.saveReadingWorkspace(snapshot)
  expect(storeAt(file).readingWorkspace()).toEqual(snapshot)
  expect(store.list()).toHaveLength(1)
  expect(store.load('a').get(1)?.status).toBe('done')
  expect(store.chats.turns(conversation)).toHaveLength(1)
  const reordered = moveReadingTab(snapshot, 'two', 'one')
  store.saveReadingWorkspace(reordered)
  expect(storeAt(file).readingWorkspace()).toEqual(reordered)
  expect(reordered.activeId).toBe('two')
  expect(store.chats.turns(conversation)).toHaveLength(1)
  expect(store.load('a').get(1)?.status).toBe('done')
  store.saveReadingWorkspace({ tabs: [], activeId: null })
  expect(storeAt(file).readingWorkspace()).toEqual({ tabs: [], activeId: null })
  expect(store.chats.turns(conversation)).toHaveLength(1)
  expect(store.load('a').get(1)?.status).toBe('done')
})
it('preserves saved tabs on write failure and rejects invalid or unregistered reading state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'translave-tabs-failure-'))
  paths.push(dir)
  const file = join(dir, 'store.sqlite'),
    store = storeAt(file)
  store.add('a', 'A.pdf', 4, '/a.pdf', '', false)
  const tab = {
    id: 'one',
    documentId: 'a',
    name: 'A.pdf',
    page: 2,
    zoom: 'fit' as const,
    scrollTop: 120,
    scrollLeft: 0,
  }
  const saved = { tabs: [tab], activeId: tab.id }
  store.saveReadingWorkspace(saved)
  for (const invalid of [
    { tabs: [tab], activeId: 'missing' },
    { tabs: [tab, tab], activeId: tab.id },
    { tabs: [{ ...tab, page: 0 }], activeId: tab.id },
    { tabs: [{ ...tab, zoom: Infinity }], activeId: tab.id },
    { tabs: [{ ...tab, scrollTop: -1 }], activeId: tab.id },
    { tabs: [{ ...tab, documentId: 'unknown' }], activeId: tab.id },
  ])
    expect(() => store.saveReadingWorkspace(invalid as any)).toThrow()
  const db = new DatabaseSync(file)
  try {
    db.exec(
      "CREATE TRIGGER reject_tabs BEFORE UPDATE ON reading_workspace BEGIN SELECT RAISE(ABORT,'fake save failure'); END;",
    )
    expect(() => store.saveReadingWorkspace({ tabs: [], activeId: null })).toThrow(
      'fake save failure',
    )
    expect(storeAt(file).readingWorkspace()).toEqual(saved)
    db.exec('DROP TRIGGER reject_tabs')
    db.prepare('UPDATE reading_workspace SET value=?').run('{invalid')
    expect(() => store.readingWorkspace()).toThrow()
    expect(db.prepare('SELECT value FROM reading_workspace').get()?.value).toBe('{invalid')
  } finally {
    db.close()
  }
})
it('closing reading tabs preserves the active tab or chooses the immediate right then left neighbor', async () => {
  const { closeReadingTab } = await import('../../src/shared/readingTabs')
  const tabs = ['one', 'two', 'three'].map((id) => ({
    id,
    documentId: 'same',
    name: 'Same.pdf',
    page: 1,
    zoom: 'fit' as const,
    scrollTop: 0,
    scrollLeft: 0,
  }))
  const w = { tabs, activeId: 'two' }
  expect(closeReadingTab(w, 'one').activeId).toBe('two')
  expect(closeReadingTab(w, 'two').activeId).toBe('three')
  expect(closeReadingTab({ tabs, activeId: 'three' }, 'three').activeId).toBe('two')
  expect(closeReadingTab({ tabs: [tabs[0]], activeId: 'one' }, 'one')).toEqual({
    tabs: [],
    activeId: null,
  })
  expect(closeReadingTab(w, 'unknown')).toBe(w)
})
it('reorders distinct tab IDs without changing reading state and cycles in the new order', () => {
  const tabs = ['one', 'two', 'three'].map((id, index) => ({
    id,
    documentId: 'same',
    name: 'Same.pdf',
    page: index + 1,
    zoom: 1 + index / 2,
    scrollTop: index * 120,
    scrollLeft: index * 20,
  }))
  const w = { tabs, activeId: 'two' }
  const moved = moveReadingTab(w, 'one', null)
  expect(moved.tabs.map((tab) => tab.id)).toEqual(['two', 'three', 'one'])
  expect(moved.activeId).toBe('two')
  moved.tabs.forEach((tab) => expect(tab).toBe(tabs.find((old) => old.id === tab.id)))
  expect(moveReadingTab(moved, 'one', 'two')).toEqual(w)
  expect(moveReadingTab(w, 'one', 'two')).toBe(w)
  expect(moveReadingTab(w, 'two', 'two')).toBe(w)
  expect(moveReadingTab(w, 'missing', null)).toBe(w)
  expect(moveReadingTab(w, 'two', 'missing')).toBe(w)
  const next = cycleReadingTab(moved, 1)
  expect(next.activeId).toBe('three')
  expect(next.tabs).toBe(moved.tabs)
  expect(cycleReadingTab(next, -1).activeId).toBe('two')
  expect(cycleReadingTab(moved, -1).activeId).toBe('one')
  expect(cycleReadingTab({ ...moved, activeId: 'one' }, 1).activeId).toBe('two')
  const empty = { tabs: [], activeId: null },
    single = { tabs: [tabs[0]], activeId: 'one' }
  expect(cycleReadingTab(empty, 1)).toBe(empty)
  expect(cycleReadingTab(single, -1)).toBe(single)
})

it('atomically removes registered document ownership, duplicate tabs and all cache versions while preserving original and app-wide data after restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-delete-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite'),
    original = join(directory, 'original.pdf')
  writeFileSync(original, '%PDF-OWN-FIXTURE')
  const store = storeAt(file)
  store.add('delete-a', 'A.pdf', 2, original, '', false)
  store.add('keep-b', 'B.pdf', 2, original, '', false)
  store.save('delete-a', 1, { status: 'done', text: 'fake-a' })
  store.version = 'older-version'
  store.save('delete-a', 2, { status: 'done', text: 'fake-old' })
  store.save('keep-b', 1, { status: 'done', text: 'fake-b' })
  const target = { documentId: 'delete-a', page: 1 }
  const conversation = store.chats.conversation(target, true)!
  store.chats.start(conversation, 'fake question', 'fake', {
    kind: 'none',
    documentId: 'delete-a',
    documentName: 'A.pdf',
    page: 1,
  })
  const memo = store.memos.load({ kind: 'page', ...target })
  store.memos.save({ id: memo.id, revision: memo.revision, body: 'fake memo' })
  const common = store.memos.create('keep common')
  const commonSaved = store.memos.save({
    id: common.id,
    revision: common.revision,
    body: 'fake common',
  })
  store.saveLibrarySort('name')
  store.pauseAll(true)
  const tabs = ['delete-a', 'keep-b', 'delete-a'].map((documentId, i) => ({
    id: 'tab' + i,
    documentId,
    name: 'fake.pdf',
    page: i === 1 ? 2 : 1,
    zoom: 1.25,
    scrollTop: 42,
    scrollLeft: 3,
  }))
  store.saveReadingWorkspace({ tabs, activeId: 'tab0' })
  const db = new DatabaseSync(file)
  db.prepare(
    'INSERT INTO translation_history(document_id,page,version,status,text) VALUES(?,1,?, ?,?)',
  ).run('delete-a', 'legacy', 'done', 'fake')
  db.prepare('INSERT INTO translation_overrides(document_id,page) VALUES(?,1)').run('delete-a')
  const deleted = store.deleteLibrary({ kind: 'document', id: 'delete-a' })
  expect(deleted).toEqual({ documentIds: ['delete-a'], folderIds: [], memoIds: [memo.id] })
  for (const table of [
    'documents',
    'translations',
    'translation_history',
    'translation_overrides',
    'page_chats',
    'memos',
  ]) {
    const field = table === 'documents' ? 'id' : 'document_id'
    expect(db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${field}=?`).get('delete-a')?.n).toBe(
      0,
    )
  }
  expect(db.prepare('SELECT COUNT(*) n FROM chat_turns').get()?.n).toBe(0)
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  expect(readFileSync(original, 'utf8')).toBe('%PDF-OWN-FIXTURE')
  expect(store.memos.load({ kind: 'standalone', id: common.id })).toEqual(commonSaved)
  expect(store.load('keep-b').get(1)).toMatchObject({ status: 'done', text: 'fake-b' })
  expect(store.readingWorkspace()).toEqual({ tabs: [tabs[1]], activeId: 'tab1' })
  expect(() => store.deleteLibrary({ kind: 'document', id: 'delete-a' })).toThrow('찾을 수')
  db.close()
  const restored = storeAt(file, 'older-version')
  expect(restored.list().map((row) => row.id)).toEqual(['keep-b'])
  expect(restored.librarySortSettings()).toBe('name')
  expect(restored.queuePaused()).toBe(true)
  expect(restored.readingWorkspace()).toEqual({ tabs: [tabs[1]], activeId: 'tab1' })
  expect(restored.memos.load({ kind: 'standalone', id: common.id })).toEqual(commonSaved)
})

it('deletes the current recursive folder tree, including moved-in documents and same-named descendants, but never outside owners', () => {
  const store = storeAt(),
    root = createFolder(store, 'root'),
    child = createFolder(store, 'same', root),
    deep = createFolder(store, 'deep', child),
    outside = createFolder(store, 'same')
  store.add('a', 'A.pdf', 1, '/fake-a.pdf', '', false, root)
  store.add('b', 'B.pdf', 1, '/fake-b.pdf', '', false, deep)
  store.add('c', 'C.pdf', 1, '/fake-c.pdf', '', false, outside)
  store.changeLibrary({ kind: 'moveDocument', id: 'a', folderId: outside })
  store.changeLibrary({ kind: 'moveDocument', id: 'c', folderId: child })
  const result = store.deleteLibrary({ kind: 'folder', id: root })
  expect(result.folderIds.sort()).toEqual([root, child, deep].sort())
  expect(result.documentIds.sort()).toEqual(['b', 'c'])
  expect(store.folders().map((f) => f.id)).toEqual([outside])
  expect(store.list().map((d) => [d.id, d.folderId])).toEqual([['a', outside]])
  const empty = createFolder(store, 'empty')
  expect(store.deleteLibrary({ kind: 'folder', id: empty }).documentIds).toEqual([])
  expect(() => store.deleteLibrary({ kind: 'folder', id: root })).toThrow('찾을 수')
})

it('rolls back a failure at the last ownership delete, including hierarchy, bodies, chat and workspace, and rejects invalid targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'translave-delete-fail-'))
  paths.push(directory)
  const file = join(directory, 'store.sqlite'),
    store = storeAt(file),
    root = createFolder(store, 'root'),
    child = createFolder(store, 'child', root)
  store.add('a', 'A.pdf', 1, '/fake.pdf', '', false, child)
  store.save('a', 1, { status: 'done', text: 'fake' })
  const memo = store.memos.load({ kind: 'page', documentId: 'a', page: 1 })
  const chat = store.chats.conversation({ documentId: 'a', page: 1 }, true)!
  store.chats.start(chat, 'fake', 'fake', {
    kind: 'none',
    documentId: 'a',
    documentName: 'A.pdf',
    page: 1,
  })
  const tab = {
    id: 'tab',
    documentId: 'a',
    name: 'A.pdf',
    page: 1,
    zoom: 'fit' as const,
    scrollTop: 0,
    scrollLeft: 0,
  }
  store.saveReadingWorkspace({ tabs: [tab], activeId: tab.id })
  const db = new DatabaseSync(file)
  const tables = [
    'documents',
    'library_folders',
    'translations',
    'memos',
    'page_chats',
    'chat_turns',
    'reading_workspace',
  ]
  const snapshot = () => tables.map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())
  const before = snapshot()
  db.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON library_folders BEGIN SELECT RAISE(FAIL,'PRIVATE_FAILURE'); END",
  )
  expect(() => store.deleteLibrary({ kind: 'folder', id: root })).toThrow()
  expect(snapshot()).toEqual(before)
  for (const input of [
    null,
    {},
    { kind: 'all', id: 'a' },
    { kind: 'folder', id: null },
    { kind: new String('document'), id: 'a' },
  ])
    expect(() => store.deleteLibrary(input)).toThrow()
  expect(store.memos.load({ kind: 'page', documentId: 'a', page: 1 }).id).toBe(memo.id)
  db.exec('DROP TRIGGER fail_delete')
  db.exec(
    "CREATE TRIGGER fail_workspace BEFORE UPDATE ON reading_workspace BEGIN SELECT RAISE(FAIL,'PRIVATE_WORKSPACE_FAILURE'); END",
  )
  expect(() => store.deleteLibrary({ kind: 'folder', id: root })).toThrow()
  expect(snapshot()).toEqual(before)
  db.exec('DROP TRIGGER fail_workspace')
  db.close()
  store.deleteLibrary({ kind: 'folder', id: root })
  expect(store.list()).toEqual([])
})

it('migrates and restores separate presentation originals/derived hashes without changing PDF ownership or saved data', () => {
  const root = mkdtempSync(join(tmpdir(), 'translave-ppt-store-'))
  paths.push(root)
  const file = join(root, 'db.sqlite'),
    original = join(root, 'slides.pptx'),
    converted = join(root, 'derived.pdf')
  writeFileSync(original, 'own source')
  writeFileSync(converted, 'own derived')
  const legacy = new DatabaseSync(file)
  legacy.exec(
    "CREATE TABLE documents (id TEXT PRIMARY KEY,name TEXT NOT NULL,total INTEGER NOT NULL,last_page INTEGER NOT NULL DEFAULT 1,paused INTEGER NOT NULL DEFAULT 0,pause_reason TEXT NOT NULL DEFAULT '',path TEXT NOT NULL DEFAULT '',sample INTEGER NOT NULL DEFAULT 0); INSERT INTO documents(id,name,total,path) VALUES('legacy','old.pdf',1,'/original.pdf')",
  )
  legacy.close()
  const store = storeAt(file),
    id = 'a'.repeat(64),
    hash = 'b'.repeat(64)
  store.add('legacy', 'old.pdf', 1, '/original.pdf', '', false)
  store.add(id, 'slides.pptx', 2, converted, '', false, null, true, {
    originalPath: original,
    pdfHash: hash,
  })
  const memo = store.memos.load({ kind: 'page', documentId: id, page: 2 })
  store.memos.save({ ...memo, body: 'own memo' })
  store.save(id, 1, { status: 'done', text: 'own result' })
  const restored = storeAt(file)
  expect(restored.source('legacy')).toEqual({ path: '/original.pdf', sample: false })
  expect(restored.source(id)).toEqual({
    path: converted,
    sample: false,
    derived: { name: 'slides.pptx', originalPath: original, pdfHash: hash },
  })
  expect(restored.pdfDirectory()).toBe(root)
  expect(restored.load(id).get(1)?.status).toBe('done')
  expect(restored.memos.load({ kind: 'page', documentId: id, page: 2 }).body).toBe('own memo')
  const db = new DatabaseSync(file)
  try {
    db.exec(
      "CREATE TRIGGER reject_derived BEFORE UPDATE ON documents BEGIN SELECT RAISE(ABORT,'fake'); END",
    )
    expect(() =>
      restored.add(id, 'changed.pptx', 3, '/invalid.pdf', '', false, null, true, {
        originalPath: '/different.pptx',
        pdfHash: 'c'.repeat(64),
      }),
    ).toThrow()
    expect(restored.source(id)).toEqual(store.source(id))
    expect(restored.pdfDirectory()).toBe(root)
  } finally {
    db.close()
  }
  expect(readFileSync(original, 'utf8')).toBe('own source')
})
