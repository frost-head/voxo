'use strict';

const { createHash } = require('crypto');

// Search over notes and the articles in your library by meaning, not just keywords.
//   1. A local keyword ranker (BM25 with stop-word removal and light stemming) always works, offline, instantly.
//   2. When the small embedding model is available, passages are also compared by meaning, and the two rankings are
//      merged (reciprocal rank fusion). "how do I draw a triangle in vulkan" finds the passage about pipelines even
//      if those words never appear together.

const STOP = new Set(`a about above after again all also am an and any are as at be because been before being below between both but by can
could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just
me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there
these they this those through to too under until up very was we were what when where which while who whom why will with would you your
tell show find give want need please explain get got make made use using used way ways thing things something anything`.split(/\s+/));

const tokensOf = (text) => String(text || '').toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) || [];

/** Very light stemmer: enough to make "pipelines"/"pipeline" and "drawing"/"draw" meet, without any language data. */
function stem(word) {
  let w = word.replace(/'s$/, '');
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && /(?:[sxz]|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
  if (w.length > 3 && /(.)\1$/.test(w)) w = w.slice(0, -1);
  return w;
}
const terms = (text) => tokensOf(text).filter((t) => !STOP.has(t) && t.length > 1).map(stem);

const hashOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

class SearchIndex {
  constructor({ store, embedder = null }) {
    this.store = store;
    this.embedder = embedder;
    this.chunks = [];
    this.stamp = '';
    this.df = new Map();
    this.avgLen = 1;
    this.vectors = new Map(); // key -> Float32Array
    this.indexing = null;
    this.progress = { done: 0, total: 0 };
  }

  // ---------------------------------------------------------------- building

  _build() {
    const { notes, items, stamp } = this.store.searchSources();
    if (stamp === this.stamp) return;
    const chunks = [];
    for (const n of notes) {
      const text = [n.title, n.body, n.quote].filter(Boolean).join('. ');
      if (!text.trim()) continue;
      chunks.push({
        key: `n:${n.id}`, kind: 'note', id: n.id, itemId: n.itemId, blockIndex: n.blockIndex, title: n.title || '',
        source: n.sourceTitle, text, boost: `${n.title || ''} ${n.tags.join(' ')} ${n.tags.join(' ')}`, color: n.color, tags: n.tags,
      });
    }
    for (const item of items) {
      let buffer = '';
      let first = -1;
      const flush = () => {
        if (buffer.trim().length > 40) chunks.push({ key: `a:${item.id}:${first}`, kind: 'article', id: item.id, itemId: item.id, blockIndex: first, title: item.title, source: item.title, text: buffer.trim(), boost: item.title });
        buffer = ''; first = -1;
      };
      item.blocks.forEach((block, index) => {
        const text = String(block.text || '').trim();
        if (!text || block.type === 'title') return;
        if (first < 0) first = index;
        buffer += `${buffer ? ' ' : ''}${text}`;
        if (buffer.length >= 520 || block.type === 'h1' || block.type === 'h2' || block.type === 'h3') flush();
      });
      flush();
    }
    this.df = new Map();
    let total = 0;
    for (const chunk of chunks) {
      chunk.hash = hashOf(chunk.text);
      chunk.terms = terms(`${chunk.text} ${chunk.boost}`);
      chunk.tf = new Map();
      for (const t of chunk.terms) chunk.tf.set(t, (chunk.tf.get(t) || 0) + 1);
      for (const t of chunk.tf.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
      total += chunk.terms.length;
    }
    this.avgLen = chunks.length ? total / chunks.length : 1;
    this.chunks = chunks;
    this.stamp = stamp;
    // Re-use stored vectors whose text has not changed.
    const stored = this.store.getEmbeddings();
    this.vectors = new Map();
    for (const chunk of chunks) {
      const row = stored.get(chunk.key);
      if (row && row.hash === chunk.hash) this.vectors.set(chunk.key, row.vec);
    }
  }

  status() {
    this._build();
    return {
      chunks: this.chunks.length,
      embedded: this.vectors.size,
      indexing: Boolean(this.indexing),
      progress: this.progress,
      semantic: this.embedder?.available === true && this.vectors.size > 0,
      semanticError: this.embedder?.available === false ? this.embedder.lastError : '',
    };
  }

  /** Embed whatever is missing, in the background. Safe to call repeatedly. */
  ensureEmbeddings() {
    if (!this.embedder || this.indexing) return this.indexing;
    this._build();
    const missing = this.chunks.filter((c) => !this.vectors.has(c.key));
    if (!missing.length) return null;
    // Notes first (small and personal), then articles.
    missing.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'note' ? -1 : 1));
    this.progress = { done: 0, total: missing.length };
    this.indexing = (async () => {
      try {
        for (let i = 0; i < missing.length; i += 32) {
          const batch = missing.slice(i, i + 32);
          const vectors = await this.embedder.embed(batch.map((c) => c.text));
          const rows = batch.map((c, j) => ({ key: c.key, hash: c.hash, vec: Float32Array.from(vectors[j]) }));
          this.store.putEmbeddings(rows);
          for (const row of rows) this.vectors.set(row.key, row.vec);
          this.progress.done = Math.min(missing.length, i + batch.length);
        }
      } catch {
        // embedder.lastError carries the reason; keyword search keeps working.
      } finally {
        this.indexing = null;
      }
    })();
    return this.indexing;
  }

  // ---------------------------------------------------------------- searching

  _lexical(queryTerms, scope) {
    const N = this.chunks.length || 1;
    const k1 = 1.4;
    const b = 0.75;
    const scored = [];
    for (const chunk of this.chunks) {
      if (scope !== 'all' && chunk.kind !== scope) continue;
      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const tf = chunk.tf.get(term);
        if (!tf) continue;
        matched += 1;
        const df = this.df.get(term) || 1;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (chunk.terms.length / this.avgLen))));
      }
      if (!score) continue;
      score *= 0.6 + 0.4 * (matched / Math.max(1, queryTerms.length)); // reward passages that cover more of the question
      scored.push({ chunk, score });
    }
    return scored.sort((x, y) => y.score - x.score).slice(0, 60);
  }

  async _semantic(query, scope) {
    if (!this.embedder || !this.vectors.size) return { hits: [], used: false };
    let q;
    try {
      [q] = await this.embedder.embed([query]);
    } catch {
      return { hits: [], used: false };
    }
    const qv = Float32Array.from(q);
    const hits = [];
    for (const chunk of this.chunks) {
      if (scope !== 'all' && chunk.kind !== scope) continue;
      const v = this.vectors.get(chunk.key);
      if (!v) continue;
      const score = dot(qv, v);
      if (score >= 0.28) hits.push({ chunk, score });
    }
    return { hits: hits.sort((x, y) => y.score - x.score).slice(0, 60), used: true };
  }

  static _snippet(chunk, queryTerms) {
    const sentences = chunk.text.match(/[^.!?\n]+[.!?]*/g) || [chunk.text];
    let best = 0;
    let bestScore = -1;
    sentences.forEach((s, i) => {
      const set = new Set(terms(s));
      let score = 0;
      for (const t of queryTerms) if (set.has(t)) score += 1;
      if (score > bestScore) { bestScore = score; best = i; }
    });
    let snippet = sentences[best].trim();
    if (snippet.length < 90 && sentences[best + 1]) snippet += ` ${sentences[best + 1].trim()}`;
    return snippet.length > 260 ? `${snippet.slice(0, 257).replace(/\s+\S*$/, '')}…` : snippet;
  }

  async search(query, { limit = 20, scope = 'all' } = {}) {
    this._build();
    const q = String(query || '').trim();
    if (!q || !this.chunks.length) return { results: [], mode: 'keyword' };
    const queryTerms = [...new Set(terms(q))];
    const lexical = queryTerms.length ? this._lexical(queryTerms, scope) : [];
    const semantic = await this._semantic(q, scope);

    const fused = new Map();
    const add = (list, weight) => list.forEach(({ chunk }, rank) => {
      const entry = fused.get(chunk.key) || { chunk, score: 0 };
      entry.score += weight / (60 + rank);
      fused.set(chunk.key, entry);
    });
    add(lexical, 1);
    add(semantic.hits, semantic.used ? 1.2 : 0);

    const perItem = new Map();
    const results = [];
    for (const { chunk, score } of [...fused.values()].sort((x, y) => y.score - x.score)) {
      if (chunk.kind === 'article') {
        const n = perItem.get(chunk.itemId) || 0;
        if (n >= 2) continue;
        perItem.set(chunk.itemId, n + 1);
      }
      results.push({
        kind: chunk.kind, id: chunk.id, itemId: chunk.itemId, blockIndex: chunk.blockIndex, title: chunk.title,
        source: chunk.source, snippet: SearchIndex._snippet(chunk, queryTerms), tags: chunk.tags || [], color: chunk.color || null, score,
      });
      if (results.length >= limit) break;
    }
    return { results, mode: semantic.used ? 'hybrid' : 'keyword', terms: queryTerms };
  }
}

module.exports = { SearchIndex, terms, stem };
