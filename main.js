'use strict';

const { app, BrowserWindow, ipcMain, net, session, dialog, protocol, shell } = require('electron');
const fs = require('fs');
const { attachContextMenu } = require('./lib/context-menu');
const path = require('path');
const { loadArticle } = require('./lib/loader');
const { TtsWorker } = require('./lib/tts-worker');
const { textToArticle, splitIntoChunks } = require('./lib/extract');
const { readPdf } = require('./lib/pdf-reader');
const { LibraryStore } = require('./lib/library-store');
const { SearchIndex } = require('./lib/search');
const { Embedder } = require('./lib/embedder');
const { fetchFeeds } = require('./lib/feeds');

protocol.registerSchemesAsPrivileged([{
  scheme: 'voxo-pdf',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

app.setName('voxo');

// ---------------------------------------------------------------- configuration

const TTS_CACHE_DIR = path.join(app.getPath('userData'), 'tts-data', 'models');
const PDFJS_RESOURCES = path.join(__dirname, 'node_modules', 'pdfjs-dist');
const PDF_STANDARD_FONT_DATA_URL = path.join(PDFJS_RESOURCES, 'standard_fonts') + path.sep;
const PDF_CMAP_URL = path.join(PDFJS_RESOURCES, 'cmaps') + path.sep;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36 voxo/0.2';
const FETCH_TIMEOUT_MS = 20000;
const MAX_PDF_BYTES = 200 * 1024 * 1024;

let libraryStore = null;

function getLibraryStore() {
  if (!libraryStore) libraryStore = new LibraryStore(path.join(app.getPath('userData'), 'library.sqlite'));
  return libraryStore;
}

function recordInLibrary(source) {
  try {
    const store = getLibraryStore();
    const id = store.record(source);
    return {
      libraryItemId: id,
      isSaved: store.isSaved(id),
      notes: store.listItemNotes(id),
      progress: store.getProgress(id),
    };
  } catch (err) {
    return {
      libraryItemId: null,
      isSaved: false,
      notes: [],
      progress: { unit: 0, fraction: 0 },
      libraryError: err.message || String(err),
    };
  }
}

/** Wraps an IPC handler so every channel returns { ok, ... } and never throws across the bridge. */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, payload) => {
    try {
      return { ok: true, ...(await fn(payload, event)) };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });
}

async function handlePdfResource(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
  try {
    const url = new URL(request.url);
    if (url.hostname !== 'pdfjs') return new Response('Not found', { status: 404 });
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (!/^(?:standard_fonts|cmaps)\//.test(relative)) return new Response('Not found', { status: 404 });
    const assetPath = path.resolve(PDFJS_RESOURCES, relative);
    if (!assetPath.startsWith(`${PDFJS_RESOURCES}${path.sep}`)) return new Response('Not found', { status: 404 });
    const data = await fs.promises.readFile(assetPath);
    return new Response(request.method === 'HEAD' ? null : data, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------- page fetching

async function fetchHtml(url) {
  const res = await net.fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`The site answered with HTTP ${res.status}.`);
  const type = res.headers.get('content-type') || '';
  if (!/html|xml/i.test(type)) throw new Error(`That address is not a web page (${type || 'unknown type'}).`);
  const bytes = Buffer.from(await res.arrayBuffer());
  let charset = /charset=([\w-]+)/i.exec(type)?.[1];
  if (!charset) charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(bytes.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** Load the page in a hidden window so JavaScript-built content exists, then read the DOM. */
async function renderHtml(url) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      session: session.fromPartition('reader-render'),
    },
  });
  win.webContents.setAudioMuted(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, target) => {
    if (!/^https?:/i.test(target)) event.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  win.webContents.setUserAgent(USER_AGENT);
  try {
    let timeout;
    try {
      await Promise.race([
        win.loadURL(url),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('The page took too long to load.')), FETCH_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    await win.webContents.executeJavaScript(`new Promise((resolve) => {
      const root = document.documentElement;
      if (!root) return resolve();
      const started = Date.now();
      let quietTimer;
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 600);
      });
      const finish = () => {
        const remaining = 1000 - (Date.now() - started);
        if (remaining > 0 && Date.now() - started < 3500) {
          clearTimeout(quietTimer);
          quietTimer = setTimeout(finish, remaining);
          return;
        }
        observer.disconnect();
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        resolve();
      };
      const maxTimer = setTimeout(finish, 3500);
      observer.observe(root, { childList: true, characterData: true, subtree: true });
      quietTimer = setTimeout(finish, 600);
    })`);
    return await win.webContents.executeJavaScript('document.documentElement.outerHTML');
  } finally {
    win.destroy();
  }
}

// ---------------------------------------------------------------- speech worker

const workerScript = path.join(__dirname, 'lib', 'tts-engine-worker.js');
const worker = new TtsWorker({ cacheDir: TTS_CACHE_DIR, workerPath: workerScript });

let mainWindow = null;
const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};

worker.on('log', (line) => sendToWindow('tts:log', line));
worker.on('exit', (message) => sendToWindow('tts:log', message));

// Kokoro voice names start with a language letter: a = American English, b = British English, e = Spanish,
// f = French, h = Hindi, i = Italian, p = Brazilian Portuguese.
const LANGUAGES = [
  { code: 'en', label: 'English', defaultVoice: 'af_heart' },
  { code: 'es', label: 'Spanish', defaultVoice: 'ef_dora' },
  { code: 'fr', label: 'French', defaultVoice: 'ff_siwis' },
  { code: 'hi', label: 'Hindi', defaultVoice: 'hf_alpha' },
  { code: 'it', label: 'Italian', defaultVoice: 'if_sara' },
  { code: 'pt', label: 'Portuguese (Brazil)', defaultVoice: 'pf_dora' },
];
const VOICES = {
  ok: true,
  defaults: { kokoro: 'af_heart' },
  languages: LANGUAGES,
  voices: {
    kokoro: [
      { name: 'af_heart', lang: 'en', desc: 'US female (default)' },
      { name: 'af_bella', lang: 'en', desc: 'US female' },
      { name: 'af_nicole', lang: 'en', desc: 'US female, softer' },
      { name: 'af_sarah', lang: 'en', desc: 'US female' },
      { name: 'af_sky', lang: 'en', desc: 'US female' },
      { name: 'af_kore', lang: 'en', desc: 'US female, warm' },
      { name: 'bf_emma', lang: 'en', desc: 'British female' },
      { name: 'bf_isabella', lang: 'en', desc: 'British female' },
      { name: 'am_adam', lang: 'en', desc: 'US male' },
      { name: 'am_michael', lang: 'en', desc: 'US male' },
      { name: 'am_fenrir', lang: 'en', desc: 'US male, deeper' },
      { name: 'am_puck', lang: 'en', desc: 'US male, lighter' },
      { name: 'bm_george', lang: 'en', desc: 'British male' },
      { name: 'bm_fable', lang: 'en', desc: 'British male, storyteller' },
      { name: 'ef_dora', lang: 'es', desc: 'female' },
      { name: 'em_alex', lang: 'es', desc: 'male' },
      { name: 'em_santa', lang: 'es', desc: 'male, deeper' },
      { name: 'ff_siwis', lang: 'fr', desc: 'female' },
      { name: 'hf_alpha', lang: 'hi', desc: 'female' },
      { name: 'hf_beta', lang: 'hi', desc: 'female, softer' },
      { name: 'hm_omega', lang: 'hi', desc: 'male' },
      { name: 'hm_psi', lang: 'hi', desc: 'male, deeper' },
      { name: 'if_sara', lang: 'it', desc: 'female' },
      { name: 'im_nicola', lang: 'it', desc: 'male' },
      { name: 'pf_dora', lang: 'pt', desc: 'female' },
      { name: 'pm_alex', lang: 'pt', desc: 'male' },
      { name: 'pm_santa', lang: 'pt', desc: 'male, deeper' },
    ],
  },
};
const VOICE_NAMES = new Set(VOICES.voices.kokoro.map((v) => v.name));

// ---------------------------------------------------------------- text helpers

/** A readable title for pasted text: its first line, trimmed to a sentence-ish length. */
function titleFromText(text) {
  const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const clean = first.replace(/\s+/g, ' ');
  if (!clean) return 'Custom text';
  if (clean.length <= 64) return clean.replace(/[.:;,]$/, '');
  const cut = clean.slice(0, 64);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 32))}…`;
}

/** Join wrapped PDF lines into one paragraph, repairing words hyphenated at a line break. */
function joinWrappedLines(lines) {
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) out = line;
    else if (/[a-z]-$/.test(out) && /^[a-z]/.test(line)) out = out.slice(0, -1) + line;
    else out = `${out} ${line}`;
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------- PDF reading

async function loadPdfFromPath(filePath) {
  if (path.extname(filePath).toLowerCase() !== '.pdf') throw new Error('That file is not a PDF.');
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile()) throw new Error('That is not a file.');
  if (stat.size > MAX_PDF_BYTES) throw new Error('That PDF is larger than 200 MB.');

  let pdfDoc;
  try {
    const data = new Uint8Array(await fs.promises.readFile(filePath));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfDoc = await pdfjs.getDocument({
      data: data.slice(),
      useWorkerFetch: false,
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
      cMapUrl: PDF_CMAP_URL,
      cMapPacked: true,
      isEvalSupported: false,
    }).promise;

    const metadata = await pdfDoc.getMetadata().catch(() => null);
    const metaTitle = String(metadata?.info?.Title || '').trim();
    const usableMeta = metaTitle.length >= 4 && !/\.(docx?|tex|pdf|indd|pages|odt)$|^(microsoft word|untitled|document\d*)\b/i.test(metaTitle);
    const article = await readPdf(pdfDoc, {
      pdfjs,
      title: usableMeta ? metaTitle : path.basename(filePath, path.extname(filePath)),
      tools: { splitIntoChunks },
      onProgress: (n, total) => sendToWindow('reader:status', `Reading PDF, page ${n} of ${total}…`),
    });
    article.hasSelectableText = article.contentWords > 0;
    if (!article.hasSelectableText && article.blocks[0]) {
      article.blocks[0].speak = false;
      article.blocks[0].chunks = [];
      article.blocks[0].words = 0;
      article.words = 0;
    }
    article.url = path.basename(filePath);
    article.siteName = `${pdfDoc.numPages} pages`;
    article.pdfPageCount = pdfDoc.numPages;
    return { article, pdfData: data };
  } finally {
    await pdfDoc?.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------- IPC: reading sources

ipcMain.handle('reader:load', async (_event, input) => {
  try {
    const article = await loadArticle(input, {
      fetchHtml,
      renderHtml,
      onStatus: (message) => sendToWindow('reader:status', message),
    });
    return { ok: true, article, ...recordInLibrary({ type: 'article', article, url: article.url }) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('reader:text', (_event, text) => {
  try {
    const article = textToArticle(text, titleFromText(text));
    return { ok: true, article, ...recordInLibrary({ type: 'text', article, text }) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

// Optional droppedPath lets the window open a PDF dragged onto it; otherwise a file picker is shown.
ipcMain.handle('reader:pdf', async (_event, droppedPath) => {
  try {
    let filePath = typeof droppedPath === 'string' && droppedPath ? droppedPath : null;
    if (!filePath) {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: 'Open a PDF',
        properties: ['openFile'],
        filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
      filePath = picked.filePaths[0];
    }
    const { article, pdfData } = await loadPdfFromPath(filePath);
    return { ok: true, article, pdfData, ...recordInLibrary({ type: 'pdf', article, filePath }) };
  } catch (err) {
    return { ok: false, error: `Could not read that PDF: ${err.message || err}` };
  }
});

// ---------------------------------------------------------------- IPC: library

handle('library:list', ({ section, query } = {}) => {
  const allowed = ['history', 'saved', 'notes', 'highlights'];
  return { entries: getLibraryStore().list(allowed.includes(section) ? section : 'history', query || '') };
});

handle('library:list-notes', (filter) => ({ notes: getLibraryStore().listNotes(filter || {}) }));
handle('library:item-notes', (itemId) => ({ notes: getLibraryStore().listItemNotes(itemId) }));
handle('library:list-tags', () => ({ tags: getLibraryStore().listTags() }));

ipcMain.handle('library:open', async (_event, id) => {
  try {
    const item = getLibraryStore().open(id);
    if (!item) return { ok: false, error: 'That item is no longer in your library.' };
    let pdfData = null;
    let fileUnavailable = false;
    if (item.type === 'pdf' && item.filePath) {
      try {
        pdfData = new Uint8Array(await fs.promises.readFile(item.filePath));
      } catch {
        fileUnavailable = true;
      }
    }
    return {
      ok: true,
      article: item.article,
      libraryItemId: item.id,
      isSaved: item.isSaved,
      notes: item.notes || [],
      progress: { unit: item.progressUnit, fraction: item.progress },
      pdfData,
      fileUnavailable,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

handle('library:toggle-saved', (id) => {
  const isSaved = getLibraryStore().toggleSaved(id);
  if (isSaved === null) throw new Error('That item is no longer in your library.');
  return { isSaved };
});

handle('library:set-progress', ({ id, unit, fraction } = {}) => {
  getLibraryStore().setProgress(id, unit, fraction);
  return {};
});

handle('library:add-note', (note) => {
  const created = getLibraryStore().addNote(note || {});
  return { noteId: created.id, note: created };
});

handle('library:update-note', ({ id, updates } = {}) => ({ note: getLibraryStore().updateNote(id, updates || {}) }));
handle('library:delete-note', (id) => ({ deleted: getLibraryStore().deleteNote(id) }));

handle('library:create-notebook', (name) => ({ notebook: getLibraryStore().createNotebook(name) }));
handle('library:rename-notebook', ({ id, name } = {}) => ({ notebook: getLibraryStore().renameNotebook(id, name) }));
handle('library:list-notebooks', () => ({ notebooks: getLibraryStore().listNotebooks() }));
handle('library:delete-notebook', (id) => ({ deleted: getLibraryStore().deleteNotebook(id) }));

handle('library:delete-item', (id) => ({ deleted: getLibraryStore().deleteItem(id) }));
handle('library:clear-history', () => ({ cleared: getLibraryStore().clearHistory() }));

handle('library:export-notes', async (filter) => {
  const markdown = getLibraryStore().exportMarkdown(filter || {});
  const stamp = new Date().toISOString().slice(0, 10);
  const picked = await dialog.showSaveDialog(mainWindow, {
    title: 'Export notes',
    defaultPath: path.join(app.getPath('documents'), `voxo-notes-${stamp}.md`),
    filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
  });
  if (picked.canceled || !picked.filePath) return { cancelled: true };
  await fs.promises.writeFile(picked.filePath, markdown, 'utf8');
  return { path: picked.filePath };
});

// ---------------------------------------------------------------- IPC: speech

ipcMain.handle('tts:voices', () => VOICES);

ipcMain.handle('tts:synth', async (_event, { text, voice } = {}) => {
  try {
    const wavPath = await worker.synth({ text, voice: VOICE_NAMES.has(voice) ? voice : VOICES.defaults.kokoro });
    try {
      const audio = await fs.promises.readFile(wavPath);
      return { ok: true, audio };
    } finally {
      fs.promises.unlink(wavPath).catch(() => {});
    }
  } catch (err) {
    return { ok: false, cancelled: Boolean(err.cancelled), error: err.message || String(err) };
  }
});

// ---------------------------------------------------------------- IPC: search by meaning + discovery feed

const embedder = new Embedder({ cacheDir: TTS_CACHE_DIR, workerPath: path.join(__dirname, 'lib', 'embed-worker.js') });
let searchIndex = null;
function getSearchIndex() {
  if (!searchIndex) searchIndex = new SearchIndex({ store: getLibraryStore(), embedder });
  return searchIndex;
}
let embedTimer = null;
// Embedding is background work: wait until the voice engine is idle so the two ONNX runtimes never load or run together.
const scheduleEmbedding = (delay = 2500) => {
  clearTimeout(embedTimer);
  embedTimer = setTimeout(() => {
    if (worker.isBusy()) { scheduleEmbedding(8000); return; }
    getSearchIndex().ensureEmbeddings();
  }, delay);
};

handle('search:query', async ({ query, scope, limit } = {}) => {
  const index = getSearchIndex();
  const out = await index.search(String(query || '').slice(0, 400), { scope: ['notes', 'articles'].includes(scope) ? scope.replace(/s$/, '') : 'all', limit: Math.min(50, Number(limit) || 20) });
  scheduleEmbedding(); // keeps the meaning index topped up in the background
  return { ...out, status: index.status() };
});
handle('search:status', () => ({ status: getSearchIndex().status() }));
handle('search:index', () => { scheduleEmbedding(0); return { status: getSearchIndex().status() }; });
handle('discover:fetch', async (urls) => fetchFeeds(Array.isArray(urls) ? urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)) : [], { userAgent: USER_AGENT }));

ipcMain.handle('tts:cancel', () => worker.cancelQueued());
ipcMain.handle('tts:set-allow-download', (_event, value) => { embedder.setAllowDownload(value); if (value) scheduleEmbedding(); return worker.setAllowDownload(value); });

// ---------------------------------------------------------------- window

function urlFromArgs(argv) {
  return argv.find((arg) => /^https?:\/\//i.test(arg));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 540,
    title: 'voxo',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: true,
    },
  });
  attachContextMenu(mainWindow.webContents);
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // The app is a single page: any navigation is a clicked link, which belongs in the system browser.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const initialUrl = urlFromArgs(process.argv);
  if (initialUrl) mainWindow.webContents.once('did-finish-load', () => sendToWindow('app:open-url', initialUrl));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      const url = urlFromArgs(argv);
      if (url) sendToWindow('app:open-url', url);
    }
  });
  app.whenReady().then(() => {
    protocol.handle('voxo-pdf', handlePdfResource);
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    worker.dispose();
    embedder.dispose();
    libraryStore?.close();
  });
}
