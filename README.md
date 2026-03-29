# Slide Roller

Slide Roller is a macOS Electron app for running up to 4 simultaneous image slideshow players with independent control, scheduling, and output routing.

## Current Features

- 4 independent players, each with its own folder, timing, transition, and output settings
- Gapless folder playback with live folder watching (auto-updates when images are added/removed)
- Transition modes: Cut or Crossfade (0.5s-5s fade duration)
- Per-player display time control
- Per-player background color and Scale to Fill option
- Scheduling per player:
  - Up to 3 schedule slots
  - Enable/disable per slot
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

## Build Installers

Build macOS artifacts:

```bash
npm run build:mac
```

Build outputs are generated in the dist directory, including:

- Slide Roller-<version>-arm64.dmg
- Slide Roller-<version>-arm64-mac.zip

## Download from GitHub Releases

This repo includes an automated release workflow at .github/workflows/release.yml.

To publish downloadable installers:

```bash
git tag v1.0.1
git push origin v1.0.1
```

When the tag is pushed, GitHub Actions builds macOS artifacts and attaches them to the GitHub Release.

## Apple Developer Signing and Notarization

Build config is set up for Developer ID signing and notarization.

Set these environment variables before running npm run build:mac:

```bash
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="your-apple-id@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="YOURTEAMID"
```

Notes:

- CSC_NAME must match your installed signing identity exactly
- If APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID are not set, notarization is skipped
- Entitlements are defined in assets/entitlements.mac.plist
- GitHub Actions can use the same values through repository secrets

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
