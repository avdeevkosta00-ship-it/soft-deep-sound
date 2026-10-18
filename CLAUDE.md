# Soft&Deep Sound

Desktop music player for Windows. Electron with vanilla HTML/CSS/JS (no frameworks, no bundler).
Author: Konstantin. Repo: github.com/infallibl3/soft-deep-sound. Current version: 1.10.0.

## Communication
- Talk to the user in Russian, briefly and warmly. The user is learning: explain git/terminal steps plainly.
- UI text exists in two languages: every new string goes into `renderer/js/i18n.js` (RU and EN).

## Commands
- `npm install` — dependencies
- `npm start` — run from sources (`npm run dev` opens DevTools)
- `npm run dist` or `BUILD-EXE.bat` — build installer + portable into `dist/`
- Release: a `vX.Y.Z` tag pushed to GitHub builds the release in GitHub Actions.
- `dist/` is build output: editing sources does not change it until you rebuild.

## Layout
- `main.js` — main process: window, `sds://` protocol (app files + local media with Range), library store (`library.json` in userData), metadata (music-metadata), tray, thumbar, sleep timer, export writes, IPC.
- `preload.js` — narrow `window.sds` bridge (contextIsolation, sandbox). The renderer never gets Node.
- `src/search/` — web search in open sources (Openverse, Internet Archive, ccMixter, Jamendo), safe downloads (`http.js` blocks private addresses and checks every redirect).
- `src/import/deezer.js` — playlist/album import via Deezer public API.
- `src/meta/musicbrainz.js` — library repair: tags from MusicBrainz (1 req/s queue, descriptive User-Agent), artwork from Cover Art Archive into the covers cache. Never rewrites audio files; only fills empty fields after the user reviews them.
- `src/meta/lyrics.js` — lyrics: sidecar `.lrc`, then file tags, then LRCLIB (a track without an artist is first identified by MusicBrainz `identify()` from title + length and offered as «Похоже, это …») (only if `lyricsOnline` is on; cached in userData/lyrics). Shown in Deep View's «Текст» mode (`renderer/js/lyrics.js` parses LRC); key L.
- `src/import/spotify.js` — Spotify import: official Web API, user login via Authorization Code + PKCE, loopback redirect `http://127.0.0.1:43117/callback`, tokens encrypted with safeStorage. Uses the Feb 2026 API (`/playlists/{id}/items`, entries carry `item`).
- `renderer/index.html`, `renderer/styles.css`, `renderer/themes-sd.css` — markup and styles; themes Soft, Deep, Pearl, Obsidian via CSS variables on `[data-theme]` / `[data-tone]`.
- `renderer/js/app.js` — state `S`, library, playlists, views, search, settings, keyboard, boot.
- `renderer/js/bridge.js` — `window.sds` in Electron, or a mock with demo tracks when opened in a plain browser (handy for UI checks).
- Other modules: `audio-engine.js`, `tools.js` (pitch/ambient/EQ), `exporter.js`, `smart.js` (analysis, Smart Session), `fuzzy.js` (typo/translit/layout search), `deepview.js`, `visual.js`, `visualizer.js`, `import-match.js` + `playlist-import.js` (playlist import UI and matching), `library-repair.js` ("Find music" on this computer, artwork/tags review in Library health), `names.js` (cleans download junk from names: ids like `1546698_`, site tags, «official audio»; shared with main.js via `import()`, hence `renderer/js/package.json` with `"type": "module"`), `appearance.js` (accent colour: theme / preset / custom / from the cover, living background live·calm·still·off, glass blur — inline CSS variables on <html> over the theme), `tour.js` (short welcome tour + showcase after the first music; full tour on «?»), `ui.js` helpers (`h`, `toast`, `openModal`).

## Rules
- Keep the security model: no Node in the renderer, CSP in `index.html`, only https opened externally, media served only for audio files and the covers cache.
- No piracy sources: do not add mp3 sites or play audio from YouTube/Spotify. Imports transfer track names only and match them to local files.
- Do not copy code from projects with incompatible licenses (e.g. Liner is source-available, not open).
- Do not reverse-engineer private APIs or extract secrets from other apps' web clients.
- New UI must work in all four themes and both languages; reuse existing classes (`chip-btn`, `seg`, `ss-mood`, `notice`, `modal-card`).
- Bump `package.json` version and the splash label in `index.html` for releases.
