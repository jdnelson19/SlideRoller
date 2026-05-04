const { app, BrowserWindow, ipcMain, dialog, screen, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const chokidar = require('chokidar');
const Store = require('electron-store');
const sharp = require('sharp');
const decklink = require('./decklink');

const scheduleStore = new Store({ name: 'player-schedules' });
const playerStateStore = new Store({ name: 'player-states' });
const appStateStore = new Store({ name: 'app-state' });

let mainWindow;
let outputWindows = {};
let folderWatchers = {}; // Track folder watchers for each player
let decklinkOutputs = {}; // Track DeckLink output selection per player
let decklinkSettings = { videoMode: null };
let decklinkFrameJobs = {};
let decklinkFramePending = {};
let decklinkActiveModes = {};
let decklinkTestPatternTimers = {};
let quitConfirmed = false;
let debugWindow = null;
let helpWindow = null;
let multiviewWindow = null;
let suppressOutputLostForPlayer = {};
const debugLogBuffer = [];
const multiviewState = {
  gridMode: '2x2',
  players: {
    1: null,
    2: null,
    3: null,
    4: null
  }
};
const MAX_DEBUG_LOG_ENTRIES = 2000;

const DEFAULT_DECKLINK_VIDEO_MODE = '1080p59.94';
const DECKLINK_VIDEO_MODE_CONFIG = {
  '1080i59.94': { width: 1920, height: 1080, fps: 29.97 },
  '1080i50': { width: 1920, height: 1080, fps: 25 },
  '1080p60': { width: 1920, height: 1080, fps: 60 },
  '1080p59.94': { width: 1920, height: 1080, fps: 59.94 },
  '1080p50': { width: 1920, height: 1080, fps: 50 },
  '1080p30': { width: 1920, height: 1080, fps: 30 },
  '1080p29.97': { width: 1920, height: 1080, fps: 29.97 },
  '1080p25': { width: 1920, height: 1080, fps: 25 },
  '1080p24': { width: 1920, height: 1080, fps: 24 },
  '1080p23.98': { width: 1920, height: 1080, fps: 23.98 }
};

function formatDebugArg(value) {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }

  if (typeof value === 'string') return value;

  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function pushDebugLog(level, source, args) {
  const messageParts = Array.isArray(args) ? args : [args];
  const message = messageParts.map(formatDebugArg).join(' ');
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message
  };

  debugLogBuffer.push(entry);
  if (debugLogBuffer.length > MAX_DEBUG_LOG_ENTRIES) {
    debugLogBuffer.shift();
  }

  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.webContents.send('debug-log-entry', entry);
  }
}

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

['log', 'info', 'warn', 'error'].forEach(level => {
  console[level] = (...args) => {
    originalConsole[level](...args);
    pushDebugLog(level, 'main', args);
  };
});

function createDebugWindow() {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.focus();
    return;
  }

  debugWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    title: 'Slide Roller Debug Logs',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  debugWindow.loadFile('src/renderer/debug.html');

  debugWindow.webContents.on('did-finish-load', () => {
    debugWindow.webContents.send('debug-log-buffer', debugLogBuffer);
  });

  debugWindow.on('closed', () => {
    debugWindow = null;
  });
}

function createHelpWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.focus();
    return;
  }

  helpWindow = new BrowserWindow({
    width: 760,
    height: 760,
    minWidth: 620,
    minHeight: 520,
    title: 'Slide Roller Help',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  helpWindow.loadFile('src/renderer/help.html');

  helpWindow.on('closed', () => {
    helpWindow = null;
  });
}

function closeMultiviewWindow() {
  const existingWindow = multiviewWindow;
  if (existingWindow && !existingWindow.isDestroyed()) {
    existingWindow.close();
    if (!existingWindow.isDestroyed()) {
      existingWindow.destroy();
    }
  }
  multiviewWindow = null;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('multiview-output-closed');
  }
}

function createMultiviewWindow(displayId) {
  const displays = screen.getAllDisplays();
  const targetDisplay = displays.find(display => display.id === displayId);
  if (!targetDisplay) {
    return { success: false, error: 'Display not found' };
  }

  if (multiviewWindow && !multiviewWindow.isDestroyed()) {
    multiviewWindow.close();
  }

  multiviewWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#000000'
  });

  multiviewWindow.multiviewDisplayId = displayId;
  multiviewWindow.loadFile('src/renderer/player-view.html');

  multiviewWindow.webContents.on('did-finish-load', () => {
    multiviewWindow.webContents.send('multiview-state', multiviewState);
  });

  multiviewWindow.on('closed', () => {
    multiviewWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('multiview-output-closed');
    }
  });

  return { success: true };
}

function broadcastMultiviewPlayerUpdate(playerId, payload) {
  multiviewState.players[playerId] = payload;

  if (multiviewWindow && !multiviewWindow.isDestroyed()) {
    multiviewWindow.webContents.send('multiview-player-update', { playerId, payload });
  }
}

function broadcastMultiviewGridMode(gridMode) {
  multiviewState.gridMode = gridMode;

  if (multiviewWindow && !multiviewWindow.isDestroyed()) {
    multiviewWindow.webContents.send('multiview-grid-mode', { gridMode });
  }
}

function notifyPlayerOutputLost(playerId, reason = 'Output connection was lost.') {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-output-lost', { playerId, reason });
  }
}

function handleDisplayRemoved(removedDisplay) {
  if (!removedDisplay) return;

  if (multiviewWindow && !multiviewWindow.isDestroyed() && multiviewWindow.multiviewDisplayId === removedDisplay.id) {
    multiviewWindow.close();
  }

  Object.entries(outputWindows).forEach(([playerKey, outputWindow]) => {
    const playerId = Number.parseInt(playerKey, 10);
    if (!outputWindow || outputWindow.isDestroyed()) return;

    const outputDisplayId = outputWindow.outputDisplayId;
    if (outputDisplayId !== removedDisplay.id) return;

    outputWindow.close();
    // The window 'closed' handler will emit player-output-lost.
    delete outputWindows[playerId];
  });
}

function getDeckLinkVideoModeConfig(mode) {
  return DECKLINK_VIDEO_MODE_CONFIG[mode] || DECKLINK_VIDEO_MODE_CONFIG[DEFAULT_DECKLINK_VIDEO_MODE];
}

function getActiveDeckLinkDeviceIndices(excludePlayerId = null) {
  const entries = Object.entries(decklinkOutputs);
  return new Set(entries
    .filter(([playerId]) => excludePlayerId === null || String(playerId) !== String(excludePlayerId))
    .map(([, output]) => output.index));
}

async function startDeckLinkOutput(deviceIndex) {
  const videoMode = decklinkSettings.videoMode || DEFAULT_DECKLINK_VIDEO_MODE;
  const startResult = decklink.startOutput({ deviceIndex, videoMode });
  if (!startResult || !startResult.ok) {
    return { success: false, error: startResult?.error || 'DeckLink output start failed.' };
  }
  console.log(`DeckLink output ${deviceIndex} started`, startResult);
  decklinkActiveModes[deviceIndex] = {
    width: startResult.width || getDeckLinkVideoModeConfig(videoMode).width,
    height: startResult.height || getDeckLinkVideoModeConfig(videoMode).height,
    videoMode: startResult.mode || videoMode
  };
  return { success: true };
}

async function stopDeckLinkOutputIfUnused(deviceIndex) {
  const active = getActiveDeckLinkDeviceIndices();
  if (!active.has(deviceIndex)) {
    decklink.stopOutput(deviceIndex);
    delete decklinkActiveModes[deviceIndex];
    if (decklinkTestPatternTimers[deviceIndex]) {
      clearInterval(decklinkTestPatternTimers[deviceIndex]);
      delete decklinkTestPatternTimers[deviceIndex];
    }
  }
}

async function sendDeckLinkFrame(deviceIndex, imagePath, scaleFill) {
  if (!imagePath) return;

  const activeMode = decklinkActiveModes[deviceIndex];
  const videoMode = activeMode?.videoMode || decklinkSettings.videoMode || DEFAULT_DECKLINK_VIDEO_MODE;
  const { width, height } = activeMode || getDeckLinkVideoModeConfig(videoMode);

  try {
    const { data, info } = await sharp(imagePath)
      .resize(width, height, {
        fit: scaleFill ? 'cover' : 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const uyvy = convertRgbaToUyvy(data, info.width, info.height);
    const result = decklink.sendFrame({ deviceIndex, frame: uyvy, width: info.width, height: info.height });
    if (!result?.ok) {
      console.warn('DeckLink frame send failed:', result?.error);
    } else if (decklinkTestPatternTimers[deviceIndex]) {
      clearInterval(decklinkTestPatternTimers[deviceIndex]);
      delete decklinkTestPatternTimers[deviceIndex];
    }
  } catch (error) {
    console.warn('DeckLink frame processing failed:', error.message || error);
  }
}

function generateDeckLinkTestPattern(width, height) {
  const uyvy = Buffer.alloc(width * height * 2);
  const lumaLevels = [235, 210, 180, 150, 120, 90, 60];
  const barWidth = Math.max(1, Math.floor(width / lumaLevels.length));

  let outIndex = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const barIndex = Math.min(lumaLevels.length - 1, Math.floor(x / barWidth));
      const y0 = lumaLevels[barIndex];
      const y1 = lumaLevels[Math.min(lumaLevels.length - 1, Math.floor((x + 1) / barWidth))];
      uyvy[outIndex++] = 128; // U
      uyvy[outIndex++] = y0;  // Y0
      uyvy[outIndex++] = 128; // V
      uyvy[outIndex++] = y1;  // Y1
    }
  }

  return uyvy;
}

function sendDeckLinkTestPattern(deviceIndex) {
  const activeMode = decklinkActiveModes[deviceIndex];
  const videoMode = activeMode?.videoMode || decklinkSettings.videoMode || DEFAULT_DECKLINK_VIDEO_MODE;
  const { width, height } = activeMode || getDeckLinkVideoModeConfig(videoMode);
  const frame = generateDeckLinkTestPattern(width, height);
  const result = decklink.sendFrame({ deviceIndex, frame, width, height });
  if (!result?.ok) {
    console.warn('DeckLink test pattern send failed:', result?.error, result);
  }
}

function startDeckLinkTestPattern(deviceIndex) {
  if (decklinkTestPatternTimers[deviceIndex]) return;
  sendDeckLinkTestPattern(deviceIndex);
  decklinkTestPatternTimers[deviceIndex] = setInterval(() => {
    sendDeckLinkTestPattern(deviceIndex);
  }, 1000);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function convertRgbaToUyvy(rgba, width, height) {
  const uyvy = Buffer.alloc(width * height * 2);
  let outIndex = 0;
  const isHD = width >= 1280;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 2) {
      const i0 = (y * width + x) * 4;
      const i1 = (y * width + Math.min(x + 1, width - 1)) * 4;

      const r0 = rgba[i0];
      const g0 = rgba[i0 + 1];
      const b0 = rgba[i0 + 2];

      const r1 = rgba[i1];
      const g1 = rgba[i1 + 1];
      const b1 = rgba[i1 + 2];

      let y0;
      let y1;
      let u0;
      let v0;
      let u1;
      let v1;

      if (isHD) {
        // BT.709 limited range
        y0 = 16 + (0.183 * r0 + 0.614 * g0 + 0.062 * b0);
        y1 = 16 + (0.183 * r1 + 0.614 * g1 + 0.062 * b1);
        u0 = 128 + (-0.101 * r0 - 0.339 * g0 + 0.439 * b0);
        v0 = 128 + (0.439 * r0 - 0.399 * g0 - 0.040 * b0);
        u1 = 128 + (-0.101 * r1 - 0.339 * g1 + 0.439 * b1);
        v1 = 128 + (0.439 * r1 - 0.399 * g1 - 0.040 * b1);
      } else {
        // BT.601 limited range
        y0 = 16 + (0.257 * r0 + 0.504 * g0 + 0.098 * b0);
        y1 = 16 + (0.257 * r1 + 0.504 * g1 + 0.098 * b1);
        u0 = 128 + (-0.148 * r0 - 0.291 * g0 + 0.439 * b0);
        v0 = 128 + (0.439 * r0 - 0.368 * g0 - 0.071 * b0);
        u1 = 128 + (-0.148 * r1 - 0.291 * g1 + 0.439 * b1);
        v1 = 128 + (0.439 * r1 - 0.368 * g1 - 0.071 * b1);
      }

      const u = (u0 + u1) / 2;
      const v = (v0 + v1) / 2;

      uyvy[outIndex++] = clampByte(u);
      uyvy[outIndex++] = clampByte(y0);
      uyvy[outIndex++] = clampByte(v);
      uyvy[outIndex++] = clampByte(y1);
    }
  }

  return uyvy;
}

function queueDeckLinkFrame(playerId, payload) {
  if (decklinkFrameJobs[playerId]) {
    decklinkFramePending[playerId] = payload;
    return;
  }

  decklinkFrameJobs[playerId] = sendDeckLinkFrame(payload.deviceIndex, payload.imagePath, payload.scaleFill)
    .finally(() => {
      decklinkFrameJobs[playerId] = null;
      const pending = decklinkFramePending[playerId];
      if (pending) {
        decklinkFramePending[playerId] = null;
        queueDeckLinkFrame(playerId, pending);
      }
    });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    },
    title: 'Slide Roller'
  });

  mainWindow.loadFile('src/renderer/index.html');

  const template = [
    ...(process.platform === 'darwin'
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Export Player Configurations...',
          accelerator: 'CommandOrControl+E',
          click: async () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;

            const defaultPath = `slide-roller-config-${new Date().toISOString().slice(0, 10)}.json`;
            const saveResult = await dialog.showSaveDialog(mainWindow, {
              title: 'Export Player Configurations',
              defaultPath,
              filters: [{ name: 'JSON', extensions: ['json'] }]
            });

            if (saveResult.canceled || !saveResult.filePath) return;

            try {
              const exportPayload = {
                version: 1,
                app: 'Slide Roller',
                exportedAt: new Date().toISOString(),
                players: {}
              };

              for (let playerId = 1; playerId <= 4; playerId += 1) {
                exportPayload.players[playerId] = {
                  state: playerStateStore.get(`player${playerId}State`, null),
                  schedules: scheduleStore.get(`player${playerId}Schedules`, null)
                };
              }

              await fs.promises.writeFile(saveResult.filePath, JSON.stringify(exportPayload, null, 2), 'utf8');

              await dialog.showMessageBox(mainWindow, {
                type: 'info',
                title: 'Export Complete',
                message: 'Player configurations were exported successfully.',
                detail: saveResult.filePath
              });
            } catch (error) {
              await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Export Failed',
                message: 'Unable to export player configurations.',
                detail: error.message || String(error)
              });
            }
          }
        },
        {
          label: 'Import Player Configurations...',
          click: async () => {
            if (!mainWindow || mainWindow.isDestroyed()) return;

            const openResult = await dialog.showOpenDialog(mainWindow, {
              title: 'Import Player Configurations',
              properties: ['openFile'],
              filters: [{ name: 'JSON', extensions: ['json'] }]
            });

            if (openResult.canceled || openResult.filePaths.length === 0) return;

            const [filePath] = openResult.filePaths;

            try {
              const raw = await fs.promises.readFile(filePath, 'utf8');
              const parsed = JSON.parse(raw);
              if (!parsed || typeof parsed !== 'object' || !parsed.players || typeof parsed.players !== 'object') {
                throw new Error('Invalid configuration file format.');
              }

              for (let playerId = 1; playerId <= 4; playerId += 1) {
                const entry = parsed.players[playerId] || parsed.players[String(playerId)] || {};

                if (entry.state) {
                  playerStateStore.set(`player${playerId}State`, entry.state);
                } else {
                  playerStateStore.delete(`player${playerId}State`);
                }

                if (entry.schedules) {
                  scheduleStore.set(`player${playerId}Schedules`, entry.schedules);
                } else {
                  scheduleStore.delete(`player${playerId}Schedules`);
                }
              }

              if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('player-configurations-imported', { filePath });
              }
            } catch (error) {
              await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: 'Import Failed',
                message: 'Unable to import player configurations.',
                detail: error.message || String(error)
              });
            }
          }
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Outputs',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-output-settings');
            }
          }
        },
        {
          label: 'Multiview',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-multiview-settings');
            }
          }
        },
        {
          label: 'Debug',
          accelerator: 'CommandOrControl+D',
          click: () => {
            createDebugWindow();
          }
        },
        {
          label: 'Stop All Players',
          accelerator: 'CommandOrControl+P',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('stop-all-players');
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Reset All to Default',
          click: () => {
            scheduleStore.clear();
            playerStateStore.clear();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('reset-all-to-default');
            }
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { role: 'minimize' },
        {
          label: 'Always on Top',
          accelerator: 'CommandOrControl+F',
          type: 'checkbox',
          checked: false,
          click: menuItem => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              const enabled = !!menuItem.checked;
              mainWindow.setAlwaysOnTop(enabled);
              mainWindow.webContents.send('always-on-top-changed', { enabled });
            }
          }
        },
        { type: 'separator' },
        {
          label: 'Layout',
          submenu: [
            {
              label: '2 Player',
              accelerator: 'CommandOrControl+1',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('set-player-layout', { mode: 'two' });
                }
              }
            },
            {
              label: '4 Player',
              accelerator: 'CommandOrControl+2',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('set-player-layout', { mode: 'four' });
                }
              }
            },
            {
              label: '2 x 2',
              accelerator: 'CommandOrControl+3',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('set-player-layout', { mode: 'grid-2x2' });
                }
              }
            },
            {
              label: '1 x 4',
              accelerator: 'CommandOrControl+4',
              click: () => {
                if (mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('set-player-layout', { mode: 'stack-1x4' });
                }
              }
            }
          ]
        },
        { type: 'separator' },
        {
          label: 'Transition',
          accelerator: 'CommandOrControl+T',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('set-global-tab', { tab: 'transition' });
            }
          }
        },
        {
          label: 'Schedule',
          accelerator: 'CommandOrControl+S',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('set-global-tab', { tab: 'schedule' });
            }
          }
        },
        {
          label: 'Output',
          accelerator: 'CommandOrControl+O',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('set-global-tab', { tab: 'output' });
            }
          }
        },
        {
          type: 'separator'
        },
        {
          label: 'Global Transition',
          accelerator: 'CommandOrControl+G',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('toggle-global-transition-footer');
            }
          }
        }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Help',
          accelerator: 'CommandOrControl+H',
          click: () => {
            createHelpWindow();
          }
        },
        {
          label: 'Report a Problem',
          click: () => {
            shell.openExternal('https://github.com/jdnelson19/SlideRoller/issues').catch(error => {
              console.error('Failed to open Report a Problem URL:', error);
            });
          }
        }
      ]
    },
    // Intentionally omit Edit/View/Window/Help menus
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    // Close all output windows
    Object.values(outputWindows).forEach(win => {
      if (win && !win.isDestroyed()) {
        win.close();
      }
    });
    closeMultiviewWindow();
    if (helpWindow && !helpWindow.isDestroyed()) {
      helpWindow.close();
    }
    // Stop all folder watchers
    Object.keys(folderWatchers).forEach(playerId => {
      stopWatchingFolder(playerId);
    });
  });
}

function broadcastDisplaysChanged() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('displays-changed');
  }
}

app.whenReady().then(() => {
  createWindow();

  screen.on('display-added', broadcastDisplaysChanged);
  screen.on('display-removed', (event, removedDisplay) => {
    handleDisplayRemoved(removedDisplay);
    broadcastDisplaysChanged();
  });
  screen.on('display-metrics-changed', broadcastDisplaysChanged);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (!quitConfirmed) {
    const focusedWindow = BrowserWindow.getFocusedWindow() || mainWindow || null;
    const response = dialog.showMessageBoxSync(focusedWindow, {
      type: 'question',
      buttons: ['Cancel', 'Quit'],
      defaultId: 1,
      cancelId: 0,
      title: 'Confirm Quit',
      message: 'Quit Slide Roller?',
      detail: 'Quitting now may interrupt live video output and active schedules.'
    });

    if (response !== 1) {
      event.preventDefault();
      return;
    }

    quitConfirmed = true;
  }

  const activeDevices = getActiveDeckLinkDeviceIndices();
  for (const deviceIndex of activeDevices) {
    decklink.stopOutput(deviceIndex);
  }
});

// IPC Handlers

// Select folder for a player
ipcMain.handle('select-folder', async (event, playerId) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    const folderPath = result.filePaths[0];
    const images = await getImagesFromFolder(folderPath);
    
    // Start watching this folder
    startWatchingFolder(playerId, folderPath);
    
    return { path: folderPath, images };
  }

  return null;
});

// Pick a folder path without starting playback/watcher
ipcMain.handle('pick-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return { path: result.filePaths[0] };
  }

  return null;
});

// Schedule persistence (per player)
ipcMain.handle('get-player-schedules', async (event, playerId) => {
  return scheduleStore.get(`player${playerId}Schedules`, null);
});

ipcMain.handle('set-player-schedules', async (event, { playerId, schedules }) => {
  scheduleStore.set(`player${playerId}Schedules`, schedules);
  return true;
});

// Player state persistence
ipcMain.handle('get-player-state', async (event, playerId) => {
  return playerStateStore.get(`player${playerId}State`, null);
});

ipcMain.handle('set-player-state', async (event, { playerId, state }) => {
  playerStateStore.set(`player${playerId}State`, state);
  return true;
});

ipcMain.handle('open-debug-window', async () => {
  createDebugWindow();
  return true;
});

ipcMain.handle('set-multiview-output', async (event, { displayId, gridMode }) => {
  const nextGridMode = gridMode === '2x1' ? '2x1' : '2x2';
  broadcastMultiviewGridMode(nextGridMode);
  return createMultiviewWindow(displayId);
});

ipcMain.handle('clear-multiview-output', async () => {
  closeMultiviewWindow();
  return { success: true };
});

ipcMain.on('multiview-update', (event, { playerId, payload }) => {
  if (!Number.isInteger(playerId) || playerId < 1 || playerId > 4) return;
  broadcastMultiviewPlayerUpdate(playerId, payload || null);
});

ipcMain.on('multiview-grid-mode', (event, { gridMode }) => {
  broadcastMultiviewGridMode(gridMode === '2x1' ? '2x1' : '2x2');
});

ipcMain.on('debug-log', (event, payload) => {
  if (!payload || typeof payload !== 'object') return;
  const level = payload.level || 'log';
  const source = payload.source || 'renderer';
  const message = payload.message || '';
  pushDebugLog(level, source, [message]);
});

// Ensure first-run state is clean (no folders/schedules/backgrounds persisted)
ipcMain.handle('ensure-fresh-first-run', async () => {
  const hasInitialized = appStateStore.get('hasInitialized', false);
  if (!hasInitialized) {
    scheduleStore.clear();
    playerStateStore.clear();
    appStateStore.set('hasInitialized', true);
    return { cleared: true };
  }
  return { cleared: false };
});

// Reload folder from saved path (used when restoring state)
ipcMain.handle('reload-folder', async (event, { playerId, folderPath }) => {
  const images = await getImagesFromFolder(folderPath);
  
  if (images && images.length > 0) {
    // Start watching this folder
    startWatchingFolder(playerId, folderPath);
    return { images };
  }
  
  return null;
});

// Get list of available displays
ipcMain.handle('get-displays', async () => {
  const displays = screen.getAllDisplays();
  return displays.map(display => ({
    id: display.id,
    label: `Display ${display.id}${display.primary ? ' (Primary)' : ''} (${display.size.width}x${display.size.height})`,
    bounds: display.bounds,
    size: display.size,
    primary: display.primary
  }));
});

// DeckLink device enumeration
ipcMain.handle('decklink-list-devices', async () => {
  return decklink.listDevices();
});

ipcMain.handle('decklink-set-output', async (event, { playerId, deviceIndex }) => {
  const result = decklink.listDevices();
  if (!result.ok || !Array.isArray(result.devices)) {
    return { success: false, error: result.error || 'DeckLink devices unavailable' };
  }

  if (deviceIndex < 0 || deviceIndex >= result.devices.length) {
    return { success: false, error: 'Invalid DeckLink device index' };
  }

  const previousOutput = decklinkOutputs[playerId];
  if (previousOutput && previousOutput.index !== deviceIndex) {
    delete decklinkOutputs[playerId];
    await stopDeckLinkOutputIfUnused(previousOutput.index);
  }

  const activeDevices = getActiveDeckLinkDeviceIndices();
  if (!activeDevices.has(deviceIndex)) {
    const startResult = await startDeckLinkOutput(deviceIndex);
    if (!startResult.success) {
      return { success: false, error: startResult.error };
    }
  }

  decklinkOutputs[playerId] = {
    index: deviceIndex,
    name: result.devices[deviceIndex]
  };

  startDeckLinkTestPattern(deviceIndex);

  if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
    outputWindows[playerId].close();
  }

  return { success: true, device: decklinkOutputs[playerId] };
});

ipcMain.handle('decklink-clear-output', async (event, { playerId }) => {
  const previousOutput = decklinkOutputs[playerId];
  delete decklinkOutputs[playerId];
  if (previousOutput) {
    await stopDeckLinkOutputIfUnused(previousOutput.index);
  }
  return { success: true };
});

ipcMain.handle('decklink-set-video-mode', async (event, { videoMode }) => {
  decklinkSettings.videoMode = videoMode || null;
  const activeDevices = getActiveDeckLinkDeviceIndices();
  for (const deviceIndex of activeDevices) {
    decklink.stopOutput(deviceIndex);
    const startResult = await startDeckLinkOutput(deviceIndex);
    if (!startResult.success) {
      console.warn(`Failed to restart DeckLink device ${deviceIndex}:`, startResult.error);
    }
  }
  return { success: true, videoMode: decklinkSettings.videoMode };
});

// Create output window for a player
ipcMain.handle('create-output-window', async (event, { playerId, displayId, outputType, streamName }) => {
  // Close existing output window for this player
  if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
    suppressOutputLostForPlayer[playerId] = true;
    outputWindows[playerId].close();
  }

  // Handle monitor output
  const displays = screen.getAllDisplays();
  const targetDisplay = displays.find(d => d.id === displayId);

  if (!targetDisplay) {
    return { success: false, error: 'Display not found' };
  }

  // Create new output window
  const outputWindow = new BrowserWindow({
    x: targetDisplay.bounds.x,
    y: targetDisplay.bounds.y,
    width: targetDisplay.bounds.width,
    height: targetDisplay.bounds.height,
    fullscreen: true,
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    backgroundColor: '#000000'
  });

  outputWindow.loadFile('src/renderer/output.html');

  outputWindow.webContents.on('did-finish-load', () => {
    outputWindow.webContents.send('init-player', { playerId, outputType, streamName });
  });

  outputWindows[playerId] = outputWindow;
  outputWindow.outputDisplayId = displayId;

  outputWindow.on('closed', () => {
    const wasSuppressed = !!suppressOutputLostForPlayer[playerId];
    delete suppressOutputLostForPlayer[playerId];

    if (outputWindows[playerId] === outputWindow) {
      delete outputWindows[playerId];
    }

    if (!wasSuppressed) {
      notifyPlayerOutputLost(playerId, 'Output window was closed or disconnected.');
    }
  });

  return { success: true, windowId: outputWindow.id };
});

// Close output window
ipcMain.handle('close-output-window', async (event, playerId) => {
  // Close monitor output window if exists
  if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
    suppressOutputLostForPlayer[playerId] = true;
    outputWindows[playerId].close();
    delete outputWindows[playerId];
  }

  return { success: true };
});

// Send image update to output window
ipcMain.on('update-output-image', (event, { playerId, imagePath, transition, duration, scaleFill }) => {
  // Update monitor output window if exists
  if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
    outputWindows[playerId].webContents.send('update-image', { imagePath, transition, duration, scaleFill });
  }

  if (decklinkOutputs[playerId]) {
    queueDeckLinkFrame(playerId, {
      deviceIndex: decklinkOutputs[playerId].index,
      imagePath,
      scaleFill
    });
  }
});

// Send background color to output window
ipcMain.on('update-background-color', (event, { playerId, color }) => {
  // Update monitor output window if exists
  if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
    outputWindows[playerId].webContents.send('update-background-color', { color });
  }
});

// Send background image to output window

// Helper function to get images from folder
async function getImagesFromFolder(folderPath) {
  const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg'];
  
  try {
    const files = await fs.promises.readdir(folderPath);
    const images = files
      .filter(file => {
        const ext = path.extname(file).toLowerCase();
        return supportedFormats.includes(ext);
      })
      .map(file => path.join(folderPath, file))
      .sort();

    return images;
  } catch (error) {
    console.error('Error reading folder:', error);
    return [];
  }
}

function startWatchingFolder(playerId, folderPath) {
  // Stop existing watcher for this player
  if (folderWatchers[playerId]) {
    folderWatchers[playerId].close();
    delete folderWatchers[playerId];
  }
  
  const supportedFormats = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.svg'];
  
  // Create new watcher
  const watcher = chokidar.watch(folderPath, {
    persistent: true,
    ignoreInitial: true,
    depth: 0, // Only watch the immediate directory, not subdirectories
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100
    }
  });
  
  // Handle file additions and deletions
  const handleChange = async () => {
    const images = await getImagesFromFolder(folderPath);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('folder-updated', { playerId, images });
    }
    // Also update output windows if they exist
    if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
      outputWindows[playerId].webContents.send('images-updated', { playerId, images });
    }
  };
  
  watcher
    .on('add', (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (supportedFormats.includes(ext)) {
        console.log(`New image detected in player ${playerId}: ${path.basename(filePath)}`);
        handleChange();
      }
    })
    .on('unlink', (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (supportedFormats.includes(ext)) {
        console.log(`Image removed from player ${playerId}: ${path.basename(filePath)}`);
        handleChange();
      }
    })
    .on('error', error => console.error(`Watcher error for player ${playerId}:`, error));
  
  folderWatchers[playerId] = watcher;
  console.log(`Started watching folder for player ${playerId}: ${folderPath}`);
}

function stopWatchingFolder(playerId) {
  if (folderWatchers[playerId]) {
    folderWatchers[playerId].close();
    delete folderWatchers[playerId];
    console.log(`Stopped watching folder for player ${playerId}`);
  }
}
