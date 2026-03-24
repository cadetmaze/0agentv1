import type { Database } from 'better-sqlite3';
import type { SQLiteAdapter } from '@0agent/core';

export interface ConversationMessage {
  id: string;
  session_id: string;
  user_entity_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_entity_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(user_entity_id, created_at);
`;

export class ConversationStore {
  private initialised = false;

  constructor(private adapter: SQLiteAdapter) {}

  init(): void {
    if (this.initialised) return;
    // Run DDL via the adapter's underlying db
    (this.adapter as unknown as { db: { exec: (s: string) => void } }).db.exec(CREATE_TABLE);
    this.initialised = true;
  }

  append(msg: ConversationMessage): void {
    this.init();
    const db = (this.adapter as unknown as { db: Database }).db;
    db.prepare(
      `INSERT INTO conversations (id, session_id, user_entity_id, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(msg.id, msg.session_id, msg.user_entity_id, msg.role, msg.content, msg.created_at);
  }

  getHistory(userEntityId: string, limit = 20): ConversationMessage[] {
    this.init();
    const db = (this.adapter as unknown as { db: Database }).db;
    const rows = db.prepare(
      `SELECT * FROM conversations WHERE user_entity_id = ?
       ORDER BY created_at DESC LIMIT ?`
    ).all(userEntityId, limit) as ConversationMessage[];
    return rows.reverse(); // chronological order
  }

  /**
   * Build conversation history as LLM messages for context injection.
   */
  buildContextMessages(userEntityId: string, limit = 10): Array<{ role: 'user' | 'assistant'; content: string }> {
    return this.getHistory(userEntityId, limit).map(m => ({
      role: m.role,
      content: m.content,
    }));
  }

  clearHistory(userEntityId: string): void {
    this.init();
    const db = (this.adapter as unknown as { db: Database }).db;
    db.prepare(`DELETE FROM conversations WHERE user_entity_id = ?`).run(userEntityId);
  }
}
