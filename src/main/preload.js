// Runs in every window before the page loads. Pages have no Node.js access;
// they talk to the main process only through the channels listed here.
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE_CHANNELS = new Set([
  'clear-multiview-output',
  'close-output-window',
  'create-output-window',
  'decklink-clear-output',
  'decklink-list-devices',
  'decklink-set-output',
  'decklink-set-video-mode',
  'ensure-fresh-first-run',
  'get-app-version',
  'get-displays',
  'get-player-schedules',
  'get-player-state',
  'pick-folder',
  'reload-folder',
  'select-folder',
  'set-multiview-output',
  'set-player-schedules',
  'set-player-state',
]);

const SEND_CHANNELS = new Set([
  'debug-log',
  'multiview-grid-mode',
  'multiview-update',
  'output-video-ended',
  'set-layout-min-size',
  'stop-decklink-video',
  'update-background-color',
  'update-output-image',
]);

const RECEIVE_CHANNELS = new Set([
  'always-on-top-changed',
  'debug-log-buffer',
  'debug-log-entry',
  'decklink-outputs-restored',
  'displays-changed',
  'folder-updated',
  'images-updated',
  'init-player',
  'multiview-grid-mode',
  'multiview-output-closed',
  'multiview-player-update',
  'multiview-state',
  'open-help',
  'open-multiview-settings',
  'open-output-settings',
  'player-configurations-imported',
  'player-output-lost',
  'player-output-video-ended',
  'reset-all-to-default',
  'set-global-tab',
  'set-player-layout',
  'set-schedule-sort',
  'stop-all-players',
  'toggle-schedule-sort',
  'update-background-color',
  'update-image',
]);

function assertChannel(allowed, channel) {
  if (!allowed.has(channel)) {
    throw new Error(`IPC channel not allowed: ${channel}`);
  }
}

// Same method names as ipcRenderer so the page scripts barely change.
// Listeners get an empty object in place of the IPC event, which would
// otherwise hand the page a reference back to ipcRenderer.
contextBridge.exposeInMainWorld('slideRoller', {
  ipc: {
    invoke(channel, ...args) {
      assertChannel(INVOKE_CHANNELS, channel);
      return ipcRenderer.invoke(channel, ...args);
    },
    send(channel, ...args) {
      assertChannel(SEND_CHANNELS, channel);
      ipcRenderer.send(channel, ...args);
    },
    on(channel, listener) {
      assertChannel(RECEIVE_CHANNELS, channel);
      ipcRenderer.on(channel, (_event, ...args) => listener({}, ...args));
    },
  },
});
