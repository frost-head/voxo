// Topic view: everything in your library that connects to a word, tag or [[link]], as a local graph plus a list.
// Opening it from a tag turns voxo from a reader into a small personal knowledge base.
import { $, api } from './common.js';
import { icon } from './icons.js';
import { extractWikiLinks } from './markdown.js';
import { linkIndex } from './links.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (name, attrs = {}) => {
  const node = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const clip = (text, n) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);
const heading = (n) => n.title || (n.body ? n.body.split('\n')[0].replace(/^[#>*\-\s]+/, '') : n.quote) || 'Untitled note';

export function initTopic({ openNote, openArticle }) {
  const dialog = $('#topic-dialog');
  const title = $('#topic-title');
  const graphBox = $('#topic-graph');
  const listBox = $('#topic-list');
  const relatedBox = $('#topic-related');
  const summary = $('#topic-summary');
  let token = 0;

  $('#topic-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  const norm = (s) => String(s).trim().toLowerCase();

  /** Notes that belong to a topic: tagged with it, titled it, or linking to it with [[…]] or #…. */
  function notesAbout(all, topic) {
    const t = norm(topic);
    const hashtag = new RegExp(`(^|[^\\p{L}\\p{N}&/#_-])#${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_-])`, 'iu');
    return all.filter((n) => n.tags.includes(t) || norm(n.title || '') === t
      || extractWikiLinks(n.body).some((l) => norm(linkIndex.nameOf(l)) === t) || hashtag.test(n.body || ''));
  }

  async function open(topic) {
    const mine = ++token;
    const name = String(topic || '').replace(/^#/, '').trim();
    if (!name) return;
    title.textContent = name;
    listBox.replaceChildren();
    relatedBox.replaceChildren();
    graphBox.replaceChildren();
    summary.textContent = 'Looking through your library…';
    if (!dialog.open) dialog.showModal();

    const [notesRes, found, history] = await Promise.all([
      api.listNotes({ limit: 2000 }),
      api.search(name, { scope: 'articles', limit: 8 }),
      api.listLibrary('history'),
    ]);
    if (mine !== token) return;
    const all = notesRes.ok ? notesRes.notes : [];
    const notes = notesAbout(all, name);
    const articles = [];
    const seen = new Set();
    const addArticle = (id, text, snippet, blockIndex) => { if (!seen.has(id)) { seen.add(id); articles.push({ id, title: text, snippet, blockIndex }); } };
    for (const e of (history.ok ? history.entries : [])) if (norm(e.title || '').includes(norm(name))) addArticle(e.id, e.title, '', null);
    for (const r of (found.ok ? found.results : [])) if (r.kind === 'article') addArticle(r.itemId, r.title, r.snippet, r.blockIndex);
    for (const n of notes) if (n.itemId !== 'standalone') addArticle(n.itemId, n.sourceTitle || 'Reading', '', null);

    // Related topics: tags that appear on the same notes.
    const co = new Map();
    for (const n of notes) for (const tag of n.tags) if (tag !== norm(name)) co.set(tag, (co.get(tag) || 0) + 1);
    for (const n of notes) for (const link of extractWikiLinks(n.body)) { const l = norm(linkIndex.nameOf(link)); if (l !== norm(name)) co.set(l, (co.get(l) || 0) + 1); }

    summary.textContent = notes.length || articles.length
      ? `${notes.length} note${notes.length === 1 ? '' : 's'} · ${articles.length} reading${articles.length === 1 ? '' : 's'}`
      : 'Nothing connects to this yet. Tag a note with it or link it with [[double brackets]] and it will appear here.';

    drawGraph(name, notes.slice(0, 9), articles.slice(0, 8));
    drawList(notes, articles);
    const related = [...co.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (related.length) {
      const label = document.createElement('p');
      label.className = 'eyebrow';
      label.textContent = 'RELATED TOPICS';
      const row = document.createElement('div');
      row.className = 'chip-row';
      for (const [tag, count] of related) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.textContent = `#${tag} · ${count}`;
        chip.addEventListener('click', () => open(tag));
        row.append(chip);
      }
      relatedBox.append(label, row);
    }
  }

  function drawGraph(name, notes, articles) {
    const nodes = [
      ...notes.map((n) => ({ kind: 'note', label: heading(n), run: () => { dialog.close(); openNote(n); } })),
      ...articles.map((a) => ({ kind: 'article', label: a.title, run: () => { dialog.close(); openArticle(a.id, a.blockIndex); } })),
    ];
    if (!nodes.length) { graphBox.hidden = true; return; }
    graphBox.hidden = false;
    const W = 560;
    const H = 300;
    const cx = W / 2;
    const cy = H / 2;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Graph of ${nodes.length} items connected to ${name}` });
    root.setAttribute('class', 'topic-svg');
    // Notes on the inner ring, readings on the outer ring, so the two kinds stay readable.
    const ring = (list, rx, ry, offset) => list.forEach((node, i) => {
      const angle = offset + (i / Math.max(1, list.length)) * Math.PI * 2;
      node.x = cx + Math.cos(angle) * rx;
      node.y = cy + Math.sin(angle) * ry;
    });
    ring(nodes.filter((n) => n.kind === 'note'), 120, 82, -Math.PI / 2);
    ring(nodes.filter((n) => n.kind === 'article'), 215, 125, -Math.PI / 2 + 0.35);
    for (const node of nodes) root.append(svg('line', { x1: cx, y1: cy, x2: node.x, y2: node.y, class: `topic-edge ${node.kind}` }));
    for (const node of nodes) {
      const g = svg('g', { class: `topic-node ${node.kind}`, tabindex: '0', role: 'button', 'aria-label': `Open ${node.label}` });
      g.append(svg('circle', { cx: node.x, cy: node.y, r: node.kind === 'note' ? 7 : 8 }));
      const text = svg('text', { x: node.x, y: node.y + (node.y < cy ? -13 : 20), 'text-anchor': 'middle' });
      text.textContent = clip(node.label, 22);
      const tip = svg('title');
      tip.textContent = node.label;
      g.append(tip, text);
      g.addEventListener('click', node.run);
      g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); node.run(); } });
      root.append(g);
    }
    const hub = svg('g', { class: 'topic-hub' });
    hub.append(svg('circle', { cx, cy, r: 26 }));
    const hubText = svg('text', { x: cx, y: cy + 4, 'text-anchor': 'middle' });
    hubText.textContent = clip(name, 10);
    hub.append(hubText);
    root.append(hub);
    graphBox.replaceChildren(root);
  }

  function drawList(notes, articles) {
    const section = (label, items) => {
      if (!items.length) return null;
      const wrap = document.createElement('div');
      wrap.className = 'topic-section';
      const h = document.createElement('p');
      h.className = 'eyebrow';
      h.textContent = `${label} (${items.length})`;
      const ul = document.createElement('ul');
      ul.className = 'topic-items';
      for (const item of items) ul.append(item);
      wrap.append(h, ul);
      return wrap;
    };
    const row = (iconName, label, sub, run) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'topic-item';
      const main = document.createElement('span');
      main.className = 'topic-item-main';
      main.textContent = label;
      b.append(icon(iconName), main);
      if (sub) { const s = document.createElement('span'); s.className = 'topic-item-sub'; s.textContent = sub; main.append(s); }
      b.addEventListener('click', run);
      li.append(b);
      return li;
    };
    const parts = [
      section('Notes', notes.map((n) => row(n.body ? 'pencil' : 'sparkle', heading(n), n.itemId === 'standalone' ? 'My note' : n.sourceTitle, () => { dialog.close(); openNote(n); }))),
      section('Readings', articles.map((a) => row('book', a.title, a.snippet, () => { dialog.close(); openArticle(a.id, a.blockIndex); }))),
    ].filter(Boolean);
    listBox.replaceChildren(...parts);
  }

  return { open };
}
