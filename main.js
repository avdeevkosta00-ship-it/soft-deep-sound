'use strict';
/**
 * Soft&Deep Sound — main process.
 * Owns: window, the privileged sds:// protocol (app files + local media with Range support),
 * library persistence, metadata probing, web search providers and safe downloads.
 */
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, Menu, nativeTheme, Tray, nativeImage, powerMonitor, screen, safeStorage, clipboard, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Readable } = require('stream');
const { pathToFileURL } = require('url');
const { httpFetch } = require('./src/search/http');
const { safeDownload } = require('./src/search/downloader');
const { extractAudio } = require('./src/search/extract');
const { tm, setLang } = require('./src/i18n-main');
const musicbrainz = require('./src/meta/musicbrainz');
const lyrics = require('./src/meta/lyrics');
const updater = require('./src/updater');
const discord = require('./src/discord');

const RENDERER_DIR = path.join(__dirname, 'renderer');
const AUDIO_EXT = new Set(['.mp3', '.flac', '.wav', '.ogg', '.oga', '.opus', '.m4a', '.aac', '.webm']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.woff2': 'font/woff2', '.json': 'application/json',
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg',
  '.opus': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.webm': 'audio/webm', '.mp4': 'video/mp4'
};

protocol.registerSchemesAsPrivileged([{
  scheme: 'sds',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
}]);

const userDir = () => app.getPath('userData');
const storeFile = () => path.join(userDir(), 'library.json');
const coversDir = () => path.join(userDir(), 'covers');
// the user's own backgrounds (Settings → Оформление → Свой фон): copies, so the originals can move or vanish
const backgroundsDir = () => path.join(userDir(), 'backgrounds');
const BG_EXT = { '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.webp': 'image', '.gif': 'image', '.mp4': 'video', '.webm': 'video' };
const defaultDownloadsDir = () => path.join(app.getPath('music'), 'Soft&Deep Sound');
// Settings → «Папка загрузок»: the user's own folder, while it still exists; otherwise the default one
const downloadsDir = () => (prefs.downloadsDir && fs.existsSync(prefs.downloadsDir) ? prefs.downloadsDir : defaultDownloadsDir());

let win;

/* ---------------------------------- protocol ---------------------------------- */
async function serveFile(filePath, request, forceType) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return new Response('Not found', { status: 404 }); }
  if (!stat.isFile()) return new Response('Not found', { status: 404 });
  const type = forceType || MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  // ACAO lets the page (sds://app) route media from sds://media through Web Audio without being muted as cross-origin.
  const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' };
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1) }
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200, headers: { ...base, 'Content-Length': String(stat.size) }
  });
}

/** true when `child` lies inside `dir` (not merely sharing a name prefix like covers-x) */
function isInside(dir, child) {
  const rel = path.relative(dir, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function registerProtocol() {
  protocol.handle('sds', (request) => {
    const url = new URL(request.url);
    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const full = path.normalize(path.join(RENDERER_DIR, rel));
      if (!isInside(RENDERER_DIR, full)) return new Response('Forbidden', { status: 403 });
      return serveFile(full, request);
    }
    if (url.host === 'media') {
      // Only audio files and our own cover cache are served — never arbitrary files.
      const p = url.searchParams.get('p') || '';
      if (!path.isAbsolute(p)) return new Response('Forbidden', { status: 403 });
      const ext = path.extname(p).toLowerCase();
      const isCover = isInside(coversDir(), path.normalize(p));
      // the user's backgrounds live in their own folder; a .webm there is a video, not audio
      const isBg = isInside(backgroundsDir(), path.normalize(p)) && !!BG_EXT[ext];
      if (isBg) return serveFile(p, request, ext === '.webm' ? 'video/webm' : undefined);
      if (!AUDIO_EXT.has(ext) && !isCover) return new Response('Forbidden', { status: 403 });
      return serveFile(p, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

/* ----------------------------------- window ----------------------------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1360, height: 860, minWidth: 1040, minHeight: 680, ...restoredBounds(),
    frame: false, show: false, backgroundColor: '#e8ebf3',
    title: 'Soft&Deep Sound',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false, // keep the player, crossfades and auto-next exact while hidden in the tray
      spellcheck: false
    }
  });
  Menu.setApplicationMenu(null);
  win.loadURL('sds://app/index.html');
  win.once('ready-to-show', () => {
    if (prefs.maximized) win.maximize();
    if (startHidden) { sendVisibility(); return; } // launched with Windows: stay in the tray
    win.show();
  });
  // closing the window hides it to the tray; music keeps playing (Quit from the tray menu really exits)
  win.on('close', (e) => {
    if (quitting || !prefs.closeToTray) return;
    e.preventDefault();
    win.hide();
    if (!prefs.trayHintShown) {
      prefs.trayHintShown = true; savePrefs();
      if (tray && process.platform === 'win32') tray.displayBalloon({ iconType: 'info', title: 'Soft&Deep Sound', content: tm('tray.hint') });
    }
  });
  win.on('show', () => { updateThumbar(); buildTrayMenu(); sendVisibility(); });
  win.on('hide', () => { buildTrayMenu(); sendVisibility(); });
  win.on('minimize', sendVisibility); win.on('restore', sendVisibility);
  win.on('focus', buildTrayMenu); win.on('blur', buildTrayMenu);
  // remember size, position and maximised state between launches
  const saveBounds = () => { if (mini) return; if (!win.isMinimized() && !win.isMaximized() && !win.isFullScreen()) prefs.bounds = win.getBounds(); prefs.maximized = win.isMaximized(); savePrefsSoon(); };
  win.on('resize', saveBounds); win.on('move', saveBounds); win.on('maximize', saveBounds); win.on('unmaximize', saveBounds);
  win.on('maximize', () => win.webContents.send('win:state', { maximized: true }));
  win.on('unmaximize', () => win.webContents.send('win:state', { maximized: false }));

  // Renderer never navigates away or opens popups; external links go to the system browser.
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('sds://')) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

/* ---------------------------------- metadata ---------------------------------- */
let mm;
function formatFields(meta) {
  const f = meta.format || {};
  return {
    bitrate: f.bitrate ? Math.round(f.bitrate / 1000) : null,
    sampleRate: f.sampleRate || null,
    bitDepth: f.bitsPerSample || null,
    codec: f.codec || f.container || null,
    lossless: !!f.lossless,
    channels: f.numberOfChannels || null
  };
}
/** Format details only (fast: no cover extraction) — used to backfill tracks imported before v1.4. */
async function formatInfo(filePath) {
  mm = mm || require('music-metadata');
  try {
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: true });
    const st = await fsp.stat(filePath);
    const c = meta.common;
    return { ...formatFields(meta), size: st.size, genre: c.genre && c.genre.length ? c.genre.join(', ') : undefined, year: c.year || undefined };
  } catch { return null; }
}

/** the shared file-name rules (renderer/js/names.js, an ES module) */
let namesMod = null;
const names = () => namesMod || (namesMod = import(pathToFileURL(path.join(__dirname, 'renderer', 'js', 'names.js')).href));

/** web search in open sources: renderer/js/websearch.js, shared with the Android app; here it fetches through http.js */
let webSearchMod = null;
const webSearch = () => webSearchMod || (webSearchMod = import(pathToFileURL(path.join(__dirname, 'renderer', 'js', 'websearch.js')).href).then((m) => m.createWebSearch({
  tm,
  async getJSON(url, timeout = 10000) {
    const res = await httpFetch(url, { headers: { 'User-Agent': 'SoftDeepSound/1.0 (desktop music player)', Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }
})));

async function probe(filePath) {
  mm = mm || require('music-metadata');
  const id = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 16);
  const base = path.basename(filePath, path.extname(filePath));
  const track = {
    id, path: filePath, title: base, artist: '', album: '', duration: 0, cover: null,
    format: path.extname(filePath).slice(1).toUpperCase(), addedAt: Date.now(), bpm: null
  };
  // "Artist - Title.mp3" fallback when tags are empty, without what download sites add (ids, «zaycev.net»…)
  const { cleanName, stripJunk } = await names();
  Object.assign(track, cleanName(base));
  try {
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: false });
    const c = meta.common;
    // sites write their name into the tags too: «Apoplexy (muzmo.ru)», «www.zaycev.net»
    if (c.title && stripJunk(c.title)) track.title = stripJunk(c.title);
    if (c.artist && stripJunk(c.artist)) track.artist = stripJunk(c.artist);
    if (c.album) track.album = c.album;
    if (c.bpm) track.bpm = Math.round(c.bpm);
    track.duration = meta.format.duration || 0;
    Object.assign(track, formatFields(meta));
    if (c.genre && c.genre.length) track.genre = c.genre.join(', ');
    if (c.year) track.year = c.year;
    try { track.size = (await fsp.stat(filePath)).size; } catch {}
    const pic = c.picture && c.picture[0];
    if (pic && pic.data) {
      await fsp.mkdir(coversDir(), { recursive: true });
      const ext = /png/.test(pic.format) ? '.png' : '.jpg';
      const cp = path.join(coversDir(), id + ext);
      await fsp.writeFile(cp, pic.data);
      track.cover = cp;
    }
  } catch (e) { /* unreadable tags — keep filename fallback */ }
  return track;
}

/** expand folders into audio files: no symlink loops, depth- and count-limited */
async function collectAudio(paths, depth = 0, seen = new Set(), out = []) {
  for (const p of paths) {
    if (out.length >= 20000 || typeof p !== 'string' || !path.isAbsolute(p)) continue;
    try {
      const st = await fsp.lstat(p);
      if (st.isSymbolicLink()) continue; // links and junctions can point back up the tree
      if (st.isDirectory()) {
        if (depth >= 12) continue;
        const real = await fsp.realpath(p);
        if (seen.has(real)) continue;
        seen.add(real);
        const entries = await fsp.readdir(p);
        await collectAudio(entries.filter((e) => !e.startsWith('$') && e !== 'System Volume Information').map((e) => path.join(p, e)), depth + 1, seen, out);
      } else if (AUDIO_EXT.has(path.extname(p).toLowerCase())) out.push(p);
    } catch { /* skip */ }
  }
  return out;
}

/**
 * "Find music on this computer": the usual places (Music, Downloads, Desktop, OneDrive) plus top-level
 * folders with a musical name on every drive. Returns folders that hold audio, biggest first.
 */
async function findMusicFolders() {
  const cand = new Set();
  const add = (p) => { try { if (p && fs.existsSync(p)) cand.add(path.normalize(p)); } catch {} };
  for (const k of ['music', 'downloads', 'desktop']) { try { add(app.getPath(k)); } catch {} }
  const home = app.getPath('home');
  for (const n of ['Music', 'Музыка']) add(path.join(home, 'OneDrive', n));
  const NAME = /music|муз|mp3|flac|audio|аудио|песни|songs|треки|tracks/i;
  // an empty card reader or a sleeping network drive must not stall the scan
  const quick = (p) => Promise.race([fsp.readdir(p, { withFileTypes: true }), new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), 2500))]);
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    let entries;
    try { entries = await quick(letter + ':\\'); } catch { continue; }
    for (const e of entries) if (e.isDirectory() && NAME.test(e.name)) add(path.join(letter + ':\\', e.name));
  }
  // a folder inside another candidate is already covered by it
  const roots = [...cand].sort((a, b) => a.length - b.length).filter((p, i, all) => !all.slice(0, i).some((q) => isInside(q, p)));
  const out = [];
  for (const dir of roots) {
    const files = await collectAudio([dir]);
    if (files.length) out.push({ path: dir, count: files.length });
  }
  return out.sort((a, b) => b.count - a.count);
}

/* ---------------------------------- mini player ---------------------------------- */
let mini = null; // { bounds, maximized } of the full window while the mini player is shown
const MINI = { w: 480, h: 124 };
function setMini(on, top) {
  if (!win || win.isDestroyed()) return;
  if (on && !mini) {
    mini = { bounds: win.getBounds(), maximized: win.isMaximized() };
    if (win.isMaximized()) win.unmaximize();
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    win.setMinimumSize(320, 96);
    win.setBounds({ x: wa.x + wa.width - MINI.w - 24, y: wa.y + wa.height - MINI.h - 24, width: MINI.w, height: MINI.h });
    win.setResizable(false);
    win.setAlwaysOnTop(top, 'floating');
  } else if (!on && mini) {
    const back = mini; mini = null;
    win.setAlwaysOnTop(false);
    win.setResizable(true);
    win.setMinimumSize(1040, 680);
    win.setBounds(back.bounds);
    if (back.maximized) win.maximize();
  } else if (on && mini) win.setAlwaysOnTop(top, 'floating');
  win.webContents.send('win:mini', !!mini);
  if (!win.isVisible()) win.show();
}

/* --------------------------------- global hotkeys --------------------------------- */
const GLOBAL_KEYS = { 'Control+Alt+P': 'toggle', 'Control+Alt+Right': 'next', 'Control+Alt+Left': 'prev', 'Control+Alt+Up': 'volUp', 'Control+Alt+Down': 'volDown' };
/** returns the combos another program already holds */
function setGlobalKeys(on) {
  for (const k of Object.keys(GLOBAL_KEYS)) { try { globalShortcut.unregister(k); } catch {} }
  if (!on) return [];
  const busy = [];
  for (const [k, cmd] of Object.entries(GLOBAL_KEYS)) {
    try { if (!globalShortcut.register(k, () => send(cmd))) busy.push(k); } catch { busy.push(k); }
  }
  return busy;
}

/* ------------------------------------- tray ------------------------------------- */
let tray = null, quitting = false, pendingFiles = [];
const media = { title: '', artist: '', playing: false, hasTrack: false };
const prefsFile = () => path.join(userDir(), 'prefs.json');
let prefs = { closeToTray: true, trayHintShown: false };
function loadPrefs() { try { Object.assign(prefs, JSON.parse(fs.readFileSync(prefsFile(), 'utf8'))); } catch {} }
function savePrefs() { try { fs.writeFileSync(prefsFile(), JSON.stringify(prefs)); } catch {} }
const img = (name) => nativeImage.createFromPath(path.join(__dirname, 'build', name));
const send = (cmd) => { if (win && !win.isDestroyed()) win.webContents.send('media:cmd', cmd); };
function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function quitApp() { quitting = true; app.quit(); }
let prefsTimer = null;
function savePrefsSoon() { clearTimeout(prefsTimer); prefsTimer = setTimeout(savePrefs, 600); }
/** the renderer pauses its animation loops while nobody can see them (music keeps playing) */
function sendVisibility() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('win:visible', win.isVisible() && !win.isMinimized());
}
/** saved bounds, but only if they are still on a connected screen */
function restoredBounds() {
  const b = prefs.bounds;
  if (!b || !b.width || !b.height) return {};
  const ok = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 20 && b.y < a.y + a.height - 80;
  });
  return ok ? { x: b.x, y: b.y, width: Math.max(1040, b.width), height: Math.max(680, b.height) } : { width: b.width, height: b.height };
}

function buildTrayMenu() {
  if (!tray) return;
  const now = media.hasTrack ? `${media.title}${media.artist ? ' — ' + media.artist : ''}` : tm('tray.nothing');
  const label = now.length > 60 ? now.slice(0, 57) + '…' : now;
  tray.setToolTip(media.hasTrack ? `Soft&Deep Sound\n${media.playing ? '▶' : 'Ⅱ'} ${label}`.slice(0, 127) : 'Soft&Deep Sound');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: media.playing ? tm('tray.pause') : tm('tray.play'), icon: img(media.playing ? 'menu-pause.png' : 'menu-play.png'), enabled: media.hasTrack, click: () => send('toggle') },
    { label: tm('tray.next'), icon: img('menu-next.png'), enabled: media.hasTrack, click: () => send('next') },
    { label: tm('tray.prev'), icon: img('menu-prev.png'), enabled: media.hasTrack, click: () => send('prev') },
    { type: 'separator' },
    { label: tm('tray.vol'), submenu: [100, 75, 50, 25].map((v) => ({ label: v + '%', click: () => send('vol:' + v) })) },
    { label: sleepAt ? tm('tray.sleepOn', new Date(sleepAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : tm('tray.sleep'), submenu: [
      ...[15, 30, 45, 60, 90].map((m) => ({ label: tm('tray.min', m), type: 'radio', checked: sleepMin === m && !!sleepAt, click: () => setSleep(m) })),
      { label: tm('tray.sleepEnd'), type: 'radio', checked: sleepMin === -1 && !!sleepAt, enabled: media.hasTrack, click: () => setSleep(-1) },
      { type: 'separator' },
      { label: tm('tray.sleepOff'), enabled: !!sleepAt, click: () => setSleep(0) }
    ] },
    { label: tm('tray.mute'), click: () => send('mute') },
    { type: 'separator' },
    { label: win && win.isVisible() ? tm('tray.hide') : tm('tray.show'), icon: img('menu-show.png'), click: () => (win.isVisible() && win.isFocused() ? win.hide() : showWindow()) },
    { label: tm('tray.closeToTray'), type: 'checkbox', checked: prefs.closeToTray, click: (it) => { prefs.closeToTray = it.checked; savePrefs(); } },
    ...(app.isPackaged ? [{ label: tm('tray.autostart'), type: 'checkbox', checked: autostartOn(), click: (it) => setAutostart(it.checked) }] : []),
    { label: tm('tray.quit'), icon: img('menu-quit.png'), click: quitApp }
  ]));
}
/* sleep timer: fades out and pauses after N minutes, or at the end of the current track (-1) */
let sleepAt = 0, sleepMin = 0, sleepTimer = null;
function setSleep(min) {
  clearTimeout(sleepTimer); sleepTimer = null; sleepAt = 0; sleepMin = min;
  if (min > 0) {
    sleepAt = Date.now() + min * 60000;
    sleepTimer = setTimeout(() => { send('sleep'); sleepAt = 0; sleepMin = 0; buildTrayMenu(); }, min * 60000);
  } else if (min === -1) { sleepAt = Date.now(); }
  send('sleepMode:' + (min === -1 ? 'end' : min > 0 ? 'time' : 'off'));
  buildTrayMenu();
}
const autostartOn = () => { try { return app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin; } catch { return false; } };
function setAutostart(on) {
  try { app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] }); } catch (e) { logError('autostart', e); }
  buildTrayMenu();
}
const startHidden = process.argv.includes('--hidden');

/** taskbar thumbnail toolbar (hover the taskbar button): ⏮ ⏯ ⏭ */
function updateThumbar() {
  if (!win || process.platform !== 'win32' || !win.isVisible()) return;
  try {
    win.setThumbarButtons([
      { tooltip: tm('tray.prev'), icon: img('tb-prev.png'), flags: media.hasTrack ? [] : ['disabled'], click: () => send('prev') },
      { tooltip: media.playing ? tm('tray.pause') : tm('tray.play'), icon: img(media.playing ? 'tb-pause.png' : 'tb-play.png'), flags: media.hasTrack ? [] : ['disabled'], click: () => send('toggle') },
      { tooltip: tm('tray.next'), icon: img('tb-next.png'), flags: media.hasTrack ? [] : ['disabled'], click: () => send('next') }
    ]);
  } catch (e) { logError('thumbar', e); }
}
function createTray() {
  const icon = img('tray.png');
  icon.addRepresentation({ scaleFactor: 2, buffer: img('tray@2x.png').toPNG() });
  tray = new Tray(icon);
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
  tray.on('double-click', showWindow);
  buildTrayMenu();
}

/* ------------------------------------- IPC ------------------------------------- */
function registerIpc() {
  ipcMain.handle('store:load', async () => {
    try { return JSON.parse(await fsp.readFile(storeFile(), 'utf8')); } catch { return null; }
  });
  // saves are serialised: a slow write can never race the next one
  let saveChain = Promise.resolve();
  ipcMain.handle('store:save', (_e, data) => {
    const json = JSON.stringify(data);
    saveChain = saveChain.catch(() => {}).then(async () => {
      const tmp = storeFile() + '.tmp';
      await fsp.writeFile(tmp, json);
      await fsp.rename(tmp, storeFile()); // atomic replace
    });
    return saveChain.then(() => true, (e) => { logError('save', e); return false; });
  });

  ipcMain.handle('library:pick', async (_e, kind) => {
    const res = await dialog.showOpenDialog(win, kind === 'folder'
      ? { title: tm('dlg.folder'), properties: ['openDirectory', 'multiSelections'] }
      : { title: tm('dlg.files'), properties: ['openFile', 'multiSelections'],
          filters: [{ name: tm('dlg.audio'), extensions: [...AUDIO_EXT].map((e) => e.slice(1)) }] });
    if (res.canceled) return [];
    return collectAudio(res.filePaths);
  });
  ipcMain.handle('library:probe', async (_e, paths) => {
    const files = await collectAudio(Array.isArray(paths) ? paths : []);
    const out = [];
    for (const f of files) out.push(await probe(f));
    return out;
  });
  // custom artwork for a track or playlist: copied into our cover cache so it survives moves of the original
  ipcMain.handle('cover:pick', async () => {
    const res = await dialog.showOpenDialog(win, { title: tm('dlg.cover'), properties: ['openFile'],
      filters: [{ name: tm('dlg.images'), extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }] });
    if (res.canceled || !res.filePaths[0]) return null;
    const src = res.filePaths[0];
    const ext = path.extname(src).toLowerCase();
    if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) throw new Error(tm('err.format'));
    const st = await fsp.stat(src);
    if (st.size > 20 * 1024 * 1024) throw new Error(tm('err.big20'));
    await fsp.mkdir(coversDir(), { recursive: true });
    const dest = path.join(coversDir(), `custom-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`);
    await fsp.copyFile(src, dest);
    return dest;
  });
  // own backgrounds: picked files are copied into userData/backgrounds; images up to 30 MB, videos up to 200 MB
  ipcMain.handle('bg:add', async () => {
    const res = await dialog.showOpenDialog(win, { title: tm('dlg.bg'), properties: ['openFile', 'multiSelections'],
      filters: [{ name: tm('dlg.bgFiles'), extensions: Object.keys(BG_EXT).map((e) => e.slice(1)) }] });
    if (res.canceled) return { added: [], skipped: 0 };
    await fsp.mkdir(backgroundsDir(), { recursive: true });
    const added = []; let skipped = 0;
    for (const src of res.filePaths.slice(0, 20)) {
      const ext = path.extname(src).toLowerCase(), kind = BG_EXT[ext];
      const st = await fsp.stat(src).catch(() => null);
      if (!kind || !st || st.size > (kind === 'video' ? 200 : 30) * 1024 * 1024) { skipped++; continue; }
      const dest = path.join(backgroundsDir(), `bg-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`);
      await fsp.copyFile(src, dest);
      added.push({ path: dest, kind, name: path.basename(src, ext) });
    }
    return { added, skipped };
  });
  // only our own copies can be removed — never anything else on disk
  ipcMain.handle('bg:remove', async (_e, p) => {
    const file = path.normalize(String(p || ''));
    if (!isInside(backgroundsDir(), file)) return false;
    await fsp.rm(file, { force: true });
    return true;
  });
  ipcMain.handle('library:scan', () => findMusicFolders());
  // lyrics: .lrc next to the file, then the tags, then (if allowed) LRCLIB
  ipcMain.handle('lyrics:get', (_e, t, opts) => {
    if (!t || typeof t !== 'object') return null;
    const str = (v) => String(v || '').slice(0, 1000);
    return lyrics.get({ path: str(t.path), title: str(t.title), artist: str(t.artist), album: str(t.album), duration: Number(t.duration) || 0 },
      { online: !!(opts && opts.online), force: !!(opts && opts.force), skipLocal: !!(opts && opts.skipLocal) });
  });
  ipcMain.handle('lyrics:save', (_e, p, text, replace) => lyrics.save(String(p || ''), String(text || ''), !!replace));
  // asked only while the lyrics tab waits for text the user went to copy; long or empty clips are not passed on
  ipcMain.handle('lyrics:clipboard', () => { const s = clipboard.readText() || ''; return s.length > 20000 ? '' : s; });
  // tags and artwork from MusicBrainz / Cover Art Archive for one track (only its names are sent)
  ipcMain.handle('meta:repair', async (_e, t) => {
    if (!t || typeof t !== 'object') return null;
    // names imported before the junk filter existed may still say «1546698_Apoplexy»
    const { stripJunk } = await names();
    const str = (v) => stripJunk(String(v || '').slice(0, 300));
    return musicbrainz.repair({ title: str(t.title), artist: str(t.artist), duration: Number(t.duration) || 0 },
      { wantCover: !!t.wantCover, wantGenre: !!t.wantGenre });
  });
  ipcMain.handle('library:exists', async (_e, p) => fs.existsSync(p));
  ipcMain.handle('library:existsMany', async (_e, paths) => {
    if (!Array.isArray(paths)) return [];
    const out = [];
    for (let i = 0; i < paths.length; i += 64) { // async, in batches: never blocks the window or the tray
      out.push(...await Promise.all(paths.slice(i, i + 64).map((p) => fsp.access(String(p)).then(() => true, () => false))));
    }
    return out;
  });
  ipcMain.handle('library:formatInfo', async (_e, paths) => {
    const out = {};
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, 2000)) out[p] = await formatInfo(p);
    return out;
  });
  // Export of a processed track: the renderer may only write to a path the user just picked
  // in the native save dialog, and only .wav/.mp3.
  const exportTargets = new Set();
  ipcMain.handle('export:pick', async (_e, { name, format }) => {
    const safe = String(name || 'track').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150);
    const wav = { name: tm('dlg.wav'), extensions: ['wav'] }, mp3 = { name: tm('dlg.mp3'), extensions: ['mp3'] };
    await fsp.mkdir(downloadsDir(), { recursive: true }).catch(() => {});
    const res = await dialog.showSaveDialog(win, {
      title: tm('dlg.export'),
      defaultPath: path.join(downloadsDir(), safe + (format === 'wav' ? '.wav' : '.mp3')),
      filters: format === 'wav' ? [wav, mp3] : [mp3, wav]
    });
    if (res.canceled || !res.filePath) return null;
    let fp = res.filePath;
    let ext = path.extname(fp).toLowerCase();
    if (ext !== '.wav' && ext !== '.mp3') {
      fp += format === 'wav' ? '.wav' : '.mp3'; ext = path.extname(fp);
      // the dialog never saw this name, so it never asked about overwriting it
      if (fs.existsSync(fp)) {
        const r = await dialog.showMessageBox(win, { type: 'question', buttons: [tm('dlg.replace'), tm('dlg.cancel')], defaultId: 1, cancelId: 1, message: tm('dlg.exists', path.basename(fp)) });
        if (r.response !== 0) return null;
      }
    }
    exportTargets.add(fp);
    return { path: fp, format: ext.slice(1) };
  });
  ipcMain.handle('export:write', async (_e, { path: fp, data }) => {
    if (!exportTargets.has(fp)) throw new Error('Path was not chosen in the save dialog');
    exportTargets.delete(fp);
    // the save dialog only offers existing folders; mkdir is a fallback, and on Windows
    // mkdir of a drive root ("E:\") fails with EPERM even though the drive is writable
    const dir = path.dirname(fp);
    const exists = await fsp.stat(dir).then((s) => s.isDirectory(), () => false);
    if (!exists) await fsp.mkdir(dir, { recursive: true });
    const tmp = fp + '.part';
    try {
      await fsp.writeFile(tmp, Buffer.from(data.buffer || data, data.byteOffset || 0, data.byteLength));
      await fsp.rename(tmp, fp);
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
    return fp;
  });
  ipcMain.handle('library:reveal', (_e, p) => shell.showItemInFolder(p));

  ipcMain.handle('web:search', async (_e, { query, settings }) => (await webSearch()).searchAll(query, settings || {}));
  ipcMain.handle('web:extract', async (_e, url) => extractAudio(url));
  ipcMain.handle('web:download', async (e, item) => {
    await fsp.mkdir(downloadsDir(), { recursive: true });
    const file = await safeDownload(item, downloadsDir(), (p) => e.sender.send('web:progress', { id: item.id, ...p }));
    return probe(file);
  });
  ipcMain.handle('web:open', (_e, url) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
  });

  // playlist import: only track lists are read (title, artist, album, length); nothing is downloaded
  ipcMain.handle('app:lang', (_e, l) => { setLang(l); buildTrayMenu(); updateThumbar(); });
  ipcMain.handle('app:paths', () => ({ downloads: downloadsDir(), userData: userDir(), downloadsCustom: downloadsDir() !== defaultDownloadsDir() }));
  ipcMain.handle('downloads:pick', async () => {
    const res = await dialog.showOpenDialog(win, { title: tm('dlg.dl'), defaultPath: downloadsDir(), properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return null;
    const dir = res.filePaths[0];
    // the folder must take files: a CD drive or a protected system folder would fail every download later
    try { await fsp.access(dir, fs.constants.W_OK); } catch { throw new Error('not-writable'); }
    prefs.downloadsDir = dir; savePrefs();
    return dir;
  });
  ipcMain.handle('downloads:reset', () => { delete prefs.downloadsDir; savePrefs(); return defaultDownloadsDir(); });
  ipcMain.handle('downloads:open', async () => { await fsp.mkdir(downloadsDir(), { recursive: true }).catch(() => {}); return shell.openPath(downloadsDir()); });

  ipcMain.on('win:min', () => win.minimize());
  // updates: state on request, download / install only on the user's click
  ipcMain.handle('update:get', () => updater.get());
  ipcMain.handle('update:check', () => updater.check(true));
  ipcMain.handle('update:download', () => updater.download());
  ipcMain.on('update:install', () => { quitting = true; updater.install(); });
  ipcMain.handle('discord:set', (_e, on, id) => { discord.configure(!!on, /^\d{15,22}$/.test(String(id || '')) ? String(id) : ''); return discord.status(); });
  // mini player: a small always-on-top strip in the corner; the full window comes back as it was
  ipcMain.on('win:mini', (_e, on, top) => setMini(!!on, top !== false));
  // global hotkeys for keyboards without media keys (the media keys themselves already work through Windows)
  ipcMain.handle('keys:global', (_e, on) => setGlobalKeys(!!on));
  ipcMain.on('win:max', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  ipcMain.on('win:close', () => win.close());
  ipcMain.on('media:state', (_e, st) => {
    const changed = st.playing !== media.playing || st.title !== media.title || st.artist !== media.artist || st.hasTrack !== media.hasTrack;
    Object.assign(media, { title: String(st.title || '').slice(0, 200), artist: String(st.artist || '').slice(0, 200), playing: !!st.playing, hasTrack: !!st.hasTrack });
    if (changed) { buildTrayMenu(); updateThumbar(); }
    discord.update({ ...media, position: Number(st.position) || 0, duration: Number(st.duration) || 0 });
  });
  ipcMain.handle('app:pendingFiles', () => { const f = pendingFiles; pendingFiles = []; return f; });
  ipcMain.handle('app:prefs', () => ({ closeToTray: prefs.closeToTray, autostart: app.isPackaged ? autostartOn() : null }));
  ipcMain.on('sleep:ended', () => { sleepAt = 0; sleepMin = 0; buildTrayMenu(); });
  ipcMain.handle('app:setPref', (_e, { key, value }) => {
    if (key === 'closeToTray') { prefs.closeToTray = !!value; savePrefs(); buildTrayMenu(); }
    if (key === 'autostart' && app.isPackaged) setAutostart(!!value);
    return true;
  });
}

/* ----------------------------------- startup ---------------------------------- */
// Safety net: a misbehaving remote server must never pop a crash dialog — log and keep playing.
const logFile = () => path.join(app.getPath('userData'), 'errors.log');
function logError(kind, err) {
  try { fs.appendFileSync(logFile(), `[${new Date().toISOString()}] ${kind}: ${err && err.stack || err}\n`); } catch {}
}
process.on('uncaughtException', (e) => logError('uncaught', e));
process.on('unhandledRejection', (e) => logError('unhandled', e));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv, workingDirectory) => {
    if (!win) return;
    showWindow();
    const files = argv.filter((a) => AUDIO_EXT.has(path.extname(a).toLowerCase())).map((a) => path.resolve(workingDirectory || process.cwd(), a));
    if (files.length) win.webContents.send('open-files', files);
  });
  app.whenReady().then(() => {
    nativeTheme.themeSource = 'light';
    registerProtocol();
    loadPrefs();
    musicbrainz.init({ version: app.getVersion(), coversDir });
    // the portable build can't replace itself; it only hears that a new version exists
    updater.init({ send: (st) => { if (win && !win.isDestroyed()) win.webContents.send('update:state', st); }, canInstall: !process.env.PORTABLE_EXECUTABLE_DIR, log: (k, e) => logError(k, e) });
    lyrics.init({ version: app.getVersion(), userDir, audioExt: AUDIO_EXT, names, identify: musicbrainz.identify, sim: musicbrainz.sim, norm: musicbrainz.norm });
    registerIpc();
    createWindow();
    createTray();
    // files from "Open with": the renderer asks for them once it is ready (no fixed delay)
    pendingFiles = process.argv.slice(1).filter((a) => AUDIO_EXT.has(path.extname(a).toLowerCase())).map((a) => path.resolve(a));
  });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => globalShortcut.unregisterAll());
  // Windows logoff / shutdown must never be blocked by close-to-tray
  app.on('session-end', () => { quitting = true; });
  app.whenReady().then(() => powerMonitor.on('shutdown', () => { quitting = true; app.quit(); }));
  app.on('window-all-closed', () => { if (quitting || !prefs.closeToTray) app.quit(); });
}