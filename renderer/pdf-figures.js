// Draws figures, tables and equations of a PDF as pictures cropped from the original page.
// The reader stores only where each one is (page + rectangle in PDF points), so the library stays small.
import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';

const MAX_WIDTH = 2200; // pixels
const MIN_WIDTH = 520;

export function createFigureRenderer({ standardFontDataUrl, cMapUrl }) {
  let docPromise = null;
  let data = null;
  let generation = 0;
  const urls = [];
  let observer = null;
  const queue = [];
  let running = false;

  function reset() {
    generation += 1;
    observer?.disconnect();
    observer = null;
    queue.length = 0;
    for (const url of urls.splice(0)) URL.revokeObjectURL(url);
    const pending = docPromise;
    docPromise = null;
    data = null;
    pending?.then((doc) => doc.destroy()).catch(() => {});
  }

  /** Call with the PDF bytes of the reading that just opened (or null when the file is unavailable). */
  function attach(bytes) {
    reset();
    data = bytes ? bytes.slice() : null; // a copy: pdf.js takes ownership of the buffer it is given
  }

  const available = () => Boolean(data) || Boolean(docPromise);

  function getDoc() {
    if (!docPromise) {
      docPromise = pdfjsLib.getDocument({
        data, standardFontDataUrl, cMapUrl, cMapPacked: true, useWorkerFetch: false, isEvalSupported: false,
      }).promise;
      data = null;
    }
    return docPromise;
  }

  async function draw(figure, block) {
    const my = generation;
    const { page: pageNumber, x0, x1, y0, y1, vx0, vy1 } = block.pdf;
    const doc = await getDoc();
    if (my !== generation) return;
    const page = await doc.getPage(pageNumber);
    try {
      const width = Math.max(1, x1 - x0);
      const height = Math.max(1, y1 - y0);
      // Drawn as sharp as the screen can show it: the figure fills the reading column.
      const shown = figure.clientWidth || 800;
      const target = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, shown * Math.min(2, window.devicePixelRatio || 1)));
      const scale = target / width;
      const viewport = page.getViewport({ scale, offsetX: -(x0 - vx0) * scale, offsetY: -(vy1 - y1) * scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(width * scale);
      canvas.height = Math.ceil(height * scale);
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      canvas.width = 0;
      canvas.height = 0;
      if (!blob || my !== generation) return;
      const url = URL.createObjectURL(blob);
      urls.push(url);
      const image = document.createElement('img');
      image.alt = block.alt || 'Figure from the PDF';
      image.src = url;
      image.decoding = 'async';
      figure.replaceChildren(image);
      figure.classList.remove('is-loading');
    } finally {
      page.cleanup();
    }
  }

  async function pump() {
    if (running) return;
    running = true;
    while (queue.length) {
      const job = queue.shift();
      try {
        await draw(job.figure, job.block);
      } catch {
        job.figure.classList.remove('is-loading');
        job.figure.classList.add('is-failed');
        job.figure.textContent = 'This figure could not be drawn.';
      }
    }
    running = false;
  }

  /** The element for one figure block. It draws itself when it scrolls near the screen. */
  function mount(block, root) {
    const figure = document.createElement('figure');
    figure.className = `image-block pdf-figure pdf-figure-${block.pdf.kind || 'figure'}`;
    const width = block.pdf.x1 - block.pdf.x0;
    const height = block.pdf.y1 - block.pdf.y0;
    figure.style.aspectRatio = `${Math.max(1, width)} / ${Math.max(1, height)}`;
    // Figures and tables use the full width of the column. Equations stay at the size of the text around them.
    if (block.pdf.kind === 'equation') figure.style.width = `calc(${(width / (block.pdf.bodyPt || 10)).toFixed(3)} * var(--reading-size, 20px))`;
    else figure.style.width = '100%';
    if (!available()) {
      figure.classList.add('is-failed');
      figure.textContent = 'The original PDF is no longer on this computer, so this picture cannot be shown.';
      return figure;
    }
    figure.classList.add('is-loading');
    if (!observer) {
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          const job = entry.target._figureJob;
          if (job) { queue.push(job); pump(); }
        }
      }, { root: root || null, rootMargin: '800px 0px' });
    }
    figure._figureJob = { figure, block };
    figure.addEventListener('click', () => figure.classList.toggle('is-zoomed'));
    observer.observe(figure);
    return figure;
  }

  return { attach, mount, reset };
}
