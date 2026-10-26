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
    reveal: (p) => ipcRenderer.invoke('library:reveal', p),
    scan: () => ipcRenderer.invoke('library:scan')
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
  backgrounds: { add: () => ipcRenderer.invoke('bg:add'), remove: (p) => ipcRenderer.invoke('bg:remove', p) },
  meta: { repair: (t) => ipcRenderer.invoke('meta:repair', t) },
  lyrics: {
    get: (t, opts) => ipcRenderer.invoke('lyrics:get', t, opts),
    save: (p, text, replace) => ipcRenderer.invoke('lyrics:save', p, text, !!replace),
    clipboard: () => ipcRenderer.invoke('lyrics:clipboard')
  },
  app: {
    paths: () => ipcRenderer.invoke('app:paths'),
    globalKeys: (on) => ipcRenderer.invoke('keys:global', on),
    pickDownloads: () => ipcRenderer.invoke('downloads:pick'), resetDownloads: () => ipcRenderer.invoke('downloads:reset'), openDownloads: () => ipcRenderer.invoke('downloads:open'), setLang: (l) => ipcRenderer.invoke('app:lang', l),
    prefs: () => ipcRenderer.invoke('app:prefs'), pendingFiles: () => ipcRenderer.invoke('app:pendingFiles'),
    onVisible: (cb) => ipcRenderer.on('win:visible', (_e, v) => cb(v)), setPref: (key, value) => ipcRenderer.invoke('app:setPref', { key, value })
  },
  media: {
    state: (st) => ipcRenderer.send('media:state', st),
    sleepEnded: () => ipcRenderer.send('sleep:ended'),
    onCommand: (cb) => ipcRenderer.on('media:cmd', (_e, cmd) => cb(cmd))
  },
  update: {
    get: () => ipcRenderer.invoke('update:get'), check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'), install: () => ipcRenderer.send('update:install'),
    onState: (cb) => ipcRenderer.on('update:state', (_e, st) => cb(st))
  },
  discord: { set: (on, id) => ipcRenderer.invoke('discord:set', on, id) },
  win: {
    min: () => ipcRenderer.send('win:min'),
    max: () => ipcRenderer.send('win:max'),
    close: () => ipcRenderer.send('win:close'),
    mini: (on, top) => ipcRenderer.send('win:mini', on, top),
    onMini: (cb) => ipcRenderer.on('win:mini', (_e, on) => cb(on)),
    onState: (cb) => ipcRenderer.on('win:state', (_e, s) => cb(s))
  },
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files))
});