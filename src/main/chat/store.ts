import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ChatActive,
  ChatTarget,
  ChatTurn,
  ChatAttachmentInfo,
  ChatTurnStatus,
} from '../../shared/chat'

export class PageChatStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS page_chats (
      id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id), page INTEGER NOT NULL,
      UNIQUE(document_id,page));
      CREATE TABLE IF NOT EXISTS chat_turns (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES page_chats(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL, request_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL,
      status TEXT NOT NULL, model TEXT NOT NULL, attachment_json TEXT NOT NULL,
      error TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 0,
      UNIQUE(conversation_id,ordinal));
      UPDATE chat_turns SET status='stopped',error='앱이 종료되어 응답이 중단됐어요.',revision=revision+1
      WHERE status IN ('queued','streaming');`)
  }
  conversation(target: ChatTarget, create = false): string | null {
    const row = this.db
      .prepare('SELECT id FROM page_chats WHERE document_id=? AND page=?')
      .get(target.documentId, target.page)
    if (row) return String(row.id)
    if (!create) return null
    const id = randomUUID()
    this.db
      .prepare('INSERT INTO page_chats(id,document_id,page) VALUES(?,?,?)')
      .run(id, target.documentId, target.page)
    return id
  }
  turns(conversationId: string | null): ChatTurn[] {
    if (!conversationId) return []
    return this.db
      .prepare('SELECT * FROM chat_turns WHERE conversation_id=? ORDER BY ordinal')
      .all(conversationId)
      .map((r) => ({
        id: String(r.id),
        requestId: String(r.request_id),
        conversationId,
        question: String(r.question),
        answer: String(r.answer),
        status: r.status as ChatTurnStatus,
        model: String(r.model),
        attachment: JSON.parse(String(r.attachment_json)),
        error: String(r.error),
        revision: Number(r.revision),
      }))
  }
  start(
    conversationId: string,
    question: string,
    model: string,
    attachment: ChatAttachmentInfo,
    retryId?: string,
  ) {
    const rows = this.turns(conversationId)
    const requestId = randomUUID()
    if (retryId) {
      const last = rows.at(-1)
      if (!last || last.id !== retryId || !['error', 'stopped'].includes(last.status))
        throw new Error('invalid retry')
      this.db
        .prepare(
          `UPDATE chat_turns SET request_id=?,answer='',status='queued',model=?,attachment_json=?,error='',revision=revision+1 WHERE id=?`,
        )
        .run(requestId, model, JSON.stringify(attachment), retryId)
      return this.turns(conversationId).at(-1)!
    }
    const id = randomUUID()
    this.db
      .prepare(
        `INSERT INTO chat_turns(id,conversation_id,ordinal,request_id,question,answer,status,model,attachment_json)
      VALUES(?,?,?,?,?,?,'queued',?,?)`,
      )
      .run(
        id,
        conversationId,
        Number(
          this.db
            .prepare(
              'SELECT COALESCE(MAX(ordinal),-1)+1 AS next FROM chat_turns WHERE conversation_id=?',
            )
            .get(conversationId)!.next,
        ),
        requestId,
        question,
        '',
        model,
        JSON.stringify(attachment),
      )
    return this.turns(conversationId).at(-1)!
  }
  update(turn: ChatTurn, answer: string, status: ChatTurnStatus, error = ''): ChatTurn | null {
    const changed = this.db
      .prepare(
        `UPDATE chat_turns SET answer=?,status=?,error=?,revision=revision+1
      WHERE id=? AND conversation_id=? AND request_id=?`,
      )
      .run(answer, status, error, turn.id, turn.conversationId, turn.requestId)
    if (!changed.changes) return null
    return { ...turn, answer, status, error, revision: turn.revision + 1 }
  }
  clear(target: ChatTarget) {
    this.db
      .prepare('DELETE FROM page_chats WHERE document_id=? AND page=?')
      .run(target.documentId, target.page)
  }
  deleteTurn(target: ChatActive): boolean {
    return !!this.db
      .prepare(
        `DELETE FROM chat_turns WHERE id=? AND request_id=?
      AND conversation_id=? AND status IN ('complete','error','stopped')
      AND conversation_id IN (SELECT id FROM page_chats WHERE document_id=? AND page=?)`,
      )
      .run(target.turnId, target.requestId, target.conversationId, target.documentId, target.page)
      .changes
  }
}
