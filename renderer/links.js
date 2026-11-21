// The link graph for [[wiki links]] and #tags: what a link points at, and what points back at a note.
//
// Links hold a KEY, not a name:  [[n-3f2a91bc04d1|Shown name]]  (note)  or  [[a-9c01e2aa71b0#14|Shown name]]  (reading, at
// paragraph 14). Renaming a note or a reading therefore never breaks a link: the key still finds it and the shown name
// is refreshed from the real title. Older links written as [[Title]] keep working by name, and are upgraded to keys.
import { extractWikiLinks, parseWikiTarget, upgradeWikiLinks } from './markdown.js';

const STANDALONE = 'standalone';
const norm = (s) => String(s || '').trim().toLowerCase();
const compact = (id) => String(id || '').replace(/-/g, '').toLowerCase();

const index = { notes: [], articles: [], tags: new Set() };

/** The key that stands for an item inside [[ ]]. */
export const keyFor = (type, id, blockIndex = null) =>
  `${type === 'article' ? 'a' : 'n'}-${compact(id).slice(0, 12)}${type === 'article' && Number.isInteger(blockIndex) && blockIndex > 0 ? `#${blockIndex}` : ''}`;

/** The text to insert between the brackets for a note, reading or tag. */
export const tokenFor = (item) => (item.type === 'tag' ? item.label : `${keyFor(item.type, item.id, item.blockIndex)}|${String(item.label).replace(/[\]|\n]/g, ' ').trim()}`);

export const linkIndex = {
  setNotes(notes) {
    index.notes = notes;
    index.tags = new Set(notes.flatMap((n) => n.tags));
  },
  setArticles(entries) { index.articles = entries.map((e) => ({ id: e.id, title: e.title || '' })); },

  /** What does [[target]] mean? A key finds its note or reading; otherwise a note title, then a reading's title, then a tag. */
  resolve(target) {
    const parsed = parseWikiTarget(target);
    if (parsed.key) {
      const pool = parsed.type === 'article' ? index.articles : index.notes;
      const hit = pool.find((x) => compact(x.id).startsWith(parsed.key));
      if (!hit) return null;
      return parsed.type === 'article'
        ? { type: 'article', id: hit.id, label: hit.title || 'Untitled reading', blockIndex: parsed.blockIndex }
        : { type: 'note', id: hit.id, label: hit.title || firstLine(hit.body) || 'Untitled note' };
    }
    const t = norm(parsed.name);
    if (!t) return null;
    const note = index.notes.find((n) => norm(n.title) === t);
    if (note) return { type: 'note', id: note.id, label: note.title };
    const article = index.articles.find((a) => norm(a.title) === t) || index.articles.find((a) => norm(a.title).includes(t) && t.length > 4);
    if (article) return { type: 'article', id: article.id, label: article.title };
    if (index.tags.has(t)) return { type: 'tag', id: t, label: `#${t}` };
    return null;
  },

  /** Notes whose text links to this note, by key (or by its title, for links written the old way). */
  backlinks(note) {
    const key = compact(note.id).slice(0, 12);
    const title = norm(note.title);
    return index.notes.filter((n) => n.id !== note.id && extractWikiLinks(n.body).some((target) => {
      const p = parseWikiTarget(target);
      return p.key ? p.type === 'note' && key.startsWith(p.key) : Boolean(title) && norm(p.name) === title;
    }));
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

  /** What to offer while typing [[…]]: notes first, then readings, then tags. Each carries the text to insert. */
  suggestions(query, limit = 8) {
    const q = norm(query);
    const hit = (s) => !q || norm(s).includes(q);
    const out = [];
    for (const n of index.notes) {
      const label = n.title || firstLine(n.body);
      if (label && hit(label)) out.push({ type: 'note', id: n.id, label });
    }
    for (const a of index.articles) if (a.title && hit(a.title)) out.push({ type: 'article', id: a.id, label: a.title });
    for (const t of index.tags) if (hit(t)) out.push({ type: 'tag', id: t, label: t });
    const seen = new Set();
    return out
      .filter((s) => (seen.has(`${s.type}:${s.id}`) ? false : seen.add(`${s.type}:${s.id}`)))
      .slice(0, limit)
      .map((s) => ({ ...s, token: tokenFor(s) }));
  },
  /** Rewrites name links in a piece of text into key links. */
  upgrade(text) {
    return upgradeWikiLinks(text, (target) => {
      const hit = linkIndex.resolve(target);
      return hit ? { ...hit, token: tokenFor(hit) } : null;
    });
  },
  /** The display name a link target currently has (for topic matching), or the target itself. */
  nameOf(target) { return linkIndex.resolve(target)?.label || parseWikiTarget(target).name || target; },
  STANDALONE,
};

function firstLine(text) { return String(text || '').split('\n').map((l) => l.replace(/^[#>\-*\s]+/, '').trim()).find(Boolean)?.slice(0, 80) || ''; }
