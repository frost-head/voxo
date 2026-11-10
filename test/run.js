'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractArticle, splitIntoChunks, cleanForSpeech } = require('../lib/extract');
const { loadArticle, normalizeUrl } = require('../lib/loader');

const ARTICLE_HTML = `<!doctype html><html><head><title>Why Bees Matter | Example News</title></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a> <a href="/subscribe">Subscribe now</a></nav>
<article><h1>Why Bees Matter</h1><p class="byline">By Jane Doe</p>
<p>Bees pollinate about a third of the food we eat. Without them, grocery shelves would look very different, and farmers would struggle to grow many fruits and vegetables across the world.[1]</p>
<h2>A quiet decline</h2>
<p>Scientists have tracked falling bee populations for years. Habitat loss, pesticides and disease all play a part, and researchers are still working out how much each one contributes to the problem.</p>
<ul><li>Plant flowers that bloom at different times of year.</li><li>Avoid pesticides in your garden whenever you can.</li></ul>
<pre>npm install bees</pre>
<p>Read the full study at https://example.com/study/bees-2026 for more detail on the methods used by the team.</p>
<p>${'Planting flowers and avoiding pesticides in your garden can help local bees recover over time. '.repeat(8)}</p>
</article>
<aside>Related: ten cookie recipes. Sign up for our newsletter!</aside>
<footer>Copyright 2026 Example News. All rights reserved.</footer></body></html>`;

// ---------------------------------------------------------------- extraction
test('extracts the article and drops page furniture', () => {
  const article = extractArticle(ARTICLE_HTML, 'https://example.com/bees');
  assert.ok(article, 'article found');
  const all = article.blocks.map((b) => b.text).join('\n');
  assert.match(all, /pollinate about a third/);
  assert.doesNotMatch(all, /cookie recipes|newsletter|Copyright|Subscribe now/);
  assert.equal(article.blocks[0].type, 'title');
  assert.equal(article.blocks[0].text.startsWith('Why Bees Matter'), true);
});

test('the site name is removed from the title', () => {
  const withHeadline = extractArticle(ARTICLE_HTML, 'https://example.com/bees');
  assert.equal(withHeadline.title, 'Why Bees Matter'); // from the page headline
  assert.equal(withHeadline.blocks[0].chunks[0], 'Why Bees Matter.');

  const noHeadline = ARTICLE_HTML
    .replace('<h1>Why Bees Matter</h1>', '')
    .replace('<head>', '<head><meta property="og:site_name" content="Example News">');
  assert.equal(extractArticle(noHeadline, 'https://example.com/bees').title, 'Why Bees Matter'); // from the site name

  const plain = ARTICLE_HTML.replace('Why Bees Matter | Example News', 'Bees: a short history');
  assert.equal(extractArticle(plain, 'https://example.com/bees').title, 'Bees: a short history');
});

test('title is not repeated as a heading, and block types are right', () => {
  const { blocks } = extractArticle(ARTICLE_HTML, 'https://example.com/bees');
  assert.equal(blocks.filter((b) => b.type === 'heading' && /^why bees matter/i.test(b.text)).length, 0);
  assert.ok(blocks.some((b) => b.type === 'heading' && b.text === 'A quiet decline' && b.level === 2));
  assert.equal(blocks.filter((b) => b.type === 'li').length, 2);
  const code = blocks.find((b) => b.type === 'code');
  assert.ok(code && code.speak === false && code.chunks.length === 0, 'code is shown but not spoken');
});

test('speech text: footnotes removed, URLs replaced, headings get end punctuation', () => {
  const { blocks } = extractArticle(ARTICLE_HTML, 'https://example.com/bees');
  const spoken = blocks.flatMap((b) => b.chunks).join(' ');
  assert.doesNotMatch(spoken, /\[1\]/);
  assert.doesNotMatch(spoken, /https?:/);
  assert.match(spoken, /Read the full study at link for more detail/);
  const heading = blocks.find((b) => b.text === 'A quiet decline');
  assert.deepEqual(heading.chunks, ['A quiet decline.']);
});

test('long paragraphs are split into short sentence-aligned chunks', () => {
  const { blocks } = extractArticle(ARTICLE_HTML, 'https://example.com/bees');
  const long = blocks.find((b) => b.text.startsWith('Planting flowers'));
  assert.ok(long.chunks.length > 1);
  for (const chunk of long.chunks) {
    assert.ok(chunk.length <= 320, `chunk too long: ${chunk.length}`);
    assert.match(chunk, /[.!?]$/, 'chunks end at a sentence boundary');
  }
  assert.equal(long.chunks.join(' '), cleanForSpeech(long.text));
});

test('a single huge sentence is broken on word boundaries', () => {
  const sentence = `${'word '.repeat(200)}end.`;
  const chunks = splitIntoChunks(sentence, 100);
  assert.ok(chunks.length > 5);
  assert.ok(chunks.every((c) => c.length <= 100));
  assert.equal(chunks.join(' '), sentence.trim());
});

test('abbreviations do not create tiny chunks', () => {
  const chunks = splitIntoChunks('Dr. Smith met Mr. Jones at 5 p.m. on Main St. yesterday.', 320);
  assert.equal(chunks.length, 1);
});

test('pages with no article return null; scripts in the page never run', () => {
  assert.equal(extractArticle('<html><body></body></html>', 'https://example.com/'), null);
  globalThis.__pwned = false;
  const html = ARTICLE_HTML.replace('</body>', '<script>globalThis.__pwned = true</script></body>');
  extractArticle(html, 'https://example.com/bees');
  assert.equal(globalThis.__pwned, false);
});

// ---------------------------------------------------------------- loader
test('normalizeUrl adds https and rejects other schemes', () => {
  assert.equal(normalizeUrl('example.com/a'), 'https://example.com/a');
  assert.equal(normalizeUrl('  http://example.com  '), 'http://example.com/');
  assert.throws(() => normalizeUrl('file:///etc/passwd'), /Only http and https/);
  assert.throws(() => normalizeUrl('javascript:alert(1)'), /Only http and https/);
  assert.throws(() => normalizeUrl(''), /Enter a web address/);
});

test('loader uses the plain download when it has enough text', async () => {
  let rendered = false;
  const statuses = [];
  const article = await loadArticle('example.com/bees', {
    fetchHtml: async () => ARTICLE_HTML,
    renderHtml: async () => { rendered = true; return ''; },
    onStatus: (s) => statuses.push(s),
  });
  assert.equal(rendered, false);
  assert.equal(article.rendered, undefined);
  assert.deepEqual(statuses, ['Fetching page…']);
});

test('loader falls back to the rendered page when the download is an empty shell', async () => {
  const shell = '<html><head><title>App</title></head><body><div id="root"></div></body></html>';
  const statuses = [];
  const article = await loadArticle('https://example.com/app', {
    fetchHtml: async () => shell,
    renderHtml: async () => ARTICLE_HTML,
    onStatus: (s) => statuses.push(s),
  });
  assert.equal(article.rendered, true);
  assert.ok(article.words > 100);
  assert.deepEqual(statuses, ['Fetching page…', 'Rendering page…']);
});

test('loader falls back to rendering when the download fails, and reports the real error otherwise', async () => {
  const ok = await loadArticle('https://example.com/x', {
    fetchHtml: async () => { throw new Error('HTTP 403'); },
    renderHtml: async () => ARTICLE_HTML,
  });
  assert.ok(ok.words > 100);

  await assert.rejects(
    loadArticle('https://example.com/x', {
      fetchHtml: async () => { throw new Error('The site answered with HTTP 404.'); },
      renderHtml: async () => { throw new Error('render failed'); },
    }),
    /HTTP 404/
  );
  await assert.rejects(
    loadArticle('https://example.com/x', { fetchHtml: async () => '<html></html>', renderHtml: async () => '<html></html>' }),
    /Could not find the main article text/
  );
});
