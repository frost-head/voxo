// The home screen's discovery feed: fresh things worth listening to, so there is always something to start with.
// Feeds are fetched by the main process (no CORS), cached for 30 minutes, and never block the rest of the page.
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

const ago = (t) => {
  if (!t) return '';
  const h = (Date.now() - t) / 3.6e6;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min ago`;
  if (h < 24) return `${Math.round(h)} h ago`;
  const d = Math.round(h / 24);
  return d < 8 ? `${d} d ago` : new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function initDiscover({ api, root, openUrl, getTopics }) {
  const state = { tab: store.get('discover.tab', 'tech'), items: [], loading: false, error: '', shown: 6 };
  const customFeeds = () => store.get('discover.custom', []).filter((u) => typeof u === 'string');

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

  function itemsFor(tab) {
    if (tab === 'quick') return state.items.filter((i) => i.minutes && i.minutes <= 5).sort((a, b) => b.published - a.published);
    if (tab === 'foryou') {
      const topics = getTopics().map((t) => t.word);
      return state.items
        .map((item) => {
          const hay = `${item.title} ${item.summary}`.toLowerCase();
          const hits = topics.filter((w) => hay.includes(w));
          return { item, hits: hits.length };
        })
        .filter((x) => x.hits > 0)
        .sort((a, b) => b.hits - a.hits || b.item.published - a.item.published)
        .map((x) => x.item);
    }
    return state.items.filter((i) => tabOf(i).includes(tab)).sort((a, b) => b.published - a.published);
  }

  async function load({ force = false } = {}) {
    const cached = store.get('discover.cache', null);
    const sameFeeds = cached && JSON.stringify(cached.urls) === JSON.stringify(allUrls());
    if (!force && sameFeeds && Date.now() - cached.t < TTL) { state.items = cached.items; render(); return; }
    if (cached?.items && sameFeeds) { state.items = cached.items; } // show the old list while refreshing
    state.loading = true;
    state.error = '';
    render();
    try {
      const res = await api.fetchFeeds(allUrls());
      if (!res.ok) throw new Error(res.error);
      if (res.items.length) {
        state.items = res.items;
        store.set('discover.cache', { t: Date.now(), urls: allUrls(), items: res.items.slice(0, 160).map((i) => ({ ...i, image: '' })) });
      } else if (!state.items.length) {
        state.error = res.errors.length ? 'voxo could not reach the news feeds. Check your connection and try again.' : 'No stories found.';
      }
    } catch (error) {
      if (!state.items.length) state.error = error.message || 'Could not load stories.';
    }
    state.loading = false;
    render();
  }

  function card(item) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'discover-card';
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
    button.append(meta, title);
    if (item.summary) {
      const summary = document.createElement('div');
      summary.className = 'discover-summary';
      summary.textContent = item.summary;
      button.append(summary);
    }
    const listen = document.createElement('div');
    listen.className = 'discover-listen';
    listen.append(icon('headphones'), 'Listen');
    button.append(listen);
    button.addEventListener('click', () => openUrl(item.link));
    return button;
  }

  function render() {
    const tabs = visibleTabs();
    if (!tabs.some((t) => t.id === state.tab)) state.tab = tabs.find((t) => t.id === 'tech')?.id || tabs[0].id;
    const header = document.createElement('div');
    header.className = 'section-header';
    const h = document.createElement('h2');
    h.textContent = 'Discover something to listen to';
    const actions = document.createElement('div');
    actions.className = 'discover-actions';
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
    const refresh = document.createElement('button');
    refresh.type = 'button'; refresh.className = 'icon-btn small'; refresh.title = 'Refresh'; refresh.setAttribute('aria-label', 'Refresh stories');
    refresh.append(icon('reset'));
    refresh.disabled = state.loading;
    refresh.addEventListener('click', () => load({ force: true }));
    actions.append(add, refresh);
    header.append(h, actions);

    const tabRow = document.createElement('div');
    tabRow.className = 'chip-row discover-tabs';
    tabRow.setAttribute('role', 'tablist');
    for (const tab of tabs) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `chip${tab.id === state.tab ? ' is-active' : ''}`;
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', String(tab.id === state.tab));
      chip.append(icon(tab.icon), tab.short || tab.label);
      chip.title = tab.label;
      chip.addEventListener('click', () => { state.tab = tab.id; state.shown = 6; store.set('discover.tab', tab.id); render(); });
      tabRow.append(chip);
    }

    const body = document.createElement('div');
    const list = itemsFor(state.tab);
    if (state.loading && !state.items.length) {
      body.className = 'discover-grid';
      for (let i = 0; i < 6; i++) { const s = document.createElement('div'); s.className = 'discover-card skeleton'; body.append(s); }
    } else if (state.error) {
      body.className = 'empty-state compact';
      const p = document.createElement('p'); p.className = 'empty-copy'; p.textContent = state.error;
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'btn btn-secondary btn-sm'; retry.textContent = 'Try again';
      retry.addEventListener('click', () => load({ force: true }));
      body.append(p, retry);
    } else if (!list.length) {
      body.className = 'empty-state compact';
      const p = document.createElement('p'); p.className = 'empty-copy';
      p.textContent = state.tab === 'quick' ? 'No short reads in the feeds right now. Try another tab or refresh.' : 'Nothing here yet.';
      body.append(p);
    } else {
      body.className = 'discover-grid';
      body.append(...list.slice(0, state.shown).map(card));
      if (list.length > state.shown) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'btn btn-ghost btn-sm discover-more'; more.textContent = `Show more (${list.length - state.shown})`;
        more.addEventListener('click', () => { state.shown += 6; render(); });
        body.append(more);
      }
    }
    root.replaceChildren(header, tabRow, body);
    root.hidden = false;
  }

  return { load, render, get items() { return state.items; } };
}
