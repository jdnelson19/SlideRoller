const path = require('path');
const { spawnSync } = require('child_process');

let addonInstance = null;

function resolveAddonPath() {
  const appRoot = path.resolve(__dirname, '..', '..');
  return path.join(appRoot, 'build', 'Release', 'decklink_addon.node');
}

function loadAddon() {
  if (addonInstance) return addonInstance;
  // eslint-disable-next-line import/no-dynamic-require, global-require
  addonInstance = require(resolveAddonPath());
  return addonInstance;
}

function listDevices() {
  const workerPath = path.join(__dirname, 'decklink-worker.js');
  const result = spawnSync(process.execPath, [workerPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8'
  });

  if (result.error) {
    return { ok: false, devices: [], error: result.error.message };
  }

  if (result.status !== 0) {
    const signalInfo = result.signal ? ` (signal: ${result.signal})` : '';
    const stderrInfo = result.stderr ? ` ${result.stderr}` : '';
    return { ok: false, devices: [], error: `DeckLink worker failed${signalInfo}.${stderrInfo}`.trim() };
  }

  if (!result.stdout) {
    return { ok: false, devices: [], error: 'DeckLink worker returned no data.' };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, devices: [], error: 'Failed to parse DeckLink response.' };
  }
}

module.exports = {
  listDevices,
  startOutput({ deviceIndex, videoMode }) {
    try {
      const addon = loadAddon();
      return addon.startOutput(deviceIndex, videoMode);
    } catch (error) {
      return { ok: false, error: error.message || 'DeckLink output start failed.' };
    }
  },
  stopOutput(deviceIndex) {
    try {
      const addon = loadAddon();
      return addon.stopOutput(deviceIndex);
    } catch (error) {
      return { ok: false, error: error.message || 'DeckLink output stop failed.' };
    }
  },
  sendFrame({ deviceIndex, frame, width, height }) {
    try {
      const addon = loadAddon();
      return addon.sendFrame(deviceIndex, frame, width, height);
    } catch (error) {
      return { ok: false, error: error.message || 'DeckLink frame send failed.' };
    }
  }
};
