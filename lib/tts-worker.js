'use strict';
// Manages the long-running `tts.py --serve` process. Requests are handled one at
// a time, in order; queued requests can be cancelled when the user jumps around.

const { spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

class TtsWorker extends EventEmitter {
  /**
   * @param {{python:string, script:string, args?:string[], cwd?:string, allowDownload?:boolean}} opts
   */
  constructor({ python, script, args = [], cwd, env = process.env, allowDownload = false }) {
    super();
    this.python = python;
    this.script = script;
    this.extraArgs = args;
    this.cwd = cwd;
    this.env = env;
    this.allowDownload = allowDownload;

    this.proc = null;
    this.isReady = false;
    this.queue = [];
    this.inflight = null;
    this.nextId = 1;
    this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-tts-'));
  }

  _start() {
    const args = [...(this.script ? [this.script] : []), '--serve', ...this.extraArgs];
    if (this.allowDownload) args.push('--allow-download');

    const proc = spawn(this.python, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.isReady = false;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => this._onLine(proc, line));
    readline.createInterface({ input: proc.stderr }).on('line', (line) => this.emit('log', line));
    proc.stdin.on('error', () => {}); // a dead worker is reported through 'exit'
    proc.on('error', (err) => this._onExit(proc, `Could not start the speech engine (${this.python}): ${err.message}`));
    proc.on('exit', (code, signal) =>
      this._onExit(proc, `The speech worker stopped (${signal || `exit code ${code}`}). See the log for details.`)
    );
  }

  _onLine(proc, line) {
    if (proc !== this.proc) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('log', line);
      return;
    }
    if (msg.ready) {
      this.isReady = true;
      this._pump();
      return;
    }
    const job = this.inflight;
    if (!job || msg.id !== job.id) return;
    this.inflight = null;
    if (msg.ok) job.resolve(job.out);
    else job.reject(new Error(msg.error || 'Speech synthesis failed.'));
    this._pump();
  }

  _onExit(proc, message) {
    if (proc !== this.proc) return; // an old worker we replaced on purpose
    this.proc = null;
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
    const { id, text, out, engine, voice } = this.inflight;
    this.proc.stdin.write(`${JSON.stringify({ id, text, out, engine, voice })}\n`);
  }

  /** Synthesize `text` to a WAV file and resolve with its path. */
  synth({ text, engine, voice }) {
    if (!this.proc) this._start();
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.queue.push({ id, text, engine, voice, out: path.join(this.tmpDir, `${id}.wav`), resolve, reject });
      this._pump();
    });
  }

  /** Drop requests that haven't started yet. The one in progress finishes. */
  cancelQueued() {
    const dropped = this.queue;
    this.queue = [];
    for (const job of dropped) {
      const err = new Error('cancelled');
      err.cancelled = true;
      job.reject(err);
    }
  }

  setAllowDownload(value) {
    value = Boolean(value);
    if (value === this.allowDownload) return;
    this.allowDownload = value;
    this.stop(); // restart with the new flag on the next request
  }

  stop() {
    const proc = this.proc;
    if (!proc) return;
    this.cancelQueued();
    if (this.inflight) {
      const err = new Error('cancelled');
      err.cancelled = true;
      this.inflight.reject(err);
      this.inflight = null;
    }
    this.proc = null;
    this.isReady = false;
    try {
      proc.stdin.write('{"cmd":"quit"}\n');
      proc.stdin.end();
    } catch {
      /* already gone */
    }
    setTimeout(() => proc.kill(), 1500).unref();
  }

  dispose() {
    this.stop();
    fs.rmSync(this.tmpDir, { recursive: true, force: true });
  }
}

module.exports = { TtsWorker };
