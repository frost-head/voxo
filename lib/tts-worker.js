'use strict';

const { utilityProcess } = require('electron');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

class TtsWorker extends EventEmitter {
  constructor({ cacheDir, allowDownload = false, workerPath } = {}) {
    super();
    this.cacheDir = cacheDir;
    this.allowDownload = Boolean(allowDownload);
    this.workerPath = workerPath || path.join(__dirname, 'tts-engine-worker.js');
    this.process = null;
    this.isReady = false;
    this.queue = [];
    this.inflight = null;
    this.nextId = 1;
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voxo-tts-'));
  }

  _start() {
    const child = utilityProcess.fork(this.workerPath, [], {
      serviceName: 'voxo speech engine',
      env: {
        ...process.env,
        VOXO_TTS_CACHE_DIR: this.cacheDir,
        VOXO_TTS_ALLOW_DOWNLOAD: String(this.allowDownload),
      },
    });
    this.process = child;
    this.isReady = false;
    child.on('message', (message) => this._onMessage(child, message));
    child.on('error', (error) => this._onExit(child, `Speech engine process error: ${error.message}`));
    child.on('exit', (code) => {
      if (code !== 0) this._onExit(child, `Speech engine process stopped (exit code ${code}).`);
      else if (child === this.process) this._onExit(child, 'Speech engine process stopped.');
    });
  }

  _onMessage(child, message) {
    if (child !== this.process) return;
    if (message.type === 'ready') {
      this.isReady = true;
      this._pump();
    } else if (message.type === 'log') {
      this.emit('log', message.line);
    } else if (message.type === 'result') {
      const job = this.inflight;
      if (!job || message.id !== job.id) return;
      this.inflight = null;
      if (message.ok) job.resolve(job.out);
      else job.reject(new Error(message.error || 'Speech synthesis failed.'));
      this._pump();
    }
  }

  _onExit(child, message) {
    if (child !== this.process) return;
    this.process = null;
    this.isReady = false;
    const failed = [this.inflight, ...this.queue].filter(Boolean);
    this.inflight = null;
    this.queue = [];
    for (const job of failed) job.reject(new Error(message));
    this.emit('exit', message);
  }

  _pump() {
    if (!this.isReady || this.inflight || this.queue.length === 0) return;
    this.inflight = this.queue.shift();
    const { id, text, out, voice } = this.inflight;
    this.process.postMessage({ type: 'synthesize', id, text, out, voice });
  }

  synth({ text, voice }) {
    if (!this.process) this._start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, text, voice, out: path.join(this.tmpDir, `${id}.wav`), resolve, reject });
      this._pump();
    });
  }

  cancelQueued() {
    const dropped = this.queue;
    this.queue = [];
    for (const job of dropped) {
      const error = new Error('cancelled');
      error.cancelled = true;
      job.reject(error);
    }
  }

  setAllowDownload(value) {
    this.allowDownload = Boolean(value);
    this.process?.postMessage({ type: 'allow-download', value: this.allowDownload });
  }

  dispose() {
    this.cancelQueued();
    const child = this.process;
    this.process = null;
    this.isReady = false;
    this.inflight?.reject(Object.assign(new Error('cancelled'), { cancelled: true }));
    this.inflight = null;
    child?.kill();
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

module.exports = { TtsWorker };
