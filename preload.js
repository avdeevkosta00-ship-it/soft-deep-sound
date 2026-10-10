'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Narrow, explicit bridge — the renderer never gets Node or raw ipcRenderer.
contextBridge.exposeInMainWorld('sds', {
  isElectron: true,
  // %27: covers live under the user folder; an apostrophe (O'Brien) must not break CSS url('…')
  mediaUrl: (p) => 'sds://media/f?p=' + encodeURIComponent(p).replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  store: {
    load: () => ipcRenderer.invoke('store:load'),
    save: (data) => ipcRenderer.invoke('store:save', data)
  },
  library: {
    pick: (kind) => ipcRenderer.invoke('library:pick', kind),
    probe: (paths) => ipcRenderer.invoke('library:probe', paths),
    exists: (p) => ipcRenderer.invoke('library:exists', p),
    existsMany: (paths) => ipcRenderer.invoke('library:existsMany', paths),
    formatInfo: (paths) => ipcRenderer.invoke('library:formatInfo', paths),
    reveal: (p) => ipcRenderer.invoke('library:reveal', p)
  },
  web: {
    search: (query, settings) => ipcRenderer.invoke('web:search', { query, settings }),
    download: (item) => ipcRenderer.invoke('web:download', item),
    extract: (url) => ipcRenderer.invoke('web:extract', url),
    open: (url) => ipcRenderer.invoke('web:open', url),
    onProgress: (cb) => ipcRenderer.on('web:progress', (_e, d) => cb(d))
  },
  exporter: {
    pick: (name, format) => ipcRenderer.invoke('export:pick', { name, format }),
    write: (p, data) => ipcRenderer.invoke('export:write', { path: p, data })
  },
  covers: { pick: () => ipcRenderer.invoke('cover:pick') },
  app: {
    paths: () => ipcRenderer.invoke('app:paths'), setLang: (l) => ipcRenderer.invoke('app:lang', l),
    prefs: () => ipcRenderer.invoke('app:prefs'), pendingFiles: () => ipcRenderer.invoke('app:pendingFiles'),
    onVisible: (cb) => ipcRenderer.on('win:visible', (_e, v) => cb(v)), setPref: (key, value) => ipcRenderer.invoke('app:setPref', { key, value })
  },
  media: {
    state: (st) => ipcRenderer.send('media:state', st),
    sleepEnded: () => ipcRenderer.send('sleep:ended'),
    onCommand: (cb) => ipcRenderer.on('media:cmd', (_e, cmd) => cb(cmd))
  },
  win: {
    min: () => ipcRenderer.send('win:min'),
    max: () => ipcRenderer.send('win:max'),
    close: () => ipcRenderer.send('win:close'),
    onState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s))
  },
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files))
});
