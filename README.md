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
- Signed/notarized release builds are produced by GitHub Actions on version tags.

## macOS Signing and Notarization

Release signing and notarization are handled by GitHub Actions in
`.github/workflows/release.yml`.

When a tag matching `v*.*.*` is pushed, CI:

- builds macOS artifacts
- signs the app
- notarizes the app
- publishes DMG/ZIP assets to the GitHub Release

### Required GitHub Secrets

Set these repository secrets for CI signing/notarization:

- `CSC_NAME`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Use this local command only when validating signing setup on a maintainer machine:

```bash
npm run check:signing
```

## Download from GitHub Releases

This repo includes an automated release workflow at `.github/workflows/release.yml`.
Tags matching `v*.*.*` trigger a GitHub Action build and publish the release assets.

To publish downloadable installers:

```bash
git tag v1.2.2
git push origin v1.2.2
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
