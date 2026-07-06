# Slide Roller

Slide Roller is a macOS Electron app for running up to 4 simultaneous image slideshow players with independent control, scheduling, and output routing.

## Current Features

- 4 independent players, each with its own folder, timing, transition, and output settings
- Gapless folder playback with live folder watching (auto-updates when images are added/removed)
- Transition modes: Cut or Crossfade (0.5s-5s fade duration)
- Per-player display time control
- Per-player background color and Scale to Fill option
- Scheduling per player:
  - Dynamic schedule list with 1 default schedule and unlimited additional schedules
  - Editable schedule names
  - Per-schedule day-of-week selection
  - Enable/disable per schedule
  - Delete or reset schedules from the schedule editor
  - Auto-start toggle
  - Header status indicator showing whether schedules are active
- Output routing:
  - Extended monitor fullscreen output windows
  - Blackmagic DeckLink output via native addon
- Built-in Player Controls Help modal
- Menu action to reset all saved player/schedule state

## Requirements

- macOS
- Node.js 18+
- npm

## Setup

```bash
npm install
```

## Run the App

Development mode (opens DevTools):

```bash
npm run dev
```

Standard mode:

```bash
npm start
```

## Code Formatting

Prettier is configured for the source files in `src/`.

```bash
npm run format
```

To verify formatting without changing files:

```bash
npm run format:check
```

## Build Installers

Build macOS artifacts:

```bash
npm run build:mac
```

Build outputs are generated in the dist directory, including:

- Slide Roller-<version>-arm64.dmg
- Slide Roller-<version>-arm64-mac.zip

Notes:

- Local unsigned builds are fine for testing on the build machine.
- For distribution to other Macs, configure signing and notarization environment variables before rebuilding.

## macOS Signing and Notarization

This project is configured for signed distribution via `electron-builder`:

- `build.mac.identity` uses `CSC_NAME`
- Hardened runtime and entitlements are enabled
- `scripts/notarize.js` runs after signing

### 1) Install a Developer ID certificate

In your Apple Developer account, create/download:

- Developer ID Application certificate

Import it into your macOS login keychain, then confirm it exists:

```bash
security find-identity -v -p codesigning
```

You should see an identity like:

- `Developer ID Application: Your Name (TEAMID)`

### 2) Set signing identity

Export the exact identity string:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
```

### 3) Configure notarization credentials (pick one)

Option A (recommended): Notarytool keychain profile

```bash
xcrun notarytool store-credentials "slide-roller-notary" \
  --apple-id "you@example.com" \
  --team-id "TEAMID" \
  --password "app-specific-password"

export APPLE_KEYCHAIN_PROFILE="slide-roller-notary"
```

Option B: Apple ID + app-specific password env vars

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"
```

Option C: App Store Connect API key env vars

```bash
export APPLE_API_KEY="/absolute/path/AuthKey_ABC123XYZ.p8"
export APPLE_API_KEY_ID="ABC123XYZ"
export APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"
```

### 4) Run readiness check

```bash
npm run check:signing
```

This command exits non-zero until your cert and notarization credentials are set.

### 5) Build signed artifacts

```bash
npm run build:mac
```

### 6) Validate signed app

```bash
codesign --verify --deep --strict --verbose=2 "dist/mac-arm64/Slide Roller.app"
spctl -a -vvv --type execute "dist/mac-arm64/Slide Roller.app" 2>&1 || true
```

### Unsigned Build Quarantine Workaround

Current local builds may be unsigned, and macOS can block launch with a quarantine warning.

If needed, remove quarantine from the app bundle in Terminal:

```bash
xattr -dr com.apple.quarantine "dist/mac-arm64/Slide Roller.app"
```

If you are launching from a mounted DMG, remove quarantine from the copied app in Applications:

```bash
xattr -dr com.apple.quarantine "/Applications/Slide Roller.app"
```

You can verify Gatekeeper assessment from Terminal:

```bash
spctl -a -vvv --type execute "dist/mac-arm64/Slide Roller.app" 2>&1 || true
```

## Download from GitHub Releases

This repo includes an automated release workflow at `.github/workflows/release.yml`.
Tags matching `v*.*.*` trigger a GitHub Action build and publish the release assets.

To publish downloadable installers:

```bash
git tag v1.2.1
git push origin v1.2.1
```

When the tag is pushed, GitHub Actions builds macOS artifacts and attaches them to the GitHub Release.

For a manual release, upload these files from the dist directory to a GitHub Release:

- Slide Roller-<version>-arm64.dmg
- Slide Roller-<version>-arm64-mac.zip


## DeckLink Notes

DeckLink output uses a native addon in src/native/decklink-addon.

Typical local setup:

```bash
npm run build:addon
npm run rebuild:addon
```

You may need Blackmagic Desktop Video and DeckLinkAPI.framework installed on macOS.

## Supported Image Formats

- .jpg, .jpeg
- .png
- .gif
- .bmp
- .webp
- .tiff
- .svg

## Project Structure

```text
src/main/main.js         Electron main process, IPC, output windows, persistence
src/renderer/index.html  Main UI
src/renderer/renderer.js Player logic, scheduling, controls, persistence
src/renderer/output.html Output window template
src/renderer/output.js   Output window renderer logic
assets/                  App assets and signing entitlements
scripts/notarize.js      Post-sign notarization hook
.github/workflows/       CI/CD release workflow
```

## License

MIT
