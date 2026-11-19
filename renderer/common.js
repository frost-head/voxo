// Shared helpers for the renderer: DOM lookups, settings storage, toasts, dialogs, swatches.

export const api = window.readerApi;
export const $ = (selector, root = document) => root.querySelector(selector);

export const NOTE_COLORS = ['yellow', 'green', 'blue', 'pink', 'orange'];
export const COLOR_LABELS = { yellow: 'Yellow', green: 'Green', blue: 'Blue', pink: 'Pink', orange: 'Orange' };

export const clamp = (value, min, max, fallback) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

export function debounce(fn, ms) {
  let timer = null;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
  wrapped.cancel = () => { clearTimeout(timer); timer = null; };
  wrapped.flush = (...args) => { if (timer) { clearTimeout(timer); timer = null; fn(...args); } };
  return wrapped;
}

// ---------------------------------------------------------------- saved settings

export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`readertts.${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`readertts.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
};

// ---------------------------------------------------------------- date formatting

export function formatLibraryDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

export function formatRelativeDate(value) {
  const diff = Date.now() - value;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  return formatLibraryDate(value);
}

export const sourceTypeLabel = (type) => ({ article: 'Article', pdf: 'PDF', text: 'Text' })[type] || 'Reading';

// ---------------------------------------------------------------- banner and toast

const banner = { root: $('#banner'), text: $('#banner-text'), hint: $('#banner-hint'), close: $('#banner-close') };

export function showError(message, hint) {
  banner.text.textContent = message;
  if (!hint && /allow-download|not cached yet/.test(message)) {
    hint = 'Open Settings, allow the voice model download, then press play again.';
  }
  banner.hint.textContent = hint || '';
  banner.hint.hidden = !hint;
  banner.root.hidden = false;
}

export const hideError = () => { banner.root.hidden = true; };
banner.close.addEventListener('click', hideError);

const toastEl = $('#toast');
let toastTimer = null;

/** Brief message at the bottom of the window; an optional action button (e.g. Undo). */
export function toast(message, { action = null, duration = 4500 } = {}) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren();
  const text = document.createElement('span');
  text.textContent = message;
  toastEl.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      toastEl.hidden = true;
      action.onClick();
    });
    toastEl.append(button);
  }
  toastEl.hidden = false;
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, duration);
}

// ---------------------------------------------------------------- small widgets

/**
 * Renders color swatch buttons into `container`.
 * @param {{selected?:string|null, allowNone?:boolean, onPick:(color:string|null)=>void}} options
 * @returns {{set:(color:string|null)=>void}}
 */
export function buildSwatches(container, { selected = null, allowNone = false, onPick }) {
  container.replaceChildren();
  const buttons = [];
  const make = (color, label) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `swatch${color ? ` swatch-${color}` : ' swatch-none'}`;
    button.dataset.color = color || '';
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-label', label);
    button.title = label;
    button.addEventListener('mousedown', (event) => event.preventDefault()); // keep any text selection
    button.addEventListener('click', () => {
      set(color);
      onPick(color);
    });
    container.append(button);
    buttons.push(button);
  };
  if (allowNone) make(null, 'No color');
  for (const color of NOTE_COLORS) make(color, COLOR_LABELS[color]);
  function set(color) {
    for (const button of buttons) {
      const on = (button.dataset.color || null) === (color || null);
      button.setAttribute('aria-checked', String(on));
      button.classList.toggle('is-selected', on);
    }
  }
  set(selected);
  return { set };
}

/** Two-step destructive button: first click arms it, second click within 3 s confirms. */
export function confirmTwice(button, onConfirm, { armedLabel = 'Sure?' } = {}) {
  let armed = false;
  let timer = null;
  const original = button.textContent;
  const reset = () => {
    armed = false;
    button.classList.remove('is-armed');
    if (original) button.textContent = original;
  };
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!armed) {
      armed = true;
      button.classList.add('is-armed');
      if (original) button.textContent = armedLabel;
      clearTimeout(timer);
      timer = setTimeout(reset, 3000);
      return;
    }
    clearTimeout(timer);
    reset();
    onConfirm();
  });
}

const promptDialog = $('#prompt-dialog');
const promptInput = $('#prompt-input');
let promptResolve = null;

function closePrompt(value) {
  if (promptDialog.open) promptDialog.close();
  const resolve = promptResolve;
  promptResolve = null;
  if (resolve) resolve(value);
}

$('#prompt-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = promptInput.value.trim();
  closePrompt(value || null);
});
$('#prompt-cancel').addEventListener('click', () => closePrompt(null));
promptDialog.addEventListener('cancel', () => closePrompt(null));

/** window.prompt() does not exist in Electron, so this is the replacement. */
export function promptName(title, initial = '') {
  if (promptResolve) closePrompt(null);
  $('#prompt-title').textContent = title;
  promptInput.value = initial;
  promptDialog.showModal();
  promptInput.focus();
  promptInput.select();
  return new Promise((resolve) => { promptResolve = resolve; });
}

export const wordCount = (text) => (String(text || '').trim().match(/\S+/g) || []).length;
