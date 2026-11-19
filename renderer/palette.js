// Command palette (Ctrl/⌘ K): jump to a reading or note, or run any app command.
import { api, $, debounce } from './common.js';
import { icon } from './icons.js';
import { noteHeading } from './notes-workspace.js';

export function initPalette({ commands, openItem, openNote }) {
  const dialog = $('#palette');
  const input = $('#palette-input');
  const list = $('#palette-list');
  let rows = [];
  let selected = 0;
  let token = 0;
  const note = document.createElement('p');
  note.className = 'palette-note';
  note.hidden = true;
  list.after(note);

  const match = (text, q) => text.toLowerCase().includes(q);

  function render(groups) {
    rows = [];
    list.replaceChildren();
    for (const group of groups) {
      if (!group.items.length) continue;
      const head = document.createElement('li');
      head.className = 'palette-group';
      head.setAttribute('role', 'presentation');
      head.textContent = group.title;
      list.append(head);
      for (const item of group.items) {
        const li = document.createElement('li');
        li.className = 'palette-item';
        li.setAttribute('role', 'option');
        const main = document.createElement('span');
        main.className = 'palette-item-main';
        main.textContent = item.label;
        if (item.sub) {
          const sub = document.createElement('span');
          sub.className = 'palette-item-sub';
          sub.textContent = item.sub;
          main.append(sub);
        }
        if (item.detail) {
          const detail = document.createElement('span');
          detail.className = 'palette-item-detail';
          detail.textContent = item.detail;
          main.append(detail);
          li.classList.add('has-detail');
        }
        li.append(icon(item.icon || 'arrow-right'), main);
        if (item.hint) { const k = document.createElement('kbd'); k.textContent = item.hint; li.append(k); }
        li.addEventListener('click', () => run(item));
        li.addEventListener('mousemove', () => select(rows.indexOf(entry)));
        const entry = { item, li };
        rows.push(entry);
        list.append(li);
      }
    }
    if (!rows.length) {
      const empty = document.createElement('li');
      empty.className = 'palette-empty';
      empty.textContent = 'Nothing matches. Try another word.';
      list.append(empty);
    }
    select(0);
  }

  function select(index) {
    if (!rows.length) return;
    selected = (index + rows.length) % rows.length;
    rows.forEach((r, i) => { r.li.classList.toggle('is-selected', i === selected); r.li.setAttribute('aria-selected', String(i === selected)); });
    rows[selected].li.scrollIntoView({ block: 'nearest' });
  }

  function run(item) {
    dialog.close();
    item.run();
  }

  async function update() {
    const q = input.value.trim().toLowerCase();
    const mine = ++token;
    if (!q) note.hidden = true;
    const cmds = commands().filter((c) => !q || match(c.label, q) || (c.keywords || '').includes(q));
    if (!q) {
      const recent = await api.listLibrary('history');
      if (mine !== token) return;
      const items = (recent.ok ? recent.entries : []).slice(0, 5).map((e) => ({ icon: 'book', label: e.title || 'Untitled reading', run: () => openItem(e.id) }));
      render([{ title: 'Jump back in', items }, { title: 'Commands', items: cmds }]);
      return;
    }
    const asked = input.value.trim();
    const [lib, notes, smart] = await Promise.all([api.listLibrary('history', q), api.listNotes({ query: q, limit: 6 }), api.search(asked, { limit: 8 })]);
    if (mine !== token) return;
    const found = smart.ok ? smart.results : [];
    const byMeaning = smart.ok && smart.mode === 'hybrid';
    const smartItems = found.map((r) => ({
      icon: r.kind === 'note' ? 'pencil' : 'book',
      label: r.kind === 'note' ? (r.title || r.source || 'Note') : r.title,
      sub: r.kind === 'note' ? r.source : '',
      detail: r.snippet,
      run: () => (r.kind === 'note' ? openNote({ id: r.id, itemId: r.itemId }) : openItem(r.itemId, { blockIndex: r.blockIndex })),
    }));
    const smartGroup = { title: byMeaning ? 'Best matches by meaning' : 'Best matches in your notes and readings', items: smartItems };
    const keywordGroups = [
      { title: 'Readings', items: (lib.ok ? lib.entries : []).slice(0, 4).map((e) => ({ icon: 'book', label: e.title || 'Untitled reading', run: () => openItem(e.id) })) },
      { title: 'Notes', items: (notes.ok ? notes.notes : []).slice(0, 4).map((n) => ({ icon: n.body ? 'pencil' : 'sparkle', label: noteHeading(n), sub: n.sourceTitle || '', run: () => openNote(n) })) },
    ];
    const natural = asked.split(/\s+/).length >= 3 || /\?$/.test(asked);
    render([...(natural ? [smartGroup, ...keywordGroups] : [...keywordGroups, smartGroup]), { title: 'Commands', items: cmds }]);
    note.hidden = byMeaning || !found.length;
    note.textContent = smart.ok && smart.status?.semanticError ? 'Searching by keywords. Allow model downloads in Settings to search by meaning.' : (smart.ok && smart.status?.indexing ? 'Learning your library… results by meaning improve as it finishes.' : '');
    note.hidden = !note.textContent;
  }

  input.addEventListener('input', debounce(update, 120));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); select(selected + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); select(selected - 1); }
    else if (event.key === 'Enter') { event.preventDefault(); if (rows[selected]) run(rows[selected].item); }
  });
  dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

  return {
    open(query = '') {
      input.value = query;
      dialog.showModal();
      input.focus();
      update();
    },
  };
}
