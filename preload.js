'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('readerApi', {
  loadUrl: (url) => ipcRenderer.invoke('reader:load', url),
  loadText: (text) => ipcRenderer.invoke('reader:text', text),
  loadPdf: () => ipcRenderer.invoke('reader:pdf'),
  listLibrary: (section) => ipcRenderer.invoke('library:list', section),
  openLibraryItem: (id) => ipcRenderer.invoke('library:open', id),
  toggleSavedItem: (id) => ipcRenderer.invoke('library:toggle-saved', id),
  addNote: (note) => ipcRenderer.invoke('library:add-note', note),
  deleteNote: (id) => ipcRenderer.invoke('library:delete-note', id),
  voices: () => ipcRenderer.invoke('tts:voices'),
  synth: (request) => ipcRenderer.invoke('tts:synth', request),
  cancel: () => ipcRenderer.invoke('tts:cancel'),
  setAllowDownload: (value) => ipcRenderer.invoke('tts:set-allow-download', value),
  onStatus: subscribe('reader:status'),
  onLog: subscribe('tts:log'),
  onOpenUrl: subscribe('app:open-url'),
});
