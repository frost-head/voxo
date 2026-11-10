'use strict';

const { app, BrowserWindow, ipcMain, net, session, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const { loadArticle } = require('./lib/loader');
const { TtsWorker } = require('./lib/tts-worker');
const { textToArticle, segmentsToArticle } = require('./lib/extract');

app.setName('voxo');

// ---------------------------------------------------------------- configuration
const TTS_DIR = path.join(__dirname, 'tts');
const TTS_SCRIPT = process.env.TTS_SCRIPT || path.join(TTS_DIR, 'tts.py');
const packagedTts = app.isPackaged && !process.env.TTS_PYTHON && !process.env.TTS_SCRIPT && !process.env.TTS_BINARY;
function packagedTtsExecutable() {
  const name = process.platform === 'win32' ? 'voxo-tts.exe' : 'voxo-tts';
  const resourcesTtsDir = path.join(process.resourcesPath, 'tts');
  const direct = path.join(resourcesTtsDir, name);
  // PyInstaller's one-folder output can be copied either as the contents of
  // its directory or as a nested `voxo-tts` directory by electron-builder.
  const nested = path.join(resourcesTtsDir, 'voxo-tts', name);
  return fs.existsSync(direct) || !fs.existsSync(nested) ? direct : nested;
}
const TTS_EXECUTABLE = process.env.TTS_BINARY || (packagedTts
  ? packagedTtsExecutable()
  : findPython());
const TTS_ARGS = packagedTts || process.env.TTS_BINARY ? [] : [TTS_SCRIPT];
const TTS_DATA_DIR = packagedTts ? path.join(app.getPath('userData'), 'tts-data') : null;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/130.0.0.0 Safari/537.36 ReaderTTS/0.1';
const FETCH_TIMEOUT_MS = 20000;

/** Python to run tts.py with: $TTS_PYTHON, else ./tts/venv, else python3 on PATH. */
function findPython() {
  if (process.env.TTS_PYTHON) return process.env.TTS_PYTHON;
  const venvPython =
    process.platform === 'win32'
      ? path.join(TTS_DIR, 'venv', 'Scripts', 'python.exe')
      : path.join(TTS_DIR, 'venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) return venvPython;
  return process.platform === 'win32' ? 'python' : 'python3';
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
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  win.webContents.setUserAgent(USER_AGENT);

  try {
    await Promise.race([
      win.loadURL(url),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The page took too long to load.')), FETCH_TIMEOUT_MS)),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // let scripts build the page
    return await win.webContents.executeJavaScript('document.documentElement.outerHTML');
  } finally {
    win.destroy();
  }
}

// ---------------------------------------------------------------- speech worker
const worker = new TtsWorker({
  python: TTS_EXECUTABLE,
  script: TTS_ARGS[0] || null,
  cwd: packagedTts ? process.resourcesPath : path.dirname(TTS_SCRIPT),
  env: packagedTts ? { ...process.env, VOXO_TTS_DATA: TTS_DATA_DIR } : process.env,
});
let mainWindow = null;
const sendToWindow = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
worker.on('log', (line) => sendToWindow('tts:log', line));
worker.on('exit', (message) => sendToWindow('tts:log', message));

let voicesCache = null;
function listVoices() {
  if (voicesCache) return Promise.resolve(voicesCache);
  return new Promise((resolve) => {
    execFile(TTS_EXECUTABLE, [...TTS_ARGS, '--voices-json'], {
      cwd: packagedTts ? process.resourcesPath : path.dirname(TTS_SCRIPT),
      env: packagedTts ? { ...process.env, VOXO_TTS_DATA: TTS_DATA_DIR } : process.env,
      timeout: 30000,
    }, (err, stdout) => {
      if (err) {
        resolve({ ok: false, error: `Could not run the speech engine (${TTS_EXECUTABLE}): ${err.message}` });
        return;
      }
      try {
        voicesCache = { ok: true, ...JSON.parse(stdout) };
        resolve(voicesCache);
      } catch {
        resolve({ ok: false, error: 'tts.py returned an unreadable voice list.' });
      }
    });
  });
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('reader:load', async (_event, input) => {
  try {
    const article = await loadArticle(input, {
      fetchHtml,
      renderHtml,
      onStatus: (message) => sendToWindow('reader:status', message),
    });
    return { ok: true, article };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
});

ipcMain.handle('reader:text', (_event, text) => {
  try { return { ok: true, article: textToArticle(text) }; }
  catch (err) { return { ok: false, error: err.message || String(err) }; }
});

ipcMain.handle('reader:pdf', async () => {
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Open a PDF', properties: ['openFile'], filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (picked.canceled || !picked.filePaths.length) return { ok: false, cancelled: true };
  let pdfDoc;
  try {
    const data = new Uint8Array(await fs.promises.readFile(picked.filePaths[0]));
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // PDF.js may transfer and detach its input buffer while creating its worker.
    // Keep this original copy intact for the renderer IPC response.
    pdfDoc = await pdfjs.getDocument({ data: data.slice(), useWorkerFetch: false, isEvalSupported: false }).promise;
    const doc = pdfDoc;
    const segments = [];
    const monoFont = /mono|courier|console|menlo|typewriter|inconsolata|source.?code/i;
    const codeSyntax = /^\s*(?:[#\\/]{1,2}|(?:if|else|elif|for|while|return|def|class|function|const|let|var|import|export|public|private|static|void|int|float|using)\b)|(?:=>|==|!=|&&|\|\||[{};]\s*$)/;
    for (let n = 1; n <= doc.numPages; n += 1) {
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
        if (item.code) { flushProse(); codeLines.push(item.text); }
        else { flushCode(); proseLines.push(item.text); }
      }
      flushCode();
      flushProse();

      page.cleanup();
    }
    const metadata = await doc.getMetadata().catch(() => null);
    const title = metadata?.info?.Title?.trim() || path.basename(picked.filePaths[0]);
    const article = segmentsToArticle(segments, title);
    article.url = path.basename(picked.filePaths[0]);
    article.siteName = `${doc.numPages} pages`;
    article.pdfPageCount = doc.numPages;
    return { ok: true, article, pdfData: data };
  } catch (err) { return { ok: false, error: `Could not read that PDF: ${err.message || err}` }; }
  finally { await pdfDoc?.destroy().catch(() => {}); }
});

ipcMain.handle('tts:voices', () => listVoices());

ipcMain.handle('tts:synth', async (_event, { text, engine, voice }) => {
  try {
    const wavPath = await worker.synth({ text, engine, voice });
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
    width: 1000,
    height: 820,
    minWidth: 560,
    minHeight: 480,
    title: 'voxo',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Audio starts after an async synthesis, so it can't rely on a fresh click.
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(path.join(__dirname, 'assets', 'icon.png'));
  }
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  const initialUrl = urlFromArgs(process.argv);
  if (initialUrl) mainWindow.webContents.once('did-finish-load', () => sendToWindow('app:open-url', initialUrl));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function seedBundledVoice() {
  if (!packagedTts) return;
  const source = path.join(process.resourcesPath, 'tts-data', 'voices');
  const destination = path.join(TTS_DATA_DIR, 'voices');
  fs.mkdirSync(destination, { recursive: true });
  for (const name of ['en_US-amy-medium.onnx', 'en_US-amy-medium.onnx.json']) {
    const target = path.join(destination, name);
    if (!fs.existsSync(target)) fs.copyFileSync(path.join(source, name), target);
  }
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
    seedBundledVoice();
    createWindow();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => worker.dispose());
}
