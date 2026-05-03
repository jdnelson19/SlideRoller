const path = require('path');
const { spawnSync } = require('child_process');

let addonInstance = null;

function resolveAddonPath() {
  const appRoot = path.resolve(__dirname, '..', '..');
  const addonPath = path.join(appRoot, 'build', 'Release', 'decklink_addon.node');
  // In a packaged Electron app, .node files are extracted from the asar bundle
  return addonPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
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
    // Try to extract the specific error from worker stdout before falling back to generic message
    if (result.stdout) {
      try {
        const parsed = JSON.parse(result.stdout);
        if (parsed.error) return { ok: false, devices: [], error: parsed.error, diagnostics: parsed.diagnostics };
      } catch (_) { /* ignore parse errors */ }
    }
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
