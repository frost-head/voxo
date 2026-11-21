// Lightweight language detection for choosing a voice. No dependencies: it looks at the writing system first
// (Devanagari → Hindi, kana → Japanese, Han → Chinese), then scores common function words for Latin-script languages.

export const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', hi: 'Hindi', it: 'Italian', pt: 'Portuguese', ja: 'Japanese', zh: 'Chinese',
};

const STOPWORDS = {
  en: 'the and of to in is that it for was on with as are this be by at have from or an they which you not but his her had were we their has been one all can there would will more when who what about if i a am my me so do does did your he she him them our us its just like love very much hello hi yes no than then also only some any how why where here out up now get got go want need make know think see said say really'.split(' '),
  es: 'el la de que y en los las un una es por con para se del al no su lo como más pero sus le ya o este sí porque esta entre cuando muy sin sobre también me hasta hay donde quien desde todo nos durante estados'.split(' '),
  fr: 'le la les de des du et en un une est que qui dans pour pas sur au avec ce il elle se ne plus par sont mais ou nous vous leur cette ont été fait comme tout aussi très être ces je tu'.split(' '),
  it: 'il lo la gli le di che un una è per con non si da in del della dei delle al nel sono ma come più anche questo questa ha hanno essere ci se loro suo sua alla tra molto quando'.split(' '),
  pt: 'o a os as de do da dos das que e em um uma é para com não se por mais mas como foi ao ele ela seu sua ou ser tem são também já muito você nos quando está isso entre'.split(' '),
};
const HINTS = {
  es: /[ñ¿¡]/g, pt: /[ãõ]|ç(?:ão|ões)/gi, fr: /[èêëîôûœù]|\bqu'|\bl'|\bd'|\bj'/gi, it: /\b(?:gli|perché|però|c'è)\b|[ìòù]\b/gi,
};

const count = (text, re) => (text.match(re) || []).length;

/** @returns {{ code: string|null, confidence: number }} code is null when the text is too short or too mixed to tell. */
export function detectLanguage(text) {
  const sample = String(text || '').slice(0, 4000);
  const letters = count(sample, /\p{L}/gu);
  if (letters < 40) return { code: null, confidence: 0 };

  const devanagari = count(sample, /[ऀ-ॿ]/g);
  const kana = count(sample, /[぀-ヿ]/g);
  const han = count(sample, /[一-鿿]/g);
  const latin = count(sample, /[A-Za-zÀ-ɏ]/g);
  const other = letters - devanagari - kana - han - latin;
  if (devanagari / letters > 0.4) return { code: 'hi', confidence: 0.95 };
  if (kana / letters > 0.1) return { code: 'ja', confidence: 0.95 };
  if (han / letters > 0.4) return { code: 'zh', confidence: 0.9 };
  if (other / letters > 0.5) return { code: 'other', confidence: 0.8 }; // Cyrillic, Arabic, …: no voice for it

  const words = sample.toLowerCase().match(/[a-zà-ÿœ']+/g) || [];
  if (words.length < 12) return { code: null, confidence: 0 };
  const scores = {};
  for (const [code, list] of Object.entries(STOPWORDS)) {
    const set = new Set(list);
    let hits = 0;
    for (const w of words) if (set.has(w)) hits += 1;
    scores[code] = hits / words.length + (HINTS[code] ? Math.min(0.08, count(sample, HINTS[code]) / words.length) : 0);
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 0.06 || best[1] < second[1] * 1.25) return { code: null, confidence: 0 };
  // Too few distinctive words to be sure (a short greeting, a name): English is the safe default for Latin script.
  const hitsOf = (code) => { const set = new Set(STOPWORDS[code]); return words.filter((w) => set.has(w)).length; };
  if (best[0] !== 'en' && (hitsOf(best[0]) < 4 || scores.en >= best[1] * 0.7)) return scores.en >= 0.1 ? { code: 'en', confidence: 0.6 } : { code: null, confidence: 0 };
  return { code: best[0], confidence: Math.min(0.99, best[1] / (second[1] + 0.001) / 3) };
}
