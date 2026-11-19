// Local listening stats, kept in localStorage only: minutes and words per day, readings finished, and topics.
import { store } from './common.js';

const dayKey = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function load() {
  const data = store.get('stats', null);
  const ok = data && typeof data === 'object';
  return {
    days: (ok && data.days) || {},
    words: (ok && data.words) || {},
    topics: (ok && data.topics) || {},
    finished: (ok && Number(data.finished)) || 0,
  };
}

function trim(map, keep) {
  const keys = Object.keys(map).sort();
  for (const old of keys.slice(0, Math.max(0, keys.length - keep))) delete map[old];
}

export function addListening(seconds) {
  if (!(seconds > 0)) return;
  const data = load();
  const key = dayKey();
  data.days[key] = (data.days[key] || 0) + seconds;
  trim(data.days, 400);
  store.set('stats', data);
}

/** Words heard today (called as each paragraph finishes). */
export function addWords(count) {
  if (!(count > 0)) return;
  const data = load();
  const key = dayKey();
  data.words[key] = (data.words[key] || 0) + Math.round(count);
  trim(data.words, 400);
  store.set('stats', data);
}

export function addFinished() {
  const data = load();
  data.finished += 1;
  store.set('stats', data);
}

const STOP = new Set(`the and for that this with from have has had are was were been being not but you your they their them his her its our out about into than then there these those what when where which while who whom why will would could should can may might just also more most some such only over under after before between through during very much many any each other another because since until upon within without across against among around however therefore thus yet still even ever never always often really actually already again here how too own same both few all one two three first second new old like get got make made use used using way ways thing things people time year years day days said says say see seen look back going went come came take took give gave want need let well part however while also page article read reading`.split(/\s+/));

/** The handful of words that best describe a reading: frequent, not common, and weighted toward the title. */
export function topicsOf(title, text) {
  const counts = new Map();
  const bump = (word, weight) => counts.set(word, (counts.get(word) || 0) + weight);
  const words = (value) => String(value || '').toLowerCase().match(/[\p{L}][\p{L}'-]{3,}/gu) || [];
  for (const w of words(title)) if (!STOP.has(w)) bump(w, 4);
  for (const w of words(text).slice(0, 4000)) if (!STOP.has(w)) bump(w, 1);
  return [...counts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([w]) => w);
}

/** Remember what you listened to. Called once per reading, when it has actually been listened to. */
export function addTopics(list) {
  if (!list?.length) return;
  const data = load();
  for (const t of list) data.topics[t] = (data.topics[t] || 0) + 1;
  const entries = Object.entries(data.topics).sort((a, b) => b[1] - a[1]).slice(0, 80);
  data.topics = Object.fromEntries(entries);
  store.set('stats', data);
}

export function getStats() {
  const data = load();
  const today = new Date();
  let streak = 0;
  const cursor = new Date(today);
  if (!data.days[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1); // today may not have started yet
  while (data.days[dayKey(cursor)] >= 60) { streak += 1; cursor.setDate(cursor.getDate() - 1); }

  const span = (n) => {
    let seconds = 0;
    let words = 0;
    const perDay = [];
    for (let i = n - 1; i >= 0; i -= 1) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const k = dayKey(d);
      seconds += data.days[k] || 0;
      words += data.words[k] || 0;
      perDay.push({ key: k, label: d.toLocaleDateString(undefined, { weekday: 'narrow' }), minutes: Math.round((data.days[k] || 0) / 60) });
    }
    return { minutes: Math.round(seconds / 60), words, perDay };
  };
  const allSeconds = Object.values(data.days).reduce((a, b) => a + b, 0);
  const allWords = Object.values(data.words).reduce((a, b) => a + b, 0);
  const week = span(7);
  return {
    streak,
    todayMinutes: Math.round((data.days[dayKey(today)] || 0) / 60),
    weekMinutes: week.minutes,
    week,
    totalMinutes: Math.round(allSeconds / 60),
    totalWords: allWords,
    finished: data.finished,
    topics: Object.entries(data.topics).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => ({ word, count })),
  };
}
