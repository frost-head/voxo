import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
import {
  api, $, store, clamp, debounce, NOTE_COLORS, buildSwatches, confirmTwice, formatLibraryDate,
  formatRelativeDate, sourceTypeLabel, showError, hideError, toast, wordCount,
} from './common.js';
import { renderMarkdown, setLinkHandlers } from './markdown.js';
import { initTopic } from './topic.js';
import { linkIndex } from './links.js';
import { initNotesWorkspace, noteHeading } from './notes-workspace.js';
import { icon, setIcon, hydrateIcons } from './icons.js';
import { addListening, addFinished, addWords, addTopics, topicsOf, getStats } from './stats.js';
import { initDiscover } from './discover.js';
import { initPalette } from './palette.js';
import { detectLanguage, LANGUAGE_NAMES } from './lang.js';
import { createMarkdownEditor } from './md-editor.js';
import { headingsOf, buildEntry, insertEntry } from './note-target.js';
import { keyFor } from './links.js';
import { createFigureRenderer } from './pdf-figures.js';
import { persona, personaLabel } from './voices.js';
import { createAmbient, SOUNDS } from './ambient.js';

hydrateIcons();

// Show ⌘ on Mac and Ctrl elsewhere in every keyboard hint.
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
for (const node of document.querySelectorAll('kbd, .hint-text, [title]')) {
  const swap = (t) => (isMac ? t.replace(/Ctrl\/⌘|Ctrl/g, '⌘') : t.replace(/Ctrl\/⌘|⌘/g, 'Ctrl').replace(/Ctrl(?=[A-Z])/, 'Ctrl '));
  if (node.title) node.title = swap(node.title);
  if (node.children.length === 0 && node.textContent) node.textContent = swap(node.textContent);
}

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
const standardFontDataUrl = 'voxo-pdf://pdfjs/standard_fonts/';
const cMapUrl = 'voxo-pdf://pdfjs/cmaps/';

const pdfFigures = createFigureRenderer({ standardFontDataUrl, cMapUrl });

const els = {
  // navigation
  navRead: $('#nav-read'), navNotes: $('#nav-notes-workspace'), navLibrary: $('#nav-library-workspace'), navDiscover: $('#nav-discover'), discoverView: $('#discover-view'),
  barTitle: $('#bar-title'), barSub: $('#bar-sub'), omniboxWrap: $('#omnibox-wrap'), barSearch: $('#bar-search'),
  themeToggle: $('#theme-toggle'), focusToggle: $('#focus-toggle'), focusExit: $('#focus-exit'), focusControls: $('#focus-controls'), focusNotes: $('#focus-notes'), sleepPill: $('#sleep-pill'), loader: $('#loader'),
  sidebarToggle: $('#sidebar-toggle'), sidebarSaved: $('#sidebar-saved'), sidebarSavedGroup: $('#sidebar-saved-group'),
  langChip: $('#lang-chip'), langChipLabel: $('#lang-chip-label'), langSelect: $('#lang-select'), langMode: $('#lang-mode'), langDetected: $('#lang-detected'), notesResizer: $('#notes-resizer'),
  addReading: $('#add-reading-btn'), paletteBtn: $('#palette-btn'), countNotes: $('#count-notes'), countArchive: $('#count-archive'),
  scroller: $('#scroller'), notesView: $('#notes-workspace-view'), libraryView: $('#library-workspace-view'),
  brandBtn: $('#brand-btn'), sidebarRecents: $('#sidebar-recents'),
  settingsBtn: $('#settings-btn'), shortcutsBtn: $('#shortcuts-btn'),
  // top bar
  form: $('#url-form'), url: $('#url'), go: $('#go'), textOpen: $('#text-open'), pdfOpen: $('#pdf-open'),
  notesToggle: $('#notes-toggle'), notesCountBadge: $('#notes-count-badge'),
  // home
  empty: $('#empty'), heroForm: $('#hero-form'), heroUrl: $('#hero-url'), heroGo: $('#hero-go'),
  greetingEyebrow: $('#greeting-eyebrow'), greeting: $('#greeting'), greetingSub: $('#greeting-sub'), stats: $('#stats'), heroSample: $('#hero-sample-btn'),
  readerTip: $('#reader-tip'), tipDismiss: $('#tip-dismiss'), finishCard: $('#finish-card'),
  heroTextBtn: $('#hero-text-btn'), heroPdfBtn: $('#hero-pdf-btn'), heroViewAll: $('#hero-recent-view-all'),
  resumeSection: $('#resume-section'), resumeCard: $('#resume-card'), recentSection: $('#recent-section'), recentStack: $('#recent-stack'),
  // article
  article: $('#article'), marker: $('#marker'), sourceLabel: $('#source-label'), bookmarkToggle: $('#bookmark-toggle'),
  title: $('#title'), meta: $('#meta'), body: $('#body'),
  pdfPreview: $('#pdf-preview'), pdfPreviewTitle: $('#pdf-preview-title'), pdfPreviewPages: $('#pdf-preview-pages'), pdfPreviewMore: $('#pdf-preview-more'),
  // notes pane
  notesPane: $('#notes-pane'), notesPaneClose: $('#notes-pane-close'), paneExport: $('#pane-export'),
  noteForm: $('#note-form'), noteQuote: $('#note-composer-quote'), noteBody: $('#note-body'), noteSubmit: $('#note-submit'),
  noteFooter: $('#note-composer-footer'), composerColors: $('#composer-colors'),
  copyLink: $('#copy-link'), noteTarget: $('#note-target'), noteWhere: $('#note-where'), noteWhereRow: $('#note-where-row'), selAdd: $('#selection-add'),
  anchorReset: $('#anchor-reset'), anchorDot: $('#anchor-dot'), anchorLabel: $('#anchor-label'),
  notesList: $('#article-notes-list'), notesEmpty: $('#article-notes-empty'),
  // selection toolbar, drop overlay
  selToolbar: $('#selection-toolbar'), selColors: $('#selection-colors'), selNote: $('#selection-note'), selCopy: $('#selection-copy'),
  dropOverlay: $('#drop-overlay'),
  // archive
  libSearch: $('#lib-search-input'), libClear: $('#library-clear-btn'), libList: $('#library-list'),
  libEmpty: $('#library-empty'), libEmptyTitle: $('#library-empty-title'), libEmptyHint: $('#library-empty-hint'),
  // dock
  progressBar: $('#progress-bar'), nowTitle: $('#now-title'), readoutBtn: $('#readout'),
  prev: $('#prev'), play: $('#play'), next: $('#next'), status: $('#status'), left: $('#left'),
  speed: $('#speed'), speedValue: $('#speed-value'), fill: $('#progress-fill'), sleep: $('#sleep-timer'),
  // dialogs
  textDialog: $('#text-dialog'), textForm: $('#text-form'), customText: $('#custom-text'), textCancel: $('#text-cancel'),
  textSubmit: $('#text-submit'), textCount: $('#custom-text-count'),
  settingsDialog: $('#settings-dialog'), settingsClose: $('#settings-close'),
  shortcutsDialog: $('#shortcuts-dialog'), shortcutsClose: $('#shortcuts-close'),
  themeSeg: $('#theme-seg'), voiceList: $('#voice-list'), ambientSeg: $('#ambient-seg'), ambientVolume: $('#ambient-volume'), ambientVolumeValue: $('#ambient-volume-value'), resetReading: $('#reset-reading'), fontStyle: $('#font-style'), fontSize: $('#font-size'), fontSizeValue: $('#font-size-value'),
  lineWidth: $('#line-width'), lineWidthValue: $('#line-width-value'), lineSpacing: $('#line-spacing'), lineSpacingValue: $('#line-spacing-value'),
  autoScroll: $('#auto-scroll'), allowDownload: $('#allow-download'), log: $('#log'),
};

const readout = els.readoutBtn;
const WORDS_PER_MINUTE = 150;
const AHEAD = 4;                 // chunks synthesized in advance, so playback never waits
const MAX_CACHED = 100;          // prepared clips kept (about 70 MB); going back replays them instantly
const PDF_PREVIEW_BATCH_SIZE = 8;
const INLINE_TAGS = new Set(['strong', 'em', 'mark', 'code', 'kbd', 'sup', 'sub', 'del', 'ins', 'small', 'abbr', 'p', 'br', 'span', 'a']);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const systemDarkMode = window.matchMedia('(prefers-color-scheme: dark)');

// ---------------------------------------------------------------- state

const state = {
  blocks: [],        // { data, el, firstUnit, speakNumber }
  units: [],         // { blockIndex, text, startWords }
  totalWords: 0,
  speakableBlocks: 0,
  pos: 0,
  loaded: -1,
  currentBlock: -1,
  playing: false,
  phase: 'empty',    // empty | ready | preparing | reading | paused | done
  gen: 0,
  voice: null,
  lang: 'en',
  langOverride: null,
  detected: null,
  speed: clamp(store.get('speed', 1), 0.6, 2.4, 1),
  libraryItemId: null,
  url: '',
  title: '',
  isSaved: false,
  view: 'read',
  notesPaneOpen: store.get('ui.notesPaneOpen', false),
  lastColor: NOTE_COLORS.includes(store.get('ui.lastColor', 'yellow')) ? store.get('ui.lastColor', 'yellow') : 'yellow',
};

const readingSettings = {
  theme: ['system', 'light', 'dark'].includes(store.get('reading.theme', 'system')) ? store.get('reading.theme', 'system') : 'system',
  font: ['serif', 'literary', 'classic', 'sans', 'humanist', 'mono'].includes(store.get('reading.font', 'serif')) ? store.get('reading.font', 'serif') : 'serif',
  fontSize: clamp(store.get('reading.fontSize', 20), 16, 28, 20),
  lineWidth: clamp(store.get('reading.lineWidth', 72), 50, 112, 72),
  lineSpacing: Math.round(clamp(store.get('reading.lineSpacing', 1.8), 1.4, 2.2, 1.8) * 10) / 10,
  autoScroll: store.get('reading.autoScroll', true) !== false,
};

let voicesInfo = null;
let syncAmbientPlayback = null; // set once the ambient mixer exists
let langMode = store.get('lang.mode', 'auto'); // 'auto' or a language code
let pdfPreviewState = null;
let pendingNote = null;     // anchor chosen for the composer
let composerColor = state.lastColor;
let currentNotes = [];
let activeLibrarySection = 'history';

const audio = new Audio();
let topicsKey = null;
let topicTicks = 0;
setInterval(() => {
  if (!(state.playing && !audio.paused && !audio.ended)) return;
  addListening(5);
  // Once you have really listened (about 30 seconds) to a reading, its topics count toward your insights.
  const key = state.libraryItemId || state.title;
  if (key !== topicsKey) { topicsKey = key; topicTicks = 0; }
  if (++topicTicks === 6) addTopics(topicsOf(state.title, state.units.map((u) => u.text).join(' ')));
}, 5000);
let cache = new Map();      // unit index -> { url, promise }

// ---------------------------------------------------------------- views

const notesWorkspace = initNotesWorkspace({
  openSource: (note) => openLibraryItem(note.itemId, note),
  openTopic: (name) => topic.open(name),
  openArticle: (id, blockIndex) => openLibraryItem(id, null, { blockIndex }),
  listenNotes: (payload) => listenToNotes(payload),
});

/** Read your own notes aloud. It opens like a reading, but is not added to your library. */
async function listenToNotes({ title, notes }) {
  hideError();
  renderStatus('Preparing your notes…');
  els.loader.hidden = false;
  const res = await api.loadNotes(title, notes);
  els.loader.hidden = true;
  if (!res.ok) { showError(res.error); setPhase(state.phase); return; }
  await setView('read');
  renderArticle(res);
  els.sourceLabel.textContent = 'Your notes';
  updateBar();
  play();
}

// Topic view + [[wiki links]] + #tags: one place decides what a click on any of them does.
const topic = initTopic({
  openNote: async (note) => { await setView('notes'); await notesWorkspace.goToNote(note.id); },
  openArticle: (id, blockIndex) => openLibraryItem(id, null, { blockIndex }),
});
setLinkHandlers({
  resolve: (target) => linkIndex.resolve(target),
  tag: (name) => topic.open(name),
  wikilink: async (target) => {
    const hit = linkIndex.resolve(target);
    if (hit?.type === 'article') { openLibraryItem(hit.id, null, hit.blockIndex ? { blockIndex: hit.blockIndex } : undefined); return; }
    if (hit?.type === 'tag') { topic.open(hit.id); return; }
    if (hit?.type === 'note') { await setView('notes'); await notesWorkspace.goToNote(hit.id); return; }
    if (/^[na]-[0-9a-f]{6,16}/i.test(target)) { toast('That note or reading no longer exists.'); return; }
    await setView('notes'); // a link written by name to something that does not exist yet: create it
    const res = await api.addNote({ itemId: 'standalone', title: target });
    if (!res.ok) { showError(res.error); return; }
    toast(`Created “${target}”.`);
    await notesWorkspace.refresh();
    await notesWorkspace.goToNote(res.note.id);
  },
});
async function refreshLinkIndex() {
  const [notes, history] = await Promise.all([api.listNotes({ limit: 2000 }), api.listLibrary('history')]);
  if (notes.ok) linkIndex.setNotes(notes.notes);
  if (history.ok) linkIndex.setArticles(history.entries);
}

/** Open a story and start reading it aloud. */
async function listenToUrl(url) {
  await setView('read');
  els.url.value = url;
  await openUrl(url);
  play();
}
/** Open a story in the background and keep it in your archive, without leaving the page you are on. */
async function saveStoryToArchive(url) {
  toast('Saving…', { duration: 15000 });
  const res = await api.loadUrl(url);
  if (!res.ok) { toast(`Could not save this story: ${res.error}`, { duration: 5000 }); return false; }
  if (!res.isSaved && res.libraryItemId) {
    const toggled = await api.toggleSavedItem(res.libraryItemId);
    if (!toggled.ok) { toast(toggled.error || 'Could not save this story.'); return false; }
  }
  toast(`Saved “${res.article.title}” to your archive.`, { duration: 3500 });
  refreshHome();
  return true;
}

const discover = initDiscover({
  api,
  homeRoot: document.querySelector('#discover-section'),
  pageRoot: els.discoverView,
  openUrl: (url) => { setView('read').then(() => openUrl(url)); },
  listenUrl: listenToUrl,
  saveUrl: saveStoryToArchive,
  openAll: () => setView('discover'),
  getTopics: () => getStats().topics,
});

async function setView(view) {
  if (state.view === 'notes' && view !== 'notes') await notesWorkspace.leave();
  state.view = view;
  for (const link of document.querySelectorAll('.app-sidebar .sidebar-link[data-view]')) {
    const on = link.dataset.view === view;
    link.classList.toggle('is-active', on);
    if (on) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (view !== 'read') leaveFocus();
  els.scroller.hidden = view !== 'read';
  els.notesView.hidden = view !== 'notes';
  els.libraryView.hidden = view !== 'library';
  els.discoverView.hidden = view !== 'discover';
  hideSelectionToolbar();
  applyNotesPaneVisibility();
  if (view === 'notes') notesWorkspace.show();
  if (view === 'library') loadLibrary(activeLibrarySection);
  if (view === 'discover') discover.showPage();
  updateBar();
}

els.navRead.dataset.view = 'read';
els.navNotes.dataset.view = 'notes';
els.navLibrary.dataset.view = 'library';
els.navDiscover.dataset.view = 'discover';
els.navDiscover.addEventListener('click', () => setView('discover'));
els.navRead.addEventListener('click', () => setView('read'));
els.navNotes.addEventListener('click', () => setView('notes'));
els.navLibrary.addEventListener('click', () => setView('library'));
els.brandBtn.addEventListener('click', () => { goHome(); });
els.heroTextBtn.addEventListener('click', () => openTextDialog());
els.heroPdfBtn.addEventListener('click', () => openPdf());
els.heroSample.addEventListener('click', () => openText(SAMPLE_TEXT));
els.tipDismiss.addEventListener('click', () => { els.readerTip.hidden = true; store.set('tipSeen', true); });
function focusAddReading() {
  if (state.view === 'read' && els.article.hidden) { els.heroUrl.focus(); return; }
  setView('read').then(() => { if (els.article.hidden) els.heroUrl.focus(); else { els.url.focus(); els.url.select(); } });
}
els.addReading.addEventListener('click', focusAddReading);
els.readoutBtn.addEventListener('click', () => { if (state.currentBlock >= 0) { setView('read'); state.blocks[state.currentBlock]?.el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' }); } });
els.heroViewAll.addEventListener('click', () => setView('library'));
els.settingsBtn.addEventListener('click', () => els.settingsDialog.showModal());
els.settingsClose.addEventListener('click', () => els.settingsDialog.close());
els.shortcutsBtn.addEventListener('click', () => els.shortcutsDialog.showModal());
els.shortcutsClose.addEventListener('click', () => els.shortcutsDialog.close());

function updateBar() {
  const reading = state.view === 'read' && !els.article.hidden;
  const titles = { read: reading ? 'Now reading' : 'Home', discover: 'Discover', notes: 'Notes', library: 'Archive' };
  els.barTitle.textContent = titles[state.view];
  els.barSub.textContent = reading ? els.sourceLabel.textContent : '';
  els.omniboxWrap.hidden = !reading;
  els.barSearch.hidden = reading;
  els.focusToggle.hidden = !reading;
  els.notesToggle.hidden = !(reading && state.libraryItemId);
}

let notesOpenBeforeFocus = false;
function enterFocus() {
  if (state.view !== 'read' || els.article.hidden || document.body.classList.contains('focus-mode')) return;
  notesOpenBeforeFocus = state.notesPaneOpen;
  document.body.classList.add('focus-mode');
  els.focusControls.hidden = false;
  els.focusNotes.hidden = !state.libraryItemId;
  state.notesPaneOpen = false; // start clean and centered; Notes (or Ctrl/⌘ J) brings the pane back
  applyNotesPaneVisibility();
  toast('Focus mode. Press Esc to bring everything back.', { duration: 2500 });
}
function leaveFocus() {
  if (!document.body.classList.contains('focus-mode')) return;
  document.body.classList.remove('focus-mode');
  els.focusControls.hidden = true;
  toggleNotesPane(notesOpenBeforeFocus);
}
els.focusNotes.addEventListener('click', () => toggleNotesPane());
els.focusToggle.addEventListener('click', enterFocus);
els.focusExit.addEventListener('click', leaveFocus);

function goHome() {
  stopEverything();
  saveProgressNow();
  clearPdfPreview();
  clearActiveNoteAnchor();
  state.libraryItemId = null;
  state.blocks = [];
  state.units = [];
  currentNotes = [];
  els.article.hidden = true;
  els.empty.hidden = false;
  els.finishCard.hidden = true;
  leaveFocus();
  document.title = 'voxo';
  setPhase('empty');
  syncButtons();
  updateProgress();
  refreshHome();
  setView('read');
  els.scroller.scrollTop = 0;
}

// ---------------------------------------------------------------- status

function setPhase(phase) {
  state.phase = phase;
  renderStatus();
}

function renderStatus(override) {
  const unit = state.units[state.pos];
  const block = unit && state.blocks[unit.blockIndex];
  const where = block && block.speakNumber ? `paragraph ${block.speakNumber} of ${state.speakableBlocks}` : '';
  const text = {
    empty: 'Choose something to read.',
    ready: 'Ready. Press play or click a paragraph.',
    preparing: 'Preparing the voice…',
    reading: where ? `Reading ${where}` : 'Reading',
    paused: where ? `Paused at ${where}` : 'Paused',
    done: 'Finished.',
  }[state.phase];
  els.status.textContent = override || text;
  els.nowTitle.textContent = state.units.length ? state.title : '';
  readout.classList.toggle('busy', state.phase === 'preparing' || Boolean(override));
}

function updateProgress() {
  const unit = state.units[state.pos];
  const spoken = unit ? unit.startWords : 0;
  const remaining = Math.max(0, state.totalWords - spoken);
  const minutes = remaining / (WORDS_PER_MINUTE * state.speed);
  els.progressBar.setAttribute('aria-valuenow', String(Math.round(state.totalWords ? Math.min(100, spoken / state.totalWords * 100) : 0)));
  els.fill.style.width = state.totalWords ? `${Math.min(100, (state.phase === 'done' ? 1 : spoken / state.totalWords) * 100)}%` : '0';
  if (!state.units.length || state.phase === 'done') els.left.textContent = '';
  else els.left.textContent = minutes < 1 ? 'Under a minute left' : `About ${Math.round(minutes)} min left`;
}

function syncButtons() {
  const hasArticle = state.units.length > 0;
  els.play.disabled = els.prev.disabled = els.next.disabled = !hasArticle;
  document.body.classList.toggle('no-reading', !hasArticle);
  els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  els.play.setAttribute('aria-pressed', String(state.playing));
  els.play.classList.toggle('is-playing', state.playing);
  syncAmbientPlayback?.();
}

// ---------------------------------------------------------------- text offsets (shared by notes and highlights)

const insideAction = (node) => Boolean(node.parentElement?.closest('.note-action'));

function textNodesOf(el) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (insideAction(node) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
  return nodes;
}

const blockText = (el) => textNodesOf(el).map((n) => n.data).join('');

/** Character offset of a DOM boundary inside `el`'s readable text. */
function offsetWithin(el, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(el);
  try { range.setEnd(container, offset); } catch { return null; }
  let total = 0;
  for (const node of textNodesOf(el)) {
    if (!range.intersectsNode(node)) break;
    total += node === range.endContainer ? range.endOffset : node.data.length;
  }
  return total;
}

function rangeFromOffsets(el, start, end) {
  let position = 0;
  let from = null;
  let to = null;
  for (const node of textNodesOf(el)) {
    const length = node.data.length;
    if (!from && start < position + length) from = { node, offset: start - position };
    if (from && end <= position + length) { to = { node, offset: end - position }; break; }
    position += length;
  }
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}

function blockOf(node) {
  const element = node?.nodeType === 1 ? node : node?.parentElement;
  const block = element?.closest('.block[data-block]');
  return block && els.article.contains(block) ? block : null;
}

/** The current text selection as a note anchor, or null. */
function selectionAnchor() {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const startEl = blockOf(range.startContainer);
  if (!startEl) return null;
  const index = Number(startEl.dataset.block);
  if (!state.blocks[index] || state.blocks[index].data.type === 'image') return null;
  const text = blockText(startEl);
  let start = offsetWithin(startEl, range.startContainer, range.startOffset);
  let end = startEl.contains(range.endContainer) ? offsetWithin(startEl, range.endContainer, range.endOffset) : text.length;
  if (start === null || end === null) return null;
  while (start < end && /\s/.test(text[start])) start += 1;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  if (end <= start) return null;
  return { blockIndex: index, startOffset: start, endOffset: end, quote: text.slice(start, end), rect: range.getBoundingClientRect() };
}

function blockAnchor(index) {
  const entry = state.blocks[index];
  return {
    blockIndex: index,
    startOffset: null,
    endOffset: null,
    quote: entry?.el ? blockText(entry.el).trim() : String(entry?.data?.text || '').trim(),
  };
}

// ---------------------------------------------------------------- article rendering

function inlineNodes(runs) {
  return (runs || []).flatMap((run) => {
    if (Object.hasOwn(run, 'text')) return [document.createTextNode(run.text)];
    if (!INLINE_TAGS.has(run.tag)) return inlineNodes(run.children);
    const el = document.createElement(run.tag);
    if (run.tag === 'a') {
      el.className = 'inline-link';
      el.href = run.href || '#';
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
    } else if (run.tag === 'span' && run.className === 'inline-link') {
      el.className = 'inline-link';
    }
    el.append(...inlineNodes(run.children));
    return [el];
  });
}

function elementFor(block) {
  let el;
  if (block.type === 'image' && block.pdf) return pdfFigures.mount(block, els.scroller);
  if (block.type === 'image') {
    el = document.createElement('figure');
    el.className = 'image-block';
    const image = document.createElement('img');
    image.alt = block.alt || '';
    if (block.srcSet) image.srcset = block.srcSet;
    image.sizes = '(max-width: 40rem) calc(100vw - 3rem), (max-width: 73.5rem) 92vw, 70rem';
    image.src = block.src;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('load', () => { if (image.naturalWidth && image.naturalWidth < 360) el.classList.add('is-small'); }, { once: true });
    image.addEventListener('error', () => {
      const caption = document.createElement('figcaption');
      caption.textContent = block.alt ? `Image unavailable: ${block.alt}` : 'Image unavailable';
      el.replaceChildren(caption);
      el.classList.add('image-unavailable');
    }, { once: true });
    el.appendChild(image);
    return el;
  }
  if (block.type === 'heading') el = document.createElement(`h${Math.min(Math.max(block.level, 2), 4)}`);
  else if (block.type === 'code') el = document.createElement('pre');
  else if (block.type === 'quote') el = document.createElement('blockquote');
  else el = document.createElement('p');

  if (block.type === 'li') {
    el.className = `item${block.marker ? ' ordered' : ''}`;
    if (block.marker) el.dataset.marker = block.marker;
    const depth = Math.min(Math.max(Number(block.level) || 0, 0), 6);
    el.style.setProperty('--list-indent', `${depth * 0.9}rem`);
  }
  if (block.type === 'caption') el.className = 'caption';

  if (block.inline) el.replaceChildren(...inlineNodes(block.inline));
  else el.textContent = block.text;
  return el;
}

function attachNoteAction(el, entry, blockIndex) {
  if (!['title', 'heading', 'p', 'li', 'quote'].includes(entry.data.type) || !state.libraryItemId) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'note-action';
  button.setAttribute('aria-label', 'Add a note to this passage');
  button.title = 'Add a note to this passage';
  const count = document.createElement('span');
  count.className = 'note-action-count';
  count.hidden = true;
  button.append(icon('pencil'), count);
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    pinAnchor(selectionAnchorIn(blockIndex) || blockAnchor(blockIndex));
  });
  el.appendChild(button);
}

function selectionAnchorIn(blockIndex) {
  const anchor = selectionAnchor();
  return anchor && anchor.blockIndex === blockIndex ? anchor : null;
}

// ---------------------------------------------------------------- PDF previews

function clearPdfPreview() {
  const previous = pdfPreviewState;
  pdfPreviewState = null;
  els.pdfPreview.open = false;
  if (previous) {
    for (const url of previous.objectUrls) URL.revokeObjectURL(url);
    const pending = previous.documentPromise;
    if (pending) pending.then((pdf) => pdf.destroy()).catch(() => {});
    else previous.document?.destroy().catch(() => {});
  }
  els.pdfPreviewPages.replaceChildren();
  els.pdfPreviewMore.hidden = true;
  els.pdfPreviewMore.disabled = false;
}

function updatePdfPreviewControls(preview) {
  if (preview !== pdfPreviewState) return;
  const rendered = preview.nextPage - 1;
  els.pdfPreviewTitle.textContent = rendered
    ? `PDF page previews — ${rendered} of ${preview.pageCount}`
    : `PDF page previews — ${preview.pageCount} pages`;
  const batchSize = preview.nextPage === 1 ? 1 : PDF_PREVIEW_BATCH_SIZE;
  const count = Math.min(batchSize, preview.pageCount - rendered);
  els.pdfPreviewMore.textContent = preview.loading
    ? 'Preparing page previews…'
    : `Show ${rendered ? 'next ' : ''}${count} ${count === 1 ? 'page' : 'pages'}`;
  els.pdfPreviewMore.disabled = preview.loading;
  els.pdfPreviewMore.hidden = rendered >= preview.pageCount;
}

async function loadPdfPreviewBatch() {
  const preview = pdfPreviewState;
  if (!preview || preview.loading || preview.nextPage > preview.pageCount) return;
  preview.loading = true;
  updatePdfPreviewControls(preview);
  try {
    if (!preview.documentPromise) {
      preview.documentPromise = pdfjsLib.getDocument({
        data: preview.data, standardFontDataUrl, cMapUrl, cMapPacked: true, useWorkerFetch: false, isEvalSupported: false,
      }).promise;
    }
    preview.document = await preview.documentPromise;
    preview.data = null;
    if (preview !== pdfPreviewState) return;

    const batchSize = preview.nextPage === 1 ? 1 : PDF_PREVIEW_BATCH_SIZE;
    const endPage = Math.min(preview.pageCount, preview.nextPage + batchSize - 1);
    for (let pageNumber = preview.nextPage; pageNumber <= endPage; pageNumber += 1) {
      if (preview !== pdfPreviewState) return;
      const page = await preview.document.getPage(pageNumber);
      const canvas = document.createElement('canvas');
      let viewport;
      let blob;
      try {
        const base = page.getViewport({ scale: 1 });
        viewport = page.getViewport({ scale: Math.min(1.5, 1100 / base.width, 1800 / base.height) });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('This window could not create a PDF preview canvas.');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.78));
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
      if (!blob) throw new Error(`Could not create a preview for page ${pageNumber}.`);
      if (preview !== pdfPreviewState) return;

      const src = URL.createObjectURL(blob);
      preview.objectUrls.push(src);
      const figure = document.createElement('figure');
      figure.className = 'pdf-page';
      const image = document.createElement('img');
      image.src = src;
      image.alt = `PDF page ${pageNumber}`;
      image.width = Math.ceil(viewport.width);
      image.height = Math.ceil(viewport.height);
      image.loading = 'lazy';
      image.decoding = 'async';
      const caption = document.createElement('figcaption');
      caption.textContent = `Page ${pageNumber}`;
      figure.append(image, caption);
      els.pdfPreviewPages.appendChild(figure);
      preview.nextPage = pageNumber + 1;
      updatePdfPreviewControls(preview);
    }
  } catch (error) {
    if (preview === pdfPreviewState) {
      if (!preview.document) preview.documentPromise = null;
      showError(`Could not render PDF page previews: ${error.message || error}`);
    }
  } finally {
    if (preview === pdfPreviewState) {
      preview.loading = false;
      updatePdfPreviewControls(preview);
    }
  }
}

els.pdfPreview.addEventListener('toggle', () => { if (els.pdfPreview.open) loadPdfPreviewBatch(); });
els.pdfPreviewMore.addEventListener('click', loadPdfPreviewBatch);

// ---------------------------------------------------------------- opening an article

function setSavedUi(isSaved) {
  state.isSaved = Boolean(isSaved);
  els.bookmarkToggle.setAttribute('aria-pressed', String(state.isSaved));
  els.bookmarkToggle.classList.toggle('is-saved', state.isSaved);
  els.bookmarkToggle.querySelector('span').textContent = state.isSaved ? 'Saved' : 'Save for later';
}

function renderArticle({ article, pdfData = null, libraryItemId = null, isSaved = false, notes = [], fileUnavailable = false, progress = null }) {
  saveProgressNow();
  clearPdfPreview();
  clearActiveNoteAnchor();
  stopEverything();
  clearAudioCache();

  state.libraryItemId = libraryItemId;
  currentNotes = sortNotes(notes || []);
  els.bookmarkToggle.hidden = !libraryItemId;
  setSavedUi(isSaved);
  applyNotesPaneVisibility();

  pdfFigures.attach(pdfData); // before the blocks are built: figures draw themselves from this file
  const hasPdfPreview = Boolean(pdfData && article.pdfPageCount);
  if (hasPdfPreview) {
    pdfPreviewState = { data: pdfData, pageCount: article.pdfPageCount, nextPage: 1, document: null, documentPromise: null, objectUrls: [], loading: false };
    updatePdfPreviewControls(pdfPreviewState);
  }

  if (article.pdfPageCount) {
    els.sourceLabel.textContent = `PDF — ${article.pdfPageCount} pages`;
  } else if (/^https?:\/\//i.test(article.url || '')) {
    let host = 'Web article';
    try { host = new URL(article.url).hostname.replace(/^www\./i, ''); } catch { /* keep fallback */ }
    els.sourceLabel.textContent = `Web article — ${host}`;
  } else {
    els.sourceLabel.textContent = 'Your text';
  }

  state.title = article.title || article.url || '';
  state.url = /^https?:\/\//i.test(article.url || '') ? article.url : '';
  els.copyLink.hidden = !state.url;
  els.title.textContent = state.title;
  els.title.dataset.title = state.title;
  const metaItems = [
    article.byline,
    article.pdfPageCount ? '' : article.siteName,
    article.words ? `${article.words.toLocaleString()} words — about ${Math.max(1, Math.round(article.words / WORDS_PER_MINUTE))} min` : '',
  ].filter(Boolean);
  els.meta.replaceChildren(...metaItems.map((text) => Object.assign(document.createElement('span'), { textContent: text })));
  els.meta.hidden = metaItems.length === 0;

  els.pdfPreview.hidden = !hasPdfPreview;
  els.pdfPreview.open = hasPdfPreview;
  els.pdfPreviewPages.replaceChildren();

  clearWordHighlight();
  state.blocks = [];
  state.units = [];
  state.totalWords = 0;
  state.speakableBlocks = 0;

  const fragment = document.createDocumentFragment();
  article.blocks.forEach((block) => {
    const isTitle = block.type === 'title';
    const el = isTitle ? els.title : elementFor(block);
    if (!isTitle) {
      el.classList.add('block');
      fragment.appendChild(el);
    }
    const entry = { data: block, el, firstUnit: null, speakNumber: 0, tokCount: 0 };
    const blockIndex = state.blocks.push(entry) - 1;
    el.dataset.block = String(blockIndex);
    attachNoteAction(el, entry, blockIndex);

    if (block.speak && block.chunks.length) {
      entry.firstUnit = state.units.length;
      entry.speakNumber = ++state.speakableBlocks;
      const perChunk = block.words / block.chunks.length;
      block.chunks.forEach((text) => {
        const tokens = text.split(/\s+/).filter(Boolean).length;
        state.units.push({ blockIndex, text, startWords: state.totalWords, tokStart: entry.tokCount, tokens });
        entry.tokCount += tokens;
        state.totalWords += perChunk;
      });
    }
  });
  els.title.classList.remove('current');
  els.body.replaceChildren(fragment);
  state.langOverride = null;
  applyArticleLanguage();
  state.pos = 0;
  state.currentBlock = -1;
  els.article.classList.remove('focused');
  els.empty.hidden = true;
  els.article.hidden = false;
  els.finishCard.hidden = true;
  els.readerTip.hidden = Boolean(store.get('tipSeen', false)) || !libraryItemId;
  els.scroller.scrollTop = 0;
  updateBar();
  applyNotesPaneVisibility(); // needs the article to be visible

  syncButtons();
  setPhase(state.units.length ? 'ready' : 'empty');
  if (!state.units.length && hasPdfPreview) renderStatus('No selectable text was found. The document pages are shown below.');
  document.title = `${article.title || 'voxo'} — voxo`;

  refreshNotesUi();

  // Pick up where the reader left off.
  if (progress && progress.unit > 0 && progress.unit < state.units.length && progress.fraction < 0.98) {
    state.pos = progress.unit;
    highlight(state.pos, { force: true });
    renderStatus(`Ready to resume at paragraph ${state.blocks[state.units[state.pos].blockIndex].speakNumber}. Press play.`);
  }
  updateProgress();
  if (fileUnavailable) renderStatus('Saved PDF text opened. The original file is no longer available for page previews.');
  refreshHome();
}

// ---------------------------------------------------------------- highlights painted on the page

const sortNotes = (notes) => [...notes].sort((a, b) => a.blockIndex - b.blockIndex || (a.startOffset ?? -1) - (b.startOffset ?? -1) || a.createdAt - b.createdAt);

function paintHighlights() {
  for (const entry of state.blocks) if (entry.el) delete entry.el.dataset.hl;
  const groups = new Map();
  for (const note of currentNotes) {
    const entry = state.blocks[note.blockIndex];
    if (!entry?.el) continue;
    const color = note.color || 'yellow';
    if (note.startOffset !== null && note.endOffset !== null) {
      const range = rangeFromOffsets(entry.el, note.startOffset, note.endOffset);
      if (range) {
        if (!groups.has(color)) groups.set(color, []);
        groups.get(color).push(range);
        continue;
      }
    }
    entry.el.dataset.hl = color; // whole-passage note, or a passage whose text changed
  }
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== 'function') return;
  for (const color of NOTE_COLORS) {
    if (groups.has(color)) CSS.highlights.set(`voxo-hl-${color}`, new Highlight(...groups.get(color)));
    else CSS.highlights.delete(`voxo-hl-${color}`);
  }
}

function applyBlockNoteCounters() {
  state.blocks.forEach((entry, i) => {
    const badge = entry.el?.querySelector('.note-action-count');
    if (!badge) return;
    const count = currentNotes.filter((n) => n.blockIndex === i && n.body).length;
    badge.textContent = String(count);
    badge.hidden = count === 0;
    entry.el.classList.toggle('has-notes', count > 0);
  });
}

function refreshNotesUi() {
  const textNotes = currentNotes.filter((n) => n.body).length;
  els.notesCountBadge.textContent = String(currentNotes.length);
  els.notesCountBadge.hidden = currentNotes.length === 0;
  els.notesCountBadge.title = `${currentNotes.length} items, ${textNotes} with notes`;
  renderNotesList();
  applyBlockNoteCounters();
  paintHighlights();
}

// ---------------------------------------------------------------- notes pane

function applyNotesPaneVisibility() {
  const visible = state.view === 'read' && Boolean(state.libraryItemId) && state.notesPaneOpen && !els.article.hidden;
  document.body.classList.toggle('notes-pane-open', visible);
  els.notesPane.hidden = !visible;
  els.notesToggle.setAttribute('aria-pressed', String(visible));
  els.focusNotes.setAttribute('aria-pressed', String(visible));
  if (visible) syncComposerToPlayback();
}

function toggleNotesPane(open) {
  state.notesPaneOpen = open === undefined ? !state.notesPaneOpen : open;
  store.set('ui.notesPaneOpen', state.notesPaneOpen);
  applyNotesPaneVisibility();
}

els.notesToggle.addEventListener('click', () => toggleNotesPane());
els.notesPaneClose.addEventListener('click', () => toggleNotesPane(false));

const composerSwatches = buildSwatches(els.composerColors, { selected: composerColor, onPick: (color) => { composerColor = color || 'yellow'; } });
composerSwatches.set(composerColor);

function clearHighlightsOfAnchor() {
  document.querySelectorAll('.note-target').forEach((el) => el.classList.remove('note-target'));
  if (globalThis.CSS?.highlights) CSS.highlights.delete('voxo-note-anchor');
}

function clearActiveNoteAnchor() {
  clearHighlightsOfAnchor();
  pendingNote = null;
  els.noteQuote.hidden = true;
  els.anchorReset.hidden = true;
  els.anchorDot.classList.remove('is-locked');
  els.noteBody.value = '';
  checkComposer();
}

function showAnchorOnPage(anchor) {
  clearHighlightsOfAnchor();
  const entry = state.blocks[anchor.blockIndex];
  if (!entry?.el) return;
  entry.el.classList.add('note-target');
  if (anchor.startOffset !== null && anchor.endOffset !== null && globalThis.CSS?.highlights && typeof globalThis.Highlight === 'function') {
    const range = rangeFromOffsets(entry.el, anchor.startOffset, anchor.endOffset);
    if (range) CSS.highlights.set('voxo-note-anchor', new Highlight(range));
  }
}

function pinAnchor(anchor) {
  if (!state.libraryItemId || !anchor) return;
  toggleNotesPane(true);
  loadNoteTargets();
  pendingNote = { blockIndex: anchor.blockIndex, startOffset: anchor.startOffset, endOffset: anchor.endOffset, quote: anchor.quote };
  showAnchorOnPage(pendingNote);
  const entry = state.blocks[anchor.blockIndex];
  els.noteQuote.textContent = pendingNote.quote;
  els.noteQuote.hidden = !pendingNote.quote;
  els.anchorDot.classList.add('is-locked');
  els.anchorLabel.textContent = entry?.speakNumber ? `Pinned to paragraph ${entry.speakNumber}` : 'Pinned to this passage';
  els.anchorReset.hidden = false;
  checkComposer();
  els.noteBody.focus();
}

function syncComposerToPlayback() {
  if (pendingNote || els.notesPane.hidden) return;
  const index = state.currentBlock >= 0 ? state.currentBlock : state.blocks.findIndex((b) => b.firstUnit !== null);
  const entry = state.blocks[index];
  els.anchorLabel.textContent = entry?.speakNumber ? `Following playback · paragraph ${entry.speakNumber}` : 'Following playback';
  els.anchorDot.classList.remove('is-locked');
}

// ---- save to: this reading, or a note you already have (a bug log, a research list…)
let targetNotes = [];
async function loadNoteTargets() {
  const res = await api.listNotes({ itemId: 'standalone', limit: 300 });
  targetNotes = res.ok ? res.notes : [];
  const want = els.noteTarget.value;
  els.noteTarget.replaceChildren(new Option('This reading', ''));
  if (targetNotes.length) {
    const group = document.createElement('optgroup');
    group.label = 'Add to one of my notes';
    for (const n of targetNotes) group.append(new Option(noteHeading(n), n.id));
    els.noteTarget.append(group);
  }
  els.noteTarget.value = targetNotes.some((n) => n.id === want) ? want : '';
  fillWhere();
}
function fillWhere() {
  const note = targetNotes.find((n) => n.id === els.noteTarget.value);
  els.noteWhereRow.hidden = !note;
  if (!note) return;
  const heads = headingsOf(note.body);
  els.noteWhere.replaceChildren(new Option('End of the note', '-1'), ...heads.map((h) => new Option(`Under ${'·'.repeat(h.level - 1)}“${h.text}”`, String(h.line))));
}
els.noteTarget.addEventListener('change', () => { if (els.noteTarget.value) store.set('ui.noteTarget', els.noteTarget.value); fillWhere(); checkComposer(); });

function checkComposer() {
  const hasText = els.noteBody.value.trim().length > 0;
  els.noteSubmit.disabled = !hasText && !(els.noteTarget.value && pendingNote);
  const expanded = hasText || Boolean(pendingNote) || document.activeElement === els.noteBody;
  els.noteFooter.hidden = !expanded;
  els.noteBody.rows = expanded ? 3 : 2;
}

els.noteBody.addEventListener('input', checkComposer);
els.noteBody.addEventListener('focus', checkComposer);
els.anchorReset.addEventListener('click', () => { clearActiveNoteAnchor(); syncComposerToPlayback(); });

/** Adds the pinned passage (and what you wrote) to a note you already have, and highlights the passage in the reading. */
async function saveToExistingNote(targetId, comment) {
  const anchor = pendingNote;
  const target = targetNotes.find((n) => n.id === targetId);
  if (!anchor?.quote || !target) { showError('Select the passage you want to add first.'); return; }
  els.noteSubmit.disabled = true;
  const latest = await api.listNotes({ itemId: 'standalone', ids: [targetId], limit: 1 }); // the note may have been edited since
  const current = latest.ok && latest.notes[0] ? latest.notes[0] : target;
  const entry = buildEntry({ quote: anchor.quote, sourceKey: keyFor('article', state.libraryItemId, anchor.blockIndex), sourceTitle: state.title, comment });
  const updated = await api.updateNote(targetId, { body: insertEntry(current.body, entry, Number(els.noteWhere.value || -1)) });
  if (!updated.ok) { checkComposer(); showError(updated.error); return; }
  // The passage stays marked in the reading, so you can see what you have collected.
  const mark = await api.addNote({
    itemId: state.libraryItemId, blockIndex: anchor.blockIndex, startOffset: anchor.startOffset, endOffset: anchor.endOffset,
    quote: anchor.quote, body: '', color: composerColor,
  });
  if (mark.ok) currentNotes = sortNotes([...currentNotes, mark.note]);
  clearActiveNoteAnchor();
  syncComposerToPlayback();
  refreshNotesUi();
  await Promise.all([loadNoteTargets(), refreshLinkIndex(), notesWorkspace.refresh()]);
  store.set('ui.noteTarget', targetId);
  els.noteTarget.value = ''; // the next note goes to this reading again, unless you choose otherwise
  fillWhere();
  toast(`Added to “${noteHeading(updated.note)}”.`, { duration: 3500 });
  checkComposer();
}

async function saveComposerNote() {
  const body = els.noteBody.value.trim();
  if (els.noteTarget.value && state.libraryItemId) {
    await saveToExistingNote(els.noteTarget.value, body);
    els.noteBody.value = '';
    checkComposer();
    return;
  }
  if (!body || !state.libraryItemId) return;
  const anchor = pendingNote || blockAnchor(state.currentBlock >= 0 ? state.currentBlock : Math.max(0, state.blocks.findIndex((b) => b.firstUnit !== null)));
  els.noteSubmit.disabled = true;
  const res = await api.addNote({
    itemId: state.libraryItemId, blockIndex: anchor.blockIndex, startOffset: anchor.startOffset, endOffset: anchor.endOffset,
    quote: anchor.quote, body, color: composerColor,
  });
  checkComposer();
  if (!res.ok) { showError(res.error); return; }
  currentNotes = sortNotes([...currentNotes, res.note]);
  clearActiveNoteAnchor();
  syncComposerToPlayback();
  refreshNotesUi();
  refreshHome();
}

els.noteForm.addEventListener('submit', (event) => { event.preventDefault(); saveComposerNote(); });
els.noteBody.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); saveComposerNote(); }
  else if (event.key === 'Escape') {
    event.stopPropagation();
    if (!els.noteBody.value.trim()) { clearActiveNoteAnchor(); syncComposerToPlayback(); }
    els.noteBody.blur();
  }
});

function noteLocation(note) {
  const entry = state.blocks[note.blockIndex];
  if (entry?.data.type === 'title') return 'Title';
  return entry?.speakNumber ? `¶ ${entry.speakNumber}` : 'Passage';
}

function focusNoteOnPage(note) {
  const entry = state.blocks[note.blockIndex];
  if (!entry?.el) return;
  showAnchorOnPage(note);
  entry.el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  document.querySelectorAll('.note-card').forEach((card) => card.classList.toggle('is-active', card.dataset.id === note.id));
}

async function openNoteInEditor(note) {
  await setView('notes');
  await notesWorkspace.openNote(note.id);
}

function makeNoteCard(note) {
  const li = document.createElement('li');
  li.className = 'note-card';
  li.dataset.id = note.id;
  li.dataset.block = String(note.blockIndex);
  li.dataset.color = note.color || 'yellow';
  if (note.blockIndex === state.currentBlock) li.classList.add('is-speaking');

  const top = document.createElement('div');
  top.className = 'note-card-top';
  const loc = document.createElement('button');
  loc.type = 'button';
  loc.className = 'note-card-loc';
  loc.title = 'Show in the text';
  loc.textContent = `${noteLocation(note)}${note.body ? '' : ' · highlight'}`;
  loc.addEventListener('click', (event) => { event.stopPropagation(); focusNoteOnPage(note); });
  const tools = document.createElement('span');
  tools.className = 'note-card-tools';

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'note-card-btn';
  edit.title = note.body ? 'Edit note' : 'Add a note to this highlight';
  edit.setAttribute('aria-label', edit.title);
  edit.append(icon('pencil'));
  edit.addEventListener('click', (event) => { event.stopPropagation(); startEdit(li, note); });

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'note-card-btn';
  del.title = 'Delete';
  del.setAttribute('aria-label', 'Delete');
  del.append(icon('trash'));
  del.addEventListener('click', (event) => { event.stopPropagation(); deleteNoteWithUndo(note); });
  tools.append(edit, del);
  top.append(loc, tools);
  li.append(top);

  if (note.quote) {
    const quote = document.createElement('blockquote');
    quote.className = 'note-card-quote';
    quote.textContent = note.quote;
    li.append(quote);
  }
  if (note.body) {
    const body = document.createElement('div');
    body.className = 'note-card-body md';
    body.append(renderMarkdown(note.body));
    li.append(body);
  }
  if (note.tags?.length) {
    const tags = document.createElement('div');
    tags.className = 'note-card-tags';
    tags.textContent = note.tags.map((t) => `#${t}`).join(' ');
    li.append(tags);
  }
  li.addEventListener('click', (event) => {
    if (event.target.closest('a, textarea, button')) return;
    openNoteInEditor(note);
  });
  return li;
}

function startEdit(li, note) {
  const editor = document.createElement('textarea');
  editor.className = 'note-card-editor';
  editor.value = note.body;
  editor.rows = 3;
  editor.setAttribute('aria-label', 'Edit note');
  const hint = document.createElement('div');
  hint.className = 'note-card-edit-hint';
  hint.textContent = 'Ctrl/⌘ Enter to save · Esc to cancel';
  const existing = li.querySelector('.note-card-body');
  if (existing) existing.replaceWith(editor); else li.append(editor);
  li.append(hint);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);
  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save && editor.value.trim() !== note.body) {
      const res = await api.updateNote(note.id, { body: editor.value });
      if (!res.ok) showError(res.error);
      else currentNotes = currentNotes.map((n) => (n.id === note.id ? { ...n, ...res.note } : n));
    }
    refreshNotesUi();
  };
  editor.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false); }
  });
  editor.addEventListener('blur', () => finish(true));
}

async function deleteNoteWithUndo(note) {
  const res = await api.deleteNote(note.id);
  if (!res.ok) { showError(res.error); return; }
  currentNotes = currentNotes.filter((n) => n.id !== note.id);
  clearHighlightsOfAnchor();
  refreshNotesUi();
  toast(note.body ? 'Note deleted.' : 'Highlight removed.', {
    duration: 6000,
    action: {
      label: 'Undo',
      onClick: async () => {
        const restored = await api.addNote({
          itemId: note.itemId, blockIndex: note.blockIndex, startOffset: note.startOffset, endOffset: note.endOffset,
          quote: note.quote, body: note.body, title: note.title, color: note.color, notebookId: note.notebookId, tags: note.tags,
        });
        if (!restored.ok) { showError(restored.error); return; }
        if (state.libraryItemId === note.itemId) {
          currentNotes = sortNotes([...currentNotes, restored.note]);
          refreshNotesUi();
        }
      },
    },
  });
}

function renderNotesList() {
  els.notesList.replaceChildren(...currentNotes.map(makeNoteCard));
  els.notesEmpty.hidden = currentNotes.length > 0;
}

els.paneExport.addEventListener('click', async () => {
  if (!state.libraryItemId) return;
  const res = await api.exportNotes({ itemId: state.libraryItemId });
  if (!res.ok) showError(res.error);
  else if (!res.cancelled) toast('Notes exported as Markdown.');
});

// ---------------------------------------------------------------- selection toolbar (highlight in one click)

let toolbarAnchor = null;

buildSwatches(els.selColors, {
  selected: null,
  onPick: (color) => highlightSelection(color || state.lastColor),
});

function hideSelectionToolbar() {
  els.selToolbar.hidden = true;
  toolbarAnchor = null;
}

function updateSelectionToolbar() {
  if (state.view !== 'read' || els.article.hidden || !state.libraryItemId) return hideSelectionToolbar();
  const anchor = selectionAnchor();
  if (!anchor) return hideSelectionToolbar();
  toolbarAnchor = anchor;
  els.selToolbar.hidden = false;
  const { width, height } = els.selToolbar.getBoundingClientRect();
  const left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.rect.left + anchor.rect.width / 2 - width / 2));
  const above = anchor.rect.top - height - 10;
  els.selToolbar.style.left = `${left}px`;
  els.selToolbar.style.top = `${above < 8 ? anchor.rect.bottom + 10 : above}px`;
}

const refreshToolbarSoon = debounce(updateSelectionToolbar, 60);
els.article.addEventListener('mouseup', refreshToolbarSoon);
els.article.addEventListener('keyup', (event) => { if (event.shiftKey || event.key.startsWith('Arrow')) refreshToolbarSoon(); });
document.addEventListener('selectionchange', () => { if (window.getSelection()?.isCollapsed) hideSelectionToolbar(); });
els.scroller.addEventListener('scroll', () => { if (!els.selToolbar.hidden) updateSelectionToolbar(); }, { passive: true });
els.selToolbar.addEventListener('mousedown', (event) => event.preventDefault());

async function highlightSelection(color) {
  const anchor = toolbarAnchor || selectionAnchor();
  if (!anchor || !state.libraryItemId) return;
  state.lastColor = color;
  store.set('ui.lastColor', color);
  composerColor = color;
  composerSwatches.set(color);
  const res = await api.addNote({
    itemId: state.libraryItemId, blockIndex: anchor.blockIndex, startOffset: anchor.startOffset, endOffset: anchor.endOffset,
    quote: anchor.quote, body: '', color,
  });
  if (!res.ok) { showError(res.error); return; }
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
  currentNotes = sortNotes([...currentNotes, res.note]);
  refreshNotesUi();
  toast('Highlighted.', { duration: 2500, action: { label: 'Undo', onClick: () => deleteNoteQuiet(res.note) } });
}

async function deleteNoteQuiet(note) {
  const res = await api.deleteNote(note.id);
  if (!res.ok) { showError(res.error); return; }
  currentNotes = currentNotes.filter((n) => n.id !== note.id);
  refreshNotesUi();
}

els.selNote.addEventListener('click', () => {
  const anchor = toolbarAnchor || selectionAnchor();
  if (!anchor) return;
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
  pinAnchor(anchor);
});

els.selAdd.addEventListener('click', async () => {
  const anchor = toolbarAnchor || selectionAnchor();
  if (!anchor) return;
  window.getSelection()?.removeAllRanges();
  hideSelectionToolbar();
  pinAnchor(anchor);
  await loadNoteTargets();
  if (!els.noteTarget.value && targetNotes.length) {
    els.noteTarget.value = targetNotes.some((n) => n.id === store.get('ui.noteTarget', '')) ? store.get('ui.noteTarget', '') : targetNotes[0].id;
    fillWhere();
  }
  if (!targetNotes.length) toast('You have no notes of your own yet. Create one in Notes first, then add passages to it.');
  checkComposer();
  els.noteTarget.focus();
});

els.selCopy.addEventListener('click', async () => {
  const anchor = toolbarAnchor || selectionAnchor();
  if (!anchor) return;
  try {
    await navigator.clipboard.writeText(anchor.quote);
  } catch {
    document.execCommand('copy');
  }
  hideSelectionToolbar();
  toast('Copied.', { duration: 1800 });
});

// ---------------------------------------------------------------- following along on the page

function moveMarker() {
  const block = state.blocks[state.currentBlock];
  if (!block) return;
  els.marker.style.transform = `translateY(${block.el.offsetTop}px)`;
  els.marker.style.height = `${block.el.offsetHeight}px`;
}
new ResizeObserver(moveMarker).observe(els.article);

function keepInView(el, force = false) {
  if (!force && !readingSettings.autoScroll) return;
  const area = els.scroller.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const comfortable = box.top >= area.top + area.height * 0.12 && box.bottom <= area.bottom - area.height * 0.28;
  if (!comfortable) el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
}

function highlight(unitIndex, { force = false } = {}) {
  const unit = state.units[unitIndex];
  if (!unit) return;
  if (state.currentBlock !== unit.blockIndex) {
    state.blocks[state.currentBlock]?.el.classList.remove('current');
    state.currentBlock = unit.blockIndex;
    const { el } = state.blocks[unit.blockIndex];
    el.classList.add('current');
    moveMarker();
    keepInView(el, force);
    syncComposerToPlayback();
    for (const card of els.notesList.children) card.classList.toggle('is-speaking', Number(card.dataset.block) === state.currentBlock);
    saveProgressSoon();
  }
  els.article.classList.add('focused');
  updateProgress();
  wordTick(true);
}

// ---------------------------------------------------------------- word tracker
// Kokoro gives no word timings, so the position inside a paragraph is estimated from how far through the clip we are,
// weighting each word by its length and trailing punctuation. Painted with the CSS Custom Highlight API: no DOM changes.

const canPaintWords = typeof CSS !== 'undefined' && Boolean(CSS.highlights) && typeof Highlight !== 'undefined';
const speakingHl = canPaintWords ? new Highlight() : null;
const spokenHl = canPaintWords ? new Highlight() : null;
if (canPaintWords) {
  speakingHl.priority = 20;
  spokenHl.priority = 10;
  CSS.highlights.set('voxo-speaking', speakingHl);
  CSS.highlights.set('voxo-spoken', spokenHl);
}
let wordTrack = null;
let lastWord = -1;
let wordFrame = 0;

function clearWordHighlight() {
  speakingHl?.clear();
  spokenHl?.clear();
  wordTrack = null;
  lastWord = -1;
}

function trackFor(blockIndex) {
  if (wordTrack && wordTrack.blockIndex === blockIndex && wordTrack.nodes[0]?.isConnected) return wordTrack;
  const entry = state.blocks[blockIndex];
  if (!entry) return null;
  const nodes = textNodesOf(entry.el);
  const text = nodes.map((n) => n.data).join('');
  const tokens = [];
  for (const m of text.matchAll(/\S+/g)) tokens.push({ s: m.index, e: m.index + m[0].length });
  wordTrack = { blockIndex, nodes, tokens };
  lastWord = -1;
  return wordTrack;
}

function rangeFor(track, start, end) {
  const range = new Range();
  let pos = 0;
  let started = false;
  for (const node of track.nodes) {
    const len = node.data.length;
    if (!started && start < pos + len) { range.setStart(node, start - pos); started = true; }
    if (started && end <= pos + len) { range.setEnd(node, end - pos); return range; }
    pos += len;
  }
  return null;
}

function unitWeights(unit) {
  if (!unit.cum) {
    const words = unit.text.split(/\s+/).filter(Boolean);
    let total = 0;
    unit.cum = words.map((w) => { total += w.length + 2 + (/[.!?]$/.test(w) ? 5 : /[,;:—–-]$/.test(w) ? 2.5 : 0); return total; });
    unit.cumTotal = total || 1;
  }
  return unit;
}

function wordTick(force = false) {
  if (!canPaintWords) return;
  const unit = state.units[state.pos];
  if (!unit || state.phase === 'preparing' || state.phase === 'done' || !state.units.length) { if (state.phase === 'done') clearWordHighlight(); return; }
  const track = trackFor(unit.blockIndex);
  if (!track || !track.tokens.length) return;
  unitWeights(unit);
  const fraction = audio.duration > 0 && state.loaded === state.pos ? Math.min(0.999, audio.currentTime / audio.duration) : 0;
  const target = fraction * unit.cumTotal;
  let i = unit.cum.findIndex((c) => c > target);
  if (i < 0) i = unit.cum.length - 1;
  const index = Math.min(track.tokens.length - 1, unit.tokStart + i);
  if (index === lastWord && !force) return;
  lastWord = index;
  const word = track.tokens[index];
  const wordRange = rangeFor(track, word.s, word.e);
  speakingHl.clear();
  if (wordRange) speakingHl.add(wordRange);
  spokenHl.clear();
  if (index > 0) {
    const done = rangeFor(track, track.tokens[0].s, track.tokens[index - 1].e);
    if (done) spokenHl.add(done);
  }
}

function wordLoop() {
  wordTick();
  wordFrame = audio.paused ? 0 : requestAnimationFrame(wordLoop);
}
audio.addEventListener('play', () => { cancelAnimationFrame(wordFrame); wordFrame = requestAnimationFrame(wordLoop); });
audio.addEventListener('pause', () => { cancelAnimationFrame(wordFrame); wordFrame = 0; });
audio.addEventListener('seeked', () => wordTick(true));

// ---------------------------------------------------------------- reading progress

let progressDirty = false;
const writeProgress = () => {
  if (!state.libraryItemId || !state.units.length || !progressDirty) return;
  progressDirty = false;
  const unit = state.units[state.pos];
  const fraction = state.phase === 'done' ? 1 : state.totalWords ? unit.startWords / state.totalWords : 0;
  api.setProgress(state.libraryItemId, state.phase === 'done' ? 0 : state.pos, fraction);
};
const saveProgressDebounced = debounce(writeProgress, 1500);
function saveProgressSoon() { progressDirty = true; saveProgressDebounced(); }
function saveProgressNow() { saveProgressDebounced.cancel(); writeProgress(); }
window.addEventListener('beforeunload', saveProgressNow);

// ---------------------------------------------------------------- speech requests (with a cache that cannot go stale)

const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true });

function dropCacheEntry(index) {
  const entry = cache.get(index);
  if (!entry) return;
  cache.delete(index);
  if (entry.url) URL.revokeObjectURL(entry.url);
}

/** Forget every prepared clip. Needed whenever the text or the voice changes. */
function clearAudioCache() {
  for (const index of [...cache.keys()]) dropCacheEntry(index);
}

function request(index) {
  if (index < 0 || index >= state.units.length) return null;
  const existing = cache.get(index);
  if (existing) return existing;
  const entry = { url: null, promise: null };
  entry.promise = api
    .synth({ text: state.units[index].text, voice: state.voice })
    .then((res) => {
      if (!res.ok) throw Object.assign(new Error(res.error), { cancelled: res.cancelled });
      const url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/wav' }));
      if (cache.get(index) !== entry) { URL.revokeObjectURL(url); throw cancelledError(); }
      entry.url = url;
      return url;
    });
  entry.promise.catch(() => { if (cache.get(index) === entry) cache.delete(index); });
  cache.set(index, entry);
  return entry;
}

function prefetch(from) {
  for (let k = 0; k < AHEAD; k += 1) request(from + k);
  // Keep everything already prepared. Only when the cache gets large do we release the clips farthest from here.
  if (cache.size > MAX_CACHED) {
    const keep = (index) => index >= state.pos && index <= state.pos + AHEAD;
    const farthest = [...cache.keys()].filter((index) => !keep(index)).sort((a, b) => Math.abs(b - state.pos) - Math.abs(a - state.pos));
    for (const index of farthest.slice(0, cache.size - MAX_CACHED)) dropCacheEntry(index);
  }
}

function resetQueue() {
  state.gen += 1;
  api.cancel();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.loaded = -1;
}

// ---------------------------------------------------------------- playback

async function playUnit(index) {
  if (index >= state.units.length) return finish();
  const gen = state.gen;
  state.pos = index;
  highlight(index);
  const entry = request(index);
  setPhase(entry.url ? 'reading' : 'preparing');
  prefetch(index + 1);
  let url;
  try {
    url = await entry.promise;
  } catch (err) {
    if (gen !== state.gen || err.cancelled) return;
    fail(err.message);
    return;
  }
  if (gen !== state.gen || !state.playing) return;
  audio.src = url;
  audio.defaultPlaybackRate = state.speed;
  audio.playbackRate = state.speed;
  state.loaded = index;
  try {
    await audio.play();
  } catch (err) {
    if (gen === state.gen) fail(`The audio could not be played: ${err.message}`);
    return;
  }
  if (gen !== state.gen) return;
  setPhase('reading');
  prefetch(index + 1);
}

audio.addEventListener('ended', () => {
  const finished = state.loaded;
  if (finished < 0) return;
  addWords(state.units[finished]?.tokens || 0);
  state.loaded = -1;
  if (!state.playing) return;
  const next = state.units[finished + 1];
  if (sleepAfterParagraph && (!next || next.blockIndex !== state.units[finished].blockIndex)) {
    clearSleep();
    if (!next) { finish(); return; }
    state.pos = finished + 1;
    highlight(state.pos);
    pause();
    toast('Sleep timer: paused after this paragraph.');
    return;
  }
  playUnit(finished + 1);
});

audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) fail('The audio could not be played.');
});

function fail(message) {
  state.playing = false;
  syncButtons();
  setPhase(state.units.length ? 'paused' : 'empty');
  showError(message);
}

function finish() {
  state.playing = false;
  clearWordHighlight();
  syncButtons();
  setPhase('done');
  addFinished();
  showFinishCard();
  updateProgress();
  progressDirty = true;
  saveProgressNow();
  clearSleep();
  refreshHome();
}

async function showFinishCard() {
  const card = els.finishCard;
  card.replaceChildren();
  const badge = document.createElement('div');
  badge.className = 'finish-badge';
  badge.append(icon('check'));
  const h = document.createElement('h2');
  h.textContent = 'You finished it.';
  const p = document.createElement('p');
  const notes = currentNotes.length;
  p.textContent = notes
    ? `${notes} highlight${notes === 1 ? '' : 's'} and note${notes === 1 ? '' : 's'} from this reading are saved in your Notes.`
    : 'Nothing marked this time. Next time, select any sentence to keep it.';
  const actions = document.createElement('div');
  actions.className = 'finish-actions';
  const again = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-secondary' });
  again.append(icon('repeat'), 'Listen again');
  again.addEventListener('click', () => { card.hidden = true; seekToUnit(0, true); els.scroller.scrollTo({ top: 0 }); });
  actions.append(again);
  if (notes) {
    const review = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-secondary' });
    review.append(icon('pencil'), 'Review notes');
    review.addEventListener('click', () => toggleNotesPane(true));
    actions.append(review);
  }
  const res = await api.listLibrary('history');
  const next = res.ok ? res.entries.find((e) => e.id !== state.libraryItemId && e.progress > 0.02 && e.progress < 0.97) : null;
  if (next) {
    const cont = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary' });
    cont.append('Continue: ', (next.title || 'Untitled').slice(0, 36), icon('arrow-right'));
    cont.addEventListener('click', () => openLibraryItem(next.id));
    actions.append(cont);
  } else {
    const home = Object.assign(document.createElement('button'), { type: 'button', className: 'btn btn-primary' });
    home.append('Read something new', icon('arrow-right'));
    home.addEventListener('click', goHome);
    actions.append(home);
  }
  card.append(badge, h, p, actions);
  card.hidden = false;
  card.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
}

function play() {
  if (!state.units.length) return;
  hideError();
  els.finishCard.hidden = true;
  if (state.phase === 'done') { seekToUnit(0, true); return; }
  state.playing = true;
  syncButtons();
  if (state.loaded === state.pos && audio.src) {
    audio.play().then(() => setPhase('reading')).catch((err) => fail(err.message));
  } else {
    playUnit(state.pos);
  }
}

function pause() {
  state.playing = false;
  audio.pause();
  syncButtons();
  setPhase('paused');
  saveProgressNow();
}

const togglePlay = () => (state.playing ? pause() : play());

function seekToUnit(index, autoplay = state.playing) {
  if (!state.units.length) return;
  resetQueue();
  state.pos = Math.min(Math.max(index, 0), state.units.length - 1);
  highlight(state.pos);
  if (autoplay) {
    state.playing = true;
    syncButtons();
    playUnit(state.pos);
  } else {
    setPhase(state.phase === 'ready' ? 'ready' : 'paused');
  }
}

function stopEverything() {
  state.playing = false;
  resetQueue();
  clearSleep();
  syncButtons();
}

function speakableBlock(from, step) {
  for (let i = from + step; i >= 0 && i < state.blocks.length; i += step) {
    if (state.blocks[i].firstUnit !== null) return i;
  }
  return -1;
}

function jump(step) {
  if (!state.units.length) return;
  const current = state.units[state.pos].blockIndex;
  if (step < 0 && state.pos > state.blocks[current].firstUnit) { seekToUnit(state.blocks[current].firstUnit); return; }
  const target = speakableBlock(current, step);
  if (target === -1) { if (step < 0) seekToUnit(0); return; }
  seekToUnit(state.blocks[target].firstUnit);
}

function seekToFraction(fraction) {
  if (!state.units.length || !state.totalWords) return;
  const target = fraction * state.totalWords;
  let index = state.units.findIndex((u) => u.startWords > target) - 1;
  if (index < -1) index = state.units.length - 1;
  seekToUnit(Math.max(0, index), state.playing);
}
els.progressBar.addEventListener('click', (event) => {
  const box = els.progressBar.getBoundingClientRect();
  seekToFraction(Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)));
});
els.progressBar.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowRight') { event.preventDefault(); jump(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); jump(-1); }
});

els.play.addEventListener('click', togglePlay);
els.prev.addEventListener('click', () => jump(-1));
els.next.addEventListener('click', () => jump(1));

els.article.addEventListener('click', (event) => {
  if (event.target.closest('a, .note-action')) return;
  const el = event.target.closest('.block');
  if (!el || window.getSelection().toString()) return;
  const block = state.blocks[Number(el.dataset.block)];
  if (block && block.firstUnit !== null) seekToUnit(block.firstUnit, true);
});

els.bookmarkToggle.addEventListener('click', async () => {
  if (!state.libraryItemId) return;
  const result = await api.toggleSavedItem(state.libraryItemId);
  if (!result.ok) { showError(result.error); return; }
  setSavedUi(result.isSaved);
  toast(result.isSaved ? 'Saved to your archive.' : 'Removed from saved.', { duration: 2200 });
  refreshSavedSidebar();
});

// ---------------------------------------------------------------- sleep timer

let sleepTimer = null;
let sleepAfterParagraph = false;

function clearSleep() {
  clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepAfterParagraph = false;
  els.sleep.value = '0';
  syncSleepPill();
}

function syncSleepPill() {
  const option = els.sleep.selectedOptions[0];
  const on = els.sleep.value !== '0';
  els.sleepPill.classList.toggle('is-on', on);
  els.sleepPill.title = on ? `Sleep timer: ${option.textContent.toLowerCase()}` : 'Sleep timer: off';
}

els.sleep.addEventListener('change', () => {
  const value = els.sleep.value;
  syncSleepPill();
  clearTimeout(sleepTimer);
  sleepTimer = null;
  sleepAfterParagraph = value === 'block';
  if (/^\d+$/.test(value) && Number(value) > 0) {
    sleepTimer = setTimeout(() => {
      sleepTimer = null;
      els.sleep.value = '0';
      syncSleepPill();
      if (state.playing) { pause(); toast('Sleep timer ended. Playback paused.'); }
    }, Number(value) * 60000);
  }
});

// ---------------------------------------------------------------- settings

function applyReadingSettings() {
  const root = document.documentElement;
  root.dataset.theme = readingSettings.theme === 'dark' || (readingSettings.theme === 'system' && systemDarkMode.matches) ? 'dark' : 'light';
  root.dataset.font = readingSettings.font;
  root.style.setProperty('--reading-size', `${readingSettings.fontSize}px`);
  root.style.setProperty('--reading-width', `${readingSettings.lineWidth}ch`);
  root.style.setProperty('--reading-leading', String(readingSettings.lineSpacing));
  for (const b of els.themeSeg.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.themeChoice === readingSettings.theme));
  setIcon(els.themeToggle.querySelector('svg'), root.dataset.theme === 'dark' ? 'sun' : 'moon');
  els.fontStyle.value = readingSettings.font;
  els.fontSize.value = String(readingSettings.fontSize);
  els.fontSizeValue.textContent = `${readingSettings.fontSize} px`;
  els.lineWidth.value = String(readingSettings.lineWidth);
  els.lineWidthValue.textContent = `${readingSettings.lineWidth} chars`;
  els.lineSpacing.value = String(readingSettings.lineSpacing);
  els.lineSpacingValue.textContent = `${readingSettings.lineSpacing.toFixed(1)}×`;
  els.autoScroll.checked = readingSettings.autoScroll;
}

function updateReadingSetting(key, value, persist = true) {
  readingSettings[key] = value;
  applyReadingSettings();
  if (persist) store.set(`reading.${key}`, value);
  if (key === 'fontSize' || key === 'lineWidth' || key === 'lineSpacing') requestAnimationFrame(moveMarker);
}

els.themeSeg.addEventListener('click', (event) => {
  const choice = event.target.closest('[data-theme-choice]')?.dataset.themeChoice;
  if (choice) updateReadingSetting('theme', choice);
});
els.themeToggle.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  updateReadingSetting('theme', dark ? 'light' : 'dark');
});
els.resetReading.addEventListener('click', () => {
  for (const [key, value] of Object.entries({ theme: 'system', font: 'serif', fontSize: 20, lineWidth: 72, lineSpacing: 1.8, autoScroll: true })) {
    readingSettings[key] = value;
    store.set(`reading.${key}`, value);
  }
  applyReadingSettings();
  requestAnimationFrame(moveMarker);
  toast('Appearance reset.', { duration: 2000 });
});
els.fontStyle.addEventListener('change', () => updateReadingSetting('font', els.fontStyle.value));
els.autoScroll.addEventListener('change', () => updateReadingSetting('autoScroll', els.autoScroll.checked));
for (const [input, key, parse] of [[els.fontSize, 'fontSize', Number], [els.lineWidth, 'lineWidth', Number], [els.lineSpacing, 'lineSpacing', Number]]) {
  input.addEventListener('input', () => updateReadingSetting(key, parse(input.value), false));
  input.addEventListener('change', () => store.set(`reading.${key}`, readingSettings[key]));
}
applyReadingSettings();
systemDarkMode.addEventListener('change', () => { if (readingSettings.theme === 'system') applyReadingSettings(); });

function updateSpeed(value, persist = true) {
  state.speed = Math.round(clamp(value, 0.6, 2.4, 1) * 10) / 10;
  els.speed.value = String(state.speed);
  els.speedValue.textContent = `${state.speed.toFixed(1)}×`;
  els.speed.setAttribute('aria-valuetext', `${state.speed.toFixed(1)} times speed`);
  audio.defaultPlaybackRate = state.speed;
  audio.playbackRate = state.speed;
  if (persist) store.set('speed', state.speed);
  updateProgress();
}
els.speed.addEventListener('input', () => updateSpeed(els.speed.value));
updateSpeed(state.speed, false);

function restartAtCurrent() {
  if (state.units.length) seekToUnit(state.pos);
}

// ---------------------------------------------------------------- language and voice

const PREVIEW_TEXT = {
  en: 'Hello. This is how I sound when I read to you.',
  es: 'Hola. Así suena mi voz cuando te leo.',
  fr: 'Bonjour. Voici comment ma voix sonne quand je vous lis un texte.',
  hi: 'नमस्ते। जब मैं आपको पढ़कर सुनाता हूँ, तो मेरी आवाज़ ऐसी होती है।',
  it: 'Ciao. Ecco come suona la mia voce quando ti leggo.',
  pt: 'Olá. É assim que a minha voz soa quando leio para você.',
};

const languageLabel = (code) => voicesInfo?.languages.find((l) => l.code === code)?.label || LANGUAGE_NAMES[code] || code;
const voicesFor = (lang) => (voicesInfo ? voicesInfo.voices.kokoro.filter((v) => v.lang === lang) : []);

/** The voice to use for a language: the one you last picked for it, else that language's default. */
function voiceForLanguage(lang) {
  const list = voicesFor(lang);
  const saved = store.get(`voice.${lang}`, lang === 'en' ? store.get('voice.kokoro', null) : null);
  if (list.some((v) => v.name === saved)) return saved;
  const fallback = voicesInfo.languages.find((l) => l.code === lang)?.defaultVoice;
  return list.some((v) => v.name === fallback) ? fallback : list[0]?.name;
}

function syncLanguageUi() {
  if (!voicesInfo) return;
  renderVoiceList();
  const manual = Boolean(state.langOverride);
  els.langChipLabel.textContent = languageLabel(state.lang).replace(/ \(.*\)/, '');
  els.langChip.classList.toggle('is-override', manual);
  els.langChip.title = manual ? 'Language set for this reading. Choose Auto-detect to let voxo decide.' : `Reading language${langMode === 'auto' ? ' (detected)' : ''}. Click to change it for this reading.`;
  els.langSelect.value = manual ? state.langOverride : 'auto';
  els.langMode.value = langMode;
  els.langDetected.textContent = langMode === 'auto' && state.detected ? `detected: ${languageLabel(state.detected)}` : '';
}

/** Switch the active language and voice. `restart` re-prepares audio from the current paragraph. */
function setLanguage(lang, { restart = false } = {}) {
  if (!voicesInfo || !voicesFor(lang).length) return;
  const voice = voiceForLanguage(lang);
  const changed = voice !== state.voice;
  state.lang = lang;
  state.voice = voice;
  store.set('lang.last', lang);
  syncLanguageUi();
  if (changed) {
    clearAudioCache(); // clips made with the old voice must not be replayed
    if (restart) restartAtCurrent();
  }
}

/** Decide the language for the reading that just opened: per-reading choice > global choice > detection. */
function applyArticleLanguage() {
  if (!voicesInfo) return; // initVoices() calls this again once the voice list has arrived
  const text = state.units.slice(0, 40).map((u) => u.text).join(' ');
  const found = detectLanguage(text);
  state.detected = found.code && voicesFor(found.code).length ? found.code : null;

  if (state.langOverride) return setLanguage(state.langOverride);
  if (langMode !== 'auto') return setLanguage(langMode);

  if (found.code && !state.detected) {
    const name = LANGUAGE_NAMES[found.code] || 'this language';
    toast(`This looks like ${name}, which voxo can't read aloud yet. It will use ${languageLabel(state.lang)}.`, { duration: 6000 });
    return;
  }
  if (state.detected && state.detected !== state.lang) {
    setLanguage(state.detected);
    toast(`Reading in ${languageLabel(state.detected)} with ${persona({ name: state.voice }).name}.`, {
      action: { label: 'Change', onClick: () => els.settingsDialog.showModal() }, duration: 6000,
    });
  } else {
    syncLanguageUi();
  }
}

els.langSelect.addEventListener('change', () => {
  const choice = els.langSelect.value;
  if (choice === 'auto') {
    state.langOverride = null;
    const found = state.detected && langMode === 'auto' ? state.detected : (langMode !== 'auto' ? langMode : state.lang);
    setLanguage(found, { restart: true });
  } else {
    state.langOverride = choice;
    setLanguage(choice, { restart: true });
  }
});

els.langMode.addEventListener('change', () => {
  langMode = els.langMode.value;
  store.set('lang.mode', langMode);
  state.langOverride = null;
  if (langMode === 'auto') applyArticleLanguage(); else setLanguage(langMode, { restart: true });
  syncLanguageUi();
});

function chooseVoice(name) {
  if (name === state.voice) return;
  state.voice = name;
  store.set(`voice.${state.lang}`, state.voice);
  if (state.lang === 'en') store.set('voice.kokoro', state.voice);
  clearAudioCache();
  renderVoiceList();
  restartAtCurrent();
}

// Voice previews: made on demand, remembered for the session, and never touch the voice you have chosen.
const previewClips = new Map(); // `${voice}|${text}` -> object URL
let previewPlayer = null;
let previewing = null;

function stopPreview() {
  if (previewPlayer) { previewPlayer.pause(); previewPlayer = null; }
  previewing = null;
}

async function previewVoice(voice) {
  const wasPlaying = previewing === voice.name;
  stopPreview();
  if (wasPlaying) { renderVoiceList(); return; }
  if (state.playing) pause();
  const p = persona(voice);
  const sample = voice.lang === 'en' ? `Hi, I'm ${p.name}. This is how I sound when I read to you.` : (PREVIEW_TEXT[voice.lang] || PREVIEW_TEXT.en);
  const key = `${voice.name}|${sample}`;
  previewing = voice.name;
  renderVoiceList({ busy: voice.name });
  hideError();
  let url = previewClips.get(key);
  if (!url) {
    const res = await api.synth({ text: sample, voice: voice.name });
    if (previewing !== voice.name) return; // another voice was chosen while this one was being made
    if (!res.ok) { previewing = null; renderVoiceList(); if (!res.cancelled) showError(res.error); return; }
    url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/wav' }));
    previewClips.set(key, url);
  }
  const player = new Audio(url);
  previewPlayer = player;
  player.playbackRate = state.speed;
  const done = () => { if (previewPlayer === player) { previewPlayer = null; previewing = null; renderVoiceList(); } };
  player.addEventListener('ended', done);
  player.addEventListener('error', done);
  renderVoiceList();
  player.play().catch(done);
}

function renderVoiceList({ busy = null } = {}) {
  if (!voicesInfo) return;
  const rows = voicesFor(state.lang).map((voice) => {
    const p = persona(voice);
    const selected = voice.name === state.voice;
    const row = document.createElement('div');
    row.className = `voice-row${selected ? ' is-selected' : ''}`;

    const play = document.createElement('button');
    play.type = 'button';
    play.className = `voice-play${previewing === voice.name ? ' is-playing' : ''}${busy === voice.name ? ' is-busy' : ''}`;
    play.setAttribute('aria-label', previewing === voice.name ? `Stop ${p.name}` : `Hear ${p.name}`);
    play.title = 'Hear a sample';
    play.append(icon(previewing === voice.name ? 'stop' : 'play'));
    play.addEventListener('click', (event) => { event.stopPropagation(); previewVoice(voice); });

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'voice-pick';
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(selected));
    const name = document.createElement('span');
    name.className = 'voice-name';
    name.textContent = `${p.name}${p.accent ? ` (${p.accent})` : ''}`;
    const trait = document.createElement('span');
    trait.className = 'voice-trait';
    trait.textContent = `${p.gender} · ${p.trait}`;
    pick.append(name, trait);
    if (selected) { const check = icon('check'); check.classList.add('voice-check'); pick.append(check); }
    pick.addEventListener('click', () => chooseVoice(voice.name));

    row.append(play, pick);
    return row;
  });
  els.voiceList.replaceChildren(...rows);
}

// ---------------------------------------------------------------- ambient soundscapes

const ambient = createAmbient();
function syncAmbientUi() {
  const current = store.get('ambient.sound', 'off');
  els.ambientSeg.replaceChildren(...SOUNDS.map((sound) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `chip${sound.id === current ? ' is-active' : ''}`;
    chip.setAttribute('role', 'radio');
    chip.setAttribute('aria-checked', String(sound.id === current));
    chip.textContent = sound.label;
    chip.addEventListener('click', () => {
      store.set('ambient.sound', sound.id);
      ambient.setSound(sound.id);
      ambient.setActive(state.playing || sound.id !== 'off' && els.settingsDialog.open); // let people hear it while choosing
      syncAmbientUi();
    });
    return chip;
  }));
  els.ambientVolume.disabled = current === 'off';
}
els.ambientVolume.value = String(Math.round(store.get('ambient.volume', 0.35) * 100));
els.ambientVolumeValue.textContent = `${els.ambientVolume.value}%`;
ambient.setVolume(Number(els.ambientVolume.value) / 100);
els.ambientVolume.addEventListener('input', () => {
  const v = Number(els.ambientVolume.value) / 100;
  els.ambientVolumeValue.textContent = `${els.ambientVolume.value}%`;
  ambient.setVolume(v);
  store.set('ambient.volume', v);
});
ambient.setSound(store.get('ambient.sound', 'off'));
syncAmbientUi();
els.settingsDialog.addEventListener('close', () => ambient.setActive(state.playing));
syncAmbientPlayback = () => ambient.setActive(state.playing);

els.allowDownload.checked = store.get('allowDownload', false);
api.setAllowDownload(els.allowDownload.checked);
els.allowDownload.addEventListener('change', () => {
  store.set('allowDownload', els.allowDownload.checked);
  api.setAllowDownload(els.allowDownload.checked);
  hideError();
  restartAtCurrent();
});

async function initVoices() {
  const res = await api.voices();
  if (!res.ok) { showError(res.error, 'Open Settings and allow the voice model download the first time you use voxo.'); return; }
  voicesInfo = res;
  const options = [new Option('Auto-detect (recommended)', 'auto'), ...voicesInfo.languages.map((l) => new Option(l.label, l.code))];
  els.langMode.replaceChildren(...options);
  els.langSelect.replaceChildren(...options.map((o) => new Option(o.value === 'auto' ? 'Auto-detect' : o.text, o.value)));
  if (langMode !== 'auto' && !voicesFor(langMode).length) langMode = 'auto';
  state.lang = langMode !== 'auto' ? langMode : store.get('lang.last', 'en');
  if (!voicesFor(state.lang).length) state.lang = 'en';
  state.voice = voiceForLanguage(state.lang);
  syncLanguageUi();
  if (state.units.length) applyArticleLanguage(); // a reading opened before the voice list arrived
}

const makeTypeIcon = (type) => icon(type === 'pdf' ? 'file' : type === 'text' ? 'type' : 'link');

// ---------------------------------------------------------------- home: resume card, recents

const SAMPLE_TEXT = `A short sample for voxo

Reading aloud is one of the oldest ways of sharing a thought. Before printing, before silent reading was common, people listened to stories, letters and arguments read across a room.

voxo brings that back. Click any paragraph to start from there, and watch the highlight follow the voice. Select a sentence to highlight it in color, or press N to attach a note to it.

Try it now: select this sentence and pick a color, then open the Notes pane to see it saved. When you finish, your reading, your place and your notes will all be waiting in the Archive.`;

function renderGreeting(entries) {
  const hour = new Date().getHours();
  const part = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const stats = getStats();
  const returning = entries.length > 0;
  els.greetingEyebrow.textContent = stats.streak > 1 ? `${stats.streak}-day listening streak` : returning ? part : '';
  els.greeting.textContent = returning ? 'What shall we read today?' : 'Welcome to voxo.';
  els.greetingSub.textContent = returning
    ? 'Paste a link, drop in some text or open a PDF. Or pick up where you left off below.'
    : 'Paste a link, drop in some text, or open a PDF. voxo reads it to you, remembers where you stopped, and keeps your notes.';
  renderInsights(stats);
}

function renderInsights(stats) {
  els.stats.replaceChildren();
  const hasData = stats.totalMinutes > 0 || stats.finished > 0 || stats.totalWords > 0;
  els.stats.hidden = !hasData;
  if (!hasData) return;

  const fmtMinutes = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ''}`.trim() : `${m} min`);
  const fmtWords = (w) => (w >= 10000 ? `${(w / 1000).toFixed(w >= 100000 ? 0 : 1)}k` : w.toLocaleString());

  const head = document.createElement('div');
  head.className = 'insights-head';
  const title = document.createElement('h2');
  title.textContent = 'Your listening';
  const badge = document.createElement('span');
  badge.className = `streak-badge${stats.streak ? '' : ' is-idle'}`;
  badge.append(icon('flame'), stats.streak ? `${stats.streak}-day streak` : 'Start a streak today');
  head.append(title, badge);

  const metrics = document.createElement('div');
  metrics.className = 'insight-metrics';
  const metric = (iconName, value, label, sub) => {
    const box = document.createElement('div');
    box.className = 'insight';
    const v = document.createElement('span'); v.className = 'insight-value'; v.textContent = value;
    const l = document.createElement('span'); l.className = 'insight-label'; l.append(icon(iconName), label);
    const s = document.createElement('span'); s.className = 'insight-sub'; s.textContent = sub;
    box.append(v, l, s);
    return box;
  };
  metrics.append(
    metric('headphones', fmtMinutes(stats.week.minutes), 'Time listened', `this week · ${fmtMinutes(stats.totalMinutes)} all time`),
    metric('book', fmtWords(stats.week.words), 'Words read', `this week · ${fmtWords(stats.totalWords)} all time`),
    metric('check', String(stats.finished), `Reading${stats.finished === 1 ? '' : 's'} finished`, stats.todayMinutes ? `${stats.todayMinutes} min today` : 'none listened today'),
  );

  const chart = document.createElement('div');
  chart.className = 'week-bars';
  chart.setAttribute('role', 'img');
  chart.setAttribute('aria-label', `Minutes listened per day this week: ${stats.week.perDay.map((d) => `${d.label} ${d.minutes}`).join(', ')}`);
  const peak = Math.max(10, ...stats.week.perDay.map((d) => d.minutes));
  for (const day of stats.week.perDay) {
    const col = document.createElement('div');
    col.className = 'week-col';
    col.title = `${day.minutes} min`;
    const bar = document.createElement('span');
    bar.className = 'week-bar';
    bar.style.height = `${Math.max(day.minutes ? 8 : 3, Math.round((day.minutes / peak) * 100))}%`;
    if (!day.minutes) bar.classList.add('is-empty');
    const label = document.createElement('span');
    label.className = 'week-label';
    label.textContent = day.label;
    col.append(bar, label);
    chart.append(col);
  }

  els.stats.append(head, metrics);
  const lower = document.createElement('div');
  lower.className = 'insights-lower';
  lower.append(chart);
  if (stats.topics.length) {
    const topics = document.createElement('div');
    topics.className = 'topic-block';
    const label = document.createElement('p');
    label.className = 'eyebrow';
    label.textContent = 'TOP TOPICS';
    const cloud = document.createElement('div');
    cloud.className = 'topic-cloud';
    const max = stats.topics[0].count;
    for (const t of stats.topics) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'topic-chip';
      chip.dataset.weight = String(Math.max(1, Math.round((t.count / max) * 3)));
      chip.append(t.word);
      chip.title = `Search your library for “${t.word}”`;
      chip.addEventListener('click', () => openPalette(t.word));
      cloud.append(chip);
    }
    topics.append(label, cloud);
    lower.append(topics);
  }
  els.stats.append(lower);
}

async function refreshCounts() {
  const [notes, history] = await Promise.all([api.listNotes({}), api.listLibrary('history')]);
  const set = (el, n) => { el.textContent = String(n); el.hidden = !n; };
  set(els.countNotes, notes.ok ? notes.notes.length : 0);
  set(els.countArchive, history.ok ? history.entries.length : 0);
}

const SIDEBAR_RECENTS = 8;

async function refreshSavedSidebar() {
  const res = await api.listLibrary('saved');
  const saved = res.ok ? res.entries.slice(0, 4) : [];
  els.sidebarSavedGroup.hidden = saved.length === 0;
  els.sidebarSaved.replaceChildren(...saved.map((item) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `sidebar-recent-link sidebar-saved-link${item.id === state.libraryItemId ? ' is-current' : ''}`;
    btn.title = item.title;
    const name = document.createElement('span');
    name.className = 'sidebar-recent-title';
    name.textContent = item.title;
    btn.append(icon('bookmark'), name);
    btn.addEventListener('click', () => openLibraryItem(item.id));
    return btn;
  }));
}

async function refreshHome() {
  refreshCounts();
  const result = await api.listLibrary('history');
  renderGreeting(result.ok ? result.entries : []);
  discover.load();
  refreshLinkIndex();
  if (!result.ok || !result.entries.length) {
    els.recentSection.hidden = true;
    els.resumeSection.hidden = true;
    els.sidebarRecents.replaceChildren(Object.assign(document.createElement('p'), { className: 'sidebar-empty', textContent: 'Readings you open will show up here.' }));
    return;
  }
  const entries = result.entries;

  els.sidebarRecents.replaceChildren(...entries.slice(0, SIDEBAR_RECENTS).map((item) => {
    const btn = document.createElement('button');
    btn.className = `sidebar-recent-link${item.id === state.libraryItemId ? ' is-current' : ''}`;
    btn.title = `${item.title}${item.progress > 0.02 ? ` · ${item.progress >= 0.97 ? 'finished' : `${Math.round(item.progress * 100)}% read`}` : ''}`;
    btn.type = 'button';
    const name = document.createElement('span');
    name.className = 'sidebar-recent-title';
    name.textContent = item.title;
    btn.append(name);
    if (item.progress > 0.02 && item.progress < 0.97) { // a thin bar shows where you stopped
      const bar = document.createElement('span');
      bar.className = 'sidebar-recent-bar';
      const fill = document.createElement('span');
      fill.style.width = `${Math.round(item.progress * 100)}%`;
      bar.append(fill);
      btn.append(bar);
    }
    btn.addEventListener('click', () => openLibraryItem(item.id));
    return btn;
  }));
  refreshSavedSidebar();

  const resumable = entries.find((e) => e.progress > 0.02 && e.progress < 0.97 && e.id !== state.libraryItemId);
  els.resumeSection.hidden = !resumable;
  if (resumable) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'resume-card';
    const label = document.createElement('span');
    label.className = 'resume-title';
    label.textContent = resumable.title;
    const sub = document.createElement('span');
    sub.className = 'resume-sub';
    sub.textContent = `${sourceTypeLabel(resumable.type)} · ${Math.round(resumable.progress * 100)}% read · ${formatRelativeDate(resumable.lastOpenedAt)}`;
    const bar = document.createElement('span');
    bar.className = 'resume-bar';
    const fill = document.createElement('span');
    fill.style.width = `${Math.round(resumable.progress * 100)}%`;
    bar.append(fill);
    const cta = document.createElement('span');
    cta.className = 'resume-cta';
    cta.append('Resume', icon('arrow-right'));
    button.append(label, sub, bar, cta);
    button.addEventListener('click', () => openLibraryItem(resumable.id));
    els.resumeCard.replaceChildren(button);
  }

  els.recentSection.hidden = false;
  els.recentStack.replaceChildren(...entries.slice(0, 5).map((item) => {
    const li = document.createElement('li');
    li.className = 'recent-row-wrap';
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'recent-row-card';
    card.addEventListener('click', () => openLibraryItem(item.id));
    const iconWrap = document.createElement('span');
    iconWrap.className = 'recent-row-icon';
    iconWrap.append(makeTypeIcon(item.type));
    const main = document.createElement('span');
    main.className = 'recent-row-main';
    const title = document.createElement('span');
    title.className = 'recent-row-title';
    title.textContent = item.title;
    const sub = document.createElement('span');
    sub.className = 'recent-row-sub';
    sub.textContent = `${sourceTypeLabel(item.type)} · ${item.noteCount || 0} note${item.noteCount === 1 ? '' : 's'}${item.progress > 0.02 ? ` · ${Math.round(item.progress * 100)}%` : ''}`;
    main.append(title, sub);
    const time = document.createElement('span');
    time.className = 'recent-row-time';
    time.textContent = formatRelativeDate(item.lastOpenedAt);
    card.append(iconWrap, main, time);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-card-delete';
    del.title = 'Remove from library';
    del.setAttribute('aria-label', `Remove ${item.title} from library`);
    del.append(icon('trash'));
    confirmTwice(del, async () => {
      const res = await api.deleteLibraryItem(item.id);
      if (!res.ok) return showError(res.error);
      refreshHome();
    }, { armedLabel: '' });
    li.append(card, del);
    return li;
  }));
}

// ---------------------------------------------------------------- archive

function setLibrarySection(section) {
  activeLibrarySection = section;
  document.querySelectorAll('[data-library-tab]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.libraryTab === section)));
  els.libClear.hidden = section !== 'history';
  els.libEmpty.querySelector('.empty-icon')?.remove();
  els.libEmpty.prepend(icon(section === 'saved' ? 'bookmark' : 'archive', { className: 'empty-icon' }));
}

function makeLibraryRow(item) {
  const row = document.createElement('li');
  row.className = 'library-row';

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'library-entry-button';
  open.dataset.openItem = item.id;
  const type = document.createElement('div');
  type.className = 'library-type';
  type.textContent = sourceTypeLabel(item.type);
  const title = document.createElement('div');
  title.className = 'library-entry-title';
  title.textContent = item.title || 'Untitled reading';
  const detail = document.createElement('div');
  detail.className = 'library-entry-detail';
  const bits = [`${item.noteCount || 0} note${item.noteCount === 1 ? '' : 's'}`, formatLibraryDate(item.lastOpenedAt)];
  if (item.progress > 0.02) bits.push(item.progress >= 0.97 ? 'Finished' : `${Math.round(item.progress * 100)}% read`);
  detail.textContent = bits.join(' · ');
  open.append(type, title, detail);
  if (item.progress > 0.02) {
    const bar = document.createElement('div');
    bar.className = 'library-progress';
    const fill = document.createElement('span');
    fill.style.width = `${Math.min(100, Math.round(item.progress * 100))}%`;
    bar.append(fill);
    open.append(bar);
  }

  const actions = document.createElement('div');
  actions.className = 'library-row-actions';
  const save = document.createElement('button');
  save.type = 'button';
  save.className = `library-save${item.isSaved ? ' is-saved' : ''}`;
  save.dataset.toggleSaved = item.id;
  save.setAttribute('aria-label', item.isSaved ? 'Remove from saved' : 'Save reading');
  save.title = item.isSaved ? 'Remove from saved' : 'Save reading';
  save.append(icon('bookmark'));
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'library-delete-item';
  remove.setAttribute('aria-label', 'Delete reading from library');
  remove.title = 'Delete reading and its notes';
  remove.append(icon('trash'));
  confirmTwice(remove, async () => {
    const res = await api.deleteLibraryItem(item.id);
    if (!res.ok) return showError(res.error);
    if (state.libraryItemId === item.id) goHomeSilently();
    loadLibrary(activeLibrarySection);
    refreshHome();
  }, { armedLabel: '' });
  actions.append(save, remove);
  row.append(open, actions);
  return row;
}

function goHomeSilently() {
  stopEverything();
  clearPdfPreview();
  state.libraryItemId = null;
  state.blocks = [];
  state.units = [];
  currentNotes = [];
  els.article.hidden = true;
  els.empty.hidden = false;
  els.finishCard.hidden = true;
  leaveFocus();
  setPhase('empty');
  syncButtons();
  updateProgress();
  updateBar();
}

async function loadLibrary(section = activeLibrarySection) {
  setLibrarySection(section);
  const result = await api.listLibrary(section === 'progress' ? 'history' : section, els.libSearch.value.trim());
  if (!result.ok) { showError(`Could not load archive: ${result.error}`); return; }
  const entries = (result.entries || []).filter((e) => section !== 'progress' || (e.progress > 0.02 && e.progress < 0.97));
  els.libList.replaceChildren(...entries.map(makeLibraryRow));
  els.libEmpty.hidden = entries.length > 0;
  if (!entries.length) {
    const searching = els.libSearch.value.trim();
    const copy = searching
      ? ['Nothing matches that search.', 'Try a different word, or clear the search box.']
      : {
        history: ['Your story starts with a first read.', 'Open an article, PDF, or text and it will appear here.'],
        progress: ['Nothing half-finished.', 'Anything you stop partway through waits here, ready to resume.'],
        saved: ['Keep a good one close.', 'Use “Save for later” on a reading to find it here.'],
      }[section];
    els.libEmptyTitle.textContent = copy[0];
    els.libEmptyHint.textContent = copy[1];
  }
}

async function openLibraryItem(id, note = null, { blockIndex = null } = {}) {
  await setView('read');
  const result = await api.openLibraryItem(id);
  if (!result.ok) { showError(result.error); return; }
  renderArticle(result);
  if (note) {
    const target = currentNotes.find((n) => n.id === note.id);
    if (target) {
      toggleNotesPane(true);
      focusNoteOnPage(target);
    }
  } else if (blockIndex != null) {
    jumpToBlock(blockIndex);
  }
}

/** Scroll to a paragraph (from a search result), flash it, and make it the place playback would start. */
function jumpToBlock(blockIndex) {
  const entry = state.blocks[blockIndex];
  if (!entry) return;
  if (entry.firstUnit != null) { state.pos = entry.firstUnit; highlight(entry.firstUnit, { force: true }); }
  entry.el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  entry.el.classList.add('found');
  setTimeout(() => entry.el.classList.remove('found'), 2400);
}

els.libSearch.addEventListener('input', debounce(() => loadLibrary(activeLibrarySection), 250));
document.querySelectorAll('[data-library-tab]').forEach((tab) => tab.addEventListener('click', () => loadLibrary(tab.dataset.libraryTab)));

els.libList.addEventListener('click', async (event) => {
  const save = event.target.closest('[data-toggle-saved]');
  if (save) {
    const result = await api.toggleSavedItem(save.dataset.toggleSaved);
    if (!result.ok) { showError(result.error); return; }
    if (state.libraryItemId === save.dataset.toggleSaved) setSavedUi(result.isSaved);
    loadLibrary(activeLibrarySection);
    refreshSavedSidebar();
    return;
  }
  const open = event.target.closest('[data-open-item]');
  if (open) await openLibraryItem(open.dataset.openItem);
});

confirmTwice(els.libClear, async () => {
  const result = await api.clearHistory();
  if (!result.ok) { showError(result.error); return; }
  toast('History cleared. Saved readings and anything with notes were kept.');
  loadLibrary('history');
  refreshHome();
}, { armedLabel: 'Click again to clear' });

// ---------------------------------------------------------------- loading sources

function setBusy(busy) {
  els.loader.hidden = !busy;
  els.go.disabled = els.heroGo.disabled = els.pdfOpen.disabled = els.heroPdfBtn.disabled = busy;
}

function afterLoad(res, noun) {
  setView('read');
  renderArticle(res);
  if (res.libraryError) showError(`Your ${noun} opened, but it could not be saved to your library: ${res.libraryError}`);
}

async function openUrl(input) {
  hideError();
  setBusy(true);
  renderStatus('Loading article…');
  const res = await api.loadUrl(input);
  setBusy(false);
  if (!res.ok) { showError(res.error); setPhase(state.phase); return; }
  els.url.value = res.article.url;
  els.heroUrl.value = '';
  afterLoad(res, 'article');
}

async function openText(text) {
  hideError();
  renderStatus('Preparing text…');
  els.loader.hidden = false;
  const res = await api.loadText(text);
  els.loader.hidden = true;
  if (!res.ok) { showError(res.error); setPhase(state.phase); return false; }
  afterLoad(res, 'text');
  return true;
}

async function openPdf(droppedPath) {
  hideError();
  setBusy(true);
  renderStatus('Opening PDF…');
  const res = await api.loadPdf(droppedPath);
  setBusy(false);
  if (res.cancelled) { setPhase(state.phase); return; }
  if (!res.ok) { showError(res.error); setPhase(state.phase); return; }
  afterLoad(res, 'PDF');
}

els.form.addEventListener('submit', (event) => { event.preventDefault(); if (els.url.value.trim()) openUrl(els.url.value); });
els.heroForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = els.heroUrl.value.trim();
  if (value) { els.url.value = value; openUrl(value); }
});
els.textOpen.addEventListener('click', () => openTextDialog());
els.pdfOpen.addEventListener('click', () => openPdf());

function openTextDialog(initial = '') {
  if (initial) els.customText.value = initial;
  textEditor.refresh();
  updateTextCount();
  els.textDialog.showModal();
  els.customText.focus();
}
const updateTextCount = () => {
  const words = wordCount(els.customText.value);
  els.textCount.textContent = words ? `${words.toLocaleString()} words — about ${Math.max(1, Math.round(words / WORDS_PER_MINUTE))} min` : '';
  els.textSubmit.disabled = words === 0;
};
els.customText.addEventListener('input', updateTextCount);
els.customText.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); els.textForm.requestSubmit(); }
});
els.textCancel.addEventListener('click', () => els.textDialog.close());
const textEditor = createMarkdownEditor({
  textarea: els.customText, preview: $('#text-preview'), toolbar: $('#text-md-toolbar'), container: $('#text-md-editor'),
  modeButtons: { write: $('#text-tab-write'), split: $('#text-tab-split'), preview: $('#text-tab-preview') },
  onChange: () => updateTextCount(),
});
els.textForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = els.customText.value.trim();
  if (!text) return;
  els.textSubmit.disabled = true;
  const ok = await openText(text);
  updateTextCount();
  if (ok) { els.textDialog.close(); els.customText.value = ''; }
});

api.onStatus((message) => renderStatus(message));
api.onOpenUrl((url) => { els.url.value = url; openUrl(url); });
api.onLog((line) => {
  const lines = (`${els.log.textContent}${line}\n`).split('\n');
  els.log.textContent = lines.slice(-200).join('\n');
  els.log.scrollTop = els.log.scrollHeight;
});

// ---------------------------------------------------------------- drag and drop

let dragDepth = 0;
let internalDrag = false; // dragging text that is already inside the app must not trigger the drop zone
window.addEventListener('dragstart', () => { internalDrag = true; });
window.addEventListener('dragend', () => { internalDrag = false; });
const dragHasContent = (event) => !internalDrag && [...(event.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/plain' || t === 'text/uri-list');
window.addEventListener('dragenter', (event) => {
  if (!dragHasContent(event)) return;
  dragDepth += 1;
  els.dropOverlay.hidden = false;
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
window.addEventListener('dragover', (event) => { if (dragHasContent(event)) event.preventDefault(); });
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  if (internalDrag) { internalDrag = false; return; }
  const file = event.dataTransfer?.files?.[0];
  if (file) {
    const filePath = api.pathForFile(file);
    if (/\.pdf$/i.test(file.name) && filePath) openPdf(filePath);
    else showError('Only PDF files can be dropped here. You can also drop a web link or some text.');
    return;
  }
  const text = (event.dataTransfer?.getData('text/uri-list') || event.dataTransfer?.getData('text/plain') || '').trim();
  if (!text) return;
  if (/^https?:\/\/\S+$/i.test(text)) { els.url.value = text; openUrl(text); }
  else openTextDialog(text);
});

// ---------------------------------------------------------------- collapsible sidebar, resizable notes pane

function setSidebarCollapsed(collapsed, { remember = true } = {}) {
  document.body.classList.toggle('sidebar-collapsed', collapsed);
  els.sidebarToggle.setAttribute('aria-expanded', String(!collapsed));
  els.sidebarToggle.title = `${collapsed ? 'Expand' : 'Collapse'} sidebar (${isMac ? '⌘' : 'Ctrl'} B)`;
  els.sidebarToggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} sidebar`);
  if (remember) store.set('sidebarCollapsed', collapsed);
  requestAnimationFrame(moveMarker);
}
const toggleSidebar = () => setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
els.sidebarToggle.addEventListener('click', toggleSidebar);
setSidebarCollapsed(Boolean(store.get('sidebarCollapsed', false)), { remember: false });

const NOTES_MIN = 280;
const NOTES_DEFAULT = 384;
function notesMax() { return Math.max(NOTES_MIN, Math.min(720, Math.round(window.innerWidth * 0.55))); }
function setNotesWidth(px, { remember = true } = {}) {
  const width = clamp(Math.round(px), NOTES_MIN, notesMax());
  document.documentElement.style.setProperty('--notes-pane-width', `${width}px`);
  els.notesResizer.setAttribute('aria-valuenow', String(width));
  if (remember) store.set('notesPaneWidth', width);
  requestAnimationFrame(moveMarker);
  return width;
}
setNotesWidth(store.get('notesPaneWidth', NOTES_DEFAULT), { remember: false });
window.addEventListener('resize', () => setNotesWidth(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--notes-pane-width')) || NOTES_DEFAULT, { remember: false }));

els.notesResizer.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  els.notesResizer.setPointerCapture(event.pointerId);
  document.body.classList.add('is-resizing');
  const onMove = (e) => setNotesWidth(window.innerWidth - e.clientX, { remember: false });
  const onUp = (e) => {
    els.notesResizer.releasePointerCapture(e.pointerId);
    els.notesResizer.removeEventListener('pointermove', onMove);
    els.notesResizer.removeEventListener('pointerup', onUp);
    els.notesResizer.removeEventListener('pointercancel', onUp);
    document.body.classList.remove('is-resizing');
    setNotesWidth(window.innerWidth - e.clientX);
  };
  els.notesResizer.addEventListener('pointermove', onMove);
  els.notesResizer.addEventListener('pointerup', onUp);
  els.notesResizer.addEventListener('pointercancel', onUp);
});
els.notesResizer.addEventListener('dblclick', () => setNotesWidth(NOTES_DEFAULT));
els.notesResizer.addEventListener('keydown', (event) => {
  const current = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--notes-pane-width')) || NOTES_DEFAULT;
  if (event.key === 'ArrowLeft') { event.preventDefault(); setNotesWidth(current + 24); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); setNotesWidth(current - 24); }
  else if (event.key === 'Home' || event.key === 'Enter') { event.preventDefault(); setNotesWidth(NOTES_DEFAULT); }
});

// ---------------------------------------------------------------- command palette

const palette = initPalette({
  commands: () => [
    { icon: 'plus', label: 'New reading', keywords: 'add link url open', hint: 'Ctrl L', run: focusAddReading },
    { icon: 'type', label: 'Read pasted text', keywords: 'paste', run: () => openTextDialog() },
    { icon: 'file', label: 'Open a PDF', run: () => openPdf() },
    { icon: 'sidebar', label: 'Collapse / expand sidebar', hint: 'Ctrl B', run: toggleSidebar },
    { icon: 'globe', label: 'Reading language and voice', keywords: 'language voice spanish french hindi italian portuguese', run: () => els.settingsDialog.showModal() },
    { icon: 'home', label: 'Go to Home', run: goHome },
    { icon: 'compass', label: 'Go to Discover', run: () => setView('discover') },
    { icon: 'pencil', label: 'Go to Notes', run: () => setView('notes') },
    { icon: 'archive', label: 'Go to Archive', run: () => setView('library') },
    ...(state.url ? [{ icon: 'link', label: 'Copy link to this reading', hint: 'Ctrl Shift C', keywords: 'url address share', run: copyReadingLink }] : []),
    ...(state.libraryItemId ? [
      { icon: 'message', label: 'Toggle notes pane', hint: 'Ctrl J', run: () => { setView('read'); toggleNotesPane(); } },
      { icon: 'focus', label: 'Focus mode', hint: 'F', run: () => { setView('read').then(enterFocus); } },
    ] : []),
    { icon: 'moon', label: 'Switch light / dark', keywords: 'theme', run: () => els.themeToggle.click() },
    { icon: 'settings', label: 'Settings', run: () => els.settingsDialog.showModal() },
    { icon: 'keyboard', label: 'Keyboard shortcuts', hint: '?', run: () => els.shortcutsDialog.showModal() },
  ],
  openItem: (id, options) => openLibraryItem(id, null, options),
  openNote: (note) => (note.itemId === 'standalone' ? setView('notes') : openLibraryItem(note.itemId, note)),
});
els.barSearch.addEventListener('click', () => palette.open());
function openPalette(query = '') { palette.open(query); }
els.paletteBtn.addEventListener('click', () => palette.open());

// ---------------------------------------------------------------- copy the link of the reading

async function copyReadingLink() {
  if (state.view !== 'read' || els.article.hidden) { toast('Open a reading first.'); return; }
  if (!state.url) { toast(state.title ? 'This reading has no web address (it is a PDF or your own text).' : 'Open a reading first.'); return; }
  try {
    await navigator.clipboard.writeText(state.url);
    toast('Link copied.', { duration: 2200 });
  } catch {
    const box = Object.assign(document.createElement('textarea'), { value: state.url });
    document.body.append(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    toast(ok ? 'Link copied.' : 'Could not copy the link.', { duration: 2200 });
  }
}
els.copyLink.addEventListener('click', copyReadingLink);

// ---------------------------------------------------------------- keyboard

function isTyping() {
  const tag = document.activeElement?.tagName || '';
  return /^(INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(tag) || document.activeElement?.isContentEditable;
}

document.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'b') { event.preventDefault(); toggleSidebar(); return; }
  if (mod && key === 'l') { event.preventDefault(); focusAddReading(); return; }
  if (mod && key === 'k') { event.preventDefault(); if (document.querySelector('dialog[open]')) return; palette.open(); return; }
  if (mod && event.shiftKey && key === 'c' && !isTyping()) { event.preventDefault(); copyReadingLink(); return; }
  if (mod && key === 'j') { event.preventDefault(); if (state.libraryItemId) { setView('read'); toggleNotesPane(); } return; }
  if (event.key === 'Escape') {
    if (!document.querySelector('dialog[open]')) leaveFocus();
    hideSelectionToolbar();
    if (pendingNote && !document.querySelector('dialog[open]')) { clearActiveNoteAnchor(); syncComposerToPlayback(); }
    return;
  }
  if (mod || event.altKey || document.querySelector('dialog[open]')) return;
  if (isTyping()) return;

  if (event.key === '?') { els.shortcutsDialog.showModal(); return; }
  if (event.key === '/') {
    if (state.view === 'library') { event.preventDefault(); els.libSearch.focus(); return; }
    if (state.view === 'notes') { event.preventDefault(); $('#ws-search-input').focus(); return; }
  }
  if (state.view !== 'read') return;
  if (event.key === ' ' && document.activeElement?.tagName !== 'BUTTON') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowRight') jump(1);
  else if (event.key === 'ArrowLeft') jump(-1);
  else if (key === 'f' && !els.article.hidden) { document.body.classList.contains('focus-mode') ? leaveFocus() : enterFocus(); }
  else if (event.key === '[') updateSpeed(state.speed - 0.1);
  else if (event.key === ']') updateSpeed(state.speed + 0.1);
  else if (key === 'h') { if (selectionAnchor()) { toolbarAnchor = null; highlightSelection(state.lastColor); } }
  else if (key === 'n' && state.libraryItemId) {
    event.preventDefault();
    pinAnchor(selectionAnchor() || blockAnchor(state.currentBlock >= 0 ? state.currentBlock : Math.max(0, state.blocks.findIndex((b) => b.firstUnit !== null))));
  }
});

// ---------------------------------------------------------------- start

syncButtons();
renderStatus();
setView('read');
checkComposer();
refreshHome();
initVoices();
