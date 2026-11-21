'use strict';
// Turns Markdown (your own text, or your notes) into the same blocks the reader uses for articles, so it is
// shown with real headings, lists and quotes and read aloud without the punctuation of the markup.

const { splitIntoChunks, cleanForSpeech } = require('./extract');

const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// [[key|Label]] / [[Title]], **bold**, __bold__, *em*, _em_, `code`, [text](url), ~~strike~~
const INLINE = /\[\[([^\]\n|]{1,120})(?:\|([^\]\n]{1,120}))?\]\]|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])|`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)/gu;

/** Display text of a wiki link: its label, or the title it was typed with. Keys (n-1234abcd) are never spoken. */
const wikiLabel = (target, label) => squash(label || target).replace(/^[na]-[0-9a-f]{6,12}(?:#\d+)?$/i, 'a linked note');

/** @returns {{ runs: object[], text: string }} inline runs for display and the plain text for speech */
function parseInline(source) {
  const runs = [];
  let plain = '';
  const re = new RegExp(INLINE.source, 'gu');
  let last = 0;
  let m;
  const text = (t) => { if (t) { runs.push({ text: t }); plain += t; } };
  const wrap = (tag, inner, extra = {}) => {
    const child = parseInline(inner);
    runs.push({ tag, ...extra, children: child.runs });
    plain += child.text;
  };
  while ((m = re.exec(source))) {
    text(source.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) text(wikiLabel(m[1], m[2]));
    else if (m[3] !== undefined || m[4] !== undefined) wrap('strong', m[3] ?? m[4]);
    else if (m[5] !== undefined) wrap('del', m[5]);
    else if (m[6] !== undefined || m[7] !== undefined) wrap('em', m[6] ?? m[7]);
    else if (m[8] !== undefined) { runs.push({ tag: 'code', children: [{ text: m[8] }] }); plain += m[8]; }
    else wrap('a', m[9], { href: m[10] });
  }
  text(source.slice(last));
  return { runs, text: plain };
}

function block(type, source, { level = 0, speak = true, marker = '' } = {}) {
  const parsed = parseInline(source);
  const text = squash(parsed.text);
  const out = { type, level, text, speak, chunks: [], words: 0 };
  if (marker) out.marker = marker;
  if (type !== 'code') out.inline = parsed.runs;
  if (speak) {
    const spoken = cleanForSpeech(text);
    if (!spoken) out.speak = false;
    else {
      const forVoice = type === 'heading' && !/[.!?:;…]$/.test(spoken) ? `${spoken}.` : spoken;
      out.chunks = splitIntoChunks(forVoice);
      out.words = forVoice.split(' ').length;
    }
  }
  return out;
}

/** Plain code blocks are shown but not read aloud. */
function codeBlock(source) {
  const out = { type: 'code', level: 0, text: source, speak: false, chunks: [], words: 0 };
  return out;
}

/** The first heading or line, without markup: a good title for a piece of Markdown. */
function titleFromMarkdown(markdown, fallback = 'Custom text') {
  for (const raw of String(markdown || '').split('\n')) {
    const line = raw.trim();
    if (!line || /^```/.test(line)) continue;
    const text = squash(parseInline(line.replace(/^(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s*)/, '')).text);
    if (!text) continue;
    if (text.length <= 64) return text.replace(/[.:;,]$/, '');
    const cut = text.slice(0, 64);
    return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 32))}…`;
  }
  return fallback;
}

/** Markdown → reader blocks (no title block). */
function markdownToBlocks(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  const isBlank = (l) => !l.trim();
  const fence = (l) => /^\s*(```|~~~)/.test(l);
  const heading = (l) => /^\s{0,3}#{1,6}\s+\S/.test(l);
  const bullet = (l) => /^\s*[-*+]\s+/.test(l);
  const numbered = (l) => /^\s*\d+[.)]\s+/.test(l);
  const quote = (l) => /^\s*>/.test(l);
  const rule = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const startsBlock = (l) => heading(l) || bullet(l) || numbered(l) || quote(l) || fence(l) || rule(l);
  const depthOf = (l) => Math.min(6, Math.floor(l.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length / 2));

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line) || rule(line)) { i += 1; continue; }

    if (fence(line)) {
      const marker = line.trim().slice(0, 3);
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) code.push(lines[i++]);
      i += 1;
      if (code.join('').trim()) blocks.push(codeBlock(code.join('\n')));
      continue;
    }
    if (heading(line)) {
      const level = line.trim().match(/^#+/)[0].length;
      blocks.push(block('heading', line.trim().replace(/^#+\s+/, '').replace(/\s+#+\s*$/, ''), { level: Math.min(4, Math.max(2, level + 1)) }));
      i += 1;
      continue;
    }
    if (bullet(line) || numbered(line)) {
      const counters = [];
      while (i < lines.length && (bullet(lines[i]) || numbered(lines[i]))) {
        const item = lines[i];
        const depth = depthOf(item);
        const isOrdered = numbered(item);
        counters.length = depth + 1;
        let marker = '';
        if (isOrdered) {
          counters[depth] = counters[depth] ? counters[depth] + 1 : Number(item.match(/^\s*(\d+)/)[1]);
          marker = `${counters[depth]}.`;
        } else counters[depth] = 0;
        let text = item.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) text = task[2];
        blocks.push(block('li', text, { level: depth, marker }));
        i += 1;
        // a wrapped continuation line belongs to the same item
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i]) && /^\s{2,}\S/.test(lines[i])) {
          const last = blocks[blocks.length - 1];
          const joined = block('li', `${last.text} ${lines[i].trim()}`, { level: last.level, marker: last.marker });
          blocks[blocks.length - 1] = joined;
          i += 1;
        }
      }
      continue;
    }
    if (quote(line)) {
      const quoted = [];
      while (i < lines.length && quote(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      const paragraphs = quoted.join('\n').split(/\n\s*\n/).map(squash).filter(Boolean);
      for (const p of paragraphs) blocks.push(block('quote', p));
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++].trim());
    blocks.push(block('p', para.join(' ')));
  }
  return blocks;
}

/** A whole reading made from Markdown. The title is the first line unless one is given. */
function markdownToArticle(markdown, title = '') {
  const heading = title || titleFromMarkdown(markdown);
  const body = markdownToBlocks(markdown);
  if (!body.length) throw new Error('Add some text to read.');
  // A leading "# Title" that is the title itself should not be read twice.
  if (!title && body[0].type === 'heading' && body[0].text.toLowerCase() === heading.toLowerCase()) body.shift();
  const titleBlock = block('title', heading);
  const blocks = [titleBlock, ...body];
  const contentWords = body.reduce((sum, b) => sum + b.words, 0);
  return { url: '', title: heading, byline: '', siteName: '', blocks, contentWords, words: blocks.reduce((sum, b) => sum + b.words, 0) };
}

/** Several notes read one after another: each note is a heading, then its quote and text. */
function notesToArticle(notes, title) {
  const blocks = [block('title', title)];
  for (const n of notes) {
    blocks.push(block('heading', n.heading || 'Untitled note', { level: 2 }));
    if (n.source) blocks.push(block('p', n.source));
    if (n.quote) blocks.push(block('quote', n.quote));
    blocks.push(...markdownToBlocks(n.body));
  }
  const contentWords = blocks.slice(1).reduce((sum, b) => sum + b.words, 0);
  if (!contentWords) throw new Error('These notes have nothing to read yet.');
  return { url: '', title, byline: '', siteName: '', blocks, contentWords, words: blocks.reduce((sum, b) => sum + b.words, 0) };
}

module.exports = { markdownToBlocks, markdownToArticle, notesToArticle, titleFromMarkdown, parseInline };
