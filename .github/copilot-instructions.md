## Slide Roller

Electron app for macOS that runs 4 independent image/video playlist players, each routed to a fullscreen monitor window or a Blackmagic DeckLink output. See README.md for features and setup.

### Layout
- `src/main/main.js`: main process. Windows, menus, folder watching (chokidar), saved state (electron-store), image decoding (sharp), DeckLink routing.
- `src/main/preload.js`: the only bridge between pages and the main process. Exposes `window.slideRoller.ipc` with `invoke`, `send` and `on`, limited to allowlisted channels.
- `src/main/decklink.js`, `decklink-worker.js`: load the native add-on; device listing runs in a child process.
- `src/native/decklink-addon/decklink_addon.cc`: N-API add-on for DeckLink output. Video is decoded by ffmpeg (ffmpeg-static), started with `posix_spawn` and an argument list.
- `src/renderer/`: plain HTML/CSS/JS pages (no framework): `index.html` (control UI), `output.html`, `player-view.html` (multiview), `help.html`, `debug.html`.

### Security rules
- Every window uses `secureWebPreferences()`: sandboxed, context isolation on, no Node.js. Keep it that way.
- A new IPC channel must be added to the matching allowlist in `preload.js`, and registered in the main process with `handleTrusted` / `onTrusted` (never `ipcMain` directly), which reject messages from anything but the bundled pages.
- Pages have a strict Content-Security-Policy: no inline scripts, no remote content. Put scripts in their own `.js` files.
- Never pass file names or other user data through a shell. Spawn processes with an argument list.
- Set text with `textContent`, not `innerHTML`, when it includes file names or imported data.

### Releases
Bump the version, commit "Release vX: ..." on main, tag `vX`, push main and the tag. `.github/workflows/release.yml` builds, signs and notarizes on macOS and publishes the GitHub release.
