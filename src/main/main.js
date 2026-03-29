const { app, BrowserWindow, ipcMain, dialog, screen, Menu } = require('electron');
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
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Player Controls Help',
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('open-help');
            }
          }
        },
        {
          label: 'Reset All to Default',
          click: () => {
            scheduleStore.clear();
            playerStateStore.clear();
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('reset-all-to-default');
            }
          }
        },
        { type: 'separator' },
        { role: 'close' }
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
  screen.on('display-removed', broadcastDisplaysChanged);
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

app.on('before-quit', () => {
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

  return { success: true, windowId: outputWindow.id };
});

// Close output window
ipcMain.handle('close-output-window', async (event, playerId) => {
  // Close monitor output window if exists
  if (outputWindows[playerId] && !outputWindows[playerId].isDestroyed()) {
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
