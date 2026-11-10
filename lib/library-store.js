'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

class LibraryStore {
  constructor(databasePath) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS reading_items (
        id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL CHECK (source_type IN ('article', 'text', 'pdf')),
        title TEXT NOT NULL,
        locator TEXT,
        file_path TEXT,
        article_json TEXT NOT NULL,
        first_opened_at INTEGER NOT NULL,
        last_opened_at INTEGER NOT NULL,
        open_count INTEGER NOT NULL DEFAULT 1,
        is_saved INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES reading_items(id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL,
        start_offset INTEGER,
        end_offset INTEGER,
        quote TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS reading_items_last_opened
        ON reading_items(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS notes_created_at
        ON notes(created_at DESC);
      CREATE INDEX IF NOT EXISTS notes_item_id
        ON notes(item_id);
    `);
  }

  record({ type, article, url = null, filePath = null, text = null }) {
    if (!['article', 'text', 'pdf'].includes(type)) throw new Error('Unknown reading source type.');
    const locator = type === 'article' ? String(url || article.url || '') : null;
    const resolvedPath = type === 'pdf' && filePath ? path.resolve(filePath) : null;
    const sourceKey = type === 'article'
      ? `article:${new URL(locator).href}`
      : type === 'pdf'
        ? `pdf:${resolvedPath}`
        : `text:${createHash('sha256').update(String(text || '')).digest('hex')}`;
    const title = String(article.title || locator || (type === 'pdf' ? path.basename(resolvedPath || '') : 'Your text'));
    const json = JSON.stringify(article);
    const now = Date.now();
    const existing = this.db.prepare('SELECT id, first_opened_at FROM reading_items WHERE source_key = ?').get(sourceKey);
    const id = existing?.id || randomUUID();

    this.db.prepare(`
      INSERT INTO reading_items (
        id, source_key, source_type, title, locator, file_path, article_json,
        first_opened_at, last_opened_at, open_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(source_key) DO UPDATE SET
        source_type = excluded.source_type,
        title = excluded.title,
        locator = excluded.locator,
        file_path = excluded.file_path,
        article_json = excluded.article_json,
        last_opened_at = excluded.last_opened_at,
        open_count = reading_items.open_count + 1
    `).run(id, sourceKey, type, title, locator, resolvedPath, json, existing?.first_opened_at || now, now);

    return id;
  }

  list(section = 'history') {
    if (section === 'notes') {
      return this.db.prepare(`
        SELECT n.id, n.item_id AS itemId, n.block_index AS blockIndex,
          n.start_offset AS startOffset, n.end_offset AS endOffset,
          n.quote, n.body, n.created_at AS createdAt,
          r.title AS sourceTitle, r.source_type AS sourceType
        FROM notes n
        JOIN reading_items r ON r.id = n.item_id
        ORDER BY n.created_at DESC
        LIMIT 500
      `).all();
    }

    const savedOnly = section === 'saved';
    return this.db.prepare(`
      SELECT id, source_type AS type, title, locator,
        first_opened_at AS firstOpenedAt, last_opened_at AS lastOpenedAt,
        open_count AS openCount, is_saved AS isSaved
      FROM reading_items
      ${savedOnly ? 'WHERE is_saved = 1' : ''}
      ORDER BY last_opened_at DESC
      LIMIT 500
    `).all();
  }

  toggleSaved(id) {
    const result = this.db.prepare(`
      UPDATE reading_items SET is_saved = CASE is_saved WHEN 1 THEN 0 ELSE 1 END
      WHERE id = ?
    `).run(String(id));
    if (!result.changes) return null;
    return this.db.prepare('SELECT is_saved AS isSaved FROM reading_items WHERE id = ?').get(String(id)).isSaved === 1;
  }

  isSaved(id) {
    return this.db.prepare('SELECT is_saved AS isSaved FROM reading_items WHERE id = ?').get(String(id))?.isSaved === 1;
  }

  open(id) {
    const now = Date.now();
    this.db.prepare(`
      UPDATE reading_items SET last_opened_at = ?, open_count = open_count + 1
      WHERE id = ?
    `).run(now, String(id));
    const row = this.db.prepare(`
      SELECT id, source_type AS type, title, locator, file_path AS filePath,
        article_json AS articleJson, is_saved AS isSaved
      FROM reading_items WHERE id = ?
    `).get(String(id));
    if (!row) return null;
    return { ...row, isSaved: row.isSaved === 1, article: JSON.parse(row.articleJson) };
  }

  addNote({ itemId, blockIndex, startOffset = null, endOffset = null, quote, body }) {
    const noteBody = String(body || '').trim();
    const noteQuote = String(quote || '').trim();
    const index = Number(blockIndex);
    if (!this.db.prepare('SELECT 1 FROM reading_items WHERE id = ?').get(String(itemId))) {
      throw new Error('This reading is no longer in your library.');
    }
    if (!noteBody) throw new Error('Write a note before saving it.');
    if (noteBody.length > 20000) throw new Error('Notes must be 20,000 characters or fewer.');
    if (!noteQuote) throw new Error('Choose a paragraph or passage to attach this note to.');
    if (!Number.isInteger(index) || index < 0) throw new Error('That passage could not be identified.');

    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO notes (id, item_id, block_index, start_offset, end_offset, quote, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      String(itemId),
      index,
      Number.isInteger(startOffset) && startOffset >= 0 ? startOffset : null,
      Number.isInteger(endOffset) && endOffset >= 0 ? endOffset : null,
      noteQuote,
      noteBody,
      Date.now(),
    );
    return id;
  }

  deleteNote(id) {
    const result = this.db.prepare('DELETE FROM notes WHERE id = ?').run(String(id));
    return result.changes > 0;
  }

  close() {
    this.db.close();
  }
}

module.exports = { LibraryStore };
