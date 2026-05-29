const path = require('path');

function resolveAddonPath() {
  const appRoot = path.resolve(__dirname, '..', '..');
  const addonPath = path.join(appRoot, 'build', 'Release', 'decklink_addon.node');
  // In a packaged Electron app, .node files are extracted from the asar bundle
  return addonPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function loadAddon() {
  return require(resolveAddonPath());
}

function main() {
  try {
    const addon = loadAddon();
    const devices = addon && typeof addon.listDevices === 'function' ? addon.listDevices() : [];
    const diagnostics = addon && typeof addon.getDiagnostics === 'function' ? addon.getDiagnostics() : null;

    if (devices.length === 0) {
      const message = diagnostics
        ? `No devices found. apiPresent=${diagnostics.apiPresent}, iteratorAvailable=${diagnostics.iteratorAvailable}`
        : 'No devices found.';
      const payload = { ok: false, devices, error: message, diagnostics };
      process.stdout.write(JSON.stringify(payload));
      return;
    }

    const payload = { ok: true, devices, diagnostics };
    process.stdout.write(JSON.stringify(payload));
  } catch (error) {
    const payload = { ok: false, devices: [], error: error.message || 'DeckLink enumeration failed' };
    process.stdout.write(JSON.stringify(payload));
    process.exitCode = 1;
  }
}

main();
