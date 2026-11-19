'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('readerApi', {
  // reading sources
  loadUrl: (url) => ipcRenderer.invoke('reader:load', url),
  loadText: (text) => ipcRenderer.invoke('reader:text', text),
  loadPdf: (droppedPath) => ipcRenderer.invoke('reader:pdf', droppedPath),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return ''; }
  },

  // library
  listLibrary: (section, query) => ipcRenderer.invoke('library:list', { section, query }),
  openLibraryItem: (id) => ipcRenderer.invoke('library:open', id),
  toggleSavedItem: (id) => ipcRenderer.invoke('library:toggle-saved', id),
  setProgress: (id, unit, fraction) => ipcRenderer.invoke('library:set-progress', { id, unit, fraction }),
  deleteLibraryItem: (id) => ipcRenderer.invoke('library:delete-item', id),
  clearHistory: () => ipcRenderer.invoke('library:clear-history'),

  // notes
  listNotes: (filter) => ipcRenderer.invoke('library:list-notes', filter),
  listItemNotes: (itemId) => ipcRenderer.invoke('library:item-notes', itemId),
  listTags: () => ipcRenderer.invoke('library:list-tags'),
  addNote: (note) => ipcRenderer.invoke('library:add-note', note),
  updateNote: (id, updates) => ipcRenderer.invoke('library:update-note', { id, updates }),
  deleteNote: (id) => ipcRenderer.invoke('library:delete-note', id),
  exportNotes: (filter) => ipcRenderer.invoke('library:export-notes', filter),

  // notebooks
  createNotebook: (name) => ipcRenderer.invoke('library:create-notebook', name),
  renameNotebook: (id, name) => ipcRenderer.invoke('library:rename-notebook', { id, name }),
  listNotebooks: () => ipcRenderer.invoke('library:list-notebooks'),
  deleteNotebook: (id) => ipcRenderer.invoke('library:delete-notebook', id),

  // speech
  voices: () => ipcRenderer.invoke('tts:voices'),
  synth: (request) => ipcRenderer.invoke('tts:synth', request),
  cancel: () => ipcRenderer.invoke('tts:cancel'),
  setAllowDownload: (value) => ipcRenderer.invoke('tts:set-allow-download', value),

  // search + discovery
  search: (query, options) => ipcRenderer.invoke('search:query', { query, ...(options || {}) }),
  searchStatus: () => ipcRenderer.invoke('search:status'),
  buildSearchIndex: () => ipcRenderer.invoke('search:index'),
  fetchFeeds: (urls) => ipcRenderer.invoke('discover:fetch', urls),

  // events
  onStatus: subscribe('reader:status'),
  onLog: subscribe('tts:log'),
  onOpenUrl: subscribe('app:open-url'),
});
