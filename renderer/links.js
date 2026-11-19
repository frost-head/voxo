// The link graph for [[wiki links]] and #tags: what a link points at, and what points back at a note.
import { extractWikiLinks } from './markdown.js';

const STANDALONE = 'standalone';
const norm = (s) => String(s || '').trim().toLowerCase();

const index = { notes: [], articles: [], tags: new Set() };

export const linkIndex = {
  setNotes(notes) {
    index.notes = notes;
    index.tags = new Set(notes.flatMap((n) => n.tags));
  },
  setArticles(entries) { index.articles = entries.map((e) => ({ id: e.id, title: e.title || '' })); },

  /** What does [[target]] mean? A note title wins, then a reading's title, then a tag. */
  resolve(target) {
    const t = norm(target);
    if (!t) return null;
    const note = index.notes.find((n) => norm(n.title) === t);
    if (note) return { type: 'note', id: note.id, label: note.title };
    const article = index.articles.find((a) => norm(a.title) === t) || index.articles.find((a) => norm(a.title).includes(t) && t.length > 4);
    if (article) return { type: 'article', id: article.id, label: article.title };
    if (index.tags.has(t)) return { type: 'tag', id: t, label: `#${t}` };
    return null;
  },

  /** Notes whose text contains [[title]] pointing at this note. */
  backlinks(note) {
    const names = [note.title].filter(Boolean).map(norm);
    if (!names.length) return [];
    return index.notes.filter((n) => n.id !== note.id && extractWikiLinks(n.body).some((l) => names.includes(norm(l))));
  },

  /** Notes that share tags with this one, most-shared first. */
  related(note, limit = 5) {
    const mine = new Set(note.tags);
    if (!mine.size) return [];
    return index.notes
      .filter((n) => n.id !== note.id && n.itemId !== undefined)
      .map((n) => ({ n, shared: n.tags.filter((t) => mine.has(t)).length }))
      .filter((x) => x.shared > 0)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, limit)
      .map((x) => x.n);
  },

  /** Titles to offer while typing [[…]]: notes first, then readings, then tags. */
  suggestions(query, limit = 8) {
    const q = norm(query);
    const hit = (s) => !q || norm(s).includes(q);
    const out = [];
    for (const n of index.notes) if (n.title && hit(n.title)) out.push({ type: 'note', label: n.title });
    for (const a of index.articles) if (a.title && hit(a.title)) out.push({ type: 'article', label: a.title });
    for (const t of index.tags) if (hit(t)) out.push({ type: 'tag', label: t });
    const seen = new Set();
    return out.filter((s) => (seen.has(norm(s.label)) ? false : seen.add(norm(s.label)))).slice(0, limit);
  },
  STANDALONE,
};
