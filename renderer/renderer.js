import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();
const standardFontDataUrl = 'voxo-pdf://pdfjs/standard_fonts/';
const cMapUrl = 'voxo-pdf://pdfjs/cmaps/';

const api = window.readerApi;
const $ = (selector) => document.querySelector(selector);
const els = {
  homeBtn: $('#home-btn'),
  form: $('#url-form'), url: $('#url'), go: $('#go'),
  heroForm: $('#hero-url-form'), heroUrl: $('#hero-url'), heroGo: $('#hero-go'),
  textOpen: $('#text-open'), pdfOpen: $('#pdf-open'), libraryOpen: $('#library-open'),
  notesToggle: $('#notes-toggle'), notesCountBadge: $('#notes-count-badge'),
  cardUrl: $('#card-url'), cardPdf: $('#card-pdf'), cardText: $('#card-text'),
  recentSection: $('#recent-section'), recentList: $('#recent-list'), recentViewAll: $('#recent-view-all'),
  textDialog: $('#text-dialog'), textForm: $('#text-form'), customText: $('#custom-text'), textCancel: $('#text-cancel'), textCloseX: $('#text-close-x'), textSubmit: $('#text-submit'),

  libraryView: $('#library-view'), libraryClose: $('#library-close'), libraryCloseText: $('#library-close-text'), libraryClearHistory: $('#library-clear-history'), libraryList: $('#library-list'), libraryEmpty: $('#library-empty'), libraryEmptyTitle: $('#library-empty-title'), libraryEmptyHint: $('#library-empty-hint'), librarySearch: $('#library-search'),

  options: $('#options'), voice: $('#voice'), allowDownload: $('#allow-download'), log: $('#log'),
  colorTheme: $('#color-theme'), fontStyle: $('#font-style'), fontSize: $('#font-size'), fontSizeValue: $('#font-size-value'),
  lineWidth: $('#line-width'), lineWidthValue: $('#line-width-value'), lineSpacing: $('#line-spacing'), lineSpacingValue: $('#line-spacing-value'),
  banner: $('#banner'), bannerText: $('#banner-text'), bannerHint: $('#banner-hint'), bannerClose: $('#banner-close'),
  scroller: $('#scroller'), empty: $('#empty'), article: $('#article'),
  marker: $('#marker'), sourceLabel: $('#source-label'), bookmarkToggle: $('#bookmark-toggle'), bookmarkLabel: $('#bookmark-label'), title: $('#title'), meta: $('#meta'), body: $('#body'),
  noteCallout: $('#note-callout'), noteCalloutQuote: $('#note-callout-quote'), noteCalloutBody: $('#note-callout-body'), noteCalloutClose: $('#note-callout-close'),
  pdfPreview: $('#pdf-preview'), pdfPreviewTitle: $('#pdf-preview-title'), pdfPreviewPages: $('#pdf-preview-pages'), pdfPreviewMore: $('#pdf-preview-more'),
  notesPane: $('#notes-pane'), notesPaneClose: $('#notes-pane-close'),
  noteForm: $('#note-form'), noteAnchorDot: $('#note-anchor-dot'), noteAnchorLabel: $('#note-anchor-label'), noteAnchorReset: $('#note-anchor-reset'),
  noteQuote: $('#note-quote'), noteBody: $('#note-body'), noteSubmit: $('#note-submit'),
  notesStreamCount: $('#notes-stream-count'), articleNotesList: $('#article-notes-list'), articleNotesEmpty: $('#article-notes-empty'),
  prev: $('#prev'), play: $('#play'), next: $('#next'),
  status: $('#status'), left: $('#left'), speed: $('#speed'), speedValue: $('#speed-value'), fill: $('#progress-fill'),
};
const readout = els.status.parentElement;

const WORDS_PER_MINUTE = 150;
const AHEAD = 2;
const PDF_PREVIEW_BATCH_SIZE = 8;
const INLINE_TAGS = new Set(['strong', 'em', 'mark', 'code', 'kbd', 'sup', 'sub', 'del', 'ins', 'small', 'abbr', 'p', 'br', 'span', 'a']);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const systemDarkMode = window.matchMedia('(prefers-color-scheme: dark)');

const clampSetting = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

// ---------------------------------------------------------------- saved settings

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`readertts.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`readertts.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

// ---------------------------------------------------------------- state

const state = {
  blocks: [],        // { data, el, firstUnit, speakNumber, noteBtn }
  units: [],         // { blockIndex, text, startWords }
  totalWords: 0,
  speakableBlocks: 0,
  pos: 0,            // index into units
  loaded: -1,        // unit currently loaded in the <audio> element
  currentBlock: -1,
  playing: false,
  phase: 'empty',    // empty | ready | preparing | reading | paused | done
  gen: 0,            // bumped whenever queued audio becomes stale
  voice: null,
  speed: clampSetting(store.get('speed', 1), 0.6, 2.4, 1),
  libraryItemId: null,
  isSaved: false,
  notes: [],         // notes for the currently open reading item
  notesPaneOpen: Boolean(store.get('notesPaneOpen', true)),
  activeNoteId: null,
};

/**
 * Tracks what passage the right-hand note composer is currently bound to:
 * mode: 'live' | 'pinned' | 'selection'
 */
let composerAnchor = {
  mode: 'live',
  blockIndex: 0,
  startOffset: null,
  endOffset: null,
  quote: '',
};

const FONT_OPTIONS = ['serif', 'literary', 'classic', 'sans', 'humanist', 'mono'];

const readingSettings = {
  theme: ['system', 'light', 'dark'].includes(store.get('reading.theme', 'dark')) ? store.get('reading.theme', 'dark') : 'dark',
  font: FONT_OPTIONS.includes(store.get('reading.font', 'serif')) ? store.get('reading.font', 'serif') : 'serif',
  fontSize: clampSetting(store.get('reading.fontSize', 20), 16, 28, 20),
  lineWidth: clampSetting(store.get('reading.lineWidth', 96), 60, 112, 96),
  lineSpacing: Math.round(clampSetting(store.get('reading.lineSpacing', 1.8), 1.4, 2.2, 1.8) * 10) / 10,
};

let voicesInfo = null;
let pdfPreviewState = null;
let activeLibrarySection = 'history';
const audio = new Audio();
const cache = new Map();

// ---------------------------------------------------------------- messages and status

function showError(message, hint) {
  els.bannerText.textContent = message;
  if (!hint && /allow-download/.test(message)) {
    hint = 'Open Voice settings, allow the voice model download, then press play again.';
  }
  els.bannerHint.textContent = hint || '';
  els.bannerHint.hidden = !hint;
  els.banner.hidden = false;
}

const hideError = () => { els.banner.hidden = true; };
els.bannerClose.addEventListener('click', hideError);

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
    ready: 'Ready. Press play or click any paragraph.',
    preparing: 'Preparing neural voice…',
    reading: where ? `Listening · ${where}` : 'Listening',
    paused: where ? `Paused · ${where}` : 'Paused',
    done: 'Finished reading.',
  }[state.phase];
  els.status.textContent = override || text;
  readout.classList.toggle('busy', state.phase === 'preparing' || Boolean(override));
}

function updateProgress() {
  const unit = state.units[state.pos];
  const spoken = unit ? unit.startWords : 0;
  const remaining = Math.max(0, state.totalWords - spoken);
  const minutes = remaining / (WORDS_PER_MINUTE * state.speed);
  els.fill.style.width = state.totalWords ? `${Math.min(100, (spoken / state.totalWords) * 100)}%` : '0';
  if (!state.units.length || state.phase === 'done') els.left.textContent = '';
  else els.left.textContent = minutes < 1 ? 'Under a minute left' : `About ${Math.round(minutes)} min left`;
}

function syncButtons() {
  const hasArticle = state.units.length > 0;
  els.play.disabled = els.prev.disabled = els.next.disabled = !hasArticle;
  els.play.setAttribute('aria-label', state.playing ? 'Pause' : 'Play');
  els.play.setAttribute('aria-pressed', String(state.playing));
  els.play.classList.toggle('is-playing', state.playing);
}

// ---------------------------------------------------------------- article rendering

function inlineNodes(runs) {
  return (runs || []).flatMap((run) => {
    if (Object.hasOwn(run, 'text')) return [document.createTextNode(run.text)];
    if (!INLINE_TAGS.has(run.tag)) return inlineNodes(run.children);
    const el = document.createElement(run.tag);
    if (run.tag === 'span' && run.className === 'inline-link') el.className = 'inline-link';
    if (run.tag === 'a') {
      el.href = run.href;
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.className = 'inline-link';
    }
    el.append(...inlineNodes(run.children));
    return [el];
  });
}

function elementFor(block) {
  let el;
  if (block.type === 'image') {
    el = document.createElement('figure');
    el.className = 'image-block';
    const image = document.createElement('img');
    image.alt = block.alt || '';
    if (block.srcSet) image.srcset = block.srcSet;
    image.sizes = '(max-width: 40rem) calc(100vw - 3rem), (max-width: 73.5rem) 68vw, 50rem';
    image.src = block.src;
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
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
  el.querySelector('.note-action')?.remove();
  if (!['title', 'heading', 'p', 'li', 'quote'].includes(entry.data.type) || !state.libraryItemId) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'note-action';
  button.setAttribute('aria-label', `Add or view notes for this ${entry.data.type === 'li' ? 'list item' : 'passage'}`);
  button.title = 'Pin passage to notes pane';
  button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16.5V20h3.5L19 8.5 15.5 5 4 16.5Zm17.7-10.3a1 1 0 0 0 0-1.4l-2.5-2.5a1 1 0 0 0-1.4 0l-1.7 1.7 3.5 3.5 2.1-1.3Z"/></svg><span class="note-action-count" hidden></span>';
  button.addEventListener('mousedown', (event) => event.preventDefault());
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const block = state.blocks[blockIndex];
    if (block) pinBlockToNoteComposer(blockIndex, true);
  });
  entry.noteBtn = button;
  el.appendChild(button);
}

function clearPdfPreview() {
  const previous = pdfPreviewState;
  pdfPreviewState = null;
  els.pdfPreview.open = false;
  if (previous) {
    for (const url of previous.objectUrls) URL.revokeObjectURL(url);
    const doc = previous.documentPromise;
    if (doc) doc.then((pdf) => pdf.destroy()).catch(() => {});
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
    ? `PDF page previews · ${rendered} of ${preview.pageCount}`
    : `PDF page previews · ${preview.pageCount} pages`;
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
        data: preview.data,
        standardFontDataUrl,
        cMapUrl,
        cMapPacked: true,
        useWorkerFetch: false,
        isEvalSupported: false,
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
        const baseViewport = page.getViewport({ scale: 1 });
        viewport = page.getViewport({ scale: Math.min(1.5, 1100 / baseViewport.width, 1800 / baseViewport.height) });
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

function updateBookmarkUI() {
  els.bookmarkToggle.hidden = !state.libraryItemId;
  els.bookmarkLabel.textContent = state.isSaved ? 'Saved' : 'Save';
  els.bookmarkToggle.setAttribute('aria-pressed', String(state.isSaved));
  els.bookmarkToggle.classList.toggle('is-saved', state.isSaved);
}

function syncNotesPaneVisibility() {
  const hasOpenArticle = !els.article.hidden && Boolean(state.libraryItemId);
  els.notesToggle.hidden = !hasOpenArticle;
  const showPane = hasOpenArticle && state.notesPaneOpen;
  els.notesPane.hidden = !showPane;
  els.notesToggle.setAttribute('aria-pressed', String(showPane));
  document.body.classList.toggle('notes-pane-open', showPane);
  requestAnimationFrame(moveMarker);
}

function setNotesPaneOpen(open) {
  state.notesPaneOpen = Boolean(open);
  store.set('notesPaneOpen', state.notesPaneOpen);
  syncNotesPaneVisibility();
}

function renderArticle(article, pdfData = null, libraryItemId = null, isSaved = false, fileUnavailable = false, initialNotes = []) {
  clearPdfPreview();
  clearActiveNote();
  state.libraryItemId = libraryItemId;
  state.isSaved = Boolean(isSaved);
  state.notes = Array.isArray(initialNotes) ? initialNotes : [];
  updateBookmarkUI();

  const hasPdfPreview = Boolean(pdfData && article.pdfPageCount);
  if (hasPdfPreview) {
    pdfPreviewState = {
      data: pdfData,
      pageCount: article.pdfPageCount,
      nextPage: 1,
      document: null,
      documentPromise: null,
      objectUrls: [],
      loading: false,
    };
    updatePdfPreviewControls(pdfPreviewState);
  }
  stopEverything();
  els.title.classList.remove('current');
  if (article.pdfPageCount) {
    els.sourceLabel.textContent = `PDF · ${article.pdfPageCount} pages`;
  } else if (/^https?:\/\//i.test(article.url || '')) {
    let host = 'Web article';
    try { host = new URL(article.url).hostname.replace(/^www\./i, ''); } catch { /* fallback */ }
    els.sourceLabel.textContent = `Web article · ${host}`;
  } else {
    els.sourceLabel.textContent = 'Custom text';
  }
  els.title.textContent = article.title || article.url;
  const metaItems = [
    article.byline,
    article.pdfPageCount ? '' : article.siteName,
    article.words ? `${article.words.toLocaleString()} words · ~${Math.max(1, Math.round(article.words / WORDS_PER_MINUTE))} min listen` : '',
  ].filter(Boolean);
  els.meta.replaceChildren(...metaItems.map((text) => Object.assign(document.createElement('span'), { textContent: text })));
  els.meta.hidden = metaItems.length === 0;
  els.pdfPreview.hidden = !hasPdfPreview;
  els.pdfPreview.open = hasPdfPreview;
  els.pdfPreviewPages.replaceChildren();

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
    const entry = { data: block, el, firstUnit: null, speakNumber: 0, noteBtn: null };
    const blockIndex = state.blocks.push(entry) - 1;
    el.dataset.block = String(blockIndex);
    attachNoteAction(el, entry, blockIndex);
    if (block.speak && block.chunks.length) {
      entry.firstUnit = state.units.length;
      entry.speakNumber = ++state.speakableBlocks;
      const perChunk = block.words / block.chunks.length;
      block.chunks.forEach((text) => {
        state.units.push({ blockIndex, text, startWords: state.totalWords });
        state.totalWords += perChunk;
      });
    }
  });
  els.body.replaceChildren(fragment);

  state.pos = 0;
  state.currentBlock = -1;
  els.article.classList.remove('focused');

  els.empty.hidden = true;
  els.libraryView.hidden = true;
  els.article.hidden = false;
  els.scroller.scrollTop = 0;

  els.noteBody.value = '';
  syncLiveNoteAnchor(true);
  renderArticleNotes();
  syncNotesPaneVisibility();

  syncButtons();
  setPhase(state.units.length ? 'ready' : 'empty');
  if (!state.units.length && hasPdfPreview) renderStatus('No selectable text was found. The document pages are shown below.');
  updateProgress();
  document.title = `${article.title || 'voxo'} — voxo`;
  if (fileUnavailable) renderStatus('Saved PDF text opened. The original file is no longer available for page previews.');
}

function showHomeScreen() {
  stopEverything(true);
  clearPdfPreview();
  clearActiveNote();
  els.article.hidden = true;
  els.libraryView.hidden = true;
  els.empty.hidden = false;
  syncNotesPaneVisibility();
  setPhase('empty');
  updateProgress();
  document.title = 'voxo';
  loadRecentReadings();
}

function showLibraryScreen(section = 'history') {
  els.empty.hidden = true;
  els.article.hidden = true;
  els.libraryView.hidden = false;

  if (state.units.length > 0) {
    els.libraryCloseText.textContent = 'Back to Article';
  } else {
    els.libraryCloseText.textContent = 'Back to Home';
  }

  resetClearHistoryConfirm();
  els.librarySearch.value = '';
  loadLibrary(section);
  syncNotesPaneVisibility();
}

els.homeBtn.addEventListener('click', () => {
  if (state.units.length > 0) {
    els.empty.hidden = true;
    els.libraryView.hidden = true;
    els.article.hidden = false;
    syncNotesPaneVisibility();
  } else {
    showHomeScreen();
  }
});

els.pdfPreview.addEventListener('toggle', () => {
  if (els.pdfPreview.open) loadPdfPreviewBatch();
});
els.pdfPreviewMore.addEventListener('click', loadPdfPreviewBatch);

// ---------------------------------------------------------------- right-side notes pane & live context

function blockLabelForIndex(blockIndex) {
  const entry = state.blocks[blockIndex];
  if (!entry) return 'Passage';
  if (entry.data.type === 'title') return 'Article Title';
  if (entry.data.type === 'heading') return 'Section Heading';
  if (entry.speakNumber) return `Paragraph ${entry.speakNumber}`;
  return `Passage ${blockIndex}`;
}

function defaultLiveBlockIndex() {
  if (state.currentBlock >= 0 && state.blocks[state.currentBlock]) return state.currentBlock;
  const firstProse = state.blocks.findIndex((b, idx) => idx > 0 && b.data.text?.trim());
  return firstProse >= 0 ? firstProse : 0;
}

function updateComposerAnchorUI() {
  const label = blockLabelForIndex(composerAnchor.blockIndex);
  if (composerAnchor.mode === 'selection') {
    els.noteAnchorDot.classList.add('is-locked');
    els.noteAnchorLabel.textContent = `Selected text · ${label}`;
    els.noteAnchorReset.hidden = false;
  } else if (composerAnchor.mode === 'pinned') {
    els.noteAnchorDot.classList.add('is-locked');
    els.noteAnchorLabel.textContent = `Pinned · ${label}`;
    els.noteAnchorReset.hidden = false;
  } else {
    els.noteAnchorDot.classList.remove('is-locked');
    els.noteAnchorLabel.textContent = state.playing
      ? `Listening now · ${label}`
      : `Live context · ${label}`;
    els.noteAnchorReset.hidden = true;
  }
  els.noteQuote.textContent = composerAnchor.quote || 'Select a passage or start listening…';
}

function syncLiveNoteAnchor(force = false) {
  if (!state.blocks.length) return;
  // Don't overwrite the user's anchor while they are actively typing a note
  if (!force && (composerAnchor.mode !== 'live' || els.noteBody.value.trim().length > 0)) {
    return;
  }
  const idx = defaultLiveBlockIndex();
  const entry = state.blocks[idx];
  composerAnchor = {
    mode: 'live',
    blockIndex: idx,
    startOffset: null,
    endOffset: null,
    quote: String(entry?.data?.text || '').trim(),
  };
  updateComposerAnchorUI();
}

function pinBlockToNoteComposer(blockIndex, focusInput = false) {
  const entry = state.blocks[blockIndex];
  if (!entry) return;
  const selectionAnchor = selectionAnchorInBlock(entry);
  if (selectionAnchor) {
    composerAnchor = { mode: 'selection', ...selectionAnchor };
  } else {
    composerAnchor = {
      mode: 'pinned',
      blockIndex,
      startOffset: null,
      endOffset: null,
      quote: String(entry.data.text || '').trim(),
    };
  }
  updateComposerAnchorUI();
  if (!state.notesPaneOpen) setNotesPaneOpen(true);
  if (focusInput) requestAnimationFrame(() => els.noteBody.focus());
}

function textOffsetBefore(element, container, offset) {
  if (element.querySelector('br')) return null;
  try {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.setEnd(container, offset);
    return range.toString().length;
  } catch { return null; }
}

function selectionAnchorInBlock(entry) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!entry.el.contains(range.startContainer) || !entry.el.contains(range.endContainer)) return null;
  const raw = range.toString();
  const quote = raw.trim();
  if (!quote) return null;
  const leading = raw.length - raw.trimStart().length;
  const trailing = raw.length - raw.trimEnd().length;
  const start = textOffsetBefore(entry.el, range.startContainer, range.startOffset);
  const end = textOffsetBefore(entry.el, range.endContainer, range.endOffset);
  return {
    blockIndex: Number(entry.el.dataset.block),
    startOffset: start === null ? null : start + leading,
    endOffset: end === null ? null : Math.max(start + leading, end - trailing),
    quote,
  };
}

// Automatically capture text selections inside the article into the right-hand note composer
document.addEventListener('selectionchange', () => {
  if (els.article.hidden || !state.libraryItemId) return;
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  const blockEl = range.startContainer.parentElement?.closest('.block');
  if (!blockEl || !els.article.contains(blockEl)) return;
  const entry = state.blocks[Number(blockEl.dataset.block)];
  if (!entry) return;
  const anchor = selectionAnchorInBlock(entry);
  if (anchor) {
    composerAnchor = { mode: 'selection', ...anchor };
    updateComposerAnchorUI();
  }
});

// Lock the live anchor as soon as the user starts typing so paragraph changes don't shift it mid-thought
els.noteBody.addEventListener('input', () => {
  if (composerAnchor.mode === 'live' && els.noteBody.value.trim().length > 0) {
    composerAnchor.mode = 'pinned';
    updateComposerAnchorUI();
  }
});

els.noteAnchorReset.addEventListener('click', () => {
  window.getSelection()?.removeAllRanges();
  composerAnchor.mode = 'live';
  syncLiveNoteAnchor(true);
});

els.notesToggle.addEventListener('click', () => setNotesPaneOpen(!state.notesPaneOpen));
els.notesPaneClose.addEventListener('click', () => setNotesPaneOpen(false));

function updateBlockNoteIndicators() {
  const counts = new Map();
  for (const note of state.notes) {
    const idx = Number(note.blockIndex);
    counts.set(idx, (counts.get(idx) || 0) + 1);
  }
  state.blocks.forEach((entry, idx) => {
    const count = counts.get(idx) || 0;
    entry.el.classList.toggle('has-notes', count > 0);
    const badge = entry.noteBtn?.querySelector('.note-action-count');
    if (badge) {
      badge.textContent = count > 0 ? String(count) : '';
      badge.hidden = count === 0;
    }
  });
}

function updateSpeakingNoteCards() {
  els.articleNotesList.querySelectorAll('.note-card').forEach((card) => {
    const blockIdx = Number(card.dataset.blockIndex);
    card.classList.toggle('is-speaking', state.currentBlock >= 0 && blockIdx === state.currentBlock);
    card.classList.toggle('is-active', card.dataset.noteId === state.activeNoteId);
  });
}

function renderArticleNotes() {
  const count = state.notes.length;
  els.notesCountBadge.textContent = String(count);
  els.notesCountBadge.hidden = count === 0;
  els.notesStreamCount.textContent = count === 1 ? '1 note on this reading' : `${count} notes on this reading`;
  els.articleNotesEmpty.hidden = count > 0;

  const sorted = [...state.notes].sort((a, b) => (a.blockIndex - b.blockIndex) || (a.createdAt - b.createdAt));
  const items = sorted.map((note) => {
    const li = document.createElement('li');
    li.className = 'note-card';
    li.dataset.noteId = note.id;
    li.dataset.blockIndex = String(note.blockIndex);

    const top = document.createElement('div');
    top.className = 'note-card-top';

    const loc = document.createElement('span');
    loc.className = 'note-card-loc';
    loc.textContent = blockLabelForIndex(Number(note.blockIndex));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'note-card-delete';
    del.dataset.deleteArticleNote = note.id;
    del.setAttribute('aria-label', 'Delete note');
    del.title = 'Delete note';
    del.textContent = '×';

    top.append(loc, del);

    const quote = document.createElement('blockquote');
    quote.className = 'note-card-quote';
    quote.textContent = note.quote;

    const body = document.createElement('p');
    body.className = 'note-card-body';
    body.textContent = note.body;

    li.append(top, quote, body);
    return li;
  });

  els.articleNotesList.replaceChildren(...items);
  updateBlockNoteIndicators();
  updateSpeakingNoteCards();
}

function clearActiveNote() {
  state.activeNoteId = null;
  document.querySelectorAll('.note-target').forEach((el) => el.classList.remove('note-target'));
  if (globalThis.CSS?.highlights) CSS.highlights.delete('voxo-note-anchor');
  els.noteCallout.hidden = true;
  els.meta.after(els.noteCallout);
  updateSpeakingNoteCards();
}

function highlightSavedText(element, startOffset, endOffset) {
  if (!globalThis.CSS?.highlights || typeof globalThis.Highlight !== 'function') return;
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset) || endOffset <= startOffset) return;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let current = 0;
  let start = null;
  let end = null;
  let node;
  while ((node = walker.nextNode())) {
    const next = current + node.textContent.length;
    if (!start && startOffset >= current && startOffset <= next) {
      start = { node, offset: startOffset - current };
    }
    if (start && endOffset >= current && endOffset <= next) {
      end = { node, offset: endOffset - current };
      break;
    }
    current = next;
  }
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  CSS.highlights.set('voxo-note-anchor', new Highlight(range));
}

function showNoteAtAnchor(note, showInlineCallout = false) {
  clearActiveNote();
  const entry = state.blocks[Number(note.blockIndex)];
  if (!entry) {
    showError('The saved note could not find its passage in this reading.');
    return;
  }
  state.activeNoteId = note.id || null;
  entry.el.classList.add('note-target');
  highlightSavedText(entry.el, note.startOffset, note.endOffset);
  if (showInlineCallout) {
    els.noteCalloutQuote.textContent = note.quote;
    els.noteCalloutBody.textContent = note.body;
    els.noteCallout.hidden = false;
    entry.el.insertAdjacentElement('afterend', els.noteCallout);
  }
  entry.el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  updateSpeakingNoteCards();
}

els.noteCalloutClose.addEventListener('click', clearActiveNote);

async function submitComposerNote() {
  if (!state.libraryItemId) return;
  const bodyText = els.noteBody.value.trim();
  if (!bodyText) return;
  if (!composerAnchor.quote) {
    syncLiveNoteAnchor(true);
  }
  els.noteSubmit.disabled = true;
  const payload = {
    itemId: state.libraryItemId,
    blockIndex: composerAnchor.blockIndex,
    startOffset: composerAnchor.startOffset,
    endOffset: composerAnchor.endOffset,
    quote: composerAnchor.quote,
    body: bodyText,
  };
  const result = await api.addNote(payload);
  els.noteSubmit.disabled = false;
  if (!result.ok) {
    showError(result.error);
    return;
  }
  const created = result.note || { ...payload, id: result.noteId, createdAt: Date.now() };
  state.notes.push(created);
  els.noteBody.value = '';
  window.getSelection()?.removeAllRanges();
  composerAnchor.mode = 'live';
  syncLiveNoteAnchor(true);
  renderArticleNotes();
  showNoteAtAnchor(created, false);
}

els.noteForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitComposerNote();
});

els.noteBody.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    event.preventDefault();
    submitComposerNote();
  }
});

els.articleNotesList.addEventListener('click', async (event) => {
  const delBtn = event.target.closest('[data-delete-article-note]');
  if (delBtn) {
    event.stopPropagation();
    const id = delBtn.dataset.deleteArticleNote;
    const result = await api.deleteNote(id);
    if (!result.ok) {
      showError(result.error);
      return;
    }
    state.notes = state.notes.filter((n) => n.id !== id);
    if (state.activeNoteId === id) clearActiveNote();
    renderArticleNotes();
    return;
  }
  const card = event.target.closest('.note-card');
  if (!card) return;
  const note = state.notes.find((n) => n.id === card.dataset.noteId);
  if (note) showNoteAtAnchor(note, false);
});

// ---------------------------------------------------------------- personal library & recent readings

function formatLibraryDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

function sourceTypeLabel(type) {
  return ({ article: 'ARTICLE', pdf: 'PDF', text: 'CUSTOM TEXT' })[type] || 'READING';
}

let clearHistoryConfirmTimer = null;

function resetClearHistoryConfirm() {
  if (clearHistoryConfirmTimer) {
    clearTimeout(clearHistoryConfirmTimer);
    clearHistoryConfirmTimer = null;
  }
  els.libraryClearHistory.classList.remove('is-confirming');
  els.libraryClearHistory.textContent = 'Clear history';
}

function detachDeletedItemIfCurrent(id) {
  if (state.libraryItemId && (!id || state.libraryItemId === id)) {
    state.libraryItemId = null;
    state.isSaved = false;
    state.notes = [];
    clearActiveNote();
    updateBookmarkUI();
    renderArticleNotes();
    syncNotesPaneVisibility();
  }
}

async function loadRecentReadings() {
  const result = await api.listLibrary('history');
  if (!result.ok || !result.entries?.length) {
    els.recentSection.hidden = true;
    return;
  }
  const recent = result.entries.slice(0, 8);
  els.recentList.replaceChildren(...recent.map((item) => {
    const li = document.createElement('li');
    li.className = 'recent-row-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'recent-row-card';
    btn.addEventListener('click', () => openLibraryItem(item.id));

    const icon = document.createElement('span');
    icon.className = 'recent-row-icon';
    icon.textContent = item.type === 'pdf' ? 'PDF' : item.type === 'text' ? 'Aa' : '↗';

    const main = document.createElement('div');
    main.className = 'recent-row-main';

    const title = document.createElement('strong');
    title.className = 'recent-row-title';
    title.textContent = item.title || 'Untitled reading';

    const sub = document.createElement('span');
    sub.className = 'recent-row-sub';
    const notesInfo = item.noteCount ? ` · ${item.noteCount} ${item.noteCount === 1 ? 'note' : 'notes'}` : '';
    const savedInfo = item.isSaved ? ' · Saved' : '';
    sub.textContent = `${sourceTypeLabel(item.type)}${savedInfo}${notesInfo}`;

    main.append(title, sub);

    const time = document.createElement('span');
    time.className = 'recent-row-time';
    time.textContent = formatLibraryDate(item.lastOpenedAt);

    btn.append(icon, main, time);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'recent-card-delete';
    del.setAttribute('aria-label', 'Remove from history');
    del.title = 'Remove from history';
    del.textContent = '×';
    del.addEventListener('click', async (event) => {
      event.stopPropagation();
      const res = await api.deleteLibraryItem(item.id);
      if (!res.ok) { showError(res.error); return; }
      loadRecentReadings();
    });

    li.append(btn, del);
    return li;
  }));
  els.recentSection.hidden = false;
}

function setLibrarySection(section) {
  activeLibrarySection = section;
  resetClearHistoryConfirm();
  document.querySelectorAll('[data-library-tab]').forEach((tab) => {
    tab.setAttribute('aria-selected', String(tab.dataset.libraryTab === section));
  });
}

function makeLibrarySourceRow(item) {
  const row = document.createElement('li');
  row.className = 'library-row';

  const mainWrap = document.createElement('div');
  mainWrap.className = 'library-row-main';

  const type = document.createElement('div');
  type.className = 'library-type';

  const typeTag = document.createElement('span');
  typeTag.className = 'library-type-tag';
  typeTag.textContent = sourceTypeLabel(item.type);

  const noteBadge = item.noteCount ? ` · ${item.noteCount} ${item.noteCount === 1 ? 'NOTE' : 'NOTES'}` : '';
  const dateStr = formatLibraryDate(item.lastOpenedAt);
  type.append(typeTag, document.createTextNode(` · ${dateStr}${noteBadge}`));

  const title = document.createElement('strong');
  title.className = 'library-entry-title';
  title.textContent = item.title || 'Untitled reading';

  mainWrap.append(type, title);

  const actions = document.createElement('div');
  actions.className = 'library-row-actions';

  const save = document.createElement('button');
  save.type = 'button';
  save.className = `library-save${item.isSaved ? ' is-saved' : ''}`;
  save.dataset.toggleSaved = item.id;
  save.setAttribute('aria-label', item.isSaved ? 'Remove from saved' : 'Save reading');
  save.title = item.isSaved ? 'Remove from saved' : 'Save reading';
  save.textContent = item.isSaved ? '★' : '☆';

  save.addEventListener('click', (e) => e.stopPropagation());

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'library-delete-item';
  remove.dataset.deleteItem = item.id;
  remove.setAttribute('aria-label', 'Delete reading from library');
  remove.title = 'Delete reading from library';
  remove.textContent = '×';
  remove.addEventListener('click', (e) => e.stopPropagation());

  actions.append(save, remove);
  row.append(mainWrap, actions);

  row.dataset.openItem = item.id;

  return row;
}

function makeLibraryNoteRow(note) {
  const row = document.createElement('li');
  row.className = 'library-row library-note-row';
  row.dataset.openNote = note.id;

  const mainWrap = document.createElement('div');
  mainWrap.className = 'library-row-main';

  const type = document.createElement('div');
  type.className = 'library-type';
  const typeTag = document.createElement('span');
  typeTag.className = 'library-type-tag';
  typeTag.textContent = sourceTypeLabel(note.sourceType);
  type.append(typeTag, document.createTextNode(` · ${formatLibraryDate(note.createdAt)}`));

  const source = document.createElement('strong');
  source.className = 'library-entry-title';
  source.textContent = note.sourceTitle || 'Untitled reading';

  const quote = document.createElement('blockquote');
  quote.className = 'library-note-quote';
  quote.textContent = note.quote;

  const body = document.createElement('p');
  body.className = 'library-note-body';
  body.textContent = note.body;

  mainWrap.append(type, source, quote, body);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'library-remove-note';
  remove.dataset.deleteNote = note.id;
  remove.setAttribute('aria-label', 'Delete note');
  remove.title = 'Delete note';
  remove.textContent = '×';
  remove.addEventListener('click', (e) => e.stopPropagation());

  const actions = document.createElement('div');
  actions.className = 'library-row-actions';
  actions.append(remove);

  row.append(mainWrap, actions);
  return row;
}

function setLibraryEmpty(section, hasQuery = false) {
  if (hasQuery) {
    els.libraryEmptyTitle.textContent = 'No results found.';
    els.libraryEmptyHint.textContent = 'Try adjusting your search terms.';
    return;
  }
  const copy = {
    history: ['Your archive begins with a first read.', 'Open an article, PDF, or custom text and it will be saved here automatically.'],
    saved: ['Keep your favorite pieces close.', 'Bookmark any reading with the Save button to build your personal collection.'],
    notes: ['No notes recorded yet.', 'Use the right-hand notes pane while reading or listening to capture thoughts.'],
  }[section];
  els.libraryEmptyTitle.textContent = copy[0];
  els.libraryEmptyHint.textContent = copy[1];
}

async function loadLibrary(section = activeLibrarySection) {
  setLibrarySection(section);
  els.libraryList.replaceChildren();
  els.libraryEmpty.hidden = true;
  els.libraryClearHistory.hidden = true;

  const query = els.librarySearch.value.trim();
  const result = await api.listLibrary(section, query);
  if (!result.ok) {
    showError(`Could not open your library: ${result.error}`);
    return;
  }

  const entries = result.entries || [];
  els.libraryList.replaceChildren(...entries.map((entry) => section === 'notes' ? makeLibraryNoteRow(entry) : makeLibrarySourceRow(entry)));
  els.libraryClearHistory.hidden = !(section === 'history' && entries.length > 0 && !query);

  if (!entries.length) {
    setLibraryEmpty(section, Boolean(query));
    els.libraryEmpty.hidden = false;
  }
}

// Live Search with Debounce
let searchTimeout;
els.librarySearch.addEventListener('input', () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    loadLibrary(activeLibrarySection);
  }, 250);
});

async function openLibraryItem(id, note = null) {
  const result = await api.openLibraryItem(id);
  if (!result.ok) {
    showError(result.error);
    return;
  }
  resetClearHistoryConfirm();
  renderArticle(
    result.article,
    result.pdfData,
    result.libraryItemId,
    result.isSaved,
    result.fileUnavailable,
    result.notes || [],
  );
  if (note) showNoteAtAnchor(note, true);
}

els.libraryOpen.addEventListener('click', () => showLibraryScreen('history'));
els.recentViewAll.addEventListener('click', () => showLibraryScreen('history'));

function closeLibraryView() {
  resetClearHistoryConfirm();
  if (state.units.length > 0) {
    els.libraryView.hidden = true;
    els.empty.hidden = true;
    els.article.hidden = false;
    syncNotesPaneVisibility();
  } else {
    showHomeScreen();
  }
}
els.libraryClose.addEventListener('click', closeLibraryView);

els.libraryClearHistory.addEventListener('click', async () => {
  if (!els.libraryClearHistory.classList.contains('is-confirming')) {
    els.libraryClearHistory.classList.add('is-confirming');
    els.libraryClearHistory.textContent = 'Confirm clear history? (Saved & notes kept)';
    clearHistoryConfirmTimer = setTimeout(resetClearHistoryConfirm, 3500);
    return;
  }
  resetClearHistoryConfirm();
  const result = await api.clearHistory();
  if (!result.ok) {
    showError(result.error);
    return;
  }
  loadLibrary(activeLibrarySection);
  loadRecentReadings();
});

document.querySelectorAll('[data-library-tab]').forEach((tab) => {
  tab.addEventListener('click', () => loadLibrary(tab.dataset.libraryTab));
});

els.libraryList.addEventListener('click', async (event) => {
  const save = event.target.closest('[data-toggle-saved]');
  if (save) {
    const result = await api.toggleSavedItem(save.dataset.toggleSaved);
    if (!result.ok) { showError(result.error); return; }
    if (state.libraryItemId === save.dataset.toggleSaved) {
      state.isSaved = result.isSaved;
      updateBookmarkUI();
    }
    loadLibrary(activeLibrarySection);
    loadRecentReadings();
    return;
  }
  const deleteItem = event.target.closest('[data-delete-item]');
  if (deleteItem) {
    const itemId = deleteItem.dataset.deleteItem;
    const result = await api.deleteLibraryItem(itemId);
    if (!result.ok) { showError(result.error); return; }
    loadLibrary(activeLibrarySection);
    loadRecentReadings();
    return;
  }
  const remove = event.target.closest('[data-delete-note]');
  if (remove) {
    const noteId = remove.dataset.deleteNote;
    const result = await api.deleteNote(noteId);
    if (!result.ok) { showError(result.error); return; }
    state.notes = state.notes.filter((n) => n.id !== noteId);
    if (state.activeNoteId === noteId) clearActiveNote();
    renderArticleNotes();
    loadLibrary(activeLibrarySection);
    loadRecentReadings();
    return;
  }
  const openNote = event.target.closest('[data-open-note]');
  if (openNote) {
    const noteId = openNote.dataset.openNote;
    const listing = await api.listLibrary('notes', '');
    const note = listing.entries?.find((entry) => entry.id === noteId);
    if (!note) { showError('That note could not be found.'); return; }
    await openLibraryItem(note.itemId, note);
    return;
  }
  const open = event.target.closest('[data-open-item]');
  if (open) await openLibraryItem(open.dataset.openItem);
});

els.bookmarkToggle.addEventListener('click', async () => {
  if (!state.libraryItemId) return;
  const result = await api.toggleSavedItem(state.libraryItemId);
  if (!result.ok) { showError(result.error); return; }
  state.isSaved = result.isSaved;
  updateBookmarkUI();
});

// ---------------------------------------------------------------- highlighting

function moveMarker() {
  const block = state.blocks[state.currentBlock];
  if (!block) return;
  els.marker.style.transform = `translateY(${block.el.offsetTop}px)`;
  els.marker.style.height = `${block.el.offsetHeight}px`;
}
new ResizeObserver(moveMarker).observe(els.article);

function keepInView(el) {
  const area = els.scroller.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const comfortable = box.top >= area.top + area.height * 0.12 && box.bottom <= area.bottom - area.height * 0.28;
  if (!comfortable) el.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
}

function highlight(unitIndex) {
  const unit = state.units[unitIndex];
  if (!unit) return;
  if (state.currentBlock !== unit.blockIndex) {
    state.blocks[state.currentBlock]?.el.classList.remove('current');
    state.currentBlock = unit.blockIndex;
    const { el } = state.blocks[unit.blockIndex];
    el.classList.add('current');
    moveMarker();
    keepInView(el);
    syncLiveNoteAnchor(false);
    updateSpeakingNoteCards();
  }
  els.article.classList.add('focused');
  updateProgress();
}

// ---------------------------------------------------------------- speech requests

const cancelledError = () => Object.assign(new Error('cancelled'), { cancelled: true });

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
      if (cache.get(index) !== entry) {
        URL.revokeObjectURL(url);
        throw cancelledError();
      }
      entry.url = url;
      return url;
    });
  entry.promise.catch(() => { if (cache.get(index) === entry) cache.delete(index); });
  cache.set(index, entry);
  return entry;
}

function prefetch(from) {
  for (let k = 0; k < AHEAD; k += 1) request(from + k);
}

function release(index) {
  const entry = cache.get(index);
  if (entry && entry.url) URL.revokeObjectURL(entry.url);
  cache.delete(index);
}

function stopAudio(clearCache = false) {
  state.gen += 1;
  api.cancel();
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  state.loaded = -1;
  if (clearCache) {
    for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
    cache.clear();
  }
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
    return fail(err.message);
  }
  if (gen !== state.gen || !state.playing) return;
  audio.src = url;
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
  updateComposerAnchorUI();
  prefetch(index + 1);
}

audio.addEventListener('ended', () => {
  const finished = state.loaded;
  if (finished < 0) return;
  state.loaded = -1;
  // Removed `release(finished)` so the audio chunk stays in memory
  // allowing instant re-play without re-synthesizing if clicked again.
  if (state.playing) playUnit(finished + 1);
});

audio.addEventListener('error', () => {
  if (audio.getAttribute('src')) fail('The audio could not be played.');
});

function fail(message) {
  state.playing = false;
  syncButtons();
  setPhase(state.units.length ? 'paused' : 'empty');
  updateComposerAnchorUI();
  showError(message);
}

function finish() {
  state.playing = false;
  syncButtons();
  setPhase('done');
  updateComposerAnchorUI();
  updateProgress();
}

function play() {
  if (!state.units.length) return;
  hideError();
  if (state.phase === 'done') return seekToUnit(0, true);
  state.playing = true;
  syncButtons();
  updateComposerAnchorUI();
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
  updateComposerAnchorUI();
}

const togglePlay = () => (state.playing ? pause() : play());

function seekToUnit(index, autoplay = state.playing) {
  if (!state.units.length) return;
  const targetPos = Math.min(Math.max(index, 0), state.units.length - 1);

  if (state.pos === targetPos && state.loaded === targetPos && audio.src) {
    audio.currentTime = 0;
    highlight(targetPos);
    if (autoplay) {
      state.playing = true;
      syncButtons();
      audio.play().then(() => setPhase('reading')).catch((err) => fail(err.message));
    }
    return;
  }

  stopAudio(false);
  state.pos = targetPos;
  highlight(state.pos);
  if (autoplay) {
    state.playing = true;
    syncButtons();
    playUnit(state.pos);
  } else {
    setPhase(state.phase === 'ready' ? 'ready' : 'paused');
    updateComposerAnchorUI();
  }
}

function stopEverything(clearCache = true) {
  state.playing = false;
  stopAudio(clearCache);
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
  if (step < 0 && state.pos > state.blocks[current].firstUnit) return seekToUnit(state.blocks[current].firstUnit);
  const target = speakableBlock(current, step);
  if (target === -1) return step > 0 ? undefined : seekToUnit(0);
  seekToUnit(state.blocks[target].firstUnit);
}

els.play.addEventListener('click', togglePlay);
els.prev.addEventListener('click', () => jump(-1));
els.next.addEventListener('click', () => jump(1));

els.article.addEventListener('click', (event) => {
  if (event.target.closest('a')) return;
  const el = event.target.closest('.block');
  if (!el || window.getSelection().toString()) return;
  const block = state.blocks[Number(el.dataset.block)];
  if (block && block.firstUnit !== null) seekToUnit(block.firstUnit, true);
});

// ---------------------------------------------------------------- settings

function applyReadingSettings() {
  const root = document.documentElement;
  root.dataset.theme = readingSettings.theme === 'dark' || (readingSettings.theme === 'system' && systemDarkMode.matches) ? 'dark' : 'light';
  root.dataset.font = readingSettings.font;
  root.style.setProperty('--reading-size', `${readingSettings.fontSize}px`);
  root.style.setProperty('--reading-width', `${readingSettings.lineWidth}ch`);
  root.style.setProperty('--reading-leading', String(readingSettings.lineSpacing));
  els.colorTheme.value = readingSettings.theme;
  els.fontStyle.value = readingSettings.font;
  els.fontSize.value = String(readingSettings.fontSize);
  els.fontSizeValue.textContent = `${readingSettings.fontSize} px`;
  els.lineWidth.value = String(readingSettings.lineWidth);
  els.lineWidthValue.textContent = `${readingSettings.lineWidth} chars`;
  els.lineSpacing.value = String(readingSettings.lineSpacing);
  els.lineSpacingValue.textContent = `${readingSettings.lineSpacing.toFixed(1)}×`;
}

function updateReadingSetting(key, value) {
  readingSettings[key] = value;
  applyReadingSettings();
  store.set(`reading.${key}`, value);
}

els.colorTheme.addEventListener('change', () => updateReadingSetting('theme', els.colorTheme.value));
els.fontStyle.addEventListener('change', () => updateReadingSetting('font', els.fontStyle.value));
els.fontSize.addEventListener('input', () => {
  readingSettings.fontSize = Number(els.fontSize.value);
  applyReadingSettings();
});
els.fontSize.addEventListener('change', () => store.set('reading.fontSize', readingSettings.fontSize));
els.lineWidth.addEventListener('input', () => {
  readingSettings.lineWidth = Number(els.lineWidth.value);
  applyReadingSettings();
});
els.lineWidth.addEventListener('change', () => store.set('reading.lineWidth', readingSettings.lineWidth));
els.lineSpacing.addEventListener('input', () => {
  readingSettings.lineSpacing = Number(els.lineSpacing.value);
  applyReadingSettings();
});
els.lineSpacing.addEventListener('change', () => store.set('reading.lineSpacing', readingSettings.lineSpacing));
applyReadingSettings();
systemDarkMode.addEventListener('change', () => {
  if (readingSettings.theme === 'system') applyReadingSettings();
});

function updateSpeed(value, persist = true) {
  state.speed = Math.round(clampSetting(value, 0.6, 2.4, 1) * 10) / 10;
  els.speed.value = String(state.speed);
  els.speedValue.textContent = `${state.speed.toFixed(1)}×`;
  els.speed.setAttribute('aria-valuetext', `${state.speed.toFixed(1)} times speed`);
  audio.playbackRate = state.speed;
  if (persist) store.set('speed', state.speed);
  updateProgress();
}

els.speed.addEventListener('input', () => updateSpeed(els.speed.value));
updateSpeed(state.speed, false);

function applyVoiceChange() {
  store.set('voice.kokoro', state.voice);
  if (state.units.length) {
    stopAudio(true);
    seekToUnit(state.pos);
  }
}

function fillVoices() {
  const list = voicesInfo.voices.kokoro;
  els.voice.replaceChildren(...list.map((v) => new Option(`${v.name} — ${v.desc}`, v.name)));
  const saved = store.get('voice.kokoro', voicesInfo.defaults.kokoro);
  els.voice.value = list.some((v) => v.name === saved) ? saved : voicesInfo.defaults.kokoro;
  state.voice = els.voice.value;
}

els.voice.addEventListener('change', () => {
  state.voice = els.voice.value;
  applyVoiceChange();
});

els.allowDownload.checked = store.get('allowDownload', false);
api.setAllowDownload(els.allowDownload.checked);
els.allowDownload.addEventListener('change', () => {
  store.set('allowDownload', els.allowDownload.checked);
  api.setAllowDownload(els.allowDownload.checked);
  if (state.units.length) seekToUnit(state.pos);
});

async function initVoices() {
  const res = await api.voices();
  if (!res.ok) {
    showError(res.error, 'Open Voice settings and allow the voice model download the first time you use voxo.');
    return;
  }
  voicesInfo = res;
  fillVoices();
}

document.addEventListener('click', (event) => {
  document.querySelectorAll('.options[open]').forEach((menu) => {
    if (!menu.contains(event.target)) menu.open = false;
  });
});

// ---------------------------------------------------------------- loading pages

async function openUrl(input) {
  hideError();
  els.go.disabled = true;
  if (els.heroGo) els.heroGo.disabled = true;
  renderStatus('Loading article…');
  const res = await api.loadUrl(input);
  els.go.disabled = false;
  if (els.heroGo) els.heroGo.disabled = false;
  if (!res.ok) {
    showError(res.error);
    setPhase(state.units.length ? 'paused' : 'empty');
    return;
  }
  els.url.value = res.article.url;
  if (els.heroUrl) els.heroUrl.value = '';
  renderArticle(res.article, null, res.libraryItemId, res.isSaved, false, res.notes);
  if (res.libraryError) showError(`Your article opened, but history could not be saved: ${res.libraryError}`);
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (els.url.value.trim()) openUrl(els.url.value);
});

els.heroForm?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (els.heroUrl.value.trim()) openUrl(els.heroUrl.value);
});

const openTextDialog = () => {
  els.textDialog.showModal();
  requestAnimationFrame(() => els.customText.focus());
};

const triggerPdfOpen = async () => {
  hideError();
  els.pdfOpen.disabled = true;
  renderStatus('Opening PDF…');
  const res = await api.loadPdf();
  els.pdfOpen.disabled = false;
  if (res.cancelled) { renderStatus(); return; }
  if (!res.ok) { showError(res.error); setPhase(state.units.length ? 'paused' : 'empty'); return; }
  renderArticle(res.article, res.pdfData, res.libraryItemId, res.isSaved, false, res.notes);
  if (res.libraryError) showError(`Your PDF opened, but history could not be saved: ${res.libraryError}`);
};

els.textOpen.addEventListener('click', openTextDialog);
els.pdfOpen.addEventListener('click', triggerPdfOpen);

// Interactive welcome chips
els.cardUrl.addEventListener('click', () => showLibraryScreen('history'));
els.cardPdf.addEventListener('click', triggerPdfOpen);
els.cardText.addEventListener('click', openTextDialog);

els.textCancel.addEventListener('click', () => els.textDialog.close());
els.textCloseX.addEventListener('click', () => els.textDialog.close());
els.textForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = els.customText.value.trim();
  if (!text) return;
  els.textSubmit.disabled = true;
  renderStatus('Preparing text…');
  const res = await api.loadText(text);
  els.textSubmit.disabled = false;
  if (!res.ok) { showError(res.error); return; }
  els.textDialog.close();
  els.customText.value = '';
  renderArticle(res.article, null, res.libraryItemId, res.isSaved, false, res.notes);
  if (res.libraryError) showError(`Your text opened, but history could not be saved: ${res.libraryError}`);
});

api.onStatus((message) => renderStatus(message));
api.onOpenUrl((url) => { els.url.value = url; openUrl(url); });
api.onLog((line) => {
  const lines = (els.log.textContent + line + '\n').split('\n');
  els.log.textContent = lines.slice(-200).join('\n');
  els.log.scrollTop = els.log.scrollHeight;
});

// ---------------------------------------------------------------- keyboard

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    els.url.focus();
    els.url.select();
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const typing = /^(INPUT|SELECT|TEXTAREA|BUTTON|SUMMARY)$/.test(document.activeElement?.tagName || '');
  if (typing) return;
  if (event.key === ' ') {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'ArrowRight') {
    jump(1);
  } else if (event.key === 'ArrowLeft') {
    jump(-1);
  } else if (event.key.toLowerCase() === 'n' && !els.article.hidden && state.libraryItemId) {
    event.preventDefault();
    if (!state.notesPaneOpen) setNotesPaneOpen(true);
    syncLiveNoteAnchor(false);
    els.noteBody.focus();
  }
});

syncButtons();
renderStatus();
initVoices();
loadRecentReadings();
