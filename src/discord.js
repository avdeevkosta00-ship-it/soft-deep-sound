'use strict';
/**
 * Discord Rich Presence: «Listening to Soft&Deep Sound — Title · Artist», with the elapsed time.
 * Talks only to the Discord app running on this computer (local IPC); nothing goes over the network.
 * Off by default; it needs a Discord application ID (its name is what Discord shows above the track).
 */
let RPC = null, client = null, ready = false, wanted = false, clientId = '', last = null, retry = null;

function load() {
  if (RPC) return true;
  try { RPC = require('discord-rpc'); return true; } catch { return false; }
}

async function connect() {
  if (!wanted || !clientId || !load() || client) return;
  client = new RPC.Client({ transport: 'ipc' });
  client.on('ready', () => { ready = true; if (last) push(last); });
  client.on('disconnected', () => { ready = false; client = null; schedule(); });
  try { await client.login({ clientId }); }
  catch { ready = false; try { client.destroy(); } catch {} client = null; schedule(); } // Discord not running: try later
}
function schedule() { clearTimeout(retry); if (wanted) retry = setTimeout(connect, 30000); }

function push(st) {
  if (!ready || !client) return;
  if (!st || !st.hasTrack) { client.clearActivity().catch(() => {}); return; }
  const act = {
    details: String(st.title || '').slice(0, 120) || '—',
    state: String(st.artist || '').slice(0, 120) || undefined,
    largeImageText: 'Soft&Deep Sound',
    instance: false
  };
  if (st.playing && st.duration > 0) {
    const now = Date.now();
    act.startTimestamp = Math.round(now - (st.position || 0) * 1000);
    act.endTimestamp = Math.round(now + (st.duration - (st.position || 0)) * 1000);
  } else act.smallImageText = 'Пауза';
  client.setActivity(act).catch(() => {});
}

module.exports = {
  /** on/off and the application ID; reconnects when either changes */
  configure(on, id) {
    const changed = id !== clientId;
    wanted = !!on; clientId = String(id || '').trim();
    if ((!wanted || changed) && client) { try { client.clearActivity().catch(() => {}); client.destroy(); } catch {} client = null; ready = false; }
    if (wanted) connect(); else clearTimeout(retry);
  },
  update(st) { last = st; push(st); },
  status: () => ({ on: wanted, connected: ready })
};
