import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import type {
  BatchBudget,
  ImageSettings,
  LibraryDocument,
  LibraryFolder,
  LibrarySort,
  PageResult,
  PageTranslation,
  LibraryDeletion,
} from '../shared/contracts'
import {
  DEFAULT_BATCH_BUDGET,
  validBatchBudget,
  DEFAULT_LIBRARY_SORT,
  validLibrarySort,
} from '../shared/contracts'
import { validateResponse } from './batching'
import { hasUntranslatedEnglish } from './translationLanguage'
import { DEFAULT_THEME, validTheme } from '../shared/themes'
import type { ThemeId } from '../shared/themes'
import { PageChatStore } from './chat/store'
import { MemoStore } from './memos'
import {
  emptyReadingWorkspace,
  validReadingWorkspace,
  removeDocumentTabs,
} from '../shared/readingTabs'
import type { ReadingWorkspace } from '../shared/readingTabs'

export class LibraryError extends Error {}

export class TranslationStore {
  private db: DatabaseSync
  readonly chats: PageChatStore
  readonly memos: MemoStore
  private chatgptMode = false
  useChatGPT() {
    this.chatgptMode = true
  }
  constructor(
    path: string,
    public version: string,
  ) {
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS cache_migrations (name TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS budget_settings (
        id INTEGER PRIMARY KEY CHECK(id=1), input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue_settings (id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS theme_settings (id INTEGER PRIMARY KEY CHECK(id=1), theme TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_settings (id INTEGER PRIMARY KEY CHECK(id=1), sort_order TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_workspace (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chatgpt_models (profile TEXT PRIMARY KEY, model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS translation_overrides (document_id TEXT NOT NULL, page INTEGER NOT NULL, PRIMARY KEY(document_id,page));
      CREATE TABLE IF NOT EXISTS translation_history (history_id INTEGER PRIMARY KEY, document_id TEXT NOT NULL, page INTEGER NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, text TEXT, code TEXT, message TEXT, result_json TEXT);
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, total INTEGER NOT NULL,
        last_page INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
        pause_reason TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS translations (
        document_id TEXT NOT NULL REFERENCES documents(id), page INTEGER NOT NULL,
        version TEXT NOT NULL, status TEXT NOT NULL, text TEXT, code TEXT, message TEXT,
        PRIMARY KEY(document_id, page, version)
      );`)
    if (
      !this.db
        .prepare('PRAGMA table_info(library_settings)')
        .all()
        .some((row) => row.name === 'last_pdf_directory')
    )
      this.db.exec('ALTER TABLE library_settings ADD COLUMN last_pdf_directory TEXT')
    const resultColumns = this.db.prepare('PRAGMA table_info(translations)').all()
    if (!resultColumns.some((r) => r.name === 'result_json'))
      this.db.exec('ALTER TABLE translations ADD COLUMN result_json TEXT')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS image_settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)',
    )
    // Additive migration preserves existing page results and reading positions.
    const columns = new Set(
      this.db
        .prepare('PRAGMA table_info(documents)')
        .all()
        .map((row) => row.name),
    )
    for (const [name, definition] of Object.entries({
      path: "TEXT NOT NULL DEFAULT ''",
      thumbnail: "TEXT NOT NULL DEFAULT ''",
      sample: 'INTEGER NOT NULL DEFAULT 0',
      added_at: 'INTEGER NOT NULL DEFAULT 0',
      last_opened: 'INTEGER',
      original_path: "TEXT NOT NULL DEFAULT ''",
      pdf_hash: "TEXT NOT NULL DEFAULT ''",
    })) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`)
    }
    this.libraryWrite(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS library_folders (
        id TEXT PRIMARY KEY, parent_id TEXT REFERENCES library_folders(id), name TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS library_folder_root_name ON library_folders(name COLLATE NOCASE) WHERE parent_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS library_folder_child_name ON library_folders(parent_id,name COLLATE NOCASE) WHERE parent_id IS NOT NULL;`)
      if (!columns.has('folder_id'))
        this.db.exec(
          'ALTER TABLE documents ADD COLUMN folder_id TEXT REFERENCES library_folders(id)',
        )
    })
    this.migrateBudgetSettings()
    this.migrateLanguageCheckedCache()
    this.chats = new PageChatStore(this.db)
    this.memos = new MemoStore(this.db)
  }
  private migrateBudgetSettings(): void {
    const migration = 'batch-budget-defaults-16000-16384'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (!this.db.prepare('SELECT name FROM cache_migrations WHERE name=?').get(migration)) {
        this.db
          .prepare(
            'UPDATE budget_settings SET input_tokens=?,output_tokens=? WHERE id=1 AND input_tokens=12000 AND output_tokens=8192',
          )
          .run(DEFAULT_BATCH_BUDGET.inputTokens, DEFAULT_BATCH_BUDGET.outputTokens)
        this.db.prepare('INSERT INTO cache_migrations(name) VALUES(?)').run(migration)
      }
      // Preserve every other saved pair; only a missing row gets initial defaults.
      if (!this.db.prepare('SELECT id FROM budget_settings WHERE id=1').get())
        this.saveBudgetSettings(DEFAULT_BATCH_BUDGET)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  private migrateLanguageCheckedCache(): void {
    if (!this.version.includes(':image1:prompt4:schema1:render1:')) return
    const migration = 'image-prompt4-language-check'
    if (this.db.prepare('SELECT name FROM cache_migrations WHERE name=?').get(migration)) return
    const previous = ':image1:prompt3:schema1:render1:'
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const rows = this.db
        .prepare("SELECT * FROM translations WHERE status='done' AND result_json IS NOT NULL")
        .all()
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO translations(document_id,page,version,status,text,result_json)
         VALUES(?,?,?,'done',?,?)`,
      )
      for (const row of rows) {
        const version = String(row.version)
        if (!version.startsWith('auto:ko:gemini:') || !version.includes(previous)) continue
        const page = Number(row.page)
        let content: PageTranslation
        try {
          content = validateResponse(
            JSON.stringify({ pages: [{ ...JSON.parse(String(row.result_json)), page, part: 1 }] }),
            [{ page, part: 1 }],
          ).get(`${page}:1`)!
          if (content.contentType === 'unreadable' || hasUntranslatedEnglish(content)) continue
        } catch {
          // Keep the old row intact; unverified results must not become new completions.
          continue
        }
        insert.run(
          String(row.document_id),
          page,
          version.replace(previous, ':image1:prompt4:schema1:render1:'),
          content.translationMarkdown,
          JSON.stringify(content),
        )
      }
      this.db.prepare('INSERT INTO cache_migrations(name) VALUES(?)').run(migration)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  add(
    id: string,
    name: string,
    total: number,
    path: string,
    thumbnail: string,
    sample: boolean,
    folderId: string | null = null,
    rememberDirectory = false,
    derived?: { originalPath: string; pdfHash: string },
  ): void {
    this.libraryWrite(() => {
      this.requireParent(folderId)
      const existing = !!this.db.prepare('SELECT id FROM documents WHERE id=?').get(id)
      this.register(id, name, total)
      this.db
        .prepare(
          `UPDATE documents SET path=?,thumbnail=?,sample=?,original_path=?,pdf_hash=?,
      added_at=CASE WHEN added_at=0 THEN ? ELSE added_at END,
      folder_id=CASE WHEN ? THEN folder_id ELSE ? END WHERE id=?`,
        )
        .run(
          path,
          thumbnail,
          Number(sample),
          derived?.originalPath ?? '',
          derived?.pdfHash ?? '',
          Date.now(),
          Number(existing),
          folderId,
          id,
        )
      if (rememberDirectory) this.savePdfDirectory(dirname(derived?.originalPath ?? path))
    })
  }
  private libraryWrite<T>(write: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const value = write()
      this.db.exec('COMMIT')
      return value
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
  folders(): LibraryFolder[] {
    return this.db
      .prepare('SELECT id,parent_id,name FROM library_folders ORDER BY name COLLATE NOCASE,id')
      .all()
      .map((row) => ({
        id: String(row.id),
        parentId: row.parent_id === null ? null : String(row.parent_id),
        name: String(row.name),
      }))
  }
  private folder(id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128)
      throw new LibraryError('폴더 정보가 올바르지 않아요.')
    const row = this.db.prepare('SELECT id,parent_id,name FROM library_folders WHERE id=?').get(id)
    if (!row) throw new LibraryError('폴더를 찾을 수 없어요.')
    return row
  }
  private requireParent(id: unknown): void {
    if (id !== null) this.folder(id)
  }
  private folderName(value: unknown): string {
    if (typeof value !== 'string') throw new LibraryError('폴더 이름을 입력해 주세요.')
    const name = value.trim().normalize('NFC')
    if (!name || name.length > 200 || /[\u0000-\u001f\u007f]/.test(name))
      throw new LibraryError('폴더 이름은 공백을 제외한 1–200자로 입력해 주세요.')
    return name
  }
  private uniqueFolder(name: string, parent: string | null, except: string | null = null) {
    if (
      this.db
        .prepare(
          'SELECT id FROM library_folders WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id IS NOT ?',
        )
        .get(parent, name, except)
    )
      throw new LibraryError('같은 위치에 같은 이름의 폴더가 있어요.')
  }
  changeLibrary(input: unknown): void {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new LibraryError('폴더 변경 정보가 올바르지 않아요.')
    const change = input as Record<string, unknown>
    this.libraryWrite(() => {
      if (change.kind === 'create') {
        this.requireParent(change.parentId)
        const name = this.folderName(change.name),
          parent = change.parentId as string | null
        this.uniqueFolder(name, parent)
        this.db
          .prepare('INSERT INTO library_folders(id,parent_id,name) VALUES(?,?,?)')
          .run(randomUUID(), parent, name)
      } else if (change.kind === 'rename') {
        const folder = this.folder(change.id),
          name = this.folderName(change.name)
        this.uniqueFolder(name, folder.parent_id as string | null, String(folder.id))
        this.db.prepare('UPDATE library_folders SET name=? WHERE id=?').run(name, String(folder.id))
      } else if (change.kind === 'moveFolder') {
        const folder = this.folder(change.id),
          parent = change.parentId as string | null
        this.requireParent(parent)
        if (
          parent !== null &&
          this.db
            .prepare(
              `WITH RECURSIVE descendants(id) AS (
          SELECT id FROM library_folders WHERE id=? UNION SELECT f.id FROM library_folders f JOIN descendants d ON f.parent_id=d.id
        ) SELECT id FROM descendants WHERE id=?`,
            )
            .get(String(folder.id), parent)
        )
          throw new LibraryError('자기 자신이나 하위 폴더로 이동할 수 없어요.')
        this.uniqueFolder(String(folder.name), parent, String(folder.id))
        this.db
          .prepare('UPDATE library_folders SET parent_id=? WHERE id=?')
          .run(parent, String(folder.id))
      } else if (change.kind === 'moveDocument') {
        this.requireParent(change.folderId)
        if (
          typeof change.id !== 'string' ||
          !this.db.prepare('SELECT id FROM documents WHERE id=?').get(change.id)
        )
          throw new LibraryError('문서를 찾을 수 없어요.')
        this.db
          .prepare('UPDATE documents SET folder_id=? WHERE id=?')
          .run(change.folderId as string | null, change.id)
      } else throw new LibraryError('지원하지 않는 폴더 작업이에요.')
    })
  }
  deleteLibrary(input: unknown): LibraryDeletion {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new LibraryError('삭제할 파일이나 폴더를 확인해 주세요.')
    const target = input as Record<string, unknown>
    if (
      typeof target.id !== 'string' ||
      !target.id ||
      target.id.length > 128 ||
      (target.kind !== 'document' && target.kind !== 'folder')
    )
      throw new LibraryError('삭제할 파일이나 폴더를 확인해 주세요.')
    const targetId = target.id
    return this.libraryWrite(() => {
      // Resolve the current hierarchy under the same write transaction as deletion.
      const folderIds =
        target.kind === 'folder'
          ? (this.folder(targetId),
            this.db
              .prepare(
                `WITH RECURSIVE tree(id) AS (
            SELECT id FROM library_folders WHERE id=? UNION
            SELECT f.id FROM library_folders f JOIN tree t ON f.parent_id=t.id
          ) SELECT id FROM tree`,
              )
              .all(targetId)
              .map((row) => String(row.id)))
          : []
      const documentIds =
        target.kind === 'document'
          ? this.db
              .prepare('SELECT id FROM documents WHERE id=?')
              .all(targetId)
              .map((row) => String(row.id))
          : folderIds.flatMap((id) =>
              this.db
                .prepare('SELECT id FROM documents WHERE folder_id=?')
                .all(id)
                .map((row) => String(row.id)),
            )
      if (target.kind === 'document' && !documentIds.length)
        throw new LibraryError('문서를 찾을 수 없어요. 목록을 다시 확인해 주세요.')
      const memoIds: string[] = []
      // Explicit ownership deletes also cover old cache versions and tables without FK cascades.
      for (const id of documentIds) {
        memoIds.push(
          ...this.db
            .prepare('SELECT id FROM memos WHERE document_id=?')
            .all(id)
            .map((row) => String(row.id)),
        )
        for (const table of [
          'translations',
          'translation_history',
          'translation_overrides',
          'page_chats',
          'memos',
        ])
          this.db.prepare(`DELETE FROM ${table} WHERE document_id=?`).run(id)
        this.db.prepare('DELETE FROM documents WHERE id=?').run(id)
      }
      // One statement checks internal parent FKs after all descendants are removed.
      if (target.kind === 'folder')
        this.db
          .prepare(
            `WITH RECURSIVE tree(id) AS (
        SELECT id FROM library_folders WHERE id=? UNION
        SELECT f.id FROM library_folders f JOIN tree t ON f.parent_id=t.id
      ) DELETE FROM library_folders WHERE id IN (SELECT id FROM tree)`,
          )
          .run(targetId)
      const workspace = this.readingWorkspace()
      const pruned = removeDocumentTabs(workspace, documentIds)
      if (pruned !== workspace) this.saveReadingWorkspace(pruned)
      return { documentIds, folderIds, memoIds }
    })
  }
  queuePaused(): boolean {
    return Boolean(this.db.prepare('SELECT paused FROM queue_settings WHERE id=1').get()?.paused)
  }
  pauseAll(paused: boolean): void {
    this.db
      .prepare(
        'INSERT INTO queue_settings(id,paused) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET paused=excluded.paused',
      )
      .run(Number(paused))
  }
  scheduled(): { id: string; name: string; total: number }[] {
    return this.db
      .prepare('SELECT id,name,total FROM documents ORDER BY added_at ASC,rowid ASC')
      .all()
      .map((row) => ({ id: String(row.id), name: String(row.name), total: Number(row.total) }))
  }
  derivedSources(): { id: string; path: string }[] {
    return this.db
      .prepare("SELECT id,path FROM documents WHERE original_path<>''")
      .all()
      .map((row) => ({ id: String(row.id), path: String(row.path) }))
  }
  source(id: string):
    | {
        path: string
        sample: boolean
        derived?: { name: string; originalPath: string; pdfHash: string }
      }
    | undefined {
    const row = this.db
      .prepare('SELECT path,sample,name,original_path,pdf_hash FROM documents WHERE id=?')
      .get(id)
    return row
      ? {
          path: String(row.path),
          sample: Boolean(row.sample),
          ...(row.original_path
            ? {
                derived: {
                  name: String(row.name),
                  originalPath: String(row.original_path),
                  pdfHash: String(row.pdf_hash),
                },
              }
            : {}),
        }
      : undefined
  }
  reconnectSource(id: string, path: string, name: string): void {
    const result = this.db
      .prepare('UPDATE documents SET path=?,name=? WHERE id=?')
      .run(path, name, id)
    if (!result.changes) throw new Error('원본 PDF 위치를 저장하지 못했어요.')
  }
  readingWorkspace(): ReadingWorkspace {
    const row = this.db.prepare('SELECT value FROM reading_workspace WHERE id=1').get()
    if (!row) return emptyReadingWorkspace()
    const value: unknown = JSON.parse(String(row.value))
    if (!validReadingWorkspace(value)) throw new Error('저장된 문서 탭을 확인할 수 없어요.')
    return value
  }
  saveReadingWorkspace(value: ReadingWorkspace): void {
    if (!validReadingWorkspace(value)) throw new Error('문서 탭 정보가 올바르지 않아요.')
    if (value.tabs.some((t) => !this.source(t.documentId)))
      throw new Error('등록되지 않은 문서 탭은 저장할 수 없어요.')
    this.db
      .prepare(
        `INSERT INTO reading_workspace(id,value) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value`,
      )
      .run(JSON.stringify(value))
  }
  opened(id: string): void {
    this.db
      .prepare(
        `UPDATE documents SET last_opened=MAX(?,
      COALESCE((SELECT MAX(last_opened)+1 FROM documents),0)) WHERE id=?`,
      )
      .run(Date.now(), id)
  }
  list(): LibraryDocument[] {
    return this.db
      .prepare(
        `SELECT d.id,d.folder_id,d.name,d.total,d.thumbnail,d.last_opened,d.added_at,
      COALESCE(SUM(t.status='done'),0) AS done,
      COALESCE(SUM(t.status='skipped'),0) AS skipped,
      COALESCE(SUM(t.status='error'),0) AS failed
      FROM documents d LEFT JOIN translations t ON t.document_id=d.id AND t.version=?
      AND t.page BETWEEN 1 AND d.total
      GROUP BY d.id ORDER BY d.last_opened DESC,d.added_at DESC,d.id ASC`,
      )
      .all(this.version)
      .map((row) => {
        const effective = this.chatgptMode
          ? [...this.load(String(row.id))]
              .filter(([page]) => page >= 1 && page <= Number(row.total))
              .map(([, result]) => result)
          : undefined
        const done = effective
            ? effective.filter((r) => r.status === 'done').length
            : Number(row.done),
          skipped = effective
            ? effective.filter((r) => r.status === 'skipped').length
            : Number(row.skipped),
          total = Number(row.total)
        return {
          id: String(row.id),
          folderId: row.folder_id === null ? null : String(row.folder_id),
          name: String(row.name),
          total,
          done,
          skipped,
          failed: effective
            ? effective.filter((r) => r.status === 'error').length
            : Number(row.failed),
          thumbnail: String(row.thumbnail),
          lastOpened: row.last_opened === null ? null : Number(row.last_opened),
          addedAt: Number(row.added_at) > 0 ? Number(row.added_at) : null,
          status: done + skipped === total ? 'complete' : 'stopped',
        }
      })
  }
  register(id: string, name: string, total: number) {
    this.db
      .prepare(
        `INSERT INTO documents(id,name,total) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,total=excluded.total,last_page=MIN(last_page,excluded.total)`,
      )
      .run(id, name, total)
    const row = this.db
      .prepare('SELECT last_page,paused,pause_reason FROM documents WHERE id=?')
      .get(id)!
    return {
      page: Number(row.last_page),
      paused: Boolean(row.paused),
      reason: String(row.pause_reason),
    }
  }
  load(id: string): Map<number, PageResult> {
    let rows = this.db
      .prepare(
        'SELECT page,version,status,text,code,message,result_json FROM translations WHERE document_id=? AND version=?',
      )
      .all(id, this.version)
    if (this.chatgptMode) {
      const occupied = new Set(rows.map((r) => Number(r.page)))
      const legacy = this.db
        .prepare(
          `SELECT page,version,status,text,code,message,result_json FROM translations t
        WHERE document_id=? AND version LIKE 'auto:ko:gemini:%' AND status IN ('done','skipped')
        AND NOT EXISTS(SELECT 1 FROM translation_overrides o WHERE o.document_id=t.document_id AND o.page=t.page)
        ORDER BY t.rowid DESC`,
        )
        .all(id)
      for (const row of legacy)
        if (!occupied.has(Number(row.page))) {
          occupied.add(Number(row.page))
          rows.push(row)
        }
    }
    return new Map(
      rows.map((row) => [
        Number(row.page),
        row.status === 'done'
          ? {
              status: 'done',
              text: String(row.text),
              ...(row.result_json ? { content: JSON.parse(String(row.result_json)) } : {}),
              ...(this.chatgptMode
                ? {
                    provenance: {
                      provider: String(row.version).startsWith('auto:ko:gemini:')
                        ? ('gemini' as const)
                        : ('chatgpt' as const),
                      model:
                        String(row.version).split(':')[
                          String(row.version).startsWith('auto:ko:gemini:') ? 3 : 4
                        ] ?? '',
                      version: String(row.version),
                      legacy: String(row.version) !== this.version,
                    },
                  }
                : {}),
            }
          : row.status === 'skipped'
            ? { status: 'skipped' }
            : {
                status: 'error',
                code: String(row.code),
                message: String(row.message),
                ...(row.result_json ? { content: JSON.parse(String(row.result_json)) } : {}),
              },
      ]),
    )
  }
  save(id: string, page: number, result: PageResult): void {
    if (!['done', 'skipped', 'error'].includes(result.status)) return
    this.db
      .prepare(
        `INSERT INTO translations(document_id,page,version,status,text,code,message,result_json) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(document_id,page,version) DO UPDATE SET status=excluded.status,text=excluded.text,code=excluded.code,message=excluded.message,result_json=excluded.result_json`,
      )
      .run(
        id,
        page,
        this.version,
        result.status,
        result.status === 'done' ? result.text : null,
        result.status === 'error' ? result.code : null,
        result.status === 'error' ? result.message : null,
        'content' in result && result.content ? JSON.stringify(result.content) : null,
      )
  }
  remove(id: string, page: number): void {
    if (this.chatgptMode) {
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db
          .prepare(
            'INSERT INTO translation_history(document_id,page,version,status,text,code,message,result_json) SELECT document_id,page,version,status,text,code,message,result_json FROM translations WHERE document_id=? AND page=? AND version=?',
          )
          .run(id, page, this.version)
        this.db
          .prepare('INSERT OR IGNORE INTO translation_overrides(document_id,page) VALUES(?,?)')
          .run(id, page)
        this.db
          .prepare('DELETE FROM translations WHERE document_id=? AND page=? AND version=?')
          .run(id, page, this.version)
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
      return
    }
    this.db
      .prepare('DELETE FROM translations WHERE document_id=? AND page=? AND version=?')
      .run(id, page, this.version)
  }
  position(id: string, page: number): void {
    this.db.prepare('UPDATE documents SET last_page=? WHERE id=?').run(page, id)
  }
  pause(id: string, paused: boolean, reason: string): void {
    this.db
      .prepare('UPDATE documents SET paused=?,pause_reason=? WHERE id=?')
      .run(Number(paused), reason, id)
  }
  imageSettings(): unknown {
    const value = this.db.prepare('SELECT value FROM image_settings WHERE id=1').get()?.value
    try {
      return value ? JSON.parse(String(value)) : undefined
    } catch {
      return undefined
    }
  }
  selectedModel(profile: string): string {
    return String(
      this.db.prepare('SELECT model FROM chatgpt_models WHERE profile=?').get(profile)?.model ?? '',
    )
  }
  saveSelectedModel(profile: string, model: string) {
    this.db
      .prepare(
        'INSERT INTO chatgpt_models(profile,model) VALUES(?,?) ON CONFLICT(profile) DO UPDATE SET model=excluded.model',
      )
      .run(profile, model)
  }
  themeSettings(): ThemeId {
    const theme = this.db.prepare('SELECT theme FROM theme_settings WHERE id=1').get()?.theme
    return validTheme(theme) ? theme : DEFAULT_THEME
  }
  librarySortSettings(): LibrarySort {
    const value = this.db
      .prepare('SELECT sort_order FROM library_settings WHERE id=1')
      .get()?.sort_order
    return validLibrarySort(value) ? value : DEFAULT_LIBRARY_SORT
  }
  pdfDirectory(): string | undefined {
    const value = this.db
      .prepare(
        'SELECT last_pdf_directory FROM library_settings WHERE id=1 AND instr(last_pdf_directory,char(0))=0',
      )
      .get()?.last_pdf_directory
    return typeof value === 'string' && isAbsolute(value) && !value.includes('\0')
      ? value
      : undefined
  }
  private savePdfDirectory(directory: string): void {
    if (!isAbsolute(directory) || directory.includes('\0'))
      throw new LibraryError('원본 폴더 위치를 저장하지 못했어요.')
    this.db
      .prepare(
        `INSERT INTO library_settings(id,sort_order,last_pdf_directory) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET last_pdf_directory=excluded.last_pdf_directory`,
      )
      .run(DEFAULT_LIBRARY_SORT, directory)
  }
  saveLibrarySort(sort: LibrarySort): void {
    if (!validLibrarySort(sort)) throw new LibraryError('지원하는 정렬 기준을 선택해 주세요.')
    this.db
      .prepare(
        'INSERT INTO library_settings(id,sort_order) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order',
      )
      .run(sort)
  }
  saveThemeSettings(theme: ThemeId): void {
    if (!validTheme(theme)) throw new Error('Invalid theme')
    this.db
      .prepare(
        'INSERT INTO theme_settings(id,theme) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET theme=excluded.theme',
      )
      .run(theme)
  }
  budgetSettings(): BatchBudget {
    const row = this.db
      .prepare('SELECT input_tokens,output_tokens FROM budget_settings WHERE id=1')
      .get()
    const budget = row && {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    }
    return validBatchBudget(budget) ? budget : { ...DEFAULT_BATCH_BUDGET }
  }
  saveBudgetSettings(value: BatchBudget): void {
    if (!validBatchBudget(value)) throw new Error('Invalid batch budget')
    this.db
      .prepare(
        'INSERT INTO budget_settings(id,input_tokens,output_tokens) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens',
      )
      .run(value.inputTokens, value.outputTokens)
  }
  saveImageSettings(value: ImageSettings): void {
    this.db
      .prepare(
        'INSERT INTO image_settings(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
      )
      .run(JSON.stringify(value))
  }
  close(): void {
    this.db.close()
  }
}
