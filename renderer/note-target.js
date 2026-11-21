// Adding a passage from a reading to a note you already have (a bug log, a research notebook, a running list),
// instead of making a separate note for every find.

const MAX_QUOTE = 1200;

/** Headings of a note, with the line each section starts on and where it ends (the next heading of the same or higher level). */
export function headingsOf(body) {
  const lines = String(body || '').split('\n');
  const heads = [];
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) heads.push({ line: i, level: m[1].length, text: m[2].trim() });
  });
  return heads.map((h, n) => {
    const next = heads.slice(n + 1).find((x) => x.level <= h.level);
    return { ...h, end: next ? next.line : lines.length };
  });
}

/** The passage as Markdown: a quote that links back to the exact paragraph, then your own words. */
export function buildEntry({ quote, sourceKey, sourceTitle, comment = '' }) {
  const text = String(quote || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE).replace(/\s+\S*$/, '')}…` : text;
  const label = String(sourceTitle || 'reading').replace(/[\]|\n]/g, ' ').trim();
  const lines = [`> ${clipped}`, `> — [[${sourceKey}|${label}]]`];
  const words = String(comment || '').trim();
  return words ? `${lines.join('\n')}\n\n${words}` : lines.join('\n');
}

/**
 * Puts an entry into a note: at the end, or at the end of the section under a heading.
 * @param {string} body    the note's Markdown
 * @param {string} entry
 * @param {number} headingLine  the line of the heading to add under, or -1 for the end of the note
 */
export function insertEntry(body, entry, headingLine = -1) {
  const lines = String(body || '').replace(/\s+$/, '').split('\n');
  const heading = headingLine >= 0 ? headingsOf(body).find((h) => h.line === headingLine) : null;
  if (!heading) return `${lines.join('\n')}${body.trim() ? '\n\n' : ''}${entry}\n`;
  let at = Math.min(heading.end, lines.length);
  while (at > heading.line + 1 && !lines[at - 1].trim()) at -= 1; // before the blank lines that precede the next section
  const before = lines.slice(0, at);
  const after = lines.slice(at);
  return `${[...before, '', ...entry.split('\n'), ...(after.length ? [''] : []), ...after].join('\n').replace(/\n{3,}/g, '\n\n')}${after.length ? '' : '\n'}`;
}
