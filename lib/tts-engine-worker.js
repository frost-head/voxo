'use strict';

const parentPort = process.parentPort;
const fs = require('fs');

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const SAMPLE_RATE = 24000;
let allowDownload = process.env.VOXO_TTS_ALLOW_DOWNLOAD === 'true';
let modelPromise = null;
let transformerEnv = null;
const cacheDir = process.env.VOXO_TTS_CACHE_DIR;

// Kokoro voice names start with a language letter (af_heart = American female). kokoro-js only knows how to
// phonemize English, so for the other languages voxo phonemizes with eSpeak NG itself and feeds Kokoro directly.
const ESPEAK_LANG = { e: 'es', f: 'fr', h: 'hi', i: 'it', p: 'pt-br' };
const FOREIGN_CHUNK = 260; // keeps every chunk under Kokoro's 510-token limit

function chunkText(text, maxChars = 400) {
  const sentences = text.match(/[^.!?।]+[.!?।]+|[^.!?।]+$/g) || [text];
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

// ---------------------------------------------------------------- other languages (eSpeak NG)

let espeakPromise = null;

function getEspeak() {
  if (!espeakPromise) {
    espeakPromise = (async () => {
      let factory;
      try {
        factory = (await import('@echogarden/espeak-ng-emscripten')).default;
      } catch (error) {
        throw new Error('Reading this language needs one extra package. Run “npm install @echogarden/espeak-ng-emscripten” in the voxo folder, then restart. ' + error.message);
      }
      const module = await factory();
      return { module, worker: new module.eSpeakNGWorker() };
    })().catch((error) => {
      espeakPromise = null;
      throw error;
    });
  }
  return espeakPromise;
}

function readCString(module, pointer) {
  let end = pointer;
  while (module.HEAPU8[end]) end += 1;
  return Buffer.from(module.HEAPU8.slice(pointer, end)).toString('utf8');
}

const PUNCTUATION = /(\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*)/;
const IS_PUNCTUATION = /^\s*[;:,.!?¡¿—…"«»“”(){}[\]]+\s*$/;

function normalizeForeign(text) {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/।/g, '.') // Devanagari danda
    .replace(/॥/g, '.')
    .replace(/[‐‑–]/g, '-')
    .replace(/[^\S \n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function phonemizeForeign(text, language) {
  const { module, worker } = await getEspeak();
  if (worker.set_voice(language) !== 0) throw new Error(`The speech engine does not have the “${language}” voice data.`);
  const pieces = normalizeForeign(text).split(PUNCTUATION).filter((piece) => piece !== '');
  const out = pieces.map((piece) => {
    if (IS_PUNCTUATION.test(piece)) return piece;
    const result = worker.text_to_phonemes(piece, 1 /* UTF-8 */, 2 /* IPA */);
    return readCString(module, result.ptr).replace(/_/g, '').replace(/\s*\|\s*/g, ' ');
  });
  // The same clean-ups kokoro-js applies to eSpeak output, so Kokoro's vocabulary recognises the symbols.
  return out.join('')
    .replace(/ʲ/g, 'j')
    .replace(/r/g, 'ɹ')
    .replace(/x/g, 'k')
    .replace(/ɬ/g, 'l')
    .replace(/‍/g, '')
    .replace(/ +/g, ' ')
    .trim();
}

async function generateForeign(model, text, voice, language) {
  const phonemes = await phonemizeForeign(text, language);
  if (!phonemes) return new Float32Array(0);
  const { input_ids } = model.tokenizer(phonemes, { truncation: true });
  const result = await model.generate_from_ids(input_ids, { voice, speed: 1 });
  return result.audio;
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
    const voiceName = voice || 'af_heart';
    const foreign = ESPEAK_LANG[voiceName.charAt(0)];
    const chunks = chunkText(text, foreign ? FOREIGN_CHUNK : 400);
    const audioChunks = [];
    let sampleCount = 0;
    for (const chunk of chunks) {
      const audio = foreign
        ? await generateForeign(model, chunk, voiceName, foreign)
        : (await model.generate(chunk, { voice: voiceName })).audio;
      audioChunks.push(audio);
      sampleCount += audio.length;
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
