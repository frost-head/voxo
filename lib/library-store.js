'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const STANDALONE_ID = 'standalone';
const NOTE_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
const MAX_NOTE_BODY = 20000;
const MAX_TAGS = 12;

// Escape LIKE wildcards so a search for "100%" or "a_b" matches literally.
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const seen = new Set();
  for (const raw of list) {
    const tag = String(raw).trim().replace(/^#/, '').toLowerCase().slice(0, 32);
    if (tag) seen.add(tag);
    if (seen.size >= MAX_TAGS) break;
  }
  return [...seen];
}

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return normalizeTags(raw);
  }
}

function normalizeColor(color) {
  if (color === null || color === undefined || color === '') return null;
  return NOTE_COLORS.includes(color) ? color : null;
}

function rowToNote(row) {
  return {
    id: row.id,
    itemId: row.itemId,
    blockIndex: row.blockIndex,
    startOffset: row.startOffset,
    endOffset: row.endOffset,
    quote: row.quote,
    body: row.body,
    title: row.title ?? null,
    color: row.color ?? null,
    notebookId: row.notebookId ?? null,
    tags: parseTags(row.tags),
    pinned: row.pinned === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.sourceTitle !== undefined ? { sourceTitle: row.sourceTitle, sourceType: row.sourceType } : {}),
  };
}

const NOTE_SELECT = `
  n.id, n.item_id AS itemId, n.block_index AS blockIndex,
  n.start_offset AS startOffset, n.end_offset AS endOffset,
  n.quote, n.body, n.created_at AS createdAt, n.updated_at AS updatedAt,
  n.title, n.color, n.notebook_id AS notebookId, n.tags, n.pinned
`;

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
        is_saved INTEGER NOT NULL DEFAULT 0,
        in_history INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS notebooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES reading_items(id) ON DELETE CASCADE,
        block_index INTEGER NOT NULL,
        start_offset INTEGER,
        end_offset INTEGER,
        quote TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS embeddings (
        key TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        vec BLOB NOT NULL
      );
    `);

    this._migrate();

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS reading_items_last_opened ON reading_items(last_opened_at DESC);
      CREATE INDEX IF NOT EXISTS notes_created_at ON notes(created_at DESC);
      CREATE INDEX IF NOT EXISTS notes_item_id ON notes(item_id);
      CREATE INDEX IF NOT EXISTS notes_notebook_id ON notes(notebook_id);
    `);

    // Hidden parent row so standalone notes satisfy the foreign key.
    this.db.prepare(`
      INSERT OR IGNORE INTO reading_items (
        id, source_key, source_type, title, locator, file_path, article_json,
        first_opened_at, last_opened_at, open_count, is_saved, in_history
      ) VALUES (?, 'standalone:default', 'text', 'Standalone Notes', NULL, NULL, '{}', 0, 0, 0, 0, 0)
    `).run(STANDALONE_ID);
  }

  /** Adds columns that older databases are missing (CREATE TABLE IF NOT EXISTS never alters). */
  _migrate() {
    const addMissing = (table, columns) => {
      const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const [name, ddl] of Object.entries(columns)) {
        if (!have.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
      }
    };
    addMissing('notes', {
      title: 'TEXT',
      color: 'TEXT',
      notebook_id: 'TEXT REFERENCES notebooks(id) ON DELETE SET NULL',
      tags: 'TEXT',
      pinned: 'INTEGER NOT NULL DEFAULT 0',
    });
    addMissing('reading_items', {
      progress_unit: 'INTEGER NOT NULL DEFAULT 0',
      progress: 'REAL NOT NULL DEFAULT 0',
    });
  }

  _transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  }

  // ------------------------------------------------------------ reading items

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
        first_opened_at, last_opened_at, open_count, in_history
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
      ON CONFLICT(source_key) DO UPDATE SET
        source_type = excluded.source_type,
        title = excluded.title,
        locator = excluded.locator,
        file_path = excluded.file_path,
        article_json = excluded.article_json,
        last_opened_at = excluded.last_opened_at,
        open_count = reading_items.open_count + 1,
        in_history = 1
    `).run(id, sourceKey, type, title, locator, resolvedPath, json, existing?.first_opened_at || now, now);
    return id;
  }

  getProgress(id) {
    const row = this.db.prepare('SELECT progress_unit AS unit, progress AS fraction FROM reading_items WHERE id = ?').get(String(id));
    return row ? { unit: row.unit, fraction: row.fraction } : { unit: 0, fraction: 0 };
  }

  setProgress(id, unit, fraction) {
    const u = Number.isInteger(unit) && unit >= 0 ? unit : 0;
    const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
    this.db.prepare('UPDATE reading_items SET progress_unit = ?, progress = ? WHERE id = ? AND id != ?')
      .run(u, f, String(id), STANDALONE_ID);
    return true;
  }

  list(section = 'history', query = '') {
    if (section === 'notes' || section === 'highlights') {
      return this.listNotes({ query, kind: section === 'highlights' ? 'highlight' : 'all' });
    }

    const q = String(query || '').trim();
    const where = [section === 'saved' ? 'is_saved = 1' : 'in_history = 1', 'id != ?'];
    const params = [STANDALONE_ID];
    if (q) {
      where.push(`title LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(q)}%`);
    }
    return this.db.prepare(`
      SELECT id, source_type AS type, title, locator,
        first_opened_at AS firstOpenedAt, last_opened_at AS lastOpenedAt,
        open_count AS openCount, is_saved AS isSaved, progress,
        (SELECT COUNT(*) FROM notes WHERE item_id = reading_items.id) AS noteCount
      FROM reading_items
      WHERE ${where.join(' AND ')}
      ORDER BY last_opened_at DESC LIMIT 500
    `).all(...params).map((row) => ({ ...row, isSaved: row.isSaved === 1 }));
  }

  listItemNotes(itemId) {
    if (!itemId) return [];
    return this.db.prepare(`
      SELECT ${NOTE_SELECT}
      FROM notes n
      WHERE n.item_id = ?
      ORDER BY n.block_index ASC, COALESCE(n.start_offset, -1) ASC, n.created_at ASC
    `).all(String(itemId)).map(rowToNote);
  }

  toggleSaved(id) {
    const result = this.db.prepare(`
      UPDATE reading_items SET is_saved = CASE is_saved WHEN 1 THEN 0 ELSE 1 END
      WHERE id = ? AND id != ?
    `).run(String(id), STANDALONE_ID);
    if (!result.changes) return null;
    return this.isSaved(id);
  }

  isSaved(id) {
    return this.db.prepare('SELECT is_saved AS isSaved FROM reading_items WHERE id = ?').get(String(id))?.isSaved === 1;
  }

  open(id) {
    const itemId = String(id);
    if (itemId === STANDALONE_ID) return null;
    const now = Date.now();
    this.db.prepare(`
      UPDATE reading_items SET last_opened_at = ?, open_count = open_count + 1, in_history = 1
      WHERE id = ?
    `).run(now, itemId);
    const row = this.db.prepare(`
      SELECT id, source_type AS type, title, locator, file_path AS filePath,
        article_json AS articleJson, is_saved AS isSaved,
        progress_unit AS progressUnit, progress
      FROM reading_items WHERE id = ?
    `).get(itemId);
    if (!row) return null;
    const { articleJson, ...rest } = row;
    return {
      ...rest,
      isSaved: row.isSaved === 1,
      article: JSON.parse(articleJson),
      notes: this.listItemNotes(row.id),
    };
  }

  deleteItem(id) {
    const itemId = String(id);
    if (itemId === STANDALONE_ID) return false; // would cascade-delete every standalone note
    return this.db.prepare('DELETE FROM reading_items WHERE id = ?').run(itemId).changes > 0;
  }

  clearHistory() {
    return this._transaction(() => {
      const deleted = this.db.prepare(`
        DELETE FROM reading_items
        WHERE is_saved = 0 AND id != ?
          AND id NOT IN (SELECT DISTINCT item_id FROM notes)
      `).run(STANDALONE_ID);
      const hidden = this.db.prepare(
        'UPDATE reading_items SET in_history = 0 WHERE in_history = 1 AND id != ?'
      ).run(STANDALONE_ID);
      return deleted.changes + hidden.changes;
    });
  }

  // ------------------------------------------------------------ notes

  /**
   * @param {{query?:string, notebookId?:string|null, tag?:string, color?:string,
   *          kind?:'all'|'note'|'highlight', itemId?:string, limit?:number}} filter
   * notebookId 'none' selects notes that are not in any notebook.
   */
  listNotes({ query = '', notebookId = null, tag = '', color = '', kind = 'all', itemId = '', ids = null, limit = 500 } = {}) {
    const where = [];
    const params = [];

    const q = String(query || '').trim();
    if (q) {
      const like = `%${escapeLike(q)}%`;
      where.push(`(n.quote LIKE ? ESCAPE '\\' OR n.body LIKE ? ESCAPE '\\' OR n.title LIKE ? ESCAPE '\\'
        OR n.tags LIKE ? ESCAPE '\\' OR r.title LIKE ? ESCAPE '\\')`);
      params.push(like, like, like, like, like);
    }
    if (notebookId === 'none') where.push('n.notebook_id IS NULL');
    else if (notebookId) { where.push('n.notebook_id = ?'); params.push(String(notebookId)); }
    if (tag) {
      where.push(`n.tags LIKE ? ESCAPE '\\'`);
      params.push(`%${escapeLike(JSON.stringify(String(tag).toLowerCase()))}%`);
    }
    if (color) { where.push('n.color = ?'); params.push(String(color)); }
    if (kind === 'note') where.push("n.body != ''");
    else if (kind === 'highlight') where.push("n.body = '' AND n.item_id != ?"), params.push(STANDALONE_ID);
    if (itemId) { where.push('n.item_id = ?'); params.push(String(itemId)); }
    if (Array.isArray(ids) && ids.length) {
      where.push(`n.id IN (${ids.map(() => '?').join(',')})`);
      params.push(...ids.map(String));
    }

    const cap = Math.min(2000, Math.max(1, Number(limit) || 500));
    const rows = this.db.prepare(`
      SELECT ${NOTE_SELECT}, r.title AS sourceTitle, r.source_type AS sourceType
      FROM notes n JOIN reading_items r ON r.id = n.item_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY n.pinned DESC, n.updated_at DESC
      LIMIT ${cap}
    `).all(...params);
    return rows.map(rowToNote);
  }

  getNote(id) {
    const row = this.db.prepare(`
      SELECT ${NOTE_SELECT}, r.title AS sourceTitle, r.source_type AS sourceType
      FROM notes n JOIN reading_items r ON r.id = n.item_id WHERE n.id = ?
    `).get(String(id));
    return row ? rowToNote(row) : null;
  }

  listTags() {
    const counts = new Map();
    for (const { tags } of this.db.prepare("SELECT tags FROM notes WHERE tags IS NOT NULL AND tags != ''").all()) {
      for (const tag of parseTags(tags)) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }

  addNote({
    itemId = STANDALONE_ID, blockIndex = 0, startOffset = null, endOffset = null,
    quote = '', body = '', title = null, color = null, notebookId = null, tags = [],
  } = {}) {
    const noteBody = String(body ?? '').trim();
    const noteQuote = String(quote ?? '').trim();
    const index = Number(blockIndex);
    const parent = String(itemId || STANDALONE_ID);

    if (!this.db.prepare('SELECT 1 FROM reading_items WHERE id = ?').get(parent)) {
      throw new Error('This reading is no longer in your library.');
    }
    if (noteBody.length > MAX_NOTE_BODY) throw new Error('Notes must be 20,000 characters or fewer.');
    if (!noteQuote && parent !== STANDALONE_ID) throw new Error('Choose a paragraph or passage to attach this note to.');
    if (!Number.isInteger(index) || index < 0) throw new Error('That passage could not be identified.');
    if (notebookId && !this.db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(String(notebookId))) {
      throw new Error('That notebook no longer exists.');
    }

    const cleanStart = Number.isInteger(startOffset) && startOffset >= 0 ? startOffset : null;
    const cleanEnd = Number.isInteger(endOffset) && cleanStart !== null && endOffset > cleanStart ? endOffset : null;
    const hasRange = cleanStart !== null && cleanEnd !== null;
    const cleanTitle = title === null || title === undefined ? null : String(title).trim().slice(0, 200) || null;

    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO notes (id, item_id, block_index, start_offset, end_offset, quote, body,
        created_at, updated_at, title, color, notebook_id, tags, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      id, parent, index, hasRange ? cleanStart : null, hasRange ? cleanEnd : null, noteQuote, noteBody,
      now, now, cleanTitle, normalizeColor(color), notebookId ? String(notebookId) : null,
      JSON.stringify(normalizeTags(tags)),
    );
    return this.getNote(id);
  }

  /** patch may contain any of: body, title, color, notebookId, tags, pinned. */
  updateNote(id, patch = {}) {
    const existing = this.getNote(id);
    if (!existing) throw new Error('Note not found.');

    const body = patch.body !== undefined ? String(patch.body ?? '').trim() : existing.body;
    if (body.length > MAX_NOTE_BODY) throw new Error('Notes must be 20,000 characters or fewer.');
    const title = patch.title !== undefined
      ? (String(patch.title ?? '').trim().slice(0, 200) || null)
      : existing.title;
    const color = patch.color !== undefined ? normalizeColor(patch.color) : existing.color;
    const tags = patch.tags !== undefined ? normalizeTags(patch.tags) : existing.tags;
    const pinned = patch.pinned !== undefined ? Boolean(patch.pinned) : existing.pinned;
    let notebookId = patch.notebookId !== undefined ? (patch.notebookId || null) : existing.notebookId;
    if (notebookId && !this.db.prepare('SELECT 1 FROM notebooks WHERE id = ?').get(String(notebookId))) {
      notebookId = null;
    }

    this.db.prepare(`
      UPDATE notes SET body = ?, title = ?, color = ?, notebook_id = ?, tags = ?, pinned = ?, updated_at = ?
      WHERE id = ?
    `).run(body, title, color, notebookId, JSON.stringify(tags), pinned ? 1 : 0, Date.now(), existing.id);
    return this.getNote(existing.id);
  }

  deleteNote(id) {
    return this.db.prepare('DELETE FROM notes WHERE id = ?').run(String(id)).changes > 0;
  }

  /** Markdown export of any note selection (same filters as listNotes). */
  exportMarkdown(filter = {}) {
    const notes = this.listNotes({ ...filter, limit: 2000 });
    const notebooks = new Map(this.listNotebooks().map((n) => [n.id, n.name]));
    const date = (t) => new Date(t).toISOString().slice(0, 10);
    const out = ['# Voxo notes', '', `_Exported ${date(Date.now())} · ${notes.length} item${notes.length === 1 ? '' : 's'}_`, ''];

    const standalone = notes.filter((n) => n.itemId === STANDALONE_ID);
    const bySource = new Map();
    for (const note of notes.filter((n) => n.itemId !== STANDALONE_ID)) {
      if (!bySource.has(note.itemId)) bySource.set(note.itemId, { title: note.sourceTitle, notes: [] });
      bySource.get(note.itemId).notes.push(note);
    }

    const render = (note) => {
      const meta = [];
      if (note.notebookId && notebooks.has(note.notebookId)) meta.push(`Notebook: ${notebooks.get(note.notebookId)}`);
      if (note.tags.length) meta.push(note.tags.map((t) => `#${t}`).join(' '));
      meta.push(date(note.updatedAt));
      const lines = [];
      if (note.title) lines.push(`### ${note.title}`, '');
      if (note.quote) lines.push(...note.quote.split('\n').map((l) => `> ${l}`), '');
      if (note.body) lines.push(note.body, '');
      lines.push(`<sub>${meta.join(' · ')}</sub>`, '');
      return lines;
    };

    if (standalone.length) {
      out.push('## Standalone notes', '');
      for (const note of standalone) out.push(...render(note));
    }
    for (const group of bySource.values()) {
      out.push(`## ${group.title}`, '');
      for (const note of group.notes) out.push(...render(note));
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------ notebooks

  createNotebook(name) {
    const trimmed = String(name || '').trim().slice(0, 80);
    if (!trimmed) throw new Error('Notebook name cannot be empty.');
    const dupe = this.db.prepare('SELECT 1 FROM notebooks WHERE name = ? COLLATE NOCASE').get(trimmed);
    if (dupe) throw new Error('A notebook with that name already exists.');
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare('INSERT INTO notebooks (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)').run(id, trimmed, now, now);
    return { id, name: trimmed, createdAt: now, updatedAt: now, noteCount: 0 };
  }

  renameNotebook(id, name) {
    const trimmed = String(name || '').trim().slice(0, 80);
    if (!trimmed) throw new Error('Notebook name cannot be empty.');
    const dupe = this.db.prepare('SELECT id FROM notebooks WHERE name = ? COLLATE NOCASE').get(trimmed);
    if (dupe && dupe.id !== String(id)) throw new Error('A notebook with that name already exists.');
    const result = this.db.prepare('UPDATE notebooks SET name = ?, updated_at = ? WHERE id = ?').run(trimmed, Date.now(), String(id));
    if (!result.changes) throw new Error('Notebook not found.');
    return this.listNotebooks().find((n) => n.id === String(id));
  }

  listNotebooks() {
    return this.db.prepare(`
      SELECT id, name, created_at AS createdAt, updated_at AS updatedAt,
        (SELECT COUNT(*) FROM notes WHERE notebook_id = notebooks.id) AS noteCount
      FROM notebooks
      ORDER BY name COLLATE NOCASE ASC
    `).all();
  }

  deleteNotebook(id) {
    return this.db.prepare('DELETE FROM notebooks WHERE id = ?').run(String(id)).changes > 0;
  }

  // ---------------------------------------------------------------- search support

  /** Everything the search index reads, plus a cheap stamp that changes whenever any of it does. */
  searchSources() {
    const noteStamp = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(updated_at), 0) AS m FROM notes').get();
    const itemStamp = this.db.prepare('SELECT COUNT(*) AS c, COALESCE(MAX(last_opened_at), 0) AS m FROM reading_items').get();
    const stamp = `${noteStamp.c}:${noteStamp.m}:${itemStamp.c}:${itemStamp.m}`;
    if (stamp === this._searchStamp && this._searchCache) return this._searchCache;
    const notes = this.listNotes({ limit: 2000 }).map((n) => ({
      id: n.id, itemId: n.itemId, blockIndex: n.blockIndex, title: n.title || '', body: n.body || '', quote: n.quote || '',
      tags: n.tags || [], color: n.color || null, sourceTitle: n.itemId === STANDALONE_ID ? 'My note' : n.sourceTitle,
    }));
    const items = [];
    for (const row of this.db.prepare('SELECT id, title, article_json FROM reading_items WHERE id != ?').all(STANDALONE_ID)) {
      try {
        const article = JSON.parse(row.article_json);
        items.push({ id: row.id, title: row.title, blocks: (article.blocks || []).map((b) => ({ type: b.type, text: b.text })) });
      } catch { /* a damaged row is simply not searchable */ }
    }
    this._searchStamp = stamp;
    this._searchCache = { notes, items, stamp };
    return this._searchCache;
  }

  getEmbeddings() {
    const out = new Map();
    for (const row of this.db.prepare('SELECT key, hash, vec FROM embeddings').all()) {
      const bytes = row.vec;
      out.set(row.key, { hash: row.hash, vec: new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) });
    }
    return out;
  }

  putEmbeddings(rows) {
    this._transaction(() => {
      const stmt = this.db.prepare('INSERT OR REPLACE INTO embeddings (key, hash, vec) VALUES (?, ?, ?)');
      for (const row of rows) stmt.run(row.key, row.hash, new Uint8Array(row.vec.buffer, row.vec.byteOffset, row.vec.byteLength));
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = { LibraryStore, STANDALONE_ID, NOTE_COLORS };
