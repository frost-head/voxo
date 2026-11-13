'use strict';

const { app, BrowserWindow, ipcMain, net, session, dialog, protocol, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { loadArticle } = require('./lib/loader');
const { TtsWorker } = require('./lib/tts-worker');
const { textToArticle, segmentsToArticle } = require('./lib/extract');
const { LibraryStore } = require('./lib/library-store');

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
  'Chrome/130.0.0.0 Safari/537.36 voxo/0.1';
const FETCH_TIMEOUT_MS = 20000;

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
    };
  } catch (err) {
    return {
      libraryItemId: null,
      isSaved: false,
      notes: [],
      libraryError: err.message || String(err),
    };
  }
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

let voicesCache = null;

function listVoices() {
  if (voicesCache) return Promise.resolve(voicesCache);
  voicesCache = {
    ok: true,
    defaults: { kokoro: 'af_heart' },
    voices: {
      kokoro: [
        { name: 'af_heart', desc: 'US female (default)' },
        { name: 'af_bella', desc: 'US female' },
        { name: 'af_nicole', desc: 'US female, softer' },
        { name: 'af_sarah', desc: 'US female' },
        { name: 'af_sky', desc: 'US female' },
        { name: 'bf_emma', desc: 'British female' },
        { name: 'bf_isabella', desc: 'British female' },
        { name: 'am_adam', desc: 'US male' },
        { name: 'am_michael', desc: 'US male' },
        { name: 'bm_george', desc: 'British male' },
      ],
    },
  };
  return Promise.resolve(voicesCache);
}

// ---------------------------------------------------------------- IPC

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
    const article = textToArticle(text);
    return { ok: true, article, ...recordInLibrary({ type: 'text', article, text }) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('reader:pdf', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
  let pdfDoc;
  try {
    const data = new Uint8Array(await fs.promises.readFile(picked.filePaths[0]));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfDoc = await pdfjs.getDocument({
      data: data.slice(),
      useWorkerFetch: false,
      standardFontDataUrl: PDF_STANDARD_FONT_DATA_URL,
      cMapUrl: PDF_CMAP_URL,
      cMapPacked: true,
      isEvalSupported: false,
    }).promise;
    const doc = pdfDoc;
    const segments = [];
    const monoFont = /mono|courier|console|menlo|typewriter|inconsolata|source.?code/i;
    const codeSyntax = /^\s*(?:[#\\/]{1,2}|(?:if|else|elif|for|while|return|def|class|function|const|let|var|import|export|public|private|static|void|int|float|using)\b)|(?:=>|==|!=|&&|\|\||[{};]\s*$)/;
    for (let n = 1; n <= doc.numPages; n += 1) {
      if (n === 1 || n % 5 === 0 || n === doc.numPages) {
        sendToWindow('reader:status', `Reading PDF text, page ${n} of ${doc.numPages}…`);
      }
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      const lines = [];
      let line = '';
      let lineCode = true;
      let lineHasFont = false;
      const flushLine = () => {
        if (line.trim()) {
          const text = line.replace(/\s+$/, '');
          lines.push({ text, code: (lineCode && lineHasFont) || codeSyntax.test(text) });
        }
        line = '';
        lineCode = true;
        lineHasFont = false;
      };
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (item.str.trim()) {
          const fontName = `${item.fontName || ''} ${content.styles?.[item.fontName]?.fontFamily || ''}`;
          lineCode = lineCode && monoFont.test(fontName);
          lineHasFont = true;
        }
        line += item.str;
        if (item.hasEOL) flushLine();
        else line += ' ';
      }
      flushLine();
      let proseLines = [];
      let codeLines = [];
      const flushProse = () => {
        if (proseLines.length) segments.push({ type: 'text', text: proseLines.join(' ') });
        proseLines = [];
      };
      const flushCode = () => {
        if (codeLines.length) segments.push({ type: 'code', text: codeLines.join('\n') });
        codeLines = [];
      };
      for (const item of lines) {
        if (item.code) {
          flushProse();
          codeLines.push(item.text);
        } else {
          flushCode();
          proseLines.push(item.text);
        }
      }
      flushCode();
      flushProse();
      page.cleanup();
    }
    const metadata = await doc.getMetadata().catch(() => null);
    const title = metadata?.info?.Title?.trim() || path.basename(picked.filePaths[0]);
    const article = segmentsToArticle(segments, title);
    article.hasSelectableText = article.contentWords > 0;
    if (!article.hasSelectableText && article.blocks[0]) {
      article.blocks[0].speak = false;
      article.blocks[0].chunks = [];
      article.blocks[0].words = 0;
      article.words = 0;
    }
    article.url = path.basename(picked.filePaths[0]);
    article.siteName = `${doc.numPages} pages`;
    article.pdfPageCount = doc.numPages;
    return {
      ok: true,
      article,
      pdfData: data,
      ...recordInLibrary({ type: 'pdf', article, filePath: picked.filePaths[0] }),
    };
  } catch (err) {
    return { ok: false, error: `Could not read that PDF: ${err.message || err}` };
  } finally {
    await pdfDoc?.destroy().catch(() => {});
  }
});

ipcMain.handle('library:list', (_event, { section, query }) => {
  try {
    const allowed = ['history', 'saved', 'notes'];
    return { ok: true, entries: getLibraryStore().list(allowed.includes(section) ? section : 'history', query) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('library:item-notes', (_event, itemId) => {
  try {
    return { ok: true, notes: getLibraryStore().listItemNotes(itemId) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

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
      pdfData,
      fileUnavailable,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('library:toggle-saved', (_event, id) => {
  try {
    const isSaved = getLibraryStore().toggleSaved(id);
    return isSaved === null ? { ok: false, error: 'That item is no longer in your library.' } : { ok: true, isSaved };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('library:add-note', (_event, note) => {
  try {
    const created = getLibraryStore().addNote(note);
    return { ok: true, noteId: created.id, note: created };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('library:delete-note', (_event, id) => {
  try {
    return { ok: true, deleted: getLibraryStore().deleteNote(id) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('library:delete-item', (_event, id) => {
  try {
    return { ok: true, deleted: getLibraryStore().deleteItem(id) };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('library:clear-history', () => {
  try {
    return { ok: true, cleared: getLibraryStore().clearHistory() };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('tts:voices', () => listVoices());

ipcMain.handle('tts:synth', async (_event, { text, voice }) => {
  try {
    const wavPath = await worker.synth({ text, voice });
    const audio = await fs.promises.readFile(wavPath);
    fs.promises.unlink(wavPath).catch(() => {});
    return { ok: true, audio };
  } catch (err) {
    return { ok: false, cancelled: Boolean(err.cancelled), error: err.message || String(err) };
  }
});

ipcMain.handle('tts:cancel', () => worker.cancelQueued());
ipcMain.handle('tts:set-allow-download', (_event, value) => worker.setAllowDownload(value));

// ---------------------------------------------------------------- window

function urlFromArgs(argv) {
  return argv.find((arg) => /^https?:\/\//i.test(arg));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1220,
    height: 850,
    minWidth: 640,
    minHeight: 520,
    title: 'voxo',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      shell.openExternal(url);
    }
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
    libraryStore?.close();
  });
}
