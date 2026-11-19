// The Notes workspace: notebooks, tags, colors, search, a Markdown editor with safe autosave, and export.

import {
  api, $, buildSwatches, confirmTwice, formatRelativeDate, promptName, showError, store, toast, wordCount,
} from './common.js';
import { renderMarkdown, extractWikiLinks } from './markdown.js';
import { linkIndex } from './links.js';
import { icon } from './icons.js';

const STANDALONE = 'standalone';
// Library "kinds" are mutually exclusive (a note is either a highlight or one of your own). Everything else combines:
// notebooks (any of), tags (all of / any of), color, pinned and the search text all narrow the list together.
const KINDS = [
  { id: 'all', label: 'All notes' },
  { id: 'highlight', label: 'Highlights' },
  { id: 'note', label: 'My notes' },
];
const kindOf = (note) => (note.itemId === STANDALONE ? 'note' : (!note.body ? 'highlight' : 'annotated'));
const newFilters = (tagMode = 'all') => ({ kind: 'all', notebooks: new Set(), unfiled: false, sources: new Set(), tags: new Set(), tagMode, color: '', pinned: false });

// ---- search language: plain words plus  field:value  (quote values with spaces: title:"deep dive").  A leading - negates.
const FIELD_ALIASES = {
  title: 'title', t: 'title', source: 'source', article: 'source', from: 'source', nb: 'nb', notebook: 'nb', book: 'nb',
  tag: 'tag', body: 'body', text: 'body', quote: 'quote', highlight: 'quote', color: 'color', colour: 'color', is: 'is',
};
const OPERATOR_HINTS = [
  { op: 'title:', desc: 'note or article title' }, { op: 'source:', desc: 'article it came from' }, { op: 'nb:', desc: 'notebook' },
  { op: 'tag:', desc: 'tag' }, { op: 'body:', desc: 'your note text' }, { op: 'quote:', desc: 'highlighted text' },
  { op: 'color:', desc: 'yellow, blue…' }, { op: 'is:', desc: 'pinned, highlight, note, unfiled' },
];
const TOKEN = /(-?)(?:#([\w-]+)|([A-Za-z]+):"([^"]*)"|([A-Za-z]+):(\S*)|"([^"]+)"|(\S+))/g;

/** "title:vulkan nb:research -tag:todo glsl" → [{field,value,neg}], free words use field 'any'. */
export function parseQuery(text) {
  const terms = [];
  for (const m of String(text || '').matchAll(TOKEN)) {
    const neg = m[1] === '-';
    let field = 'any';
    let value;
    if (m[2] !== undefined) { field = 'tag'; value = m[2]; }
    else if (m[3] !== undefined || m[5] !== undefined) {
      const name = (m[3] ?? m[5]).toLowerCase();
      const v = m[3] !== undefined ? m[4] : m[6];
      if (FIELD_ALIASES[name]) { field = FIELD_ALIASES[name]; value = v; }
      else value = `${m[3] ?? m[5]}:${v}`;
    } else value = m[7] ?? m[8];
    value = String(value || '').toLowerCase();
    if (value) terms.push({ field, value, neg, raw: m[0] });
  }
  return terms;
}

/** Markdown to plain text, for list titles and previews. */
export const plain = (text) => String(text || '')
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/(\*\*|__|\*|_|`)/g, '')
  .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '')
  .replace(/^[#>\-*+\s]+/gm, '');
const firstLine = (text) => plain(text).split('\n').map((l) => l.trim()).find(Boolean) || '';
export const noteHeading = (note) => note.title || firstLine(note.body) || firstLine(note.quote).slice(0, 80) || 'Untitled note';

export function initNotesWorkspace({ openSource, openTopic = () => {}, openArticle = () => {} }) {
  const el = {
    smartList: $('#nw-smart-list'), notebookList: $('#nw-notebook-list'), tagList: $('#nw-tag-list'),
    newNotebook: $('#nw-new-notebook'), listTitle: $('#nw-list-title'), exportList: $('#nw-export'), newNote: $('#ws-new-note'),
    search: $('#ws-search-input'), colorFilter: $('#nw-color-filter'), list: $('#ws-notes-list'), empty: $('#ws-notes-empty'),
    editorEmpty: $('#nw-editor-empty'), editorBody: $('#nw-editor-body'), source: $('#ws-editor-source'), saveState: $('#ws-save-state'),
    openSource: $('#ws-open-source'), pin: $('#ws-pin'), exportOne: $('#ws-export-one'), del: $('#ws-delete'),
    title: $('#ws-note-title'), colors: $('#ws-colors'), notebookSelect: $('#ws-notebook-select'),
    tagChips: $('#ws-tag-chips'), tagInput: $('#ws-tag-input'), tagSuggestions: $('#ws-tag-suggestions'),
    quote: $('#ws-quote'), tabWrite: $('#ws-tab-write'), tabPreview: $('#ws-tab-preview'), wordCount: $('#ws-word-count'),
    body: $('#ws-note-body'), preview: $('#ws-preview'),
    smart: $('#nw-smart'), smartNote: $('#nw-smart-note'), group: $('#nw-group'), links: $('#ws-links'), wlSuggest: $('#ws-wl-suggest'),
    sourceList: $('#nw-source-list'), suggest: $('#nw-suggest'), tagMode: $('#nw-tag-mode'), selectToggle: $('#nw-select-toggle'), activeFilters: $('#nw-active-filters'), bulk: $('#nw-bulk'),
  };

  const st = {
    f: newFilters(),
    all: [],        // every note
    pool: [],       // notes matching the search text
    srcOpen: false,
    group: store.get('notes.group', 'none'),
    collapsed: new Set(),
    smart: store.get('notes.smart', false),
    rank: null,       // Map(noteId -> rank) while "search by meaning" is on
    hits: [],         // reading passages that answer the search
    order: [],        // ids in the order the list shows them
    smartMode: '',
    smartToken: 0,
    filledId: null,
    notes: [],      // pool narrowed by all active filters (what the list shows)
    notebooks: [],
    tags: [],
    activeId: null,
    selecting: false,
    sel: new Set(),
    anchor: null,
    bulkPanel: null,
  };

  const active = () => st.notes.find((n) => n.id === st.activeId) || null;

  // ------------------------------------------------------------ filters

  const anyFilter = (f = st.f) => f.kind !== 'all' || f.notebooks.size || f.unfiled || f.sources.size || f.tags.size || f.color || f.pinned;

  /** Does a note pass every active facet? `skip` leaves one facet out, so a nav row can show "how many you'd get". */
  function matches(note, f = st.f, skip = '') {
    if (skip !== 'kind' && f.kind !== 'all' && kindOf(note) !== f.kind) return false;
    if (skip !== 'nb' && (f.notebooks.size || f.unfiled)) {
      const hit = (f.unfiled && !note.notebookId) || (note.notebookId && f.notebooks.has(note.notebookId));
      if (!hit) return false;
    }
    if (skip !== 'tag' && f.tags.size) {
      const has = (t) => note.tags.includes(t);
      if (!(f.tagMode === 'any' ? [...f.tags].some(has) : [...f.tags].every(has))) return false;
    }
    if (skip !== 'src' && f.sources.size && !f.sources.has(note.itemId)) return false;
    if (skip !== 'color' && f.color && note.color !== f.color) return false;
    if (skip !== 'pinned' && f.pinned && !note.pinned) return false;
    return true;
  }
  const nbName = (note) => st.notebooks.find((n) => n.id === note.notebookId)?.name || '';
  const sourceName = (note) => (note.itemId === STANDALONE ? 'My note' : note.sourceTitle || '');

  function termMatches(note, { field, value }) {
    const has = (text) => String(text || '').toLowerCase().includes(value);
    switch (field) {
      case 'title': return has(noteHeading(note)) || has(sourceName(note));
      case 'source': return has(sourceName(note));
      case 'nb': return value === 'none' || value === 'unfiled' ? !note.notebookId : has(nbName(note));
      case 'tag': return note.tags.some((t) => t.includes(value));
      case 'body': return has(note.body);
      case 'quote': return has(note.quote);
      case 'color': return (note.color || 'none') === value;
      case 'is':
        if (value === 'pinned') return Boolean(note.pinned);
        if (value === 'unfiled') return !note.notebookId;
        if (value === 'note' || value === 'mine') return note.itemId === STANDALONE;
        if (value === 'highlight') return kindOf(note) === 'highlight';
        if (value === 'annotated') return kindOf(note) === 'annotated';
        return false;
      default:
        return has(noteHeading(note)) || has(note.body) || has(note.quote) || has(sourceName(note)) || has(nbName(note)) || note.tags.some((t) => t.includes(value));
    }
  }
  const queryMatch = (note, terms) => terms.every((term) => termMatches(note, term) !== term.neg);

  const countWhere = (skip, test) => st.pool.filter((n) => matches(n, st.f, skip) && test(n)).length;

  function navLabel() {
    if (!anyFilter()) return 'All notes';
    const parts = [];
    if (st.f.kind !== 'all') parts.push(KINDS.find((k) => k.id === st.f.kind).label);
    const books = [...st.f.notebooks].map((id) => st.notebooks.find((n) => n.id === id)?.name).filter(Boolean);
    if (st.f.unfiled) books.unshift('Unfiled');
    if (books.length) parts.push(books.join(' + '));
    if (st.f.sources.size) parts.push([...st.f.sources].map((id) => st.all.find((n) => n.itemId === id)?.sourceTitle || 'Article').join(' + '));
    if (st.f.tags.size) parts.push([...st.f.tags].map((t) => `#${t}`).join(st.f.tagMode === 'any' ? ' or ' : ' + '));
    if (st.f.pinned) parts.push('Pinned');
    return parts.length === 1 ? parts[0] : 'Filtered notes';
  }

  function toggleIn(set, value) { if (set.has(value)) set.delete(value); else set.add(value); }

  async function changeFilters(mutate) {
    await flush();
    await discardIfBlank(st.activeId);
    mutate(st.f);
    st.activeId = null;
    refresh();
  }
  const clearFilters = () => changeFilters((f) => Object.assign(f, newFilters(f.tagMode)));

  // ------------------------------------------------------------ saving (never loses an edit)

  let pending = null; // { id, patch }
  let saveTimer = null;

  function setSaveState(text) { el.saveState.textContent = text; }

  async function flush() {
    clearTimeout(saveTimer);
    if (!pending) return;
    const { id, patch } = pending;
    pending = null;
    setSaveState('Saving…');
    const res = await api.updateNote(id, patch);
    if (!res.ok) { showError(res.error); setSaveState('Not saved'); return; }
    const index = st.notes.findIndex((n) => n.id === id);
    if (index >= 0) st.notes[index] = { ...st.notes[index], ...res.note };
    if (id === st.activeId) setSaveState('Saved');
    const inAll = st.all.findIndex((n) => n.id === id);
    if (inAll >= 0) st.all[inAll] = { ...st.all[inAll], ...res.note };
    linkIndex.setNotes(st.all);
    renderList();
    if (id === st.activeId) renderLinks();
  }

  function queueSave(patch) {
    if (!st.activeId) return;
    pending = { id: st.activeId, patch: { ...(pending && pending.id === st.activeId ? pending.patch : {}), ...patch } };
    setSaveState('Editing…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 600);
  }

  /** Standalone notes the user never typed into should not pile up. */
  async function discardIfBlank(id) {
    const note = st.notes.find((n) => n.id === id);
    if (note && note.itemId === STANDALONE && !note.title && !note.body && !note.tags.length) {
      await api.deleteNote(id);
      st.notes = st.notes.filter((n) => n.id !== id);
    }
  }

  // ------------------------------------------------------------ navigation column

  function navButton(label, count, isActive, onClick, extra) {
    const li = document.createElement('li');
    li.className = 'nw-nav-item';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `nw-nav-btn${isActive ? ' is-active' : ''}${count === 0 ? ' is-zero' : ''}`;
    button.setAttribute('aria-pressed', String(Boolean(isActive)));
    const name = document.createElement('span');
    name.className = 'nw-nav-name';
    name.textContent = label;
    const badge = document.createElement('span');
    badge.className = 'nw-nav-count';
    badge.textContent = String(count);
    button.append(name, badge);
    button.addEventListener('click', onClick);
    li.append(button);
    if (extra) li.append(extra);
    return li;
  }

  function renderNav() {
    const kindCount = (id) => countWhere('kind', (n) => id === 'all' || kindOf(n) === id);
    const rows = KINDS.map((k) => navButton(
      k.label, kindCount(k.id), st.f.kind === k.id,
      () => changeFilters((f) => { f.kind = k.id; }),
    ));
    rows.push(navButton('Pinned', countWhere('pinned', (n) => n.pinned), st.f.pinned, () => changeFilters((f) => { f.pinned = !f.pinned; })));
    el.smartList.replaceChildren(...rows);

    el.notebookList.replaceChildren(...st.notebooks.map((nb) => {
      const actions = document.createElement('span');
      actions.className = 'nw-nav-actions';
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.title = 'Rename notebook';
      rename.setAttribute('aria-label', `Rename ${nb.name}`);
      rename.append(icon('pencil'));
      rename.addEventListener('click', async (event) => {
        event.stopPropagation();
        const name = await promptName('Rename notebook', nb.name);
        if (!name) return;
        const res = await api.renameNotebook(nb.id, name);
        if (!res.ok) return showError(res.error);
        refresh();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.title = 'Delete notebook (notes are kept)';
      remove.setAttribute('aria-label', `Delete ${nb.name}`);
      remove.append(icon('trash'));
      confirmTwice(remove, async () => {
        const res = await api.deleteNotebook(nb.id);
        if (!res.ok) return showError(res.error);
        st.f.notebooks.delete(nb.id);
        toast(`Deleted notebook “${nb.name}”. Its notes were kept.`);
        refresh();
      }, { armedLabel: '' });
      actions.append(rename, remove);
      return navButton(nb.name, countWhere('nb', (n) => n.notebookId === nb.id), st.f.notebooks.has(nb.id),
        () => changeFilters((f) => toggleIn(f.notebooks, nb.id)), actions);
    }));
    el.notebookList.prepend(navButton('Unfiled', countWhere('nb', (n) => !n.notebookId), st.f.unfiled,
      () => changeFilters((f) => { f.unfiled = !f.unfiled; })));
    if (!st.notebooks.length) {
      const hint = document.createElement('li');
      hint.className = 'nw-nav-hint';
      hint.textContent = 'Group notes into notebooks with +';
      el.notebookList.append(hint);
    }

    const bySource = new Map();
    for (const n of st.pool) if (n.itemId !== STANDALONE) bySource.set(n.itemId, n.sourceTitle || 'Untitled article');
    for (const id of st.f.sources) if (!bySource.has(id)) bySource.set(id, st.all.find((n) => n.itemId === id)?.sourceTitle || 'Article');
    const sources = [...bySource].map(([id, title]) => ({ id, title, count: countWhere('src', (n) => n.itemId === id) }))
      .sort((a, b) => (st.f.sources.has(b.id) - st.f.sources.has(a.id)) || b.count - a.count || a.title.localeCompare(b.title));
    const shown = st.srcOpen ? sources : sources.slice(0, 5);
    const sourceRows = shown.map((src) => navButton(src.title, src.count, st.f.sources.has(src.id), () => changeFilters((f) => toggleIn(f.sources, src.id))));
    if (sources.length > 5) {
      const more = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'nw-more';
      button.textContent = st.srcOpen ? 'Show fewer' : `Show ${sources.length - 5} more`;
      button.addEventListener('click', () => { st.srcOpen = !st.srcOpen; renderNav(); });
      more.append(button);
      sourceRows.push(more);
    }
    if (!sources.length) {
      const hint = document.createElement('li');
      hint.className = 'nw-nav-hint';
      hint.textContent = 'Highlights are grouped by article.';
      sourceRows.push(hint);
    }
    el.sourceList.replaceChildren(...sourceRows);

    el.tagMode.hidden = st.f.tags.size < 2;
    for (const button of el.tagMode.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === st.f.tagMode));

    el.tagList.replaceChildren(...st.tags.map((tag) => {
      const on = st.f.tags.has(tag.name);
      const n = countWhere('tag', (note) => note.tags.includes(tag.name));
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `tag-chip${on ? ' is-active' : ''}${n === 0 ? ' is-zero' : ''}`;
      chip.setAttribute('aria-pressed', String(on));
      chip.textContent = `#${tag.name}`;
      chip.title = `${n} matching note${n === 1 ? '' : 's'} · ${tag.count} in total`;
      chip.addEventListener('click', () => changeFilters((f) => toggleIn(f.tags, tag.name)));
      return chip;
    }));
    if (!st.tags.length) {
      const hint = document.createElement('p');
      hint.className = 'nw-nav-hint';
      hint.textContent = 'Tags you add show up here.';
      el.tagList.append(hint);
    }

    el.tagSuggestions.replaceChildren(...st.tags.map((t) => Object.assign(document.createElement('option'), { value: t.name })));
  }

  // ------------------------------------------------------------ note list

  function renderList() {
    el.listTitle.textContent = navLabel();
    el.empty.hidden = st.notes.length > 0;
    el.list.classList.toggle('is-selecting', st.selecting || st.sel.size > 0);
    el.selectToggle.setAttribute('aria-pressed', String(st.selecting || st.sel.size > 0));
    const cardFor = (note) => {
      const picked = st.sel.has(note.id);
      const li = document.createElement('li');
      li.className = `ws-note-card${note.id === st.activeId ? ' is-active' : ''}${picked ? ' is-selected' : ''}`;
      li.dataset.id = note.id;
      if (note.color) li.dataset.color = note.color;

      const check = document.createElement('button');
      check.type = 'button';
      check.className = 'ws-check';
      check.setAttribute('role', 'checkbox');
      check.setAttribute('aria-checked', String(picked));
      check.setAttribute('aria-label', `Select “${noteHeading(note)}”`);
      check.append(icon('check'));
      li.append(check);

      const top = document.createElement('div');
      top.className = 'ws-note-top';
      const title = document.createElement('div');
      title.className = 'ws-note-title';
      if (note.pinned) { const pin = icon('pin'); pin.style.cssText = 'width:.75rem;height:.75rem;margin-right:.3rem;vertical-align:-1px;color:var(--accent)'; title.append(pin); }
      title.append(noteHeading(note));
      const time = document.createElement('div');
      time.className = 'ws-note-time';
      time.textContent = formatRelativeDate(note.updatedAt);
      top.append(title, time);
      li.append(top);

      const previewText = note.body ? plain(note.body).replace(/\s+/g, ' ').trim() : note.quote;
      if (previewText) {
        const preview = document.createElement('div');
        preview.className = `ws-note-preview${note.body ? '' : ' is-quote'}`;
        preview.textContent = previewText;
        li.append(preview);
      }

      const meta = document.createElement('div');
      meta.className = 'ws-note-meta';
      const bits = [note.itemId === STANDALONE ? 'My note' : note.sourceTitle, ...note.tags.slice(0, 3).map((t) => `#${t}`)].filter(Boolean);
      meta.textContent = bits.join(' · ');
      li.append(meta);
      return li;
    };

    const nodes = [];
    st.order = [];
    const groupOf = (note) => {
      if (st.group === 'source') return note.itemId === STANDALONE ? { key: 's:mine', label: 'My notes', icon: 'pencil' } : { key: `s:${note.itemId}`, label: note.sourceTitle || 'Untitled article', icon: 'file' };
      if (st.group === 'notebook') return note.notebookId ? { key: `b:${note.notebookId}`, label: nbName(note) || 'Notebook', icon: 'book' } : { key: 'b:none', label: 'Unfiled', icon: 'inbox' };
      return null;
    };
    if (st.group === 'none') {
      for (const note of st.notes) { nodes.push(cardFor(note)); st.order.push(note.id); }
    } else {
      const groups = new Map();
      for (const note of st.notes) {
        const g = groupOf(note);
        if (!groups.has(g.key)) groups.set(g.key, { ...g, notes: [] });
        groups.get(g.key).notes.push(note);
      }
      for (const g of groups.values()) {
        const closed = st.collapsed.has(g.key);
        const head = document.createElement('li');
        head.className = `ws-group${closed ? ' is-closed' : ''}`;
        head.dataset.group = g.key;
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ws-group-toggle';
        toggle.setAttribute('aria-expanded', String(!closed));
        const chevron = icon('chevron');
        chevron.classList.add('ws-group-chevron');
        const name = document.createElement('span');
        name.className = 'ws-group-name';
        name.append(icon(g.icon), g.label);
        const count = document.createElement('span');
        count.className = 'ws-group-count';
        count.textContent = String(g.notes.length);
        toggle.append(chevron, name, count);
        toggle.addEventListener('click', () => { if (closed) st.collapsed.delete(g.key); else st.collapsed.add(g.key); renderList(); });
        const all = document.createElement('button');
        all.type = 'button';
        all.className = 'ws-group-select';
        all.textContent = g.notes.every((n) => st.sel.has(n.id)) ? 'Deselect' : 'Select all';
        all.title = `Select every note in “${g.label}”`;
        all.addEventListener('click', () => {
          const next = new Set(st.sel);
          const every = g.notes.every((n) => next.has(n.id));
          for (const n of g.notes) { if (every) next.delete(n.id); else next.add(n.id); }
          st.selecting = true;
          setSelection(next, { keepPanel: true });
        });
        head.append(toggle, all);
        nodes.push(head);
        if (!closed) for (const note of g.notes) { nodes.push(cardFor(note)); st.order.push(note.id); }
      }
    }

    if (st.hits.length) {
      const head = document.createElement('li');
      head.className = 'ws-group ws-hits-head';
      head.textContent = 'From your readings';
      nodes.push(head);
      for (const hit of st.hits) {
        const li = document.createElement('li');
        li.className = 'ws-hit';
        const b = document.createElement('button');
        b.type = 'button';
        const t = document.createElement('span'); t.className = 'ws-hit-title'; t.append(icon('book'), hit.title);
        const p = document.createElement('span'); p.className = 'ws-hit-snippet'; p.textContent = hit.snippet;
        b.append(t, p);
        b.addEventListener('click', () => openArticle(hit.itemId, hit.blockIndex));
        li.append(b);
        nodes.push(li);
      }
    }
    el.list.replaceChildren(...nodes);
    el.group.value = st.group;
    el.smart.setAttribute('aria-pressed', String(st.smart));
    renderActiveFilters();
    renderBulk();
  }

  // ------------------------------------------------------------ active filter chips

  function renderActiveFilters() {
    const chips = [];
    const add = (label, remove) => chips.push({ label, remove });
    if (st.f.kind !== 'all') add(KINDS.find((k) => k.id === st.f.kind).label, (f) => { f.kind = 'all'; });
    if (st.f.unfiled) add('Unfiled', (f) => { f.unfiled = false; });
    for (const id of st.f.notebooks) add(st.notebooks.find((n) => n.id === id)?.name || 'Notebook', (f) => f.notebooks.delete(id));
    for (const id of st.f.sources) add(`📄 ${st.all.find((n) => n.itemId === id)?.sourceTitle || 'Article'}`, (f) => f.sources.delete(id));
    for (const tag of st.f.tags) add(`#${tag}`, (f) => f.tags.delete(tag));
    if (st.f.color) add(`${st.f.color} notes`, (f) => { f.color = ''; });
    if (st.f.pinned) add('Pinned', (f) => { f.pinned = false; });
    const terms = parseQuery(el.search.value);
    for (const term of terms) {
      add(`${term.neg ? 'not ' : ''}${term.field === 'any' ? '' : `${term.field}: `}${term.value}`, () => {
        el.search.value = el.search.value.replace(term.raw, '').replace(/\s{2,}/g, ' ').trim();
      });
    }

    if (!chips.length) {
      const hint = document.createElement('span');
      hint.className = 'nw-filter-hint';
      hint.textContent = 'No filters — pick from the left, or type  title:  nb:  tag:  source:  in search.';
      el.activeFilters.replaceChildren(hint);
      return;
    }
    const nodes = chips.map(({ label, remove }) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip';
      chip.append(label);
      const x = document.createElement('button');
      x.type = 'button';
      x.setAttribute('aria-label', `Remove filter ${label}`);
      x.append(icon('x'));
      x.addEventListener('click', () => changeFilters(remove));
      chip.append(x);
      return chip;
    });
    const count = document.createElement('span');
    count.className = 'nw-result-count';
    count.textContent = `${st.notes.length} of ${st.pool.length}`;
    nodes.push(count);
    if (chips.length > 1) {
      const clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'nw-clear-filters';
      clear.textContent = 'Clear all';
      clear.addEventListener('click', () => { el.search.value = ''; clearFilters(); });
      nodes.splice(nodes.length - 1, 0, clear);
    }
    el.activeFilters.replaceChildren(...nodes);
  }

  // ------------------------------------------------------------ selection + bulk actions

  function setSelection(ids, { keepPanel = false } = {}) {
    st.sel = new Set(ids);
    if (!keepPanel) st.bulkPanel = null;
    renderList();
  }

  function handleSelectClick(id, event) {
    if (event.shiftKey && st.anchor && st.notes.some((n) => n.id === st.anchor)) {
      const ids = st.order.length ? st.order : st.notes.map((n) => n.id);
      const [a, b] = [ids.indexOf(st.anchor), ids.indexOf(id)].sort((x, y) => x - y);
      const next = new Set(st.sel);
      for (const rangeId of ids.slice(a, b + 1)) next.add(rangeId);
      setSelection(next, { keepPanel: true });
    } else {
      const next = new Set(st.sel);
      toggleIn(next, id);
      st.anchor = id;
      setSelection(next, { keepPanel: true });
    }
  }

  el.list.addEventListener('click', (event) => {
    const card = event.target.closest('.ws-note-card');
    if (!card) return;
    const id = card.dataset.id;
    if (event.target.closest('.ws-check') || event.ctrlKey || event.metaKey || event.shiftKey || st.selecting) {
      handleSelectClick(id, event);
      return;
    }
    if (st.sel.size) { setSelection([]); }
    select(id);
  });

  el.selectToggle.addEventListener('click', () => {
    st.selecting = !(st.selecting || st.sel.size > 0);
    if (!st.selecting) st.sel = new Set();
    st.bulkPanel = null;
    renderList();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !el.list.offsetParent) return;
    if (st.sel.size || st.selecting) { st.selecting = false; setSelection([]); }
  });

  const selectedNotes = () => st.notes.filter((n) => st.sel.has(n.id));

  async function bulkUpdate(patchFor, message) {
    await flush();
    const targets = selectedNotes();
    const results = await Promise.all(targets.map((note) => {
      const patch = patchFor(note);
      return patch ? api.updateNote(note.id, patch) : Promise.resolve({ ok: true, skipped: true });
    }));
    const failed = results.find((r) => !r.ok);
    if (failed) showError(failed.error);
    const changed = results.filter((r) => r.ok && !r.skipped).length;
    await refresh();
    if (!failed) toast(changed ? message(changed) : 'Nothing needed changing.');
  }

  const plural = (n) => `${n} note${n === 1 ? '' : 's'}`;

  function bulkButton(label, iconName, onClick, extra = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn ${extra.cls || 'btn-secondary'} btn-xs`;
    if (iconName) b.append(icon(iconName));
    b.append(label);
    if (extra.panel) b.setAttribute('aria-expanded', String(st.bulkPanel === extra.panel));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  function renderBulk() {
    const picked = selectedNotes();
    const show = st.sel.size > 0;
    el.bulk.hidden = !show;
    if (!show) { el.bulk.replaceChildren(); return; }

    const count = document.createElement('span');
    count.className = 'nw-bulk-count';
    count.textContent = `${picked.length} selected`;

    const allSelected = picked.length === st.notes.length;
    const togglePanel = (name) => () => { st.bulkPanel = st.bulkPanel === name ? null : name; renderBulk(); };
    const allPinned = picked.length > 0 && picked.every((n) => n.pinned);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-secondary btn-xs danger';
    del.textContent = 'Delete';
    confirmTwice(del, async () => {
      const targets = selectedNotes();
      await flush();
      const results = await Promise.all(targets.map((n) => api.deleteNote(n.id)));
      const failed = results.find((r) => !r.ok);
      if (failed) showError(failed.error);
      st.sel = new Set();
      st.selecting = false;
      st.activeId = null;
      await refresh();
      toast(`Deleted ${plural(targets.length)}.`, {
        duration: 8000,
        action: {
          label: 'Undo',
          onClick: async () => {
            for (const note of targets) {
              const restored = await api.addNote({
                itemId: note.itemId, blockIndex: note.blockIndex, startOffset: note.startOffset, endOffset: note.endOffset,
                quote: note.quote, body: note.body, title: note.title, color: note.color, notebookId: note.notebookId, tags: note.tags,
              });
              if (restored.ok && note.pinned) await api.updateNote(restored.note.id, { pinned: true });
              if (!restored.ok) { showError(restored.error); break; }
            }
            refresh();
          },
        },
      });
    }, { armedLabel: `Delete ${picked.length}?` });

    const row = document.createElement('div');
    row.className = 'nw-bulk-row';
    row.append(
      count,
      bulkButton(allSelected ? 'None' : `All ${st.notes.length}`, null, () => setSelection(allSelected ? [] : st.notes.map((n) => n.id), { keepPanel: true })),
      bulkButton('Tag', 'bookmark', togglePanel('tags'), { panel: 'tags' }),
      bulkButton('Notebook', 'book', togglePanel('notebook'), { panel: 'notebook' }),
      bulkButton('Color', null, togglePanel('color'), { panel: 'color' }),
      bulkButton(allPinned ? 'Unpin' : 'Pin', 'pin', () => bulkUpdate(
        (n) => (n.pinned === !allPinned ? null : { pinned: !allPinned }),
        (c) => `${allPinned ? 'Unpinned' : 'Pinned'} ${plural(c)}.`,
      )),
      bulkButton('Export', 'download', async () => { await flush(); const res = await api.exportNotes({ ids: picked.map((n) => n.id) }); if (!res.ok) showError(res.error); else if (!res.cancelled) toast(`Exported ${plural(picked.length)}.`); }),
      del,
    );
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn small';
    close.title = 'Clear selection (Esc)';
    close.setAttribute('aria-label', 'Clear selection');
    close.append(icon('x'));
    close.addEventListener('click', () => { st.selecting = false; setSelection([]); });
    row.append(close);

    const nodes = [row];
    if (st.bulkPanel) nodes.push(buildBulkPanel(picked));
    el.bulk.replaceChildren(...nodes);
  }

  function buildBulkPanel(picked) {
    const panel = document.createElement('div');
    panel.className = 'nw-bulk-panel';

    if (st.bulkPanel === 'tags') {
      const row = document.createElement('div');
      row.className = 'row';
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Tag(s) to add — comma separated';
      input.setAttribute('list', 'ws-tag-suggestions');
      input.maxLength = 80;
      input.setAttribute('aria-label', 'Tags to add to the selected notes');
      const apply = bulkButton(`Add to ${picked.length}`, 'plus', null, { cls: 'btn-primary' });
      const run = () => {
        const tags = input.value.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
        if (!tags.length) return;
        bulkUpdate(
          (n) => { const next = [...new Set([...n.tags, ...tags])].slice(0, 12); return next.length === n.tags.length ? null : { tags: next }; },
          (c) => `Tagged ${plural(c)} ${tags.map((t) => `#${t}`).join(' ')}.`,
        );
      };
      apply.addEventListener('click', run);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); run(); } });
      row.append(input, apply);
      panel.append(row);

      const counts = new Map();
      for (const n of picked) for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
      if (counts.size) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = 'On these notes — click × to remove from all of them:';
        const cloud = document.createElement('div');
        cloud.className = 'row';
        for (const [tag, n] of [...counts].sort((a, b) => b[1] - a[1])) {
          const chip = document.createElement('span');
          chip.className = 'tag-chip is-removable';
          chip.append(`#${tag}${n < picked.length ? ` · ${n}` : ''}`);
          const x = document.createElement('button');
          x.type = 'button';
          x.setAttribute('aria-label', `Remove tag ${tag} from selected notes`);
          x.append(icon('x'));
          x.addEventListener('click', () => bulkUpdate(
            (note) => (note.tags.includes(tag) ? { tags: note.tags.filter((t) => t !== tag) } : null),
            (c) => `Removed #${tag} from ${plural(c)}.`,
          ));
          chip.append(x);
          cloud.append(chip);
        }
        panel.append(hint, cloud);
      }
      queueMicrotask(() => input.focus());
    } else if (st.bulkPanel === 'notebook') {
      const select = document.createElement('select');
      select.className = 'select';
      select.setAttribute('aria-label', 'Move the selected notes to a notebook');
      select.append(new Option('Move to…', '__'), new Option('No notebook (unfile)', ''), ...st.notebooks.map((nb) => new Option(nb.name, nb.id)));
      select.addEventListener('change', () => {
        const target = select.value === '' ? null : select.value;
        if (select.value === '__') return;
        const name = target ? st.notebooks.find((nb) => nb.id === target)?.name : 'no notebook';
        bulkUpdate((n) => ((n.notebookId || null) === target ? null : { notebookId: target }), (c) => `Moved ${plural(c)} to ${name}.`);
      });
      const row = document.createElement('div');
      row.className = 'row';
      row.append(select);
      panel.append(row);
    } else if (st.bulkPanel === 'color') {
      const swatches = document.createElement('div');
      swatches.className = 'swatches';
      swatches.setAttribute('role', 'radiogroup');
      swatches.setAttribute('aria-label', 'Color for the selected notes');
      buildSwatches(swatches, {
        allowNone: true,
        onPick: (color) => bulkUpdate((n) => ((n.color || null) === (color || null) ? null : { color: color || null }), (c) => `Recolored ${plural(c)}.`),
      });
      panel.append(swatches);
    }
    return panel;
  }

  // ------------------------------------------------------------ editor

  const composerColors = buildSwatches(el.colors, {
    allowNone: true,
    onPick: (color) => { queueSave({ color }); const n = active(); if (n) n.color = color; renderList(); },
  });

  function renderTagChips(tags) {
    el.tagChips.replaceChildren(...tags.map((tag) => {
      const chip = document.createElement('span');
      chip.className = 'tag-chip is-editable';
      const label = document.createElement('button');
      label.type = 'button';
      label.className = 'tag-chip-label';
      label.textContent = `#${tag}`;
      label.title = `Explore everything about #${tag}`;
      label.addEventListener('click', () => openTopic(tag));
      chip.append(label);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.append(icon('x'));
      remove.setAttribute('aria-label', `Remove tag ${tag}`);
      remove.addEventListener('click', () => changeTags(tags.filter((t) => t !== tag)));
      chip.append(remove);
      return chip;
    }));
  }

  function changeTags(tags) {
    const note = active();
    if (!note) return;
    note.tags = tags;
    renderTagChips(tags);
    queueSave({ tags });
    renderList();
  }

  function addTagFromInput() {
    const note = active();
    if (!note) return;
    const raw = el.tagInput.value.split(',').map((t) => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean);
    el.tagInput.value = '';
    if (!raw.length) return;
    changeTags([...new Set([...note.tags, ...raw])].slice(0, 12));
  }

  el.tagInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') { event.preventDefault(); addTagFromInput(); }
    else if (event.key === 'Backspace' && !el.tagInput.value) {
      const note = active();
      if (note && note.tags.length) changeTags(note.tags.slice(0, -1));
    }
  });
  el.tagInput.addEventListener('blur', addTagFromInput);

  function setMode(mode) {
    const preview = mode === 'preview';
    el.tabWrite.setAttribute('aria-selected', String(!preview));
    el.tabPreview.setAttribute('aria-selected', String(preview));
    el.body.hidden = preview;
    el.preview.hidden = !preview;
    if (preview) {
      el.preview.replaceChildren(el.body.value.trim() ? renderMarkdown(el.body.value) : Object.assign(document.createElement('p'), { className: 'md-empty', textContent: 'Nothing to preview yet.' }));
    }
  }
  el.tabWrite.addEventListener('click', () => setMode('write'));
  el.tabPreview.addEventListener('click', () => setMode('preview'));

  function fillEditor() {
    const note = active();
    st.filledId = note ? note.id : null;
    el.editorEmpty.hidden = Boolean(note);
    el.editorBody.hidden = !note;
    if (!note) return;
    el.source.textContent = note.itemId === STANDALONE ? 'My note' : `From “${note.sourceTitle}”`;
    el.openSource.hidden = note.itemId === STANDALONE;
    el.pin.setAttribute('aria-pressed', String(note.pinned));
    el.title.value = note.title || '';
    el.body.value = note.body || '';
    el.wordCount.textContent = `${wordCount(note.body)} words`;
    composerColors.set(note.color);
    el.quote.hidden = !note.quote;
    el.quote.textContent = note.quote || '';
    el.notebookSelect.replaceChildren(
      new Option('No notebook', ''),
      ...st.notebooks.map((nb) => new Option(nb.name, nb.id)),
    );
    el.notebookSelect.value = note.notebookId && st.notebooks.some((nb) => nb.id === note.notebookId) ? note.notebookId : '';
    renderTagChips(note.tags);
    setSaveState('');
    setMode('write');
    renderLinks();
  }

  // ------------------------------------------------------------ connections: links out, links back, related notes

  async function goToNote(id) {
    await flush();
    if (!st.notes.some((n) => n.id === id)) {
      st.f = newFilters(st.f.tagMode);
      el.search.value = '';
      st.rank = null;
      st.hits = [];
      recompute();
    }
    await select(id);
    el.list.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  async function createLinked(title) {
    const res = await api.addNote({ itemId: STANDALONE, title });
    if (!res.ok) return showError(res.error);
    toast(`Created “${title}”.`);
    await refresh();
    await goToNote(res.note.id);
  }

  function renderLinks() {
    const note = active();
    if (!note) { el.links.hidden = true; return; }
    const outgoing = extractWikiLinks(note.body).map((target) => ({ target, hit: linkIndex.resolve(target) }));
    const back = linkIndex.backlinks(note);
    const related = linkIndex.related(note).filter((n) => !back.some((b) => b.id === n.id));
    const sections = [];
    const row = (iconName, label, sub, run, cls = '') => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `ws-link-row ${cls}`.trim();
      const main = document.createElement('span');
      main.textContent = label;
      b.append(icon(iconName), main);
      if (sub) { const sp = document.createElement('span'); sp.className = 'ws-link-sub'; sp.textContent = sub; b.append(sp); }
      b.addEventListener('click', run);
      li.append(b);
      return li;
    };
    const section = (title, rows) => {
      if (!rows.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'ws-links-section';
      const h = document.createElement('p');
      h.className = 'eyebrow';
      h.textContent = `${title} (${rows.length})`;
      const ul = document.createElement('ul');
      ul.append(...rows);
      wrap.append(h, ul);
      sections.push(wrap);
    };
    section('Links to', outgoing.map(({ target, hit }) => {
      if (!hit) return row('plus', target, 'create this note', () => createLinked(target), 'is-missing');
      if (hit.type === 'note') return row('pencil', hit.label, 'note', () => goToNote(hit.id));
      if (hit.type === 'article') return row('book', hit.label, 'reading', () => openArticle(hit.id));
      return row('hash', hit.label, 'topic', () => openTopic(hit.id));
    }));
    section('Linked from', back.map((n) => row('pencil', noteHeading(n), sourceName(n), () => goToNote(n.id))));
    section('Related by tag', related.map((n) => row('pencil', noteHeading(n), n.tags.filter((t) => note.tags.includes(t)).map((t) => `#${t}`).join(' '), () => goToNote(n.id))));
    el.links.replaceChildren(...sections);
    el.links.hidden = sections.length === 0;
  }

  // ------------------------------------------------------------ [[ autocomplete

  const wl = { open: false, start: 0, items: [], index: 0 };
  function caretPoint(textarea, position) {
    const mirror = document.createElement('div');
    const cs = getComputedStyle(textarea);
    for (const prop of ['font', 'letterSpacing', 'lineHeight', 'padding', 'border', 'boxSizing', 'whiteSpace', 'wordWrap', 'tabSize']) mirror.style[prop] = cs[prop];
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.textContent = textarea.value.slice(0, position);
    const mark = document.createElement('span');
    mark.textContent = '\u200b';
    mirror.append(mark);
    document.body.append(mirror);
    const box = textarea.getBoundingClientRect();
    const point = { x: box.left + mark.offsetLeft - textarea.scrollLeft, y: box.top + mark.offsetTop - textarea.scrollTop + (parseFloat(cs.lineHeight) || 20) };
    mirror.remove();
    return point;
  }
  function closeWl() { wl.open = false; el.wlSuggest.hidden = true; }
  function renderWl() {
    el.wlSuggest.replaceChildren(...wl.items.map((item, i) => {
      const row = document.createElement('div');
      row.className = 'nw-suggest-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(i === wl.index));
      const name = document.createElement('span');
      name.textContent = item.label;
      const meta = document.createElement('span');
      meta.className = 'nw-suggest-meta';
      meta.textContent = item.type === 'article' ? 'reading' : item.type === 'tag' ? 'topic' : 'note';
      row.append(name, meta);
      row.addEventListener('mousedown', (event) => { event.preventDefault(); acceptWl(i); });
      return row;
    }));
  }
  function acceptWl(i) {
    const item = wl.items[i];
    if (!item) return;
    const caret = el.body.selectionStart;
    const after = el.body.value.slice(caret);
    const insert = `${item.label}]]`;
    el.body.value = el.body.value.slice(0, wl.start) + insert + (after.startsWith(']]') ? after.slice(2) : after);
    const pos = wl.start + insert.length;
    el.body.setSelectionRange(pos, pos);
    closeWl();
    el.body.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function updateWl() {
    const pos = el.body.selectionStart;
    const m = /\[\[([^\]\n|]*)$/.exec(el.body.value.slice(0, pos));
    if (!m) { closeWl(); return; }
    wl.start = pos - m[1].length;
    wl.items = linkIndex.suggestions(m[1]);
    if (!wl.items.length) { closeWl(); return; }
    wl.index = 0;
    wl.open = true;
    const point = caretPoint(el.body, pos);
    el.wlSuggest.style.left = `${Math.min(point.x, window.innerWidth - 300)}px`;
    el.wlSuggest.style.top = `${Math.min(point.y, window.innerHeight - 260)}px`;
    el.wlSuggest.hidden = false;
    renderWl();
  }
  el.body.addEventListener('input', updateWl);
  el.body.addEventListener('click', closeWl);
  el.body.addEventListener('blur', () => setTimeout(closeWl, 120));
  el.body.addEventListener('keydown', (event) => {
    if (!wl.open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      wl.index = (wl.index + (event.key === 'ArrowDown' ? 1 : -1) + wl.items.length) % wl.items.length;
      renderWl();
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      acceptWl(wl.index);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeWl();
    }
  });

  async function select(id) {
    if (id === st.activeId) return;
    await flush();
    const previous = st.activeId;
    st.activeId = id;
    await discardIfBlank(previous);
    renderList();
    fillEditor();
  }

  el.title.addEventListener('input', () => {
    const note = active();
    if (!note) return;
    note.title = el.title.value.trim() || null;
    queueSave({ title: el.title.value });
    renderList();
  });
  el.body.addEventListener('input', () => {
    const note = active();
    if (!note) return;
    note.body = el.body.value;
    el.wordCount.textContent = `${wordCount(el.body.value)} words`;
    queueSave({ body: el.body.value });
    renderList();
  });
  el.notebookSelect.addEventListener('change', () => {
    const note = active();
    if (!note) return;
    note.notebookId = el.notebookSelect.value || null;
    queueSave({ notebookId: el.notebookSelect.value || null });
    flush().then(refresh);
  });

  el.pin.addEventListener('click', async () => {
    const note = active();
    if (!note) return;
    note.pinned = !note.pinned;
    el.pin.setAttribute('aria-pressed', String(note.pinned));
    queueSave({ pinned: note.pinned });
    await flush();
    refresh();
  });

  el.openSource.addEventListener('click', async () => {
    const note = active();
    if (!note) return;
    await flush();
    openSource(note);
  });

  confirmTwice(el.del, async () => {
    const note = active();
    if (!note) return;
    pending = null;
    const res = await api.deleteNote(note.id);
    if (!res.ok) return showError(res.error);
    st.activeId = null;
    await refresh();
    toast('Note deleted.', {
      action: {
        label: 'Undo',
        onClick: async () => {
          const restored = await api.addNote({
            itemId: note.itemId, blockIndex: note.blockIndex, startOffset: note.startOffset, endOffset: note.endOffset,
            quote: note.quote, body: note.body, title: note.title, color: note.color, notebookId: note.notebookId, tags: note.tags,
          });
          if (!restored.ok) return showError(restored.error);
          await refresh();
          select(restored.note.id);
        },
      },
      duration: 7000,
    });
  });

  // ------------------------------------------------------------ export / create / filters

  async function exportNotes(filter) {
    await flush();
    const res = await api.exportNotes(filter);
    if (!res.ok) return showError(res.error);
    if (!res.cancelled) toast('Notes exported as Markdown.');
  }
  el.exportList.addEventListener('click', () => {
    const ids = (st.sel.size ? selectedNotes() : st.notes).map((n) => n.id);
    if (!ids.length) return toast('Nothing to export in this list.');
    exportNotes({ ids });
  });
  el.exportOne.addEventListener('click', () => { const n = active(); if (n) exportNotes({ ids: [n.id] }); });

  async function createNote() {
    await flush();
    await discardIfBlank(st.activeId);
    const f = st.f;
    // A brand-new note must stay visible, so drop only the filters it could not satisfy.
    if (f.kind === 'highlight') f.kind = 'all';
    f.pinned = false;
    f.sources.clear();
    el.search.value = '';
    const tags = f.tags.size ? (f.tagMode === 'any' ? [[...f.tags][0]] : [...f.tags]) : [];
    const notebookId = f.notebooks.size && !f.unfiled ? [...f.notebooks][0] : null;
    if (f.notebooks.size > 1 && !f.unfiled) { f.notebooks = new Set([notebookId]); }
    const res = await api.addNote({ itemId: STANDALONE, notebookId, tags, color: f.color || null });
    if (!res.ok) return showError(res.error);
    st.activeId = null;
    await refresh();
    await select(res.note.id);
    el.title.focus();
  }
  el.newNote.addEventListener('click', createNote);

  el.newNotebook.addEventListener('click', async () => {
    const name = await promptName('New notebook');
    if (!name) return;
    const res = await api.createNotebook(name);
    if (!res.ok) return showError(res.error);
    st.f = newFilters(st.f.tagMode);
    st.f.notebooks.add(res.notebook.id);
    st.activeId = null;
    refresh();
  });

  const colorFilter = buildSwatches(el.colorFilter, {
    allowNone: true,
    onPick: (color) => changeFilters((f) => { f.color = color || ''; }),
  });

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => { await flush(); await runSmart(); recompute(); }, 120);
    renderSuggest();
  });
  el.search.addEventListener('focus', renderSuggest);
  el.search.addEventListener('blur', () => setTimeout(closeSuggest, 140));
  el.search.addEventListener('keydown', (event) => {
    const items = [...el.suggest.querySelectorAll('[role=option]')];
    if (event.key === 'Escape') { if (!el.suggest.hidden) { closeSuggest(); event.stopPropagation(); } return; }
    if (!items.length || el.suggest.hidden) return;
    const current = items.findIndex((i) => i.getAttribute('aria-selected') === 'true');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((i, idx) => i.setAttribute('aria-selected', String(idx === next)));
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && current >= 0) {
      event.preventDefault();
      items[current].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    }
  });

  // ------------------------------------------------------------ search suggestions (notebooks, articles, tags, operators)

  const closeSuggest = () => { el.suggest.hidden = true; el.search.setAttribute('aria-expanded', 'false'); };

  /** The word being typed: the text after the last space, minus a field prefix. */
  function currentWord() {
    const text = el.search.value;
    const m = text.match(/(\S*)$/);
    let word = m ? m[1] : '';
    const start = text.length - word.length;
    let field = '';
    const op = word.match(/^-?([A-Za-z]+):("?)(.*)$/);
    if (op && FIELD_ALIASES[op[1].toLowerCase()]) { field = FIELD_ALIASES[op[1].toLowerCase()]; word = op[3]; }
    else if (word.startsWith('#')) { field = 'tag'; word = word.slice(1); }
    return { start, field, word: word.replace(/^"|"$/g, '').toLowerCase() };
  }

  function suggestionGroups() {
    const { field, word } = currentWord();
    const groups = [];
    const want = (type) => !field || field === type || (field === 'any');
    const like = (name) => !word || String(name).toLowerCase().includes(word);
    if (want('nb')) {
      const rows = st.notebooks.filter((nb) => like(nb.name)).slice(0, 4)
        .map((nb) => ({ label: nb.name, meta: `${st.all.filter((n) => n.notebookId === nb.id).length}`, apply: (f) => f.notebooks.add(nb.id) }));
      if (rows.length) groups.push({ title: 'Notebooks', icon: 'book', rows });
    }
    if (want('source')) {
      const seen = new Map();
      for (const n of st.all) if (n.itemId !== STANDALONE && like(n.sourceTitle)) seen.set(n.itemId, { t: n.sourceTitle, c: (seen.get(n.itemId)?.c || 0) + 1 });
      const rows = [...seen].slice(0, 4).map(([id, v]) => ({ label: v.t, meta: String(v.c), apply: (f) => f.sources.add(id) }));
      if (rows.length) groups.push({ title: 'Articles', icon: 'file', rows });
    }
    if (want('tag')) {
      const rows = st.tags.filter((t) => like(t.name)).slice(0, 5).map((t) => ({ label: `#${t.name}`, meta: String(t.count), apply: (f) => f.tags.add(t.name) }));
      if (rows.length) groups.push({ title: 'Tags', icon: 'bookmark', rows });
    }
    return { groups, field, word };
  }

  function renderSuggest() {
    const { groups, field, word } = suggestionGroups();
    const nodes = [];
    const section = (title, iconName) => {
      const h = document.createElement('div');
      h.className = 'nw-suggest-title';
      if (iconName) h.append(icon(iconName));
      h.append(title);
      nodes.push(h);
    };
    const option = (label, meta, onPick) => {
      const row = document.createElement('div');
      row.className = 'nw-suggest-row';
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');
      const name = document.createElement('span');
      name.textContent = label;
      row.append(name);
      if (meta) { const m = document.createElement('span'); m.className = 'nw-suggest-meta'; m.textContent = meta; row.append(m); }
      row.addEventListener('mousedown', (event) => { event.preventDefault(); onPick(); });
      nodes.push(row);
    };

    if (!field && word) {
      // Offer to search a specific field for what they typed.
      section('Search in', 'search');
      for (const [label, op] of [['Titles', 'title'], ['Article names', 'source'], ['Note text', 'body'], ['Highlighted quotes', 'quote']]) {
        option(`${label} · ${op}:${word}`, '', () => {
          const { start } = currentWord();
          el.search.value = `${el.search.value.slice(0, start)}${op}:${/\s/.test(word) ? `"${word}"` : word} `;
          closeSuggest();
          flush().then(recompute);
          el.search.focus();
        });
      }
    }
    for (const group of groups) {
      section(group.title, group.icon);
      for (const row of group.rows) {
        option(row.label, row.meta, () => {
          const { start } = currentWord();
          el.search.value = el.search.value.slice(0, start).trimEnd();
          closeSuggest();
          changeFilters(row.apply);
        });
      }
    }
    if (!word && !field) {
      section('Narrow with operators', 'command');
      for (const hint of OPERATOR_HINTS) {
        option(hint.op, hint.desc, () => {
          el.search.value = `${el.search.value}${el.search.value && !el.search.value.endsWith(' ') ? ' ' : ''}${hint.op}`;
          el.search.focus();
          renderSuggest();
        });
      }
    } else if (!groups.length && field) {
      const none = document.createElement('div');
      none.className = 'nw-suggest-none';
      none.textContent = `No ${field === 'nb' ? 'notebook' : field === 'source' ? 'article' : field} matches “${word}” — keep typing to filter by text.`;
      nodes.push(none);
    }
    el.suggest.hidden = nodes.length === 0;
    el.search.setAttribute('aria-expanded', String(!el.suggest.hidden));
    el.suggest.replaceChildren(...nodes);
  }
  for (const button of el.tagMode.querySelectorAll('button')) {
    button.addEventListener('click', () => changeFilters((f) => { f.tagMode = button.dataset.mode; }));
  }

  // ------------------------------------------------------------ search by meaning

  async function runSmart() {
    const free = parseQuery(el.search.value).filter((t) => t.field === 'any' && !t.neg).map((t) => t.value).join(' ');
    el.smartNote.hidden = true;
    if (!st.smart || !free) { st.rank = null; st.hits = []; return; }
    const mine = ++st.smartToken;
    const [notes, readings] = await Promise.all([api.search(free, { scope: 'notes', limit: 60 }), api.search(free, { scope: 'articles', limit: 5 })]);
    if (mine !== st.smartToken) return;
    if (!notes.ok) { st.rank = null; return; }
    st.rank = new Map(notes.results.map((r, i) => [r.id, i]));
    st.hits = readings.ok ? readings.results : [];
    st.smartMode = notes.mode;
    el.smartNote.hidden = false;
    el.smartNote.textContent = notes.mode === 'hybrid'
      ? 'Ranked by meaning, best match first.'
      : (notes.status?.semanticError ? 'Ranked by keywords. Allow model downloads in Settings to search by meaning.' : (notes.status?.indexing ? 'Learning your notes… ranked by keywords until it finishes.' : 'Ranked by keywords.'));
  }

  el.smart.addEventListener('click', async () => {
    st.smart = !st.smart;
    store.set('notes.smart', st.smart);
    await runSmart();
    recompute();
  });
  el.group.addEventListener('change', () => { st.group = el.group.value; store.set('notes.group', st.group); renderList(); });

  // ------------------------------------------------------------ data

  let refreshToken = 0;
  async function refresh() {
    const token = ++refreshToken;
    const [all, notebooks, tags] = await Promise.all([
      api.listNotes({ limit: 2000 }),
      api.listNotebooks(),
      api.listTags(),
    ]);
    if (token !== refreshToken) return; // a newer refresh superseded this one
    for (const res of [all, notebooks, tags]) {
      if (!res.ok) return showError(res.error);
    }
    st.all = all.notes;
    linkIndex.setNotes(st.all);
    st.notebooks = notebooks.notebooks;
    st.tags = tags.tags;
    await runSmart();
    recompute(true);
  }

  /** Re-apply the search text and filters to the notes already in memory (no round trip while typing). */
  function recompute(force = false) {
    // Forget filters that point at things that no longer exist.
    for (const id of [...st.f.notebooks]) if (!st.notebooks.some((n) => n.id === id)) st.f.notebooks.delete(id);
    const known = new Set(st.tags.map((t) => t.name));
    for (const t of [...st.f.tags]) if (!known.has(t)) st.f.tags.delete(t);
    const terms = parseQuery(el.search.value);
    const free = terms.filter((t) => t.field === 'any' && !t.neg);
    const structural = terms.filter((t) => !(t.field === 'any' && !t.neg));
    if (st.smart && free.length && st.rank) {
      // Meaning-based: the ranking comes from the search index; operators like tag: still narrow it.
      const rankOf = st.rank;
      st.pool = st.all.filter((n) => rankOf.has(n.id) && queryMatch(n, structural)).sort((a, b) => rankOf.get(a.id) - rankOf.get(b.id));
    } else {
      st.pool = terms.length ? st.all.filter((n) => queryMatch(n, terms)) : st.all;
      if (!(st.smart && free.length)) { st.hits = []; st.rank = null; }
    }
    st.notes = st.pool.filter((n) => matches(n));
    const visible = new Set(st.notes.map((n) => n.id));
    st.sel = new Set([...st.sel].filter((id) => visible.has(id)));
    if (!st.sel.size && st.bulkPanel) st.bulkPanel = null;
    colorFilter.set(st.f.color || null);
    if (!visible.has(st.activeId)) st.activeId = st.notes[0]?.id ?? null;
    renderNav();
    renderList();
    if (force || st.activeId !== st.filledId) fillEditor();
  }

  return {
    show: refresh,
    refresh,
    goToNote,
    async openNote(id) {
      await flush();
      st.f = newFilters(st.f.tagMode);
      el.search.value = '';
      st.activeId = id;
      await refresh();
    },
    async leave() {
      await flush();
      await discardIfBlank(st.activeId);
      st.activeId = null;
    },
    flush,
  };
}
