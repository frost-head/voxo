// Discovery: fresh things worth listening to. One shared list of stories feeds two places: a short row on Home and the
// full Discover page. Feeds are fetched by the main process (no CORS), cached for 30 minutes, and never block the page.
import { icon } from './icons.js';
import { store, promptName, toast } from './common.js';

const FEEDS = {
  tech: ['https://hnrss.org/frontpage?points=100', 'https://feeds.arstechnica.com/arstechnica/index', 'https://www.theverge.com/rss/index.xml'],
  science: ['https://www.quantamagazine.org/feed/', 'https://aeon.co/feed.rss'],
  world: ['https://feeds.bbci.co.uk/news/world/rss.xml', 'https://feeds.npr.org/1001/rss.xml'],
};
const TABS = [
  { id: 'foryou', label: 'For you', icon: 'sparkle' },
  { id: 'tech', label: 'Trending in Technology', short: 'Technology', icon: 'trending' },
  { id: 'quick', label: 'Quick 5-minute reads', short: 'Quick reads', icon: 'clock' },
  { id: 'science', label: 'Science & ideas', short: 'Ideas', icon: 'globe' },
  { id: 'world', label: 'World news', short: 'World', icon: 'globe' },
  { id: 'mine', label: 'My feeds', icon: 'rss' },
];
const TTL = 30 * 60 * 1000;
const HOME_COUNT = 6;
const PAGE_STEP = 12;

const ago = (t) => {
  if (!t) return '';
  const h = (Date.now() - t) / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d < 8 ? `${d} d ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function initDiscover({ api, homeRoot, pageRoot, openUrl, listenUrl, saveUrl, openAll, getTopics }) {
  const state = {
    tab: store.get('discover.tab', 'tech'), items: [], loading: false, error: '', updatedAt: 0,
    shown: PAGE_STEP, query: '', busy: new Set(),
  };
  const customFeeds = () => store.get('discover.custom', []).filter((u) => typeof u === 'string');
  const hidden = () => new Set(store.get('discover.hidden', []));
  const saved = () => new Set(store.get('discover.saved', []));

  const allUrls = () => [...new Set([...Object.values(FEEDS).flat(), ...customFeeds()])];
  const tabOf = (item) => {
    const tabs = Object.entries(FEEDS).filter(([, urls]) => urls.includes(item.feed)).map(([id]) => id);
    if (customFeeds().includes(item.feed)) tabs.push('mine');
    return tabs;
  };

  function visibleTabs() {
    const topics = getTopics();
    return TABS.filter((t) => (t.id === 'foryou' ? topics.length > 0 : t.id === 'mine' ? customFeeds().length > 0 : true));
  }

  function itemsFor(tab, query = '') {
    const gone = hidden();
    let list;
    if (tab === 'quick') list = state.items.filter((i) => i.minutes && i.minutes <= 5).sort((a, b) => b.published - a.published);
    else if (tab === 'foryou') {
      const topics = getTopics().map((t) => t.word);
      list = state.items
        .map((item) => {
          const hay = `${item.title} ${item.summary}`.toLowerCase();
          return { item, hits: topics.filter((w) => hay.includes(w)).length };
        })
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits || b.item.published - a.item.published)
        .map((x) => x.item);
    } else list = state.items.filter((i) => tabOf(i).includes(tab)).sort((a, b) => b.published - a.published);
    list = list.filter((i) => !gone.has(i.link));
    const q = query.trim().toLowerCase();
    return q ? list.filter((i) => `${i.title} ${i.summary} ${i.source}`.toLowerCase().includes(q)) : list;
  }

  async function load({ force = false } = {}) {
    if (state.loading) return;
    const cached = store.get('discover.cache', null);
    const sameFeeds = cached && JSON.stringify(cached.urls) === JSON.stringify(allUrls());
    if (!force && sameFeeds && Date.now() - cached.t < TTL) { state.items = cached.items; state.updatedAt = cached.t; renderAll(); return; }
    if (cached?.items && sameFeeds) { state.items = cached.items; state.updatedAt = cached.t; } // show the old list while refreshing
    const before = new Set(state.items.map((i) => i.link));
    state.loading = true;
    state.error = '';
    renderAll();
    try {
      const res = await api.fetchFeeds(allUrls());
      if (!res.ok) throw new Error(res.error);
      if (res.items.length) {
        state.items = res.items;
        state.updatedAt = Date.now();
        store.set('discover.cache', { t: state.updatedAt, urls: allUrls(), items: res.items.slice(0, 160) });
        if (force) {
          const fresh = res.items.filter((i) => !before.has(i.link)).length;
          toast(fresh ? `${fresh} new ${fresh === 1 ? 'story' : 'stories'}.` : 'Up to date: the feeds have not published anything new yet.', { duration: 3000 });
        }
      } else if (!state.items.length) {
        state.error = res.errors.length ? 'voxo could not reach the news feeds. Check your connection and try again.' : 'No stories found.';
      } else if (force) toast('Could not reach the feeds. Showing what you already have.', { duration: 3500 });
    } catch (error) {
      if (!state.items.length) state.error = error.message || 'Could not load stories.';
      else if (force) toast('Could not refresh. Showing what you already have.', { duration: 3500 });
    }
    state.loading = false;
    renderAll();
  }

  // ---------------------------------------------------------------- one story card, with quick controls on hover

  function control(label, iconName, onClick, { pressed = null } = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'discover-tool';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (pressed !== null) b.setAttribute('aria-pressed', String(pressed));
    b.append(icon(iconName));
    b.addEventListener('click', (event) => { event.stopPropagation(); onClick(b); });
    return b;
  }

  function card(item, { rich }) {
    const wrap = document.createElement('article');
    wrap.className = `discover-card${rich && item.image ? ' has-image' : ''}`;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'discover-open';
    open.setAttribute('aria-label', `Open: ${item.title}`);
    open.addEventListener('click', () => openUrl(item.link));

    if (rich && item.image) {
      const pic = document.createElement('div');
      pic.className = 'discover-pic';
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.src = item.image;
      img.addEventListener('error', () => { wrap.classList.remove('has-image'); pic.remove(); }, { once: true });
      pic.append(img);
      wrap.append(pic);
    }
    const body = document.createElement('div');
    body.className = 'discover-body';
    const meta = document.createElement('div');
    meta.className = 'discover-meta';
    const source = document.createElement('span');
    source.textContent = item.source;
    meta.append(source);
    const time = ago(item.published);
    if (time) { const t = document.createElement('span'); t.textContent = time; meta.append(t); }
    if (item.minutes) { const m = document.createElement('span'); m.className = 'discover-min'; m.append(icon('clock'), `${item.minutes} min`); meta.append(m); }
    const title = document.createElement('div');
    title.className = 'discover-title';
    title.textContent = item.title;
    body.append(meta, title);
    if (item.summary) {
      const summary = document.createElement('div');
      summary.className = 'discover-summary';
      summary.textContent = item.summary;
      body.append(summary);
    }
    wrap.append(body, open);

    // Quick controls: they appear when you hover (or tab to) the card, so the grid stays calm.
    const tools = document.createElement('div');
    tools.className = 'discover-tools';
    tools.append(
      control('Listen now', 'headphones', () => listenUrl(item.link)),
      control(saved().has(item.link) ? 'Saved to your archive' : 'Save to your archive', 'bookmark', async (b) => {
        if (state.busy.has(item.link) || saved().has(item.link)) { toast('Already saved to your archive.', { duration: 2000 }); return; }
        state.busy.add(item.link);
        b.classList.add('is-busy');
        const ok = await saveUrl(item.link);
        state.busy.delete(item.link);
        b.classList.remove('is-busy');
        if (ok) { store.set('discover.saved', [...saved(), item.link].slice(-500)); b.setAttribute('aria-pressed', 'true'); b.title = 'Saved to your archive'; }
      }, { pressed: saved().has(item.link) }),
      control('Open in your browser', 'external', () => api.openExternal(item.link)),
      control('Copy link', 'copy', async () => {
        try { await navigator.clipboard.writeText(item.link); toast('Link copied.', { duration: 1800 }); } catch { toast('Could not copy the link.'); }
      }),
      control('Not interested', 'eye-off', () => {
        store.set('discover.hidden', [...hidden(), item.link].slice(-500));
        toast('Hidden.', { duration: 4000, action: { label: 'Undo', onClick: () => { store.set('discover.hidden', [...hidden()].filter((l) => l !== item.link)); renderAll(); } } });
        renderAll();
      }),
    );
    wrap.append(tools);
    return wrap;
  }

  // ---------------------------------------------------------------- shared pieces

  function tabsRow(tabs, onPick) {
    const row = document.createElement('div');
    row.className = 'chip-row discover-tabs';
    row.setAttribute('role', 'tablist');
    for (const tab of tabs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${tab.id === state.tab ? ' is-active' : ''}`;
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(tab.id === state.tab));
      chip.append(icon(tab.icon), tab.short || tab.label);
      chip.title = tab.label;
      chip.addEventListener('click', () => { state.tab = tab.id; state.shown = PAGE_STEP; store.set('discover.tab', tab.id); onPick(); });
      row.append(chip);
    }
    return row;
  }

  function addFeedButton() {
    const add = document.createElement('button');
    add.type = 'button'; add.className = 'link-btn'; add.append(icon('rss'), 'Add a feed');
    add.addEventListener('click', async () => {
      const url = await promptName('Add a feed: paste an RSS or Atom address');
      if (!url) return;
      if (!/^https?:\/\/\S+$/i.test(url.trim())) { toast('That does not look like a web address.'); return; }
      store.set('discover.custom', [...new Set([...customFeeds(), url.trim()])]);
      state.tab = 'mine';
      store.set('discover.tab', 'mine');
      load({ force: true });
    });
    return add;
  }

  function refreshButton() {
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = `icon-btn small${state.loading ? ' is-spinning' : ''}`;
    refresh.title = 'Refresh stories';
    refresh.setAttribute('aria-label', 'Refresh stories');
    refresh.append(icon('reset'));
    refresh.disabled = state.loading;
    refresh.addEventListener('click', () => load({ force: true }));
    return refresh;
  }

  function emptyOrError(retry = true) {
    const body = document.createElement('div');
    body.className = 'empty-state compact';
    const p = document.createElement('p');
    p.className = 'empty-copy';
    p.textContent = state.error || (state.tab === 'quick' ? 'No short reads in the feeds right now. Try another tab or refresh.' : state.query ? 'No stories match your search.' : 'Nothing here yet.');
    body.append(p);
    if (state.error && retry) {
      const again = document.createElement('button');
      again.type = 'button'; again.className = 'btn btn-secondary btn-sm'; again.textContent = 'Try again';
      again.addEventListener('click', () => load({ force: true }));
      body.append(again);
    }
    return body;
  }

  function skeletons(n) {
    const grid = document.createElement('div');
    grid.className = 'discover-grid';
    for (let i = 0; i < n; i++) { const s = document.createElement('div'); s.className = 'discover-card skeleton'; grid.append(s); }
    return grid;
  }

  // ---------------------------------------------------------------- Home: a short row

  function renderHome() {
    if (!homeRoot) return;
    const tabs = visibleTabs();
    if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs.find((t) => t.id === 'tech')?.id || tabs[0].id;
    const header = document.createElement('div');
    header.className = 'section-header';
    const h = document.createElement('h2');
    h.textContent = 'Discover something to listen to';
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
    const all = document.createElement('button');
    all.type = 'button'; all.className = 'link-btn'; all.append('See all', icon('arrow-right'));
    all.addEventListener('click', () => openAll());
    actions.append(refreshButton(), all);
    header.append(h, actions);

    const list = itemsFor(state.tab);
    let body;
    if (state.loading && !state.items.length) body = skeletons(HOME_COUNT);
    else if (state.error || !list.length) body = emptyOrError();
    else {
      body = document.createElement('div');
      body.className = 'discover-grid';
      body.append(...list.slice(0, HOME_COUNT).map((item) => card(item, { rich: false })));
    }
    homeRoot.replaceChildren(header, tabsRow(tabs, renderHome), body);
    homeRoot.hidden = false;
  }

  // ---------------------------------------------------------------- the Discover page

  let pageBuilt = false;
  let searchInput = null;
  let gridHost = null;
  let tabsHost = null;
  let stamp = null;

  function buildPage() {
    if (!pageRoot || pageBuilt) return;
    pageBuilt = true;
    const head = document.createElement('header');
    head.className = 'library-header-full discover-page-head';
    const titles = document.createElement('div');
    const h = document.createElement('h2');
    h.className = 'view-title';
    h.textContent = 'Discover';
    const intro = document.createElement('p');
    intro.className = 'view-intro';
    intro.textContent = 'Fresh stories to listen to. Hover a story to save it, listen now, or hide it.';
    stamp = document.createElement('p');
    stamp.className = 'discover-stamp';
    titles.append(h, intro, stamp);
    const side = document.createElement('div');
    side.className = 'discover-page-tools';
    const field = document.createElement('label');
    field.className = 'search-field wide';
    field.append(icon('search'));
    searchInput = document.createElement('input');
    searchInput.type = 'search';
    searchInput.placeholder = 'Search these stories…';
    searchInput.setAttribute('aria-label', 'Search stories');
    searchInput.addEventListener('input', () => { state.query = searchInput.value; state.shown = PAGE_STEP; renderPage(); });
    field.append(searchInput);
    side.append(field);
    head.append(titles, side);
    tabsHost = document.createElement('div');
    tabsHost.className = 'discover-page-tabs';
    gridHost = document.createElement('div');
    gridHost.className = 'discover-page-body';
    const scroll = document.createElement('div');
    scroll.className = 'library-content-full discover-scroll';
    scroll.append(gridHost);
    const shell = document.createElement('div');
    shell.className = 'library-shell-full discover-shell';
    shell.append(head, tabsHost, scroll);
    pageRoot.replaceChildren(shell);
  }

  function renderPage() {
    if (!pageRoot) return;
    buildPage();
    const tabs = visibleTabs();
    if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs.find((t) => t.id === 'tech')?.id || tabs[0].id;
    stamp.textContent = state.loading ? 'Refreshing…' : state.updatedAt ? `Updated ${ago(state.updatedAt) || 'just now'}` : '';
    const bar = document.createElement('div');
    bar.className = 'discover-page-bar';
    const row = tabsRow(tabs, renderPage);
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
    actions.append(addFeedButton(), refreshButton());
    bar.append(row, actions);
    tabsHost.replaceChildren(bar);

    const list = itemsFor(state.tab, state.query);
    if (state.loading && !state.items.length) gridHost.replaceChildren(skeletons(9));
    else if (state.error || !list.length) gridHost.replaceChildren(emptyOrError());
    else {
      const grid = document.createElement('div');
      grid.className = 'discover-grid discover-grid-page';
      grid.append(...list.slice(0, state.shown).map((item) => card(item, { rich: true })));
      const nodes = [grid];
      if (list.length > state.shown) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'btn btn-secondary btn-sm discover-more'; more.textContent = `Show more (${list.length - state.shown})`;
        more.addEventListener('click', () => { state.shown += PAGE_STEP; renderPage(); });
        nodes.push(more);
      }
      gridHost.replaceChildren(...nodes);
    }
  }

  function renderAll() { renderHome(); if (pageBuilt || pageRoot) renderPage(); }

  return {
    load,
    render: renderAll,
    showPage() { renderPage(); if (!state.items.length || Date.now() - state.updatedAt > TTL) load(); },
    get items() { return state.items; },
  };
}
