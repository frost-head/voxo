// A Markdown editor around a plain <textarea>: a formatting toolbar, shortcuts, smart lists, and a live preview
// (write / split / preview). The textarea stays the source of truth, so every other part of the app keeps working with it.
import { renderMarkdown } from './markdown.js';
import { icon } from './icons.js';

const ACTIONS = [
  { id: 'h', icon: 'heading', label: 'Heading', hint: 'Ctrl/⌘ Alt 1' },
  { id: 'bold', icon: 'bold', label: 'Bold', hint: 'Ctrl/⌘ B' },
  { id: 'italic', icon: 'italic', label: 'Italic', hint: 'Ctrl/⌘ I' },
  { id: 'code', icon: 'code', label: 'Code', hint: 'Ctrl/⌘ E' },
  { sep: true },
  { id: 'ul', icon: 'list', label: 'Bulleted list' },
  { id: 'ol', icon: 'list-ordered', label: 'Numbered list' },
  { id: 'task', icon: 'check-square', label: 'Checklist' },
  { id: 'quote', icon: 'quote', label: 'Quote' },
  { sep: true },
  { id: 'link', icon: 'link', label: 'Link', hint: 'Ctrl/⌘ K' },
  { id: 'wiki', icon: 'network', label: 'Link to a note or reading', hint: 'type [[' },
];

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])(\s+)(\[[ xX]\]\s+)?/;

export function createMarkdownEditor({ textarea, preview, toolbar = null, modeButtons = null, container = null, onChange = () => {}, onLinkKey = null }) {
  let mode = 'write';

  // ---------------------------------------------------------------- editing helpers

  const value = () => textarea.value;
  function replaceRange(start, end, text, selStart = start + text.length, selEnd = selStart) {
    textarea.focus();
    textarea.setSelectionRange(start, end);
    // execCommand keeps the browser's own undo stack working; fall back to a plain assignment where it is unavailable.
    if (!document.execCommand('insertText', false, text)) {
      textarea.setRangeText(text, start, end, 'end');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    textarea.setSelectionRange(selStart, selEnd);
  }
  const lineBounds = (pos) => {
    const v = value();
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos);
    if (end < 0) end = v.length;
    return { start, end };
  };
  function selectedLines() {
    const a = lineBounds(textarea.selectionStart).start;
    const b = lineBounds(Math.max(textarea.selectionStart, textarea.selectionEnd - (textarea.selectionEnd > textarea.selectionStart && value()[textarea.selectionEnd - 1] === '\n' ? 1 : 0))).end;
    return { start: a, end: b, text: value().slice(a, b) };
  }

  /** Wrap the selection (or the word at the caret) in a marker such as ** or `. Pressing it again removes it. */
  function wrap(before, after = before, placeholder = 'text') {
    let { selectionStart: s, selectionEnd: e } = textarea;
    const v = value();
    if (s === e) {
      const word = /[\p{L}\p{N}_]/u;
      while (s > 0 && word.test(v[s - 1])) s -= 1;
      while (e < v.length && word.test(v[e])) e += 1;
    }
    const inner = v.slice(s, e);
    if (v.slice(s - before.length, s) === before && v.slice(e, e + after.length) === after) {
      replaceRange(s - before.length, e + after.length, inner, s - before.length, s - before.length + inner.length);
      return;
    }
    const text = inner || placeholder;
    replaceRange(s, e, `${before}${text}${after}`, s + before.length, s + before.length + text.length);
  }

  /** Toggle a line prefix (like "- " or "> ") on every selected line. */
  function prefixLines(make, test) {
    const { start, end, text } = selectedLines();
    const lines = text.split('\n');
    const all = lines.every((l) => !l.trim() || test(l));
    let n = 0;
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      n += 1;
      return all ? l.replace(test.strip, '') : make(l.replace(LIST_LINE, '$1').replace(/^(\s*)(?:#{1,6}\s+|>\s?)/, '$1'), n);
    }).join('\n');
    replaceRange(start, end, next, start, start + next.length);
  }
  const strip = (re) => Object.assign((l) => re.test(l), { strip: re });

  function heading() {
    const { start, end } = lineBounds(textarea.selectionStart);
    const line = value().slice(start, end);
    const m = /^(#{1,4})\s+/.exec(line);
    const level = m ? (m[1].length % 4) + 1 : 1; // cycles # → ## → ### → ####
    const body = line.replace(/^#{1,6}\s+/, '');
    replaceRange(start, end, `${'#'.repeat(level)} ${body}`);
  }

  function link() {
    const { selectionStart: s, selectionEnd: e } = textarea;
    const inner = value().slice(s, e);
    if (/^https?:\/\//i.test(inner)) { replaceRange(s, e, `[link](${inner})`, s + 1, s + 5); return; }
    const text = inner || 'link text';
    const url = 'https://';
    replaceRange(s, e, `[${text}](${url})`, s + text.length + 3, s + text.length + 3 + url.length);
  }

  function wiki() {
    const { selectionStart: s, selectionEnd: e } = textarea;
    replaceRange(s, e, '[[', s + 2); // the app's [[ autocomplete takes it from here
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function run(id) {
    switch (id) {
      case 'h': heading(); break;
      case 'bold': wrap('**'); break;
      case 'italic': wrap('*'); break;
      case 'code': {
        const sel = value().slice(textarea.selectionStart, textarea.selectionEnd);
        if (sel.includes('\n')) replaceRange(textarea.selectionStart, textarea.selectionEnd, `\`\`\`\n${sel}\n\`\`\``);
        else wrap('`');
        break;
      }
      case 'ul': prefixLines((l) => `- ${l.trimStart()}`, strip(/^\s*[-*+]\s+(?!\[[ xX]\])/)); break;
      case 'ol': prefixLines((l, n) => `${n}. ${l.trimStart()}`, strip(/^\s*\d+[.)]\s+/)); break;
      case 'task': prefixLines((l) => `- [ ] ${l.trimStart()}`, strip(/^\s*[-*+]\s+\[[ xX]\]\s+/)); break;
      case 'quote': prefixLines((l) => `> ${l.trimStart()}`, strip(/^\s*>\s?/)); break;
      case 'link': link(); break;
      case 'wiki': wiki(); break;
      default: break;
    }
    refreshPreview();
  }

  // ---------------------------------------------------------------- keyboard

  textarea.addEventListener('keydown', (event) => {
    if (event.isComposing) return;
    const mod = event.ctrlKey || event.metaKey;
    if (mod && !event.shiftKey && !event.altKey) {
      const k = event.key.toLowerCase();
      const map = { b: 'bold', i: 'italic', e: 'code', k: 'link' };
      if (map[k]) { event.preventDefault(); run(map[k]); return; }
    }
    if (mod && event.altKey && event.key === '1') { event.preventDefault(); run('h'); return; }

    if (event.key === 'Tab' && !mod) {
      const { start, end, text } = selectedLines();
      const onList = LIST_LINE.test(text.split('\n')[0]);
      if (onList || textarea.selectionStart !== textarea.selectionEnd) {
        event.preventDefault();
        const next = text.split('\n').map((l) => (event.shiftKey ? l.replace(/^(?: {1,2}|\t)/, '') : `  ${l}`)).join('\n');
        replaceRange(start, end, next, start, start + next.length);
        refreshPreview();
      } else if (!event.shiftKey) {
        event.preventDefault();
        replaceRange(textarea.selectionStart, textarea.selectionEnd, '  ');
      }
      return;
    }

    if (event.key === 'Enter' && !event.shiftKey && !mod && !event.altKey && textarea.selectionStart === textarea.selectionEnd) {
      const pos = textarea.selectionStart;
      const { start, end } = lineBounds(pos);
      const line = value().slice(start, end);
      const quote = /^(\s*>\s?)(.*)$/.exec(line);
      const item = LIST_LINE.exec(line);
      if (item && pos >= start + item[0].length) {
        event.preventDefault();
        const rest = line.slice(item[0].length);
        if (!rest.trim()) { replaceRange(start, end, '', start); return refreshPreview(); } // Enter on an empty item ends the list
        const numbered = /\d/.test(item[2]);
        const marker = numbered ? `${parseInt(item[2], 10) + 1}${item[2].slice(-1)}` : item[2];
        replaceRange(pos, pos, `\n${item[1]}${marker}${item[3]}${item[4] ? '[ ] ' : ''}`);
        refreshPreview();
      } else if (quote && pos >= start + quote[1].length) {
        event.preventDefault();
        if (!quote[2].trim()) { replaceRange(start, end, '', start); return refreshPreview(); }
        replaceRange(pos, pos, `\n${quote[1]}`);
        refreshPreview();
      }
    }
  });

  // ---------------------------------------------------------------- preview and modes

  const toggleTask = (lineNo, checked) => {
    const lines = value().split('\n');
    if (lineNo >= lines.length) return;
    lines[lineNo] = lines[lineNo].replace(/\[( |x|X)\]/, checked ? '[x]' : '[ ]');
    textarea.value = lines.join('\n');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  };

  function refreshPreview() {
    if (mode === 'write') return;
    const text = value();
    const empty = Object.assign(document.createElement('p'), { className: 'md-empty', textContent: 'Nothing to preview yet.' });
    preview.replaceChildren(text.trim() ? renderMarkdown(text, { onToggleTask: toggleTask }) : empty);
  }
  let timer = null;
  textarea.addEventListener('input', () => {
    onChange();
    if (mode === 'write') return;
    clearTimeout(timer);
    timer = setTimeout(refreshPreview, 120);
  });

  function setMode(next) {
    mode = next;
    textarea.hidden = next === 'preview';
    preview.hidden = next === 'write';
    container?.setAttribute('data-mode', next);
    for (const [name, button] of Object.entries(modeButtons || {})) button.setAttribute('aria-selected', String(name === next));
    refreshPreview();
  }
  for (const [name, button] of Object.entries(modeButtons || {})) button.addEventListener('click', () => setMode(name));

  // ---------------------------------------------------------------- toolbar

  if (toolbar) {
    toolbar.replaceChildren(...ACTIONS.map((a) => {
      if (a.sep) return Object.assign(document.createElement('span'), { className: 'md-tool-sep' });
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'md-tool';
      b.title = a.hint ? `${a.label} (${a.hint})` : a.label;
      b.setAttribute('aria-label', a.label);
      b.append(icon(a.icon));
      b.addEventListener('mousedown', (event) => event.preventDefault()); // keep the caret and selection in the text
      b.addEventListener('click', () => run(a.id));
      return b;
    }));
  }

  setMode('write');
  return { setMode, refresh: refreshPreview, get mode() { return mode; }, run };
}
