'use strict'

const { contextBridge, ipcRenderer } = require('electron')

const on = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('agl', {
  init: () => ipcRenderer.invoke('app:init'),
  saveSettings: (partial) => ipcRenderer.invoke('settings:save', partial),
  reconnect: () => ipcRenderer.invoke('connection:reconnect'),
  setTestMode: (value) => ipcRenderer.invoke('mode:set', value),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  loadFolder: (folder) => ipcRenderer.invoke('folder:load', folder),
  sendGraphic: (slot, filePath) => ipcRenderer.invoke('graphic:send', slot, filePath),
  onUpload: on('upload'),
  onConnection: on('connection'),
  onSafety: on('safety'),
  onPrefetch: on('prefetch'),
})
