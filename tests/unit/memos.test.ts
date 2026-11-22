import { afterEach, describe, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoStore } from '../../src/main/memos'
import { TranslationStore } from '../../src/main/store'
import { MemoDrafts, memoKey } from '../../src/renderer/src/memoDrafts'
import { DEFAULT_MEMO_PREFERENCES, shortMemoTitle, sortMemos } from '../../src/shared/memos'
import type { Memo, MemoAPI, MemoTarget } from '../../src/shared/memos'

afterEach(() => vi.restoreAllMocks())
function setup() {
  const db = new DatabaseSync(':memory:')
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE documents(id TEXT PRIMARY KEY,total INTEGER,name TEXT DEFAULT 'fixture.pdf'); INSERT INTO documents(id,total) VALUES('A',3),('B',2)",
  )
  return { db, store: new MemoStore(db) }
}
describe('memo ownership and additive local storage', () => {
  it('exports ordered nonempty page snapshots with owner-checked current drafts without writing records', () => {
    const { db, store } = setup()
    try {
      const page = (n: number) => ({ kind: 'page' as const, documentId: 'A', page: n })
      const third = store.load(page(3)),
        first = store.load(page(1)),
        blank = store.load(page(2))
      store.save({ ...first, body: 'old' })
      store.save({ ...third, body: 'third' })
      store.save({ ...blank, body: ' \n\t ' })
      const other = store.load({ kind: 'page', documentId: 'B', page: 1 }),
        standalone = store.create('separate')
      const before = db.prepare('SELECT * FROM memos ORDER BY id').all()
      const raw = '# 한글\r\n\r\n`$x$` $2^{-1}$ \\Rightarrow\n'
      const input = {
        target: page(1),
        scope: 'document' as const,
        format: 'md' as const,
        drafts: [{ id: first.id, body: raw }],
      }
      const snapshot = store.exportSource(input)
      expect(snapshot.sections.map((s) => [s.page, s.body])).toEqual([
        [1, raw],
        [3, 'third'],
      ])
      expect(db.prepare('SELECT * FROM memos ORDER BY id').all()).toEqual(before)
      expect(store.exportSource({ ...input, scope: 'single' }).sections).toEqual([
        snapshot.sections[0],
      ])
      for (const id of [other.id, standalone.id, 'missing'])
        expect(() =>
          store.exportSource({ ...input, drafts: [{ id, body: 'wrong owner' }] }),
        ).toThrow('소속')
      store.save({ ...store.load(page(1)), body: 'later' })
      expect(snapshot.sections[0].body).toBe(raw)
    } finally {
      db.close()
    }
  })
  it('rejects empty/missing/invalid export targets without creating page notes and preserves standalone source', () => {
    const { db, store } = setup()
    try {
      const input = {
        target: { kind: 'page' as const, documentId: 'A', page: 1 },
        scope: 'single' as const,
        format: 'md' as const,
        drafts: [],
      }
      expect(() => store.exportSource(input)).toThrow('내용이 없어요')
      expect(db.prepare('SELECT count(*) AS n FROM memos').get()!.n).toBe(0)
      const note = store.create('independent'),
        body = '\n\\frac{1}{2}\n```\n\\n\n```\n'
      store.save({ ...note, body })
      expect(
        store.exportSource({ ...input, target: { kind: 'standalone', id: note.id } }).sections[0],
      ).toEqual({ id: note.id, page: null, body })
      for (const bad of [
        { ...input, format: 'html' },
        { ...input, target: { kind: 'page', documentId: 'B', page: 3 } },
        { ...input, drafts: [{ id: note.id, body: '\0' }] },
      ])
        expect(() => store.exportSource(bad as any)).toThrow()
    } finally {
      db.close()
    }
  })
  it('shares a page note by document/page while standalone IDs survive title and sort changes', () => {
    const { db, store } = setup()
    try {
      const target = { kind: 'page' as const, documentId: 'A', page: 1 }
      const first = store.load(target),
        text = '# 제목\n\n한글 **강조** $2^{-1}$\n```js\nconst x = 1\n```'
      const saved = store.save({ id: first.id, revision: first.revision, body: text })
      expect(store.load(target)).toEqual(saved)
      expect(store.load({ ...target, page: 2 }).body).toBe('')
      expect(store.load({ ...target, documentId: 'B' }).id).not.toBe(saved.id)
      for (const invalid of [
        { ...target, page: 0 },
        { ...target, page: 4 },
        { ...target, documentId: 'missing' },
      ])
        expect(() => store.load(invalid)).toThrow()
      const standalone = store.create('공통 메모')
      const renamed = store.rename({ ...standalone, title: '새 제목' })
      expect(renamed.id).toBe(standalone.id)
      expect(renamed.createdAt).toBe(standalone.createdAt)
      expect(renamed.updatedAt).toBeGreaterThan(standalone.updatedAt)
      expect(store.list().map((m) => m.id)).toEqual([standalone.id])
      expect(() => store.rename({ ...saved, title: 'page rename' })).toThrow()
      expect(() => store.delete(saved)).toThrow()
      expect(() => store.load({ kind: 'standalone', id: saved.id })).toThrow()
    } finally {
      db.close()
    }
  })
  it('rejects empty names, stale writes and invalid bodies without altering the persisted note', () => {
    const { db, store } = setup()
    try {
      for (const title of ['', '   ', '\0', 'x'.repeat(201)])
        expect(() => store.create(title)).toThrow()
      const note = store.create('safe'),
        saved = store.save({ ...note, body: 'latest' })
      expect(() => store.save({ ...note, body: 'stale' })).toThrow(/변경/)
      expect(() => store.rename({ ...note, title: 'stale' })).toThrow()
      expect(() => store.delete(note)).toThrow()
      for (const body of ['\0', 'x'.repeat(1024 * 1024 + 1)])
        expect(() => store.save({ ...saved, body })).toThrow()
      expect(store.load({ kind: 'standalone', id: note.id })).toEqual(saved)
    } finally {
      db.close()
    }
  })
  it('preserves body/title/preferences on actual SQLite failure and clears only a successfully deleted selection', () => {
    const { db, store } = setup()
    try {
      const note = store.create('keep')
      const prefs = {
        ...DEFAULT_MEMO_PREFERENCES,
        selection: { kind: 'standalone' as const, id: note.id },
      }
      store.preferences(prefs)
      db.exec(
        "CREATE TRIGGER fail_update BEFORE UPDATE ON memos BEGIN SELECT RAISE(FAIL,'FAKE_MEMO_WRITE'); END; CREATE TRIGGER fail_delete BEFORE DELETE ON memos BEGIN SELECT RAISE(FAIL,'FAKE_MEMO_DELETE'); END",
      )
      expect(() => store.save({ ...note, body: 'retain-draft' })).toThrow()
      expect(() => store.rename({ ...note, title: 'not-saved' })).toThrow()
      expect(() => store.delete(note)).toThrow()
      expect(store.load({ kind: 'standalone', id: note.id })).toEqual(note)
      expect(store.preferences()).toEqual(prefs)
      db.exec('DROP TRIGGER fail_update; DROP TRIGGER fail_delete')
      store.delete(note)
      expect(store.list()).toEqual([])
      expect(store.preferences().selection).toEqual({ kind: 'standalone', id: null })
      expect(() => store.load({ kind: 'standalone', id: note.id })).toThrow()
    } finally {
      db.close()
    }
  })
  it('restores notes/preferences and migrates old document/chat/cache/settings without losing records', () => {
    const folder = mkdtempSync(join(tmpdir(), 'translave-memos-')),
      path = join(folder, 'db.sqlite')
    let store = new TranslationStore(path, 'fake-version')
    try {
      store.register('A', 'A.pdf', 3)
      store.save('A', 1, { status: 'done', text: '기존 결과' })
      const chat = store.chats.start(
        store.chats.conversation({ documentId: 'A', page: 1 }, true)!,
        '질문',
        'fake',
        { kind: 'page_image', documentId: 'A', documentName: 'A.pdf', page: 1 },
      )
      store.chats.update(chat, '답변', 'complete')
      const db = (store as any).db as DatabaseSync
      db.exec(
        "INSERT INTO theme_settings VALUES(1,'blue'); DROP TABLE memo_preferences; DROP TABLE memos",
      )
      store.close()
      store = new TranslationStore(path, 'fake-version')
      expect(store.load('A').get(1)).toMatchObject({ status: 'done', text: '기존 결과' })
      expect(store.chats.turns(chat.conversationId)[0].answer).toBe('답변')
      expect(
        ((store as any).db as DatabaseSync).prepare('SELECT theme FROM theme_settings').get()!
          .theme,
      ).toBe('blue')
      const note = store.memos.create('restore')
      const saved = store.memos.save({ ...note, body: 'Math $4 \\times 128$\n\n한글' })
      const prefs = {
        selection: { kind: 'standalone' as const, id: note.id },
        mode: 'source' as const,
        sort: 'name' as const,
      }
      store.memos.preferences(prefs)
      store.close()
      store = new TranslationStore(path, 'fake-version')
      expect(store.memos.load({ kind: 'standalone', id: note.id })).toEqual(saved)
      expect(store.memos.preferences()).toEqual(prefs)
    } finally {
      store.close()
      rmSync(folder, { recursive: true, force: true })
    }
  })
  it('uses safe defaults for unsupported saved preferences and deterministic natural sorting', () => {
    const { db, store } = setup()
    try {
      db.prepare('INSERT INTO memo_preferences VALUES(1,?)').run('{broken')
      expect(store.preferences()).toEqual(DEFAULT_MEMO_PREFERENCES)
      db.prepare('UPDATE memo_preferences SET value=?').run(JSON.stringify({ mode: 'unknown' }))
      expect(store.preferences()).toEqual(DEFAULT_MEMO_PREFERENCES)
      vi.spyOn(Date, 'now').mockReturnValue(1000)
      const a = store.create('note10'),
        b = store.create('note2')
      const updated = store.save({ ...a, body: 'changed' })
      expect(sortMemos(store.list(), 'modified').map((m) => m.id)).toEqual([a.id, b.id])
      expect(sortMemos(store.list(), 'created').map((m) => m.id)).toEqual([b.id, a.id])
      expect(sortMemos([updated, b], 'name').map((m) => m.id)).toEqual([b.id, a.id])
      expect(sortMemos([b, updated], 'name')).toEqual(sortMemos([updated, b], 'name'))
      expect(shortMemoTitle('가나다라마바사아자차카타파')).toBe('가나다라마바사아자차카타…')
      expect(shortMemoTitle('👨‍👩‍👧‍👦'.repeat(13))).toBe('👨‍👩‍👧‍👦'.repeat(12) + '…')
    } finally {
      db.close()
    }
  })
})

function drafts() {
  const notes = new Map<string, Memo>(
    ['A', 'B'].map((id) => [
      id,
      {
        id,
        documentId: null,
        page: null,
        title: id,
        body: '',
        createdAt: 1,
        updatedAt: 1,
        revision: 0,
      },
    ]),
  )
  const load = vi.fn(async (target: MemoTarget) => ({
    status: 'ok' as const,
    value: structuredClone(
      notes.get(target.kind === 'standalone' ? target.id : target.documentId)!,
    ),
  }))
  const save = vi.fn<MemoAPI['memoSave']>(async (input) => {
    const note = { ...notes.get(input.id)!, body: input.body, revision: input.revision + 1 }
    notes.set(input.id, note)
    return { status: 'ok', value: structuredClone(note) }
  })
  return { notes, load, save, session: new MemoDrafts({ memoLoad: load, memoSave: save }) }
}
describe('serialized memo drafts and delayed owner responses', () => {
  it('keeps separate owners and sends newer text after an older save response without reverting either draft', async () => {
    const h = drafts(),
      a = { kind: 'standalone' as const, id: 'A' },
      b = { kind: 'standalone' as const, id: 'B' }
    await h.session.open(a)
    await h.session.open(b)
    let resolve!: (value: any) => void
    h.save.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    h.session.edit(memoKey(a), 'older-A')
    h.session.edit(memoKey(a), 'newest-A')
    h.session.edit(memoKey(b), 'only-B')
    expect(h.session.entries.get('A')!.body).toBe('newest-A')
    await h.session.flush('B')
    resolve({ status: 'ok', value: { ...h.notes.get('A'), body: 'older-A', revision: 1 } })
    await h.session.flush('A')
    expect(h.save.mock.calls.map(([v]) => [v.id, v.body])).toEqual([
      ['A', 'older-A'],
      ['B', 'only-B'],
      ['A', 'newest-A'],
    ])
    expect(h.session.entries.get('A')!.body).toBe('newest-A')
    expect(h.session.entries.get('B')!.body).toBe('only-B')
    expect(h.session.entries.get('A')!.saving).toBe(false)
  })
  it('retains failed drafts across switching, retries conflicts explicitly, and never revives a deleted note from late saves', async () => {
    const h = drafts(),
      a = { kind: 'standalone' as const, id: 'A' },
      b = { kind: 'standalone' as const, id: 'B' }
    await h.session.open(a)
    h.save.mockResolvedValueOnce({
      status: 'error',
      message: 'fake save failure',
      current: { ...h.notes.get('A')!, revision: 3 },
    })
    h.session.edit('A', 'unsaved')
    await h.session.flush('A')
    await h.session.open(b)
    await h.session.open(a)
    expect(h.session.entries.get('A')!.body).toBe('unsaved')
    expect(h.session.entries.get('A')!.error).toBe('fake save failure')
    await h.session.retry('A', a)
    expect(h.save.mock.calls.at(-1)![0].revision).toBe(3)
    let resolve!: (value: any) => void
    h.save.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    h.session.edit('A', 'pending')
    const pending = h.session.flush('A')
    await h.session.changed('A', true)
    resolve({ status: 'ok', value: { ...h.notes.get('A'), body: 'pending', revision: 5 } })
    await pending
    expect(h.session.entries.get('A')).toMatchObject({ deleted: true, body: '', memo: undefined })
  })
})
