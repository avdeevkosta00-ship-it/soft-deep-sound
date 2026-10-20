'use strict';
/**
 * Updates from GitHub Releases (electron-updater). The installed (NSIS) app checks a few seconds after start
 * and every 6 hours; nothing is downloaded without the user's click: «Download» → progress → «Restart».
 * The portable build and runs from sources only report that a new version exists (with a link).
 */
const { app } = require('electron');

const EVERY = 6 * 3600 * 1000;
let deps = null, au = null, state = { status: 'idle' }, timer = null;

function emit(patch) {
  state = { ...state, ...patch };
  deps.send(state);
}

function init(d) {
  deps = d; // { send(state), canInstall: bool, log(kind, err) }
  if (!app.isPackaged) return;
  try { au = require('electron-updater').autoUpdater; } catch (e) { deps.log('updater', e); return; }
  au.autoDownload = false;
  au.autoInstallOnAppQuit = true;
  au.allowPrerelease = false;
  au.on('checking-for-update', () => emit({ status: 'checking' }));
  au.on('update-available', (i) => emit({ status: 'available', version: i.version, notes: String(i.releaseNotes || '').slice(0, 2000) }));
  au.on('update-not-available', () => emit({ status: 'latest' }));
  au.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  au.on('update-downloaded', (i) => emit({ status: 'ready', version: i.version }));
  au.on('error', (e) => { deps.log('updater', e); emit({ status: 'error', error: String(e && e.message || e).slice(0, 200) }); });
  setTimeout(() => check(false), 8000);
  timer = setInterval(() => check(false), EVERY);
}

async function check(manual) {
  if (!au) return { status: app.isPackaged ? 'error' : 'dev' };
  try { await au.checkForUpdates(); } catch (e) { if (manual) emit({ status: 'error', error: String(e.message || e).slice(0, 200) }); }
  return state;
}
async function download() { if (!au || !deps.canInstall) return state; try { await au.downloadUpdate(); } catch (e) { emit({ status: 'error', error: String(e.message || e) }); } return state; }
function install() { if (au && state.status === 'ready') setImmediate(() => au.quitAndInstall(false, true)); }
const get = () => ({ ...state, ...(app.isPackaged ? {} : { status: 'dev' }), current: app.getVersion(), canInstall: !!deps && deps.canInstall });

module.exports = { init, check, download, install, get, stop: () => clearInterval(timer) };
