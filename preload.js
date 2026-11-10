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
  voices: () => ipcRenderer.invoke('tts:voices'),
  synth: (request) => ipcRenderer.invoke('tts:synth', request),
  cancel: () => ipcRenderer.invoke('tts:cancel'),
  setAllowDownload: (value) => ipcRenderer.invoke('tts:set-allow-download', value),
  onStatus: subscribe('reader:status'),
  onLog: subscribe('tts:log'),
  onOpenUrl: subscribe('app:open-url'),
});
