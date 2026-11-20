'use strict';

// Turns a PDF into reader blocks the way a person would read it: columns in order, headings by font size,
// running headers/footers dropped, footnotes and references kept out of the narration, code only where the font is
// monospace, and figures, tables and display equations kept as pictures (cropped from the page at display time).
//
//   const article = await readPdf(pdfDoc, { pdfjs, title, tools: { splitIntoChunks }, onProgress });

const MONO_FONT = /mono|courier|consol|menlo|monaco|typewriter|inconsolata|cmtt|lmmono|lmtt|sourcecode|source code|fira ?code|jetbrains|cousine|ubuntu ?mono|andale|lucida ?console|nimbusmon|dejavusansmono|liberationmono/i;
const MATH_FONT = /cmmi|cmsy|cmex|cmmib|cmbsy|msam|msbm|mathit|mathematical|cambria ?math|stix|eufm|eusm|lmmath|rsfs|wasy|bbm|dsrom|xits ?math|asana ?math/i;
const BOLD_FONT = /bold|black|heavy|semibold|demi|cmbx|cmssbx|-bd\b|,bd\b/i;
const ITALIC_FONT = /italic|oblique|cmti|cmsl|,it\b|-it\b/i;

const CAPTION_START = /^(?:figure|fig\.?|table|algorithm|listing|scheme|chart|exhibit)\s*[\dIVXA-Z]{1,5}(?:\.\d+)?\s*[.:|—–-]/i;
const CAPTION_LABEL_ONLY = /^(?:figure|fig\.?|table)\s+\d{1,3}\s*$/i;
const SENTENCE_END = /[.!?:;”"')\]’]$/;
const LIST_MARKER = /^(?:([•◦▪●‣·–—*-])|(\d{1,3}[.)])|(\(\d{1,3}\)|\([a-z]\)|[a-z][.)]))\s+(?=\S)/;
const REF_HEADING = /^(?:\d+\.?\s*)?(?:references|bibliography|works cited|literature cited|reference list|sources)$/i;
const NON_ENTRY_HEADING = /^(?:\d+\.?\s*)?(?:appendix|appendices|supplementary|acknowledg(?:e)?ments?|author contributions)\b/i;
const BULLET_CHARS = /[\u0080-\u009f]/g; // Word/TeX bullets that land in private-use or control code points

const median = (list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const quantile = (list, q) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))))];
};

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
function boxThrough(m, [x0, y0, x1, y1]) {
  const xs = [];
  const ys = [];
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) {
    xs.push(m[0] * x + m[2] * y + m[4]);
    ys.push(m[1] * x + m[3] * y + m[5]);
  }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}
const area = (b) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
const overlapArea = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const union = (a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const near = (a, b, gap) => a.x0 <= b.x1 + gap && b.x0 <= a.x1 + gap && a.y0 <= b.y1 + gap && b.y0 <= a.y1 + gap;
const centerIn = (p, b) => (p.x0 + p.x1) / 2 >= b.x0 && (p.x0 + p.x1) / 2 <= b.x1 && p.y >= b.y0 && p.y <= b.y1 + 2;

// ---------------------------------------------------------------- page analysis

function fontTraits(page, fontName, cache) {
  if (cache.has(fontName)) return cache.get(fontName);
  let name = '';
  try { name = page.commonObjs.get(fontName)?.name || ''; } catch { /* not resolved */ }
  name = String(name).replace(/^[A-Z]{6}\+/, '');
  const traits = {
    name,
    mono: MONO_FONT.test(name),
    math: MATH_FONT.test(name),
    bold: BOLD_FONT.test(name),
    italic: ITALIC_FONT.test(name),
  };
  cache.set(fontName, traits);
  return traits;
}

/** Runs → visual line pieces. A piece is a stretch of one line with no wide gap inside it. */
function piecesFromItems(items, page, fontCache) {
  const runs = [];
  for (const item of items) {
    if (!('str' in item) || !item.str) continue;
    const [a, b, , , e, f] = item.transform;
    if (Math.abs(b) > Math.abs(a) * 0.3) continue; // rotated text: margin stamps, watermarks
    const size = Math.hypot(a, b) || item.height || 0;
    if (!size) continue;
    const traits = fontTraits(page, item.fontName, fontCache);
    let str = item.str;
    // Typeset code (LaTeX listings and the like) is kerned token by token, and pdf.js turns those kerns into spaces.
    // A real space always takes a full character cell, so an item narrower than its text says the spaces are not real.
    if (traits.mono && str.includes(' ') && str.trim() && item.width < str.length * 0.6 * size * 0.88) str = str.replace(/ /g, '');
    runs.push({ s: str, x: e, y: f, w: item.width || 0, size, ...traits });
  }
  runs.sort((p, q) => q.y - p.y || p.x - q.x);

  const lines = [];
  for (const run of runs) {
    let target = null;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i -= 1) {
      if (Math.abs(lines[i].y - run.y) <= 0.5 * Math.max(lines[i].size, run.size)) { target = lines[i]; break; }
    }
    if (!target) { target = { y: run.y, size: run.size, runs: [] }; lines.push(target); }
    if (run.size > target.size && run.s.trim()) { target.size = run.size; }
    target.runs.push(run);
  }

  const pieces = [];
  for (const line of lines) {
    line.runs.sort((p, q) => p.x - q.x);
    let group = [];
    const flush = () => {
      const piece = makePiece(group);
      if (piece) pieces.push(piece);
      group = [];
    };
    for (const run of line.runs) {
      // Compare with the last run that has visible text: spaces between table cells must not hide the gap.
      let prev = null;
      for (let k = group.length - 1; k >= 0; k -= 1) if (group[k].s.trim()) { prev = group[k]; break; }
      if (prev && run.s.trim()) {
        const gap = run.x - (prev.x + prev.w);
        const sz = Math.max(prev.size, run.size);
        // A wide gap ends a piece; a smaller gap does too when the baselines differ (the two sides are different columns).
        if (gap > 0.75 * sz || (gap > 0.4 * sz && Math.abs(run.y - prev.y) > 1.5 && Math.abs(run.size - prev.size) < 0.6)) flush();
      }
      group.push(run);
    }
    flush();
  }
  return pieces;
}

function makePiece(runs) {
  let text = '';
  let prevEnd = null;
  let prevMono = false;
  const weight = { size: new Map(), bold: 0, italic: 0, mono: 0, math: 0, chars: 0 };
  let baseline = null;
  let baseWeight = 0;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const run of runs) {
    const body = run.s.replace(BULLET_CHARS, '•');
    if (prevEnd !== null && run.mono && prevMono) {
      // Code: the gap between tokens is a whole number of character cells.
      const cells = Math.round((run.x - prevEnd) / (0.6 * run.size));
      if (cells > 0 && !text.endsWith(' ') && !body.startsWith(' ')) text += ' '.repeat(cells);
    } else if (prevEnd !== null && run.x - prevEnd > 0.12 * run.size && !text.endsWith(' ') && !body.startsWith(' ')) text += ' ';
    prevMono = run.mono;
    text += body;
    prevEnd = run.x + run.w;
    const n = body.replace(/\s/g, '').length;
    if (!n) continue;
    x0 = Math.min(x0, run.x);
    x1 = Math.max(x1, run.x + run.w);
    const key = Math.round(run.size * 2) / 2;
    weight.size.set(key, (weight.size.get(key) || 0) + n);
    weight.chars += n;
    if (run.bold) weight.bold += n;
    if (run.italic) weight.italic += n;
    if (run.mono) weight.mono += n;
    if (run.math) weight.math += n;
    if (n > baseWeight) { baseWeight = n; baseline = run.y; }
  }
  if (!weight.chars) return null;
  let size = 0;
  let best = -1;
  for (const [key, n] of weight.size) if (n > best) { best = n; size = key; }
  return {
    text: weight.mono / weight.chars > 0.8 ? text.trim() : text.replace(/\s+/g, ' ').trim(),
    x0, x1, y: baseline, size,
    chars: weight.chars,
    bold: weight.bold / weight.chars,
    italic: weight.italic / weight.chars,
    mono: weight.mono / weight.chars,
    math: weight.math / weight.chars,
  };
}

/** Pictures on the page: raster images, embedded figure forms, vector drawings and ruled tables. */
function findRegions(opList, OPS, width, height, pieces, bodySize) {
  const stack = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const images = [];
  const forms = [];
  const shapes = [];
  let pending = null;
  const painters = new Set([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const imageOps = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((v) => v !== undefined));
  const pageArea = width * height;

  for (let i = 0; i < opList.fnArray.length; i += 1) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = mul(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (args[0]) ctm = mul(args[0], ctm);
      if (args[1]) forms.push(boxThrough(ctm, args[1]));
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (imageOps.has(fn)) images.push(boxThrough(ctm, [0, 0, 1, 1]));
    else if (fn === OPS.constructPath) {
      const mm = args[2];
      pending = mm && mm.length === 4 && mm.every(Number.isFinite) ? boxThrough(ctm, mm) : null;
    } else if (painters.has(fn)) {
      if (pending) shapes.push(pending);
      pending = null;
    } else if (fn === OPS.endPath) pending = null;
  }

  const wide = (b) => b.x1 - b.x0 >= width * 0.92 && b.y1 - b.y0 >= height * 0.92;
  const candidates = [];
  for (const b of images) if (b.x1 - b.x0 >= 28 && b.y1 - b.y0 >= 22 && area(b) < pageArea * 0.85) candidates.push({ ...b, kind: 'image' });
  for (const b of forms) if (b.x1 - b.x0 >= 36 && b.y1 - b.y0 >= 30 && area(b) < pageArea * 0.6) candidates.push({ ...b, kind: 'form' });

  // Vector drawings: cluster painted paths that touch, ignoring underlines, link borders and highlights behind text.
  const thin = (b) => Math.min(b.x1 - b.x0, b.y1 - b.y0) < 1.6;
  const textBoxes = pieces.map((p) => ({ x0: p.x0, x1: p.x1, y0: p.y - p.size * 0.3, y1: p.y + p.size * 0.95 }));
  const usable = [];
  for (const b of shapes) {
    if (wide(b) || (b.x1 - b.x0 < 1.5 && b.y1 - b.y0 < 1.5)) continue;
    if (!thin(b) && b.y1 - b.y0 <= bodySize * 1.7 && textBoxes.some((t) => overlapArea(t, b) > 0.5 * area(b))) continue;
    usable.push(b);
  }
  usable.sort((p, q) => p.x0 - q.x0);
  const parent = usable.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length && usable[j].x0 <= usable[i].x1 + 5; j += 1) {
      if (near(usable[i], usable[j], 5)) parent[find(j)] = find(i);
    }
  }
  const clusters = new Map();
  usable.forEach((b, i) => {
    const key = find(i);
    const c = clusters.get(key) || { box: b, count: 0, solid: 0, h: 0, v: 0 };
    c.box = union(c.box, b);
    c.count += 1;
    if (!thin(b)) c.solid += 1;
    else if (b.x1 - b.x0 > b.y1 - b.y0) c.h += 1;
    else c.v += 1;
    clusters.set(key, c);
  });
  for (const c of clusters.values()) {
    const w = c.box.x1 - c.box.x0;
    const h = c.box.y1 - c.box.y0;
    if (w < 36 || h < 26) continue;
    const grid = c.h >= 2 && c.v >= 2;
    if (c.solid >= 3 || grid) candidates.push({ ...c.box, kind: grid && c.solid < 3 ? 'table' : 'vector' });
  }

  // Ruled tables without vertical lines (book-style tables): groups of long horizontal rules.
  const rules = shapes.filter((b) => thin(b) && b.x1 - b.x0 >= 60 && b.y1 - b.y0 < 1.6 && !wide(b)).sort((p, q) => q.y1 - p.y1);
  const used = new Set();
  for (let i = 0; i < rules.length; i += 1) {
    if (used.has(i)) continue;
    const group = [i];
    for (let j = i + 1; j < rules.length; j += 1) {
      const last = rules[group[group.length - 1]];
      if (Math.abs(rules[j].x0 - rules[i].x0) <= 6 && Math.abs(rules[j].x1 - rules[i].x1) <= 6 && last.y1 - rules[j].y1 < 220) group.push(j);
    }
    if (group.length >= 2) {
      const top = rules[group[0]];
      const bottom = rules[group[group.length - 1]];
      const box = { x0: Math.min(top.x0, bottom.x0), x1: Math.max(top.x1, bottom.x1), y0: bottom.y0, y1: top.y1 };
      const inside = pieces.filter((p) => p.y > box.y0 && p.y < box.y1 && p.x0 >= box.x0 - 4 && p.x1 <= box.x1 + 4);
      if (box.y1 - box.y0 >= 24 && inside.length >= 3 && group.length >= 3) {
        candidates.push({ ...box, kind: 'table' });
        group.forEach((k) => used.add(k));
      }
    }
  }

  // Reject boxes that are really text panels, then merge overlapping ones.
  const ok = candidates.filter((b) => {
    const inside = pieces.filter((p) => centerIn(p, b));
    const longText = inside.filter((p) => p.text.length > 45 && Math.abs(p.size - bodySize) < 1.2 && p.x1 - p.x0 > (b.x1 - b.x0) * 0.6);
    const chars = inside.reduce((n, p) => n + p.chars, 0);
    const monoChars = inside.reduce((n, p) => n + p.mono * p.chars, 0);
    if (inside.length >= 2 && chars > 0 && monoChars / chars > 0.6) return false; // a framed code listing stays code
    return longText.length < 3 && (b.kind !== 'form' || inside.filter((p) => Math.abs(p.size - bodySize) < 1.2).length < 8);
  });
  ok.sort((p, q) => area(q) - area(p));
  const kept = [];
  for (const b of ok) {
    const host = kept.find((k) => overlapArea(k, b) > 0.55 * area(b));
    if (host) { Object.assign(host, union(host, b)); continue; }
    kept.push({ ...b });
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < kept.length && !changed; i += 1) {
      for (let j = i + 1; j < kept.length; j += 1) {
        if (near(kept[i], kept[j], 3)) { Object.assign(kept[i], union(kept[i], kept[j])); kept.splice(j, 1); changed = true; break; }
      }
    }
  }
  return kept;
}

async function analyzePage(page, pdfjs, fontCache) {
  const view = page.view;
  const opList = await page.getOperatorList();
  const content = await page.getTextContent();
  const pieces = piecesFromItems(content.items, page, fontCache);
  return { view, rotate: page.rotate || 0, width: view[2] - view[0], height: view[3] - view[1], pieces, opList };
}

// ---------------------------------------------------------------- document statistics

function bodyFontSize(pages) {
  const counts = new Map();
  for (const p of pages) for (const piece of p.pieces) counts.set(piece.size, (counts.get(piece.size) || 0) + piece.chars);
  let best = 0;
  let size = 11;
  for (const [key, n] of counts) if (n > best) { best = n; size = key; }
  return size;
}

function marginKey(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** Marks pieces that are running headers/footers or bare page numbers. */
function markMargins(pages) {
  const counts = new Map();
  const zone = (page, piece) => {
    const rel = (piece.y - page.view[1]) / page.height;
    return rel > 0.91 || rel < 0.09;
  };
  for (const page of pages) {
    const seen = new Set();
    for (const piece of page.pieces) {
      if (!zone(page, piece)) continue;
      const key = marginKey(piece.text);
      if (key.length <= 120 && !seen.has(key)) { seen.add(key); counts.set(key, (counts.get(key) || 0) + 1); }
    }
  }
  const need = Math.max(2, Math.ceil(pages.length * 0.3));
  for (const page of pages) {
    for (const piece of page.pieces) {
      if (!zone(page, piece)) continue;
      const key = marginKey(piece.text);
      const pageNumber = /^(?:page\s+)?#(?:\s*(?:of|\/)\s*#)?$/.test(key) || /^[-–—\s]*#[-–—\s]*$/.test(key);
      if (pageNumber || (pages.length >= 2 && counts.get(key) >= need)) piece.margin = true;
    }
  }
}

// ---------------------------------------------------------------- layout: columns and reading order

function detectColumns(pieces, width, x0Page) {
  const body = pieces.filter((p) => p.chars >= 3);
  if (body.length < 8) return null;
  const minX = quantile(body.map((p) => p.x0), 0.03);
  const maxX = quantile(body.map((p) => p.x1), 0.97);
  const extent = maxX - minX;
  if (extent < width * 0.4) return null;
  const narrow = body.filter((p) => p.x1 - p.x0 < extent * 0.56);
  if (narrow.length < 8) return null;
  const bins = new Array(Math.ceil(extent) + 2).fill(0);
  for (const p of narrow) {
    for (let x = Math.max(0, Math.floor(p.x0 - minX)); x <= Math.min(bins.length - 1, Math.ceil(p.x1 - minX)); x += 1) bins[x] += 1;
  }
  const lo = Math.floor(extent * 0.3);
  const hi = Math.floor(extent * 0.7);
  let bestStart = -1;
  let bestLen = 0;
  let runStart = -1;
  for (let x = lo; x <= hi + 1; x += 1) {
    const empty = x <= hi && bins[x] <= Math.max(1, Math.round(narrow.length * 0.05)); // a few full-width lines may cross the gutter
    if (empty && runStart < 0) runStart = x;
    if (!empty && runStart >= 0) {
      if (x - runStart > bestLen) { bestLen = x - runStart; bestStart = runStart; }
      runStart = -1;
    }
  }
  if (bestLen < 6) return null;
  const split = minX + bestStart + bestLen / 2;
  const left = narrow.filter((p) => p.x1 <= split + 2).length;
  const right = narrow.filter((p) => p.x0 >= split - 2).length;
  if (left < 5 || right < 5) return null;
  return { split, minX, maxX, extent };
}

function classify(item, cols) {
  if (!cols) return 'L';
  const w = item.x1 - item.x0;
  if (item.x0 < cols.split - 4 && item.x1 > cols.split + 4) return 'F';
  if (w > cols.extent * 0.56) return 'F';
  return item.x1 <= cols.split + 2 ? 'L' : 'R';
}

/** Items (pieces and figure regions) → ordered flows: [{cls, items}] where each flow is one column band or one full-width run. */
function orderFlows(items, cols) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const flows = [];
  let L = [];
  let R = [];
  const flushColumns = () => {
    if (L.length) flows.push({ cls: 'L', items: L });
    if (R.length) flows.push({ cls: 'R', items: R });
    L = [];
    R = [];
  };
  let full = null;
  for (const item of sorted) {
    const cls = classify(item, cols);
    if (cls === 'F') {
      flushColumns();
      if (!full) { full = { cls: 'F', items: [] }; flows.push(full); }
      full.items.push(item);
    } else {
      full = null;
      (cls === 'L' ? L : R).push(item);
    }
  }
  flushColumns();
  return flows;
}

/** Same-baseline pieces of one flow → lines. */
function linesFromItems(items) {
  const pieces = items.filter((i) => i.kind === 'text');
  const sorted = [...pieces].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  const lines = [];
  for (const p of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) <= 0.5 * Math.max(last.size, p.size)) {
      last.parts.push(p);
      last.x1 = Math.max(last.x1, p.x1);
      last.x0 = Math.min(last.x0, p.x0);
      if (p.size > last.size) last.size = p.size;
    } else {
      lines.push({ parts: [p], x0: p.x0, x1: p.x1, y: p.y, size: p.size });
    }
  }
  for (const line of lines) {
    line.parts.sort((a, b) => a.x0 - b.x0);
    const joined = line.parts.map((p) => p.text).join(' ');
    line.text = line.parts.every((p) => p.mono > 0.8) ? joined.trim() : joined.replace(/\s+/g, ' ').trim();
    const chars = line.parts.reduce((n, p) => n + p.chars, 0) || 1;
    const share = (key) => line.parts.reduce((n, p) => n + p[key] * p.chars, 0) / chars;
    line.bold = share('bold');
    line.italic = share('italic');
    line.mono = share('mono');
    line.math = share('math');
    line.chars = chars;
  }
  return lines;
}

// ---------------------------------------------------------------- blocks

function tidy(text) {
  return text
    .replace(/­/g, '')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/[‐‑]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function joinLines(a, b) {
  if (/[A-Za-zÀ-ɏ]-$/.test(a) && /^[a-zß-ÿ]/.test(b)) return a.slice(0, -1) + b; // line-end hyphenation
  return `${a} ${b}`;
}

function spokenText(text) {
  return text
    .replace(/\s*\[\d+(?:\s*[,–—-]\s*\d+)*\]/g, '')
    .replace(/\s*\((?:[A-Z][A-Za-z-]+(?: et al\.)?(?:,? (?:and|&) [A-Z][A-Za-z-]+)?,? (?:19|20)\d\d[a-z]?(?:[;,] ?)?)+\)/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingLevel(size, body) {
  if (size >= body * 1.55) return 2;
  if (size >= body * 1.25) return 2;
  if (size >= body * 1.1) return 3;
  return 4;
}

function blocksFromFlow(flow, ctx) {
  const { body, page, tools } = ctx;
  const out = [];
  const regionsHere = flow.items.filter((i) => i.kind === 'region');
  const lines = linesFromItems(flow.items);

  // Interleave pictures with lines by vertical position.
  const sequence = [
    ...lines.map((l) => ({ type: 'line', y: l.y + l.size, line: l })),
    ...regionsHere.map((r) => ({ type: 'region', y: r.y, region: r })),
  ].sort((a, b) => b.y - a.y);

  const bodyLines = lines.filter((l) => Math.abs(l.size - body) < 1.2 && l.mono < 0.5);
  const colLeft = quantile(bodyLines.map((l) => l.x0), 0.15) || (lines.length ? Math.min(...lines.map((l) => l.x0)) : 0);
  const colRight = quantile(bodyLines.map((l) => l.x1), 0.85) || (lines.length ? Math.max(...lines.map((l) => l.x1)) : 0);
  const colWidth = Math.max(1, colRight - colLeft);
  const gaps = [];
  for (let i = 1; i < bodyLines.length; i += 1) {
    const g = bodyLines[i - 1].y - bodyLines[i].y;
    const r = g / body;
    if (r > 0.9 && r < 3) gaps.push(r);
  }
  const lead = gaps.length >= 5 ? median(gaps) : 1.25;

  let cur = null; // { type, lines, ... }
  const flush = () => {
    if (!cur) return;
    emit(cur);
    cur = null;
  };

  function block(type, text, extra = {}) {
    const display = tidy(text);
    if (!display) return;
    const speak = extra.speak !== false && !ctx.refMode;
    const spoken = speak ? spokenText(display) : '';
    const b = { type, level: extra.level || 0, text: display, speak: Boolean(spoken), chunks: [], words: 0 };
    if (b.speak) {
      const forVoice = type === 'heading' && !SENTENCE_END.test(spoken) ? `${spoken}.` : spoken;
      b.chunks = tools.splitIntoChunks(forVoice);
      b.words = forVoice.split(' ').length;
    }
    if (extra.marker !== undefined) b.marker = extra.marker;
    if (type === 'li' && ctx.refMode) b.reference = true;
    out.push(b);
  }

  function emit(c) {
    if (c.type === 'code') {
      const minX = Math.min(...c.lines.map((l) => l.x0));
      const unit = Math.max(1, c.lines[0].size * 0.6);
      const text = c.lines.map((l) => ' '.repeat(Math.max(0, Math.round((l.x0 - minX) / unit))) + l.text).join('\n');
      out.push({ type: 'code', level: 0, text, speak: false, chunks: [], words: 0 });
      return;
    }
    let text = c.lines[0].text;
    for (let i = 1; i < c.lines.length; i += 1) text = joinLines(text, c.lines[i].text);
    if (c.type === 'heading') {
      const clean = tidy(text);
      ctx.refMode = REF_HEADING.test(clean);
      if (NON_ENTRY_HEADING.test(clean)) ctx.refMode = false;
      block('heading', clean, { level: c.level });
    } else if (c.type === 'li') block('li', text, { level: c.depth, marker: c.marker });
    else if (c.type === 'caption') { block('caption', text, { speak: false }); if (c.footnote && out.length) out[out.length - 1].footnote = true; }
    else if (ctx.refMode) block('li', text, { marker: '' });
    else block('p', text);
  }

  const centered = (l) => Math.abs((l.x0 + l.x1) / 2 - (colLeft + colRight) / 2) < colWidth * 0.06 && l.x1 - l.x0 < colWidth * 0.85;

  let previous = null;
  let eq = null;
  const flushEq = () => {
    if (!eq) return;
    const pad = 3;
    const rect = {
      x0: eq.x0 - pad, x1: eq.x1 + pad, y0: eq.y0 - pad, y1: eq.y1 + pad,
    };
    out.push(figureBlock(page, rect, 'Equation', 'equation', body));
    eq = null;
  };

  const lastY = () => (previous ? previous.y : null);

  for (const entry of sequence) {
    if (entry.type === 'region') {
      flush(); flushEq();
      out.push(figureBlock(page, entry.region, '', entry.region.kind, body));
      previous = null;
      continue;
    }
    const line = entry.line;
    const text = line.text;
    if (!text) continue;

    // Display equations: mostly math fonts, or centered with a good share of them.
    const numbered_eq = line.parts.some((q) => /\(\d{1,3}(?:\.\d+)?\)$/.test(q.text)) && line.math >= 0.2 && line.x0 - colLeft > 2 * line.size && line.chars < 140;
    const nearEq = eq && eq.last - line.y <= line.size * 2.6 && line.math >= 0.25;
    const isEq = line.math >= 0.6 || numbered_eq || nearEq || (line.math >= 0.3 && centered(line) && line.chars < 140);
    if (isEq && line.mono < 0.5) {
      flush();
      const top = line.y + line.size * 0.95;
      const bottom = line.y - line.size * 0.35;
      if (eq && eq.last - line.y <= line.size * 2.6) {
        eq.x0 = Math.min(eq.x0, line.x0); eq.x1 = Math.max(eq.x1, line.x1);
        eq.y1 = Math.max(eq.y1, top); eq.y0 = Math.min(eq.y0, bottom); eq.last = line.y;
      } else {
        flushEq();
        eq = { x0: line.x0, x1: line.x1, y0: bottom, y1: top, last: line.y };
      }
      previous = line;
      continue;
    }
    flushEq();

    const gap = previous ? previous.y - line.y : Infinity;
    const isCode = line.mono >= 0.8;
    const isCaption = CAPTION_START.test(text) || (CAPTION_LABEL_ONLY.test(text) && line.bold > 0.5);
    const small = line.size <= body * 0.86;
    const bigText = line.size >= body * 1.25 || (line.size >= body * 1.1 && line.bold > 0.5);
    const allBold = line.bold >= 0.85 && line.chars < 110 && !/[.!?]$/.test(text) && line.size >= body * 0.95;
    const numbered = /^(?:\d+(?:\.\d+){0,3}\.?|[A-Z]\.|[IVX]+\.)\s+\S/.test(text);
    const isHeading = !isCode && !isCaption && !small && (bigText || (allBold && (numbered || line.chars < 70)) || (line.size >= body * 1.0 && REF_HEADING.test(text) && line.chars < 30));
    const marker = !isHeading && !isCode && !isCaption ? LIST_MARKER.exec(text) : null;

    if (isCode) {
      if (cur?.type === 'code' && gap < line.size * (lead + 1.4)) cur.lines.push(line);
      else { flush(); cur = { type: 'code', lines: [line] }; }
    } else if (isHeading) {
      if (cur?.type === 'heading' && Math.abs(cur.size - line.size) < 0.6 && gap < line.size * (lead + 0.5)) cur.lines.push(line);
      else { flush(); cur = { type: 'heading', lines: [line], size: line.size, level: headingLevel(line.size, body) }; }
    } else if (isCaption || (cur?.type === 'caption' && (small || Math.abs(line.size - cur.size) < 0.6) && gap < line.size * (lead + 0.35) && !marker)) {
      if (isCaption || !cur || cur.type !== 'caption') { flush(); cur = { type: 'caption', lines: [line], size: line.size }; }
      else cur.lines.push(line);
    } else if (small && (line.y - ctx.pageBottom) < ctx.pageHeight * 0.35) {
      if (cur?.type === 'caption') cur.lines.push(line);
      else { flush(); cur = { type: 'caption', lines: [line], size: line.size, footnote: true }; }
    } else if (marker) {
      flush();
      const text2 = text.slice(marker[0].length);
      const ordered = Boolean(marker[2] || marker[3]);
      const depth = Math.max(0, Math.min(5, Math.round((line.x0 - colLeft) / (body * 1.6))));
      cur = { type: 'li', lines: [{ ...line, text: text2 }], marker: ordered ? (marker[2] || marker[3]) : '', depth, textX: line.x0 };
    } else if (cur?.type === 'li' && gap < line.size * (lead + 0.35) && line.x0 > cur.textX + 0.4 * line.size) {
      cur.lines.push(line);
    } else {
      const prev = cur?.type === 'p' ? cur.lines[cur.lines.length - 1] : null;
      let breaks = !prev;
      if (prev) {
        const prevEnded = SENTENCE_END.test(prev.text);
        const prevShort = prev.x1 < colRight - 2.5 * prev.size;
        const indent = line.x0 - colLeft > 0.9 * line.size && line.x0 - colLeft < 5 * line.size;
        breaks = gap > lead * Math.max(prev.size, line.size) * 1.32
          || (indent && (prevEnded || prevShort))
          || (prevShort && prevEnded && /^[A-Z0-9“"(\[]/.test(line.text))
          || Math.abs(line.size - prev.size) > prev.size * 0.12
          || (prev.bold >= 0.85) !== (line.bold >= 0.85)
          || centered(prev) || centered(line)
          || (ctx.refMode && line.x0 <= colLeft + 1 && (prevEnded || /^\[?\d+[\].)]/.test(line.text)));
      }
      if (breaks) { flush(); cur = { type: 'p', lines: [line] }; } else cur.lines.push(line);
    }
    previous = line;
    void lastY;
  }
  flush();
  flushEq();
  return out;
}

function figureBlock(page, rect, alt, kind, bodyPt) {
  return {
    type: 'image', level: 0, text: '', speak: false, chunks: [], words: 0, src: '', alt: alt || (kind === 'table' ? 'Table' : 'Figure'),
    pdf: {
      page: page.number, kind, bodyPt: round(bodyPt || 10),
      x0: round(rect.x0), y0: round(rect.y0), x1: round(rect.x1), y1: round(rect.y1),
      vx0: round(page.view[0]), vy1: round(page.view[3]),
    },
  };
}
const round = (n) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- whole document

function titleFromFirstPage(pages, body) {
  const first = pages.find((p) => p.pieces.some((x) => !x.margin));
  if (!first) return null;
  const pieces = first.pieces.filter((p) => !p.margin && p.y > first.view[1] + first.height * 0.45);
  const biggest = Math.max(0, ...pieces.map((p) => p.size));
  if (biggest < body * 1.25) return null;
  const picked = pieces.filter((p) => p.size >= biggest * 0.9).sort((a, b) => b.y - a.y || a.x0 - b.x0);
  for (const p of picked) p.title = true;
  const lines = [];
  for (const p of picked) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - p.y) < p.size * 0.5) last.t += ` ${p.text}`;
    else lines.push({ y: p.y, t: p.text });
  }
  return lines.map((l) => l.t).join(' ').replace(/\s+/g, ' ').trim();
}

/** Tables drawn without rules: consecutive rows whose cells line up in the same columns. */
function textTables(pieces, body) {
  const rows = [];
  for (const p of [...pieces].sort((a, b) => b.y - a.y || a.x0 - b.x0)) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - p.y) <= 0.4 * p.size) last.cells.push(p);
    else rows.push({ y: p.y, size: p.size, cells: [p] });
  }
  const aligned = (a, b) => a.cells.length === b.cells.length && a.cells.every((c, i) => Math.abs(c.x0 - b.cells[i].x0) <= 4 || Math.abs(c.x1 - b.cells[i].x1) <= 4);
  const tableRow = (r) => r.cells.length >= 3 && r.cells.every((c) => c.text.length <= 40) && r.cells.every((c) => !/[.!?]$/.test(c.text) || c.text.length < 12);
  const found = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (!tableRow(rows[i])) continue;
    let j = i;
    while (j + 1 < rows.length && tableRow(rows[j + 1]) && rows[j].y - rows[j + 1].y < rows[j].size * 2.6 && aligned(rows[i], rows[j + 1])) j += 1;
    if (j > i) {
      const cells = rows.slice(i, j + 1).flatMap((r) => r.cells);
      found.push({
        x0: Math.min(...cells.map((c) => c.x0)) - 3, x1: Math.max(...cells.map((c) => c.x1)) + 3,
        y0: rows[j].y - rows[j].size * 0.4, y1: rows[i].y + rows[i].size * 1.0, kind: 'table',
      });
      i = j;
    }
  }
  void body;
  return found;
}

/** Flags the pieces that belong to figure/table captions so a picture never swallows its own caption. */
function markCaptionPieces(pieces, body) {
  const starts = pieces.filter((p) => CAPTION_START.test(p.text) || CAPTION_LABEL_ONLY.test(p.text));
  for (const start of starts) {
    let y = start.y;
    let size = start.size;
    start.caption = true;
    for (const p of pieces) if (Math.abs(p.y - start.y) < 0.5 * Math.max(p.size, start.size)) p.caption = true;
    for (let guard = 0; guard < 8; guard += 1) { // continuation lines: same size, right below, same column
      const next = pieces.filter((p) => !p.caption && p.y < y && y - p.y < size * 1.7 && Math.abs(p.size - size) < 0.6 && p.x0 >= start.x0 - 8 && p.x0 <= start.x0 + 30);
      if (!next.length) break;
      y = Math.max(...next.map((p) => p.y));
      for (const p of pieces) if (Math.abs(p.y - y) < 0.5 * p.size && Math.abs(p.size - size) < 0.6) p.caption = true;
    }
  }
}

async function readPdf(pdfDoc, { pdfjs, title: fallbackTitle = '', tools, onProgress } = {}) {
  const OPS = pdfjs.OPS;
  const fontCache = new Map();
  const pages = [];
  for (let n = 1; n <= pdfDoc.numPages; n += 1) {
    if (onProgress && (n === 1 || n % 5 === 0 || n === pdfDoc.numPages)) onProgress(n, pdfDoc.numPages);
    const page = await pdfDoc.getPage(n);
    try {
      const analysis = await analyzePage(page, pdfjs, fontCache);
      analysis.number = n;
      pages.push(analysis);
    } finally {
      page.cleanup();
    }
  }

  const body = bodyFontSize(pages);
  markMargins(pages);
  const detectedTitle = titleFromFirstPage(pages, body);

  const blocks = [];
  const ctx = { body, tools, refMode: false };
  for (const page of pages) {
    const text = page.pieces.filter((p) => !p.margin && !p.title);
    let regions = [];
    if (!page.rotate) {
      regions = findRegions(page.opList, OPS, page.width, page.height, text, body)
        .map((r) => ({ ...r, x0: r.x0, x1: r.x1 }));
    }
    for (const t of textTables(text.filter((p) => !p.caption || p.text.length < 25), body)) {
      if (!regions.some((r) => overlapArea(r, t) > 0.3 * area(t))) regions.push(t);
    }
    // Take in axis labels, legends and other small text hugging each picture, then drop the text it covers.
    markCaptionPieces(text, body);
    for (const region of regions) {
      for (let pass = 0; pass < 3; pass += 1) {
        let grew = false;
        for (const p of text) {
          if (p.absorbed) continue;
          const box = { x0: p.x0, x1: p.x1, y0: p.y - p.size * 0.3, y1: p.y + p.size * 0.95 };
          if (CAPTION_START.test(p.text) || CAPTION_LABEL_ONLY.test(p.text)) continue;
          if (p.caption && !centerIn(p, region)) continue;
          const smallish = p.size <= body * 0.95 || (p.text.length <= 8 && /^[\d.,\-\u2212+%eE\s]+$/.test(p.text));
          const inside = centerIn(p, region);
          const close = near(box, region, 14);
          if (inside || (close && smallish && p.text.length <= 40 && !CAPTION_START.test(p.text))) {
            p.absorbed = true;
            if (!inside) { Object.assign(region, union(region, box)); grew = true; }
          }
        }
        if (!grew) break;
      }
    }
    const pageBlocks = [];
    const items = [
      ...text.filter((p) => !p.absorbed).map((p) => ({ ...p, kind: 'text' })),
      ...regions.map((r) => ({ ...r, kind: 'region', y: r.y1, regionKind: r.kind, size: 0 })),
    ];
    const cols = detectColumns(text.filter((p) => !p.absorbed), page.width, page.view[0]);
    const pageCtx = {
      ...ctx,
      page,
      pageBottom: page.view[1],
      pageHeight: page.height,
      get refMode() { return ctx.refMode; },
      set refMode(v) { ctx.refMode = v; },
    };
    for (const flow of orderFlows(items, cols)) {
      // regions carry their own kind in `kind`; blocksFromFlow wants it on the region itself
      for (const it of flow.items) if (it.kind === 'region') it.kind = 'region';
      const regionFlow = { ...flow, items: flow.items.map((i) => (i.kind === 'region' ? { ...i, kind: 'region', rkind: i.regionKind } : i)) };
      const made = blocksFromFlow({ ...regionFlow, items: regionFlow.items }, pageCtx);
      pageBlocks.push(...made);
    }
    // Footnotes belong after the page's text, not in the middle of a sentence.
    blocks.push(...pageBlocks.filter((b) => !b.footnote), ...pageBlocks.filter((b) => b.footnote));
  }

  // Paragraphs that run over a column or page break, even with a figure or footnote wedged in between.
  const merged = [];
  const passable = new Set(['image', 'caption']);
  for (const b of blocks) {
    let host = null;
    if (b.type === 'p' && /^[a-z\u00df-\u00ff(]/.test(b.text)) {
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        if (merged[i].type === 'p') { host = merged[i]; break; }
        if (!passable.has(merged[i].type)) break;
      }
    }
    if (host && (!SENTENCE_END.test(host.text) || /-$/.test(host.text))) {
      const text = joinLines(host.text, b.text);
      const spoken = spokenText(text);
      host.text = text;
      host.chunks = tools.splitIntoChunks(spoken);
      host.words = spoken.split(' ').length;
      host.speak = Boolean(spoken);
    } else {
      merged.push(b);
    }
  }

  const words = merged.reduce((n, b) => n + b.words, 0);
  const metaTitle = String(fallbackTitle || '').trim();
  const title = detectedTitle || metaTitle || 'PDF document';
  const titleBlock = { type: 'title', level: 0, text: title, speak: true, chunks: [], words: 0 };
  const spokenTitle = spokenText(title);
  titleBlock.chunks = tools.splitIntoChunks(SENTENCE_END.test(spokenTitle) ? spokenTitle : `${spokenTitle}.`);
  titleBlock.words = spokenTitle.split(' ').length;

  const all = [titleBlock, ...merged];
  const contentWords = all.slice(1).reduce((n, b) => n + b.words, 0);
  return {
    url: '', title, byline: '', siteName: '', blocks: all, contentWords,
    words: all.reduce((n, b) => n + b.words, 0),
    figures: all.filter((b) => b.type === 'image').length,
  };
}

module.exports = { readPdf };
