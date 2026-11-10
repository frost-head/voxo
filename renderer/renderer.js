import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

'use strict';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).toString();

const api = window.readerApi;
const $ = (selector) => document.querySelector(selector);

const els = {
  form: $('#url-form'), url: $('#url'), go: $('#go'),
  textOpen: $('#text-open'), pdfOpen: $('#pdf-open'), textDialog: $('#text-dialog'), textForm: $('#text-form'), customText: $('#custom-text'), textCancel: $('#text-cancel'), textSubmit: $('#text-submit'),
  options: $('#options'), engine: $('#engine'), voice: $('#voice'), allowDownload: $('#allow-download'), log: $('#log'),
  banner: $('#banner'), bannerText: $('#banner-text'), bannerHint: $('#banner-hint'), bannerClose: $('#banner-close'),
  scroller: $('#scroller'), empty: $('#empty'), article: $('#article'),
  marker: $('#marker'), title: $('#title'), meta: $('#meta'), body: $('#body'),
  pdfPreview: $('#pdf-preview'), pdfPreviewTitle: $('#pdf-preview-title'), pdfPreviewPages: $('#pdf-preview-pages'),
  prev: $('#prev'), play: $('#play'), next: $('#next'),
  status: $('#status'), left: $('#left'), speed: $('#speed'), fill: $('#progress-fill'),
};
const readout = els.status.parentElement;

const WORDS_PER_MINUTE = 150; // typical speaking pace at 1x
const AHEAD = 2;              // chunks synthesized in advance
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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
  blocks: [],        // { data, el, firstUnit, speakNumber }
  units: [],         // { blockIndex, text, startWords }
  totalWords: 0,
  speakableBlocks: 0,
  pos: 0,            // index into units
  loaded: -1,        // unit currently loaded in the <audio> element
  currentBlock: -1,
  playing: false,
  phase: 'empty',    // empty | ready | preparing | reading | paused | done
  gen: 0,            // bumped whenever queued audio becomes stale
  engine: 'kokoro',
  voice: null,
  speed: store.get('speed', 1),
};
let voicesInfo = null;

const audio = new Audio();
const cache = new Map(); // unit index -> { url, promise }

// ---------------------------------------------------------------- messages and status
function showError(message, hint) {
  els.bannerText.textContent = message;
  if (!hint && /allow-download/.test(message)) {
    hint = 'Open Voice, turn on "Allow model downloads", and press play again.';
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
    empty: 'Open a page, paste text, or choose a PDF to begin.',
    ready: 'Ready. Press play, or click a paragraph to start there.',
    preparing: 'Preparing the voice…',
    reading: where ? `Reading ${where}` : 'Reading',
    paused: where ? `Paused at ${where}` : 'Paused',
    done: 'Finished.',
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
function elementFor(block) {
  let el;
  if (block.type === 'image') {
    el = document.createElement('figure');
    el.className = 'image-block';
    const image = document.createElement('img');
    image.src = block.src;
    image.alt = block.alt || '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    el.appendChild(image);
    return el;
  }
  if (block.type === 'heading') el = document.createElement(`h${Math.min(Math.max(block.level, 2), 4)}`);
  else if (block.type === 'code') el = document.createElement('pre');
  else el = document.createElement('p');
  if (block.type === 'li') el.className = 'item';
  if (block.type === 'caption') el.className = 'caption';
  el.textContent = block.text; // plain text only
  return el;
}

function renderArticle(article) {
  stopEverything();
  els.title.classList.remove('current'); // the title element is reused between pages

  els.title.textContent = article.title || article.url;
  els.meta.replaceChildren(
    ...[article.byline, article.siteName, article.words ? `${article.words.toLocaleString()} words, about ${Math.max(1, Math.round(article.words / WORDS_PER_MINUTE))} min` : '']
      .filter(Boolean)
      .map((text) => Object.assign(document.createElement('span'), { textContent: text }))
  );

  const previews = article.pdfPreviews || [];
  els.pdfPreview.hidden = previews.length === 0;
  els.pdfPreview.open = false;
  els.pdfPreviewTitle.textContent = article.pdfPageCount > previews.length
    ? `Preview first ${previews.length} of ${article.pdfPageCount} PDF pages`
    : `Preview ${previews.length} PDF pages`;
  els.pdfPreviewPages.replaceChildren(...previews.map(({ pageNumber, src }) => {
    const figure = document.createElement('figure');
    figure.className = 'pdf-page';
    const image = document.createElement('img');
    image.src = src;
    image.alt = `PDF page ${pageNumber}`;
    image.loading = 'lazy';
    image.decoding = 'async';
    const caption = document.createElement('figcaption');
    caption.textContent = `Page ${pageNumber}`;
    figure.append(image, caption);
    return figure;
  }));

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
    const entry = { data: block, el, firstUnit: null, speakNumber: 0 };
    const blockIndex = state.blocks.push(entry) - 1;
    el.dataset.block = String(blockIndex);

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
  els.article.hidden = false;
  els.scroller.scrollTop = 0;
  syncButtons();
  setPhase(state.units.length ? 'ready' : 'empty');
  if (!state.units.length && previews.length) renderStatus('No selectable text. Expand the page previews to read this PDF visually.');
  updateProgress();
  document.title = `${article.title || 'voxo'} · voxo`;
}

async function renderPdfPreviews(data, pageCount) {
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const previews = [];
  try {
    for (let n = 1; n <= Math.min(pageCount, 100); n += 1) {
      const page = await pdf.getPage(n);
      const initial = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(1.5, 1100 / initial.width) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      previews.push({ pageNumber: n, src: canvas.toDataURL('image/jpeg', 0.76) });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return previews;
}

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
    .synth({ text: state.units[index].text, engine: state.engine, voice: state.voice })
    .then((res) => {
      if (!res.ok) throw Object.assign(new Error(res.error), { cancelled: res.cancelled });
      const url = URL.createObjectURL(new Blob([res.audio], { type: 'audio/wav' }));
      if (cache.get(index) !== entry) { // the request went stale while it was running
        URL.revokeObjectURL(url);
        throw cancelledError();
      }
      entry.url = url;
      return url;
    });
  // Failed requests are dropped, so pressing play again retries them.
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

function resetQueue() {
  state.gen += 1;
  api.cancel();
  for (const entry of cache.values()) if (entry.url) URL.revokeObjectURL(entry.url);
  cache.clear();
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
  prefetch(index + 1);
}

audio.addEventListener('ended', () => {
  const finished = state.loaded;
  if (finished < 0) return;
  state.loaded = -1;
  release(finished);
  if (state.playing) playUnit(finished + 1);
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
  syncButtons();
  setPhase('done');
  updateProgress();
}

function play() {
  if (!state.units.length) return;
  hideError();
  if (state.phase === 'done') return seekToUnit(0, true); // starts playback itself
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
  syncButtons();
}

/** Index of the nearest block with speech in the given direction, or -1. */
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
  const el = event.target.closest('.block');
  if (!el || window.getSelection().toString()) return; // don't interrupt text selection
  const block = state.blocks[Number(el.dataset.block)];
  if (block && block.firstUnit !== null) seekToUnit(block.firstUnit, true);
});

// ---------------------------------------------------------------- settings
els.speed.value = String(state.speed);
els.speed.addEventListener('change', () => {
  state.speed = Number(els.speed.value);
  store.set('speed', state.speed);
  audio.playbackRate = state.speed;
  updateProgress();
});

function applyVoiceChange() {
  store.set('engine', state.engine);
  store.set(`voice.${state.engine}`, state.voice);
  if (state.units.length) seekToUnit(state.pos); // re-reads the current chunk in the new voice
}

function fillVoices() {
  const list = voicesInfo.voices[state.engine];
  els.voice.replaceChildren(...list.map((v) => new Option(`${v.name}, ${v.desc}`, v.name)));
  const saved = store.get(`voice.${state.engine}`, voicesInfo.defaults[state.engine]);
  els.voice.value = list.some((v) => v.name === saved) ? saved : voicesInfo.defaults[state.engine];
  state.voice = els.voice.value;
}

els.engine.addEventListener('change', () => {
  state.engine = els.engine.value;
  fillVoices();
  applyVoiceChange();
});
els.voice.addEventListener('change', () => {
  state.voice = els.voice.value;
  applyVoiceChange();
});

els.allowDownload.checked = store.get('allowDownload', false);
api.setAllowDownload(els.allowDownload.checked);
els.allowDownload.addEventListener('change', () => {
  store.set('allowDownload', els.allowDownload.checked);
  api.setAllowDownload(els.allowDownload.checked);
  if (state.units.length) seekToUnit(state.pos); // the worker restarted; queue the chunk again
});

async function initVoices() {
  const res = await api.voices();
  if (!res.ok) {
    showError(
      res.error,
      'Installed copies include the speech engine and do not need system Python. Reinstall the app if its bundled engine is missing. For development builds, see the Python setup instructions in the README.',
    );
    return;
  }
  voicesInfo = res;
  els.engine.replaceChildren(...res.engines.map((name) => new Option(name, name)));
  const saved = store.get('engine', 'kokoro');
  state.engine = res.engines.includes(saved) ? saved : 'kokoro';
  els.engine.value = state.engine;
  fillVoices();
}

document.addEventListener('click', (event) => {
  if (els.options.open && !els.options.contains(event.target)) els.options.open = false;
});

// ---------------------------------------------------------------- loading pages
async function openUrl(input) {
  hideError();
  els.go.disabled = true;
  renderStatus('Fetching page…');
  const res = await api.loadUrl(input);
  els.go.disabled = false;
  if (!res.ok) {
    showError(res.error);
    setPhase(state.units.length ? 'paused' : 'empty');
    return;
  }
  els.url.value = res.article.url;
  renderArticle(res.article);
}

els.form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (els.url.value.trim()) openUrl(els.url.value);
});

els.textOpen.addEventListener('click', () => els.textDialog.showModal());
els.textCancel.addEventListener('click', () => els.textDialog.close());
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
  renderArticle(res.article);
});
els.pdfOpen.addEventListener('click', async () => {
  hideError();
  els.pdfOpen.disabled = true;
  renderStatus('Opening PDF…');
  const res = await api.loadPdf();
  els.pdfOpen.disabled = false;
  if (res.cancelled) { renderStatus(); return; }
  if (!res.ok) { showError(res.error); setPhase(state.units.length ? 'paused' : 'empty'); return; }
  try {
    res.article.pdfPreviews = await renderPdfPreviews(res.pdfData, res.article.pdfPageCount);
  } catch (err) {
    console.error('PDF preview rendering failed', err);
    res.article.pdfPreviews = [];
  }
  renderArticle(res.article);
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
  if (event.key === ' ') { event.preventDefault(); togglePlay(); }
  else if (event.key === 'ArrowRight') jump(1);
  else if (event.key === 'ArrowLeft') jump(-1);
});

syncButtons();
renderStatus();
initVoices();

