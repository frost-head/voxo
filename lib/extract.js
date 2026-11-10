'use strict';
// Turns raw HTML into reader blocks. Speech blocks contain plain text chunks;
// visual image blocks contain validated URLs, never page-supplied HTML.

const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,figcaption,dt,dd,img';
const MAX_CHUNK_CHARS = 320; // keeps time-to-first-audio short for long paragraphs

const squash = (s) => s.replace(/\s+/g, ' ').trim();

function externalImageUrl(raw, baseUrl) {
  if (!raw) return null;
  try {
    const url = new URL(raw.trim(), baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function cleanImageSrcSet(raw, baseUrl) {
  if (!raw) return '';
  return raw.split(',').map((candidate) => {
    const match = candidate.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?[wx]))?$/i);
    if (!match) return null;
    const url = externalImageUrl(match[1], baseUrl);
    return url ? `${url}${match[2] ? ` ${match[2]}` : ''}` : null;
  }).filter(Boolean).join(', ');
}

function collectInline(node) {
  const output = [];
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = child.textContent.replace(/\s+/g, ' ');
      if (text) output.push({ text });
      continue;
    }
    if (child.nodeType !== 1) continue;

    const tag = child.tagName.toLowerCase();
    if (tag === 'img' || tag === 'script' || tag === 'style') continue;
    if (tag === 'br') { output.push({ tag: 'br' }); continue; }

    const children = collectInline(child);
    if (!children.length) continue;
    if (tag === 'a') output.push({ tag: 'span', className: 'inline-link', children });
    else if (['strong', 'b', 'em', 'i', 'mark', 'code', 'kbd', 'sup', 'sub', 'del', 'ins', 'small', 'abbr'].includes(tag)) {
      output.push({ tag: tag === 'b' ? 'strong' : tag === 'i' ? 'em' : tag, children });
    } else output.push(...children);
  }
  return output;
}

/** Text as it should be spoken: no footnote markers, no raw URLs. */
function cleanForSpeech(text) {
  return squash(
    text
      .replace(/\[\d{1,3}\]/g, '')
      .replace(/https?:\/\/\S+/g, 'link')
  );
}

/** Split text into sentence-aligned chunks of at most ~max characters. */
function splitIntoChunks(text, max = MAX_CHUNK_CHARS) {
  const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
  const sentences = [...segmenter.segment(text)].map((s) => s.segment.trim()).filter(Boolean);

  const pieces = [];
  for (const sentence of sentences) {
    if (sentence.length <= max) {
      pieces.push(sentence);
      continue;
    }
    // A very long sentence: break it on word boundaries.
    let current = '';
    for (const word of sentence.split(' ')) {
      if (current && current.length + word.length + 1 > max) {
        pieces.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) pieces.push(current);
  }

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 1 > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function ensureEndPunctuation(text) {
  return /[.!?:;…"')”’]$/.test(text) ? text : `${text}.`;
}

function makeBlock(type, text, { speak = true, level = 0 } = {}) {
  const block = { type, level, text, speak, chunks: [], words: 0 };
  if (speak) {
    const spoken = cleanForSpeech(text);
    if (!spoken) {
      block.speak = false;
    } else {
      const forVoice = type === 'heading' || type === 'title' ? ensureEndPunctuation(spoken) : spoken;
      block.chunks = splitIntoChunks(forVoice);
      block.words = forVoice.split(' ').length;
    }
  }
  return block;
}

function textToArticle(input, title = 'Custom text') {
  const paragraphs = String(input || '').split(/\n\s*\n/).map(squash).filter(Boolean);
  if (!paragraphs.length) throw new Error('Add some text to read.');
  const blocks = [makeBlock('title', title), ...paragraphs.map((text) => makeBlock('p', text))];
  return { url: '', title, byline: '', siteName: '', blocks, words: blocks.reduce((sum, block) => sum + block.words, 0) };
}

function segmentsToArticle(segments, title) {
  const blocks = [makeBlock('title', title)];
  for (const segment of segments) {
    const text = String(segment.text || '').trim();
    if (!text) continue;
    if (segment.type === 'code') blocks.push(makeBlock('code', text, { speak: false }));
    else blocks.push(makeBlock('p', squash(text)));
  }
  const contentWords = blocks.slice(1).reduce((sum, block) => sum + block.words, 0);
  return { url: '', title, byline: '', siteName: '', blocks, contentWords, words: blocks.reduce((sum, block) => sum + block.words, 0) };
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SITE_SEPARATOR = /^\s+[|–—·»-]\s+/; // "Headline | Site", spaces required

/** Page titles often end with the site name ("Story | Example News"). Prefer the plain headline. */
function cleanTitle(title, headlines, siteName) {
  const lower = title.toLowerCase();
  const headline = headlines.find(
    (h) => h.length >= 6 && h.length < title.length && lower.startsWith(h.toLowerCase()) && SITE_SEPARATOR.test(title.slice(h.length))
  );
  if (headline) return headline;
  if (siteName) {
    const stripped = title.replace(new RegExp(`\\s+[|–—·»-]\\s+${escapeRegExp(siteName)}\\s*$`, 'i'), '').trim();
    if (stripped.length >= 6) return stripped;
  }
  return title;
}

/**
 * Extract the main article from an HTML string.
 * Returns null when no article can be found.
 */
function extractArticle(html, url) {
  const quiet = new VirtualConsole(); // jsdom prints CSS parse errors otherwise
  let dom;
  try {
    dom = new JSDOM(html, { url, virtualConsole: quiet }); // scripts are NOT run
  } catch {
    return null;
  }

  // Read the page's own headlines first; Readability removes the one that repeats the title.
  const headlines = [...dom.window.document.querySelectorAll('h1')].map((h) => squash(h.textContent || ''));
  const parsed = new Readability(dom.window.document).parse();
  if (!parsed || !parsed.content) return null;

  const body = new JSDOM(parsed.content, { virtualConsole: quiet }).window.document;
  const title = cleanTitle(squash(parsed.title || dom.window.document.title || ''), headlines, squash(parsed.siteName || ''));

  const blocks = [];
  if (title) blocks.push(makeBlock('title', title));

  for (const el of body.querySelectorAll(BLOCK_SELECTOR)) {
    const tag = el.tagName.toLowerCase();

    if (tag === 'blockquote') {
      if (el.parentElement?.closest('blockquote')) continue;
      const quote = el.cloneNode(true);
      quote.querySelectorAll('img,pre,ul,ol').forEach((child) => child.remove());
      const paragraphs = [...quote.querySelectorAll('p')].map((p) => squash(p.textContent || '')).filter(Boolean);
      const text = paragraphs.length ? paragraphs.join('\n') : squash(quote.textContent || '');
      if (text) {
        const block = makeBlock('quote', text);
        block.inline = paragraphs.length
          ? [...quote.querySelectorAll('p')].map((p) => ({ tag: 'p', children: collectInline(p) }))
          : collectInline(quote);
        blocks.push(block);
      }
      continue;
    }
    if (tag !== 'img' && el.parentElement?.closest('blockquote')) continue;

    if (tag === 'li') {
      const item = el.cloneNode(true);
      item.querySelectorAll('ul,ol,img').forEach((child) => child.remove());
      const text = squash(item.textContent || '');
      if (!text) continue;

      const list = el.parentElement?.matches('ol,ul') ? el.parentElement : null;
      const ordered = list?.tagName.toLowerCase() === 'ol';
      const siblings = list ? [...list.children].filter((child) => child.tagName === 'LI') : [el];
      const siblingIndex = Math.max(0, siblings.indexOf(el));
      const start = Number(list?.getAttribute('start')) || 1;
      const markerValue = Number(el.getAttribute('value')) || start + siblingIndex;
      let depth = 0;
      for (let parent = list?.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === 'LI') depth += 1;
      }

      const block = makeBlock('li', text, { level: depth });
      block.marker = ordered ? `${markerValue}.` : '';
      block.inline = collectInline(item);
      blocks.push(block);
      continue;
    }
    if (el.parentElement?.closest('li')) continue;

    // Keep paragraph text around inline images, but skip higher-level wrappers.
    if ([...el.querySelectorAll(BLOCK_SELECTOR)].some((child) => child.tagName !== 'IMG')) continue;

    if (tag === 'img') {
      const srcSet = cleanImageSrcSet(
        el.getAttribute('data-srcset') || el.getAttribute('data-lazy-srcset') || el.getAttribute('srcset'),
        url,
      );
      const imageUrl = [
        el.getAttribute('data-src'),
        el.getAttribute('data-original'),
        el.getAttribute('data-lazy-src'),
        el.getAttribute('src'),
      ].map((candidate) => externalImageUrl(candidate, url)).find(Boolean)
        || (srcSet ? srcSet.split(',')[0].trim().split(/\s+/)[0] : null);
      if (imageUrl) {
        const image = makeBlock('image', '', { speak: false });
        image.src = imageUrl;
        if (srcSet) image.srcSet = srcSet;
        image.alt = squash(el.getAttribute('alt') || '');
        blocks.push(image);
      }
      continue;
    }

    if (tag === 'pre') {
      const code = (el.textContent || '').replace(/\s+$/, '');
      if (code.trim()) blocks.push(makeBlock('code', code, { speak: false }));
      continue;
    }

    const textEl = el.cloneNode(true);
    textEl.querySelectorAll('img').forEach((img) => img.remove());
    const text = squash(textEl.textContent || '');
    if (!text) continue;

    if (/^h[1-6]$/.test(tag)) {
      // Readability usually repeats the page title as the first heading.
      if (blocks.length === 1 && text.toLowerCase() === title.toLowerCase()) continue;
      const block = makeBlock('heading', text, { level: Number(tag[1]) });
      block.inline = collectInline(textEl);
      blocks.push(block);
    } else if (tag === 'dt' || tag === 'dd') {
      blocks.push(makeBlock('li', text));
    } else if (tag === 'figcaption') {
      const block = makeBlock('caption', text, { speak: false });
      block.inline = collectInline(textEl);
      blocks.push(block);
    } else {
      const block = makeBlock('p', text);
      block.inline = collectInline(textEl);
      blocks.push(block);
    }
  }

  const words = blocks.reduce((sum, b) => sum + b.words, 0);
  return {
    url,
    title,
    byline: squash(parsed.byline || ''),
    siteName: squash(parsed.siteName || ''),
    blocks,
    words,
  };
}

module.exports = { extractArticle, splitIntoChunks, cleanForSpeech, textToArticle, segmentsToArticle, MAX_CHUNK_CHARS };
