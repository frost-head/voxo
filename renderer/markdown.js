// Small, safe Markdown renderer. It builds DOM nodes directly (never innerHTML), so
// note text can contain anything without being able to inject markup or script.

// [[Wiki links]] and #tags are recognised first; the rest is classic inline Markdown.
const INLINE_SOURCE = /(\[\[([^\]\n|]{1,120})(?:\|([^\]\n]{1,120}))?\]\]|(?<![\p{L}\p{N}&/#_-])#([\p{L}][\p{L}\p{N}_-]{1,30})|\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\))/gu;

// The app registers what a click on a link or tag should do, and how to tell whether a link points at something real.
const handlers = { wikilink: null, tag: null, resolve: null };
export function setLinkHandlers(next) { Object.assign(handlers, next); }

/** Every [[target]] in a piece of text, in order, de-duplicated. */
export function extractWikiLinks(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\[\[([^\]\n|]{1,120})(?:\|[^\]\n]{1,120})?\]\]/g)) {
    const target = m[1].trim();
    if (target && !out.some((t) => t.toLowerCase() === target.toLowerCase())) out.push(target);
  }
  return out;
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
      el = document.createElement('a');
      el.href = '#';
      el.className = 'wikilink';
      el.dataset.target = target;
      el.textContent = (match[3] || target).trim();
      el.title = `Open “${target}”`;
      if (handlers.resolve && !handlers.resolve(target)) { el.classList.add('is-missing'); el.title = `“${target}” does not exist yet. Click to create it.`; }
      el.addEventListener('click', (event) => { event.preventDefault(); handlers.wikilink?.(target); });
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
export function renderMarkdown(source) {
  const fragment = document.createDocumentFragment();
  const lines = String(source || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;

  const isBlank = (l) => !l.trim();
  const isBullet = (l) => /^\s*[-*+]\s+/.test(l);
  const isNumbered = (l) => /^\s*\d+[.)]\s+/.test(l);
  const isQuote = (l) => /^\s*>/.test(l);
  const isHeading = (l) => /^#{1,4}\s+/.test(l);
  const isFence = (l) => /^```/.test(l.trim());
  const startsBlock = (l) => isBullet(l) || isNumbered(l) || isQuote(l) || isHeading(l) || isFence(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i += 1; continue; }

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
        let text = lines[i].replace(ordered ? /^\s*\d+[.)]\s+/ : /^\s*[-*+]\s+/, '');
        const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
        if (task) {
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.disabled = true;
          box.checked = task[1].toLowerCase() === 'x';
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
