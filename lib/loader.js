'use strict';
// Gets a URL, extracts the article, and falls back to rendering the page in a
// hidden browser window when the plain download has too little text (pages that
// build their content with JavaScript). The fetchers are passed in, so this file
// has no dependency on Electron and can be tested on its own.

const { extractArticle } = require('./extract');

const MIN_WORDS = 120; // below this, the static HTML probably wasn't the real page

function normalizeUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new Error('Enter a web address.');
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`"${input}" is not a valid web address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only http and https addresses can be opened.');
  }
  return url.href;
}

/**
 * @param {string} input  URL typed by the user
 * @param {{fetchHtml:(url:string)=>Promise<string>, renderHtml:(url:string)=>Promise<string>,
 *          onStatus?:(msg:string)=>void}} deps
 */
async function loadArticle(input, { fetchHtml, renderHtml, onStatus = () => {} }) {
  const url = normalizeUrl(input);

  let article = null;
  let fetchError = null;
  onStatus('Fetching page…');
  try {
    article = extractArticle(await fetchHtml(url), url);
  } catch (err) {
    fetchError = err;
  }

  if (!article || article.words < MIN_WORDS) {
    onStatus('Rendering page…');
    try {
      const rendered = extractArticle(await renderHtml(url), url);
      if (rendered && (!article || rendered.words > article.words)) {
        article = rendered;
        article.rendered = true;
      }
    } catch (err) {
      if (!article) throw fetchError || err;
    }
  }

  if (!article || article.words === 0) {
    throw (
      fetchError ||
      new Error('Could not find the main article text on this page. It may need a login.')
    );
  }
  return article;
}

module.exports = { loadArticle, normalizeUrl, MIN_WORDS };
