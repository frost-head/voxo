'use strict';

const { utilityProcess } = require('electron');

/** Owns the embedding worker process; starts it lazily and restarts it if it dies. */
class Embedder {
  constructor({ cacheDir, workerPath }) {
    this.cacheDir = cacheDir;
    this.workerPath = workerPath;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.allowDownload = false;
    this.available = null; // null = untried, true = worked once, false = last attempt failed
    this.lastError = '';
  }

  _start() {
    if (this.child) return this.child;
    const child = utilityProcess.fork(this.workerPath, [], {
      stdio: 'ignore',
      env: { ...process.env, VOXO_TTS_CACHE_DIR: this.cacheDir, VOXO_TTS_ALLOW_DOWNLOAD: String(this.allowDownload) },
    });
    child.on('message', (message) => {
      if (message.type !== 'result') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.ok) { this.available = true; entry.resolve(message.vectors); } else { this.available = false; this.lastError = message.error; entry.reject(new Error(message.error)); }
    });
    child.on('exit', () => {
      this.child = null;
      for (const entry of this.pending.values()) entry.reject(new Error('The search helper stopped unexpectedly.'));
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  setAllowDownload(value) {
    this.allowDownload = Boolean(value);
    this.child?.postMessage({ type: 'allow-download', value: this.allowDownload });
  }

  embed(texts) {
    const child = this._start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.postMessage({ type: 'embed', id, texts });
    });
  }

  dispose() {
    this.child?.kill();
    this.child = null;
  }
}

module.exports = { Embedder };
