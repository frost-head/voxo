'use strict';

// Runs in an Electron utilityProcess. Turns text into 384-number "meaning" vectors with a small sentence-embedding
// model (all-MiniLM-L6-v2, ~23 MB quantised) so voxo can search by meaning. Everything stays on this device.

const parentPort = process.parentPort;
const fs = require('fs');

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
let allowDownload = process.env.VOXO_TTS_ALLOW_DOWNLOAD === 'true';
const cacheDir = process.env.VOXO_TTS_CACHE_DIR;
let transformerEnv = null;
let pipelinePromise = null;

function getPipeline() {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      fs.mkdirSync(cacheDir, { recursive: true });
      const { env, pipeline } = await import('@huggingface/transformers');
      transformerEnv = env;
      env.cacheDir = cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = allowDownload;
      return pipeline('feature-extraction', MODEL_ID, { dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 } });
    })().catch((error) => {
      pipelinePromise = null;
      throw new Error(allowDownload
        ? error.message
        : `The search model is not downloaded yet. Turn on “Allow model downloads” in Settings. ${error.message}`);
    });
  }
  return pipelinePromise;
}

async function embed({ id, texts }) {
  try {
    const extractor = await getPipeline();
    const vectors = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => String(t).slice(0, 1800));
      const output = await extractor(batch, { pooling: 'mean', normalize: true });
      const dim = output.dims[output.dims.length - 1];
      for (let row = 0; row < batch.length; row++) vectors.push(Array.from(output.data.slice(row * dim, (row + 1) * dim)));
    }
    parentPort.postMessage({ type: 'result', id, ok: true, vectors });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, ok: false, error: error.message || String(error) });
  }
}

parentPort.on('message', (event) => {
  const message = event.data;
  if (message.type === 'allow-download') {
    allowDownload = Boolean(message.value);
    if (transformerEnv) transformerEnv.allowRemoteModels = allowDownload;
    return;
  }
  if (message.type === 'embed') embed(message);
});

parentPort.start();
parentPort.postMessage({ type: 'ready' });
