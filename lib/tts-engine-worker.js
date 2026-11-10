'use strict';

const parentPort = process.parentPort;
const fs = require('fs');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SAMPLE_RATE = 24000;
let allowDownload = process.env.VOXO_TTS_ALLOW_DOWNLOAD === 'true';
let modelPromise = null;
let transformerEnv = null;
const cacheDir = process.env.VOXO_TTS_CACHE_DIR;

function chunkText(text, maxChars = 400) {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = '';
  for (let sentence of sentences) {
    sentence = sentence.trim();
    while (sentence.length > maxChars) {
      let cut = sentence.lastIndexOf(' ', maxChars);
      if (cut < 1) cut = maxChars;
      const part = sentence.slice(0, cut).trim();
      if (part) {
        if (current) chunks.push(current);
        chunks.push(part);
      }
      sentence = sentence.slice(cut).trim();
      current = '';
    }
    if (!sentence) continue;
    if (current && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = `${current} ${sentence}`.trim();
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function getModel() {
  if (!modelPromise) {
    modelPromise = (async () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      const { env } = await import('@huggingface/transformers');
      transformerEnv = env;
      env.cacheDir = cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = allowDownload;

      const { KokoroTTS } = await import('kokoro-js');
      return KokoroTTS.from_pretrained(MODEL_ID, {
        dtype: 'q8',
        device: 'cpu',
        progress_callback: (progress) => {
          const file = progress.file || progress.name || 'Kokoro model';
          if (typeof progress.progress === 'number') {
            parentPort.postMessage({
              type: 'log',
              line: `Downloading ${file}: ${Math.round(progress.progress)}%`,
            });
          }
        },
      });
    })().catch((error) => {
      modelPromise = null;
      if (!allowDownload) {
        throw new Error(`Kokoro model is not cached yet. Turn on “Allow model downloads” in Voice and try again. ${error.message}`);
      }
      throw error;
    });
  }
  return modelPromise;
}

function toWav(samples, sampleRate) {
  const headerSize = 44;
  const buffer = Buffer.allocUnsafe(headerSize + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, headerSize + i * 2);
  }
  return buffer;
}

async function synthesize({ id, text, out, voice }) {
  try {
    if (!text || !text.trim()) throw new Error('No text to speak.');
    const model = await getModel();
    const chunks = chunkText(text);
    const audioChunks = [];
    let sampleCount = 0;
    for (const chunk of chunks) {
      const result = await model.generate(chunk, { voice: voice || 'af_heart' });
      audioChunks.push(result.audio);
      sampleCount += result.audio.length;
    }
    const audio = new Float32Array(sampleCount);
    let offset = 0;
    for (const chunk of audioChunks) {
      audio.set(chunk, offset);
      offset += chunk.length;
    }
    fs.writeFileSync(out, toWav(audio, SAMPLE_RATE));
    parentPort.postMessage({ type: 'result', id, ok: true });
  } catch (error) {
    parentPort.postMessage({
      type: 'result',
      id,
      ok: false,
      error: `${error.name || 'Error'}: ${error.message || String(error)}`,
    });
  }
}

parentPort.on('message', (event) => {
  const message = event.data;
  if (message.type === 'allow-download') {
    allowDownload = Boolean(message.value);
    if (transformerEnv) transformerEnv.allowRemoteModels = allowDownload;
    return;
  }
  if (message.type === 'synthesize') synthesize(message);
});

parentPort.start();
parentPort.postMessage({ type: 'ready' });
