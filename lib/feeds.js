'use strict';

// A tiny RSS/Atom reader for the home-screen discovery feed. No dependencies: feeds are small and regular enough
// that a few careful regular expressions are plenty, and it keeps the app's attack surface (and install size) down.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decode(text) {
  return String(text || '')
    .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function unwrap(raw) {
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return cdata ? cdata[1] : decode(raw);
}

function tag(block, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? unwrap(m[1]).trim() : '';
}

const stripHtml = (html) => decode(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function linkOf(block) {
  const atom = /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i.exec(block) || /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  if (atom) return decode(atom[1]);
  return tag(block, 'link') || tag(block, 'guid');
}

function imageOf(block, html) {
  const media = /<media:(?:thumbnail|content)\b[^>]*\burl=["']([^"']+)["']/i.exec(block);
  if (media) return decode(media[1]);
  const enclosure = /<enclosure\b[^>]*\btype=["']image[^"']*["'][^>]*\burl=["']([^"']+)["']/i.exec(block) || /<enclosure\b[^>]*\burl=["']([^"']+\.(?:jpe?g|png|webp))["']/i.exec(block);
  if (enclosure) return decode(enclosure[1]);
  const img = /<img\b[^>]*\bsrc=["']([^"']+)["']/i.exec(html);
  return img ? decode(img[1]) : '';
}

/** @returns {{ title: string, items: object[] }} */
function parseFeed(xml, fallbackSource = '') {
  const head = xml.split(/<(?:item|entry)[\s>]/i)[0];
  const source = stripHtml(tag(head, 'title')) || fallbackSource;
  const blocks = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  const items = [];
  for (const block of blocks.slice(0, 25)) {
    const title = stripHtml(tag(block, 'title'));
    const link = linkOf(block);
    if (!title || !/^https?:\/\//i.test(link)) continue;
    const fullHtml = tag(block, 'content:encoded') || tag(block, 'content');
    const summaryHtml = tag(block, 'description') || tag(block, 'summary') || fullHtml;
    const summary = stripHtml(summaryHtml);
    const fullText = fullHtml ? stripHtml(fullHtml) : '';
    const words = fullText ? fullText.split(/\s+/).length : 0;
    const published = Date.parse(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date')) || 0;
    items.push({
      title,
      link,
      source,
      summary: summary.length > 220 ? `${summary.slice(0, 217).replace(/\s+\S*$/, '')}…` : summary,
      minutes: words >= 120 ? Math.max(1, Math.round(words / 230)) : null, // only when the feed carries the whole article
      published,
      image: imageOf(block, summaryHtml + fullHtml),
    });
  }
  return { title: source, items };
}

async function fetchOne(url, { timeoutMs = 12000, userAgent } = {}) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Feeds must be web addresses.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': userAgent || 'voxo', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > 5 * 1024 * 1024) throw new Error('Feed too large.');
    if (!/<(rss|feed|rdf:RDF)\b/i.test(text.slice(0, 2000))) throw new Error('Not a feed.');
    return parseFeed(text, new URL(url).hostname.replace(/^www\./, ''));
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch several feeds in parallel; one failing never blocks the rest. */
async function fetchFeeds(urls, options) {
  const unique = [...new Set((urls || []).filter((u) => typeof u === 'string'))].slice(0, 12);
  const results = await Promise.allSettled(unique.map((u) => fetchOne(u, options)));
  const items = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') items.push(...r.value.items.map((item) => ({ ...item, feed: unique[i] })));
    else errors.push({ url: unique[i], error: r.reason?.message || String(r.reason) });
  });
  const seen = new Set();
  const deduped = items.filter((item) => (seen.has(item.link) ? false : seen.add(item.link)));
  return { items: deduped, errors };
}

module.exports = { parseFeed, fetchFeeds, fetchOne };
