import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  Memo,
  MemoPreferences,
  MemoTarget,
  MemoExportInput,
  MemoExportSnapshot,
} from '../shared/memos'
import { DEFAULT_MEMO_PREFERENCES } from '../shared/memos'

export class MemoError extends Error {
  constructor(
    message: string,
    public current?: Memo,
  ) {
    super(message)
  }
}
export class MemoStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS memos (
      id TEXT PRIMARY KEY, document_id TEXT REFERENCES documents(id), page INTEGER,
      title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(document_id,page), CHECK((document_id IS NULL AND page IS NULL) OR (document_id IS NOT NULL AND page>=1)));
      CREATE TABLE IF NOT EXISTS memo_preferences (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);`)
  }
  private row(r: any): Memo {
    return {
      id: String(r.id),
      documentId: r.document_id === null ? null : String(r.document_id),
      page: r.page === null ? null : Number(r.page),
      title: String(r.title),
      body: String(r.body),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      revision: Number(r.revision),
    }
  }
  private get(id: unknown): Memo {
    if (typeof id !== 'string' || id.length > 100) throw new MemoError('메모를 다시 선택해 주세요.')
    const row = this.db.prepare('SELECT * FROM memos WHERE id=?').get(id)
    if (!row) throw new MemoError('메모가 삭제되었거나 존재하지 않아요.')
    return this.row(row)
  }
  list() {
    return this.db
      .prepare('SELECT * FROM memos WHERE document_id IS NULL')
      .all()
      .map((row) => {
        const { body: _body, ...summary } = this.row(row)
        return summary
      })
  }
  exportSource(input: MemoExportInput): MemoExportSnapshot {
    if (
      !input ||
      !['pdf', 'md'].includes(input.format) ||
      !['single', 'document'].includes(input.scope) ||
      !Array.isArray(input.drafts) ||
      input.drafts.length > 10000
    )
      throw new MemoError('내보낼 메모와 형식을 확인해 주세요.')
    const target = input.target
    let notes: Memo[], title: string
    if (target?.kind === 'standalone') {
      const memo = this.get(target.id)
      if (memo.documentId !== null || input.scope !== 'single')
        throw new MemoError('별도 메모를 다시 선택해 주세요.')
      notes = [memo]
      title = memo.title
    } else {
      if (
        target?.kind !== 'page' ||
        typeof target.documentId !== 'string' ||
        !Number.isSafeInteger(target.page) ||
        target.page < 1
      )
        throw new MemoError('PDF와 페이지를 먼저 선택해 주세요.')
      const doc = this.db
        .prepare('SELECT name,total FROM documents WHERE id=?')
        .get(target.documentId)
      if (!doc || target.page > Number(doc.total))
        throw new MemoError('PDF와 페이지를 먼저 선택해 주세요.')
      notes = this.db
        .prepare('SELECT * FROM memos WHERE document_id=? ORDER BY page')
        .all(target.documentId)
        .map((row) => this.row(row))
        .filter((memo) => input.scope === 'document' || memo.page === target.page)
      title =
        String(doc.name).replace(/\.pdf$/i, '') +
        (input.scope === 'document' ? ' 메모' : ` ${target.page}페이지 메모`)
    }
    const seen = new Set<string>()
    for (const draft of input.drafts) {
      if (
        !draft ||
        typeof draft.id !== 'string' ||
        seen.has(draft.id) ||
        typeof draft.body !== 'string' ||
        Buffer.byteLength(draft.body) > 1024 * 1024 ||
        draft.body.includes('\0')
      )
        throw new MemoError('내보낼 메모 내용을 확인해 주세요.')
      seen.add(draft.id)
      const note = notes.find((memo) => memo.id === draft.id)
      if (!note) throw new MemoError('내보낼 메모의 소속을 확인해 주세요.')
      note.body = draft.body
    }
    const sections = notes
      .filter((memo) => memo.body.trim())
      .map(({ id, page, body }) => ({ id, page, body }))
    if (!sections.length) throw new MemoError('내보낼 메모 내용이 없어요.')
    if (
      sections.reduce((size, section) => size + Buffer.byteLength(section.body), 0) >
      64 * 1024 * 1024
    )
      throw new MemoError('한 번에 내보낼 메모는 64 MiB 이하로 선택해 주세요.')
    return { title, sections }
  }
  load(target: MemoTarget): Memo {
    if (target?.kind === 'standalone') {
      const memo = this.get(target.id)
      if (memo.documentId !== null) throw new MemoError('별도 메모를 다시 선택해 주세요.')
      return memo
    }
    if (
      target?.kind !== 'page' ||
      typeof target.documentId !== 'string' ||
      !Number.isInteger(target.page) ||
      target.page < 1
    )
      throw new MemoError('PDF와 페이지를 먼저 선택해 주세요.')
    const doc = this.db.prepare('SELECT total FROM documents WHERE id=?').get(target.documentId)
    if (!doc || target.page > Number(doc.total))
      throw new MemoError('PDF와 페이지를 먼저 선택해 주세요.')
    const row = this.db
      .prepare('SELECT * FROM memos WHERE document_id=? AND page=?')
      .get(target.documentId, target.page)
    if (row) return this.row(row)
    const id = randomUUID(),
      now = Date.now()
    this.db
      .prepare(
        'INSERT INTO memos(id,document_id,page,title,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(id, target.documentId, target.page, '', now, now)
    return this.get(id)
  }
  private title(value: unknown) {
    if (typeof value !== 'string') throw new MemoError('제목을 입력해 주세요.')
    const title = value.trim().normalize('NFC')
    if (!title || title.length > 200 || /[\u0000-\u001f\u007f]/.test(title))
      throw new MemoError('제목은 1–200자로 입력해 주세요.')
    return title
  }
  create(value: unknown): Memo {
    const title = this.title(value),
      id = randomUUID(),
      now = Date.now()
    this.db
      .prepare('INSERT INTO memos(id,title,created_at,updated_at) VALUES(?,?,?,?)')
      .run(id, title, now, now)
    return this.get(id)
  }
  private checked(input: { id: string; revision: number }): Memo {
    const current = this.get(input?.id)
    if (!Number.isSafeInteger(input.revision) || current.revision !== input.revision)
      throw new MemoError('메모가 변경됐어요. 초안을 확인하고 다시 저장해 주세요.', current)
    return current
  }
  save(input: { id: string; revision: number; body: string }): Memo {
    const current = this.checked(input)
    if (
      typeof input.body !== 'string' ||
      Buffer.byteLength(input.body) > 1024 * 1024 ||
      input.body.includes('\0')
    )
      throw new MemoError('메모는 1 MiB 이하의 일반 텍스트로 작성해 주세요.')
    const result = this.db
      .prepare('UPDATE memos SET body=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?')
      .run(input.body, Math.max(Date.now(), current.updatedAt + 1), current.id, current.revision)
    if (!result.changes)
      throw new MemoError(
        '메모가 변경됐어요. 초안을 확인하고 다시 저장해 주세요.',
        this.get(current.id),
      )
    return this.get(current.id)
  }
  rename(input: { id: string; revision: number; title: string }): Memo {
    const current = this.checked(input),
      title = this.title(input.title)
    if (current.documentId !== null) throw new MemoError('페이지별 메모의 제목은 변경하지 않아요.')
    const result = this.db
      .prepare(
        'UPDATE memos SET title=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?',
      )
      .run(title, Math.max(Date.now(), current.updatedAt + 1), current.id, current.revision)
    if (!result.changes)
      throw new MemoError('메모가 변경됐어요. 다시 선택해 주세요.', this.get(current.id))
    return this.get(current.id)
  }
  delete(input: { id: string; revision: number }) {
    const memo = this.checked(input)
    if (memo.documentId !== null) throw new MemoError('별도 메모를 다시 선택해 주세요.')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const preferences = this.preferences()
      if (
        !this.db.prepare('DELETE FROM memos WHERE id=? AND revision=?').run(memo.id, memo.revision)
          .changes
      )
        throw new MemoError('메모가 변경됐어요. 다시 선택해 주세요.', this.get(memo.id))
      if (preferences.selection.kind === 'standalone' && preferences.selection.id === memo.id)
        this.preferences({ ...preferences, selection: { kind: 'standalone', id: null } })
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  preferences(next?: MemoPreferences): MemoPreferences {
    const valid = (value: any): value is MemoPreferences =>
      value &&
      ['preview', 'source'].includes(value.mode) &&
      ['modified', 'created', 'name'].includes(value.sort) &&
      (value.selection?.kind === 'page' ||
        (value.selection?.kind === 'standalone' &&
          (value.selection.id === null || typeof value.selection.id === 'string')))
    if (next !== undefined) {
      if (!valid(next)) throw new MemoError('메모 설정을 확인해 주세요.')
      if (
        next.selection.kind === 'standalone' &&
        next.selection.id !== null &&
        this.get(next.selection.id).documentId !== null
      )
        throw new MemoError('별도 메모를 다시 선택해 주세요.')
      this.db
        .prepare(
          'INSERT INTO memo_preferences(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
        )
        .run(JSON.stringify(next))
      return next
    }
    const row = this.db.prepare('SELECT value FROM memo_preferences WHERE id=1').get()
    try {
      const stored = row ? JSON.parse(String(row.value)) : null
      if (valid(stored)) {
        if (
          stored.selection.kind === 'standalone' &&
          stored.selection.id &&
          !this.db
            .prepare('SELECT id FROM memos WHERE id=? AND document_id IS NULL')
            .get(stored.selection.id)
        )
          return { ...stored, selection: { kind: 'standalone', id: null } }
        return stored
      }
    } catch {
      /* Unsupported saved preferences fall back without rewriting records. */
    }
    return structuredClone(DEFAULT_MEMO_PREFERENCES)
  }
}
