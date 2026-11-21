// Small, safe Markdown renderer. It builds DOM nodes directly (never innerHTML), so
// note text can contain anything without being able to inject markup or script.

// [[Wiki links]] and #tags are recognised first; the rest is classic inline Markdown.
const INLINE_SOURCE = /(\[\[([^\]\n|]{1,120})(?:\|([^\]\n]{1,120}))?\]\]|(?<![\p{L}\p{N}&/#_-])#([\p{L}][\p{L}\p{N}_-]{1,30})|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|~~([^~\n]+)~~)/gu;

// The app registers what a click on a link or tag should do, and how to tell whether a link points at something real.
const handlers = { wikilink: null, tag: null, resolve: null };
export function setLinkHandlers(next) { Object.assign(handlers, next); }

const KEYED = /^([na])-([0-9a-f]{6,16})(?:#(\d{1,6}))?$/i;

/** [[n-3f2a91bc04d1|Name]] holds a key; [[Some title]] is an older link written by name. */
export function parseWikiTarget(target) {
  const m = KEYED.exec(String(target || '').trim());
  if (!m) return { key: null, name: String(target || '').trim() };
  return { key: m[2].toLowerCase(), type: m[1].toLowerCase() === 'a' ? 'article' : 'note', blockIndex: m[3] ? Number(m[3]) : null, name: '' };
}

/** Every [[target]] in a piece of text, in order, de-duplicated. */
export function extractWikiLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\[\[([^\]\n|]{1,120})(?:\|[^\]\n]{1,120})?\]\]/g)) {
    const target = m[1].trim();
    if (target && !out.some((t) => t.toLowerCase() === target.toLowerCase())) out.push(target);
  }
  return out;
}

/** Rewrites links written by name ([[Title]]) into key links, wherever the app can tell what they point at. */
export function upgradeWikiLinks(text, resolve) {
  let changed = false;
  const next = String(text || '').replace(/\[\[([^\]\n|]{1,120})(?:\|([^\]\n]{1,120}))?\]\]/g, (whole, target, label) => {
    if (parseWikiTarget(target).key) return whole;
    const hit = resolve(target.trim());
    if (!hit || hit.type === 'tag' || !hit.token) return whole;
    changed = true;
    return `[[${hit.token.split('|')[0]}|${(label || hit.label).trim()}]]`;
  });
  return { text: next, changed };
}

export function renderInline(text, parent) {
  // A fresh regex per call: nested calls (bold inside a link, etc.) must not share lastIndex.
  const INLINE = new RegExp(INLINE_SOURCE.source, 'gu');
  let last = 0;
  let match;
  while ((match = INLINE.exec(text))) {
    if (match.index > last) parent.append(text.slice(last, match.index));
    let el;
    if (match[2] !== undefined) {
      const target = match[2].trim();
      const stored = (match[3] || '').trim();
      const hit = handlers.resolve ? handlers.resolve(target) : undefined; // an object, or null when it points at nothing
      el = document.createElement('a');
      el.href = '#';
      el.className = 'wikilink';
      el.dataset.target = target;
      // The name shown is the CURRENT title of what the link points at, so a rename is reflected everywhere.
      el.textContent = (parseWikiTarget(target).key && hit?.label) || stored || (parseWikiTarget(target).key ? 'Missing note' : target);
      el.title = `Open “${el.textContent}”`;
      if (handlers.resolve && !hit) {
        el.classList.add('is-missing');
        el.title = parseWikiTarget(target).key ? 'This note or reading was deleted.' : `“${target}” does not exist yet. Click to create it.`;
      }
      el.addEventListener('click', (event) => { event.preventDefault(); handlers.wikilink?.(target, stored); });
    } else if (match[4] !== undefined) {
      const tagName = match[4].toLowerCase(); // captured now: `match` changes on the next loop
      el = document.createElement('a');
      el.href = '#';
      el.className = 'hashtag';
      el.dataset.tag = tagName;
      el.textContent = `#${match[4]}`;
      el.title = `Everything about #${tagName}`;
      el.addEventListener('click', (event) => { event.preventDefault(); handlers.tag?.(tagName); });
    } else if (match[5] !== undefined || match[6] !== undefined) {
      el = document.createElement('strong');
      renderInline(match[5] ?? match[6], el);
    } else if (match[7] !== undefined || match[8] !== undefined) {
      el = document.createElement('em');
      renderInline(match[7] ?? match[8], el);
    } else if (match[9] !== undefined) {
      el = document.createElement('code');
      el.textContent = match[9];
    } else if (match[12] !== undefined) {
      el = document.createElement('del');
      renderInline(match[12], el);
    } else {
      el = document.createElement('a');
      el.href = match[11];
      el.target = '_blank';
      el.rel = 'noopener noreferrer';
      el.className = 'inline-link';
      renderInline(match[10], el);
    }
    parent.append(el);
    last = INLINE.lastIndex;
  }
  if (last < text.length) parent.append(text.slice(last));
}

/** @returns {DocumentFragment} */
export function renderMarkdown(source, { onToggleTask = null } = {}) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const isBlank = (l) => !l.trim();
  const isBullet = (l) => /^\s*[-*+]\s+/.test(l);
  const isNumbered = (l) => /^\s*\d+[.)]\s+/.test(l);
  const isQuote = (l) => /^\s*>/.test(l);
  const isHeading = (l) => /^#{1,4}\s+/.test(l);
  const isFence = (l) => /^```/.test(l.trim());
  const isRule = (l) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(l);
  const startsBlock = (l) => isBullet(l) || isNumbered(l) || isQuote(l) || isHeading(l) || isFence(l) || isRule(l);
  const depthOf = (l) => Math.min(6, Math.floor(l.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length / 2));

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }
    if (isRule(line) && !isBullet(line)) { fragment.append(document.createElement('hr')); i += 1; continue; }

    if (isFence(line)) {
      const code = [];
      i += 1;
      while (i < lines.length && !isFence(lines[i])) code.push(lines[i++]);
      i += 1;
      const pre = document.createElement('pre');
      pre.textContent = code.join('\n');
      fragment.append(pre);
      continue;
    }

    if (isHeading(line)) {
      const level = Math.min(4, line.match(/^#+/)[0].length) + 2; // render as h3–h6 inside notes
      const h = document.createElement(`h${Math.min(level, 6)}`);
      renderInline(line.replace(/^#+\s+/, '').trim(), h);
      fragment.append(h);
      i += 1;
      continue;
    }

    if (isBullet(line) || isNumbered(line)) {
      const ordered = isNumbered(line);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? isNumbered(lines[i]) : isBullet(lines[i]))) {
        const li = document.createElement('li');
        const lineNo = i;
        const depth = depthOf(lines[i]);
        if (depth) li.style.setProperty('margin-left', `${depth * 1.1}rem`);
        let text = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, '');
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.disabled = !onToggleTask;
          box.checked = task[1].toLowerCase() === 'x';
          if (onToggleTask) box.addEventListener('change', () => onToggleTask(lineNo, box.checked));
          li.append(box, ' ');
          text = task[2];
          li.className = 'task';
        }
        renderInline(text, li);
        list.append(li);
        i += 1;
      }
      fragment.append(list);
      continue;
    }

    if (isQuote(line)) {
      const quoted = [];
      while (i < lines.length && isQuote(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      const bq = document.createElement('blockquote');
      bq.append(renderMarkdown(quoted.join('\n')));
      fragment.append(bq);
      continue;
    }

    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++]);
    const p = document.createElement('p');
    para.forEach((text, index) => {
      if (index) p.append(document.createElement('br'));
      renderInline(text, p);
    });
    fragment.append(p);
  }
  return fragment;
}
