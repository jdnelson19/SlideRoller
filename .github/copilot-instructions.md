## Slide Roller Project

This is an Electron-based macOS application for managing 4 simultaneous image slideshow players with professional output capabilities.

### Project Architecture
- Electron main process handles window management and hardware access
- React-based renderer for UI
- Each player independently manages its own image sequence
- Support for hardware outputs (extended monitors, Blackmagic Decklink, NDI)

### Key Features
- 4 independent media players
- Folder-based image playback
- Transition controls (cut/crossfade with 0.5-5s duration)
- Multiple output options (monitors, Blackmagic devices, NDI streams)
- No gaps between images during playback

### Development Notes
- Use Electron IPC for communication between main and renderer processes
- Hardware video output requires native Node modules
- NDI integration requires grandiose or similar NDI SDK bindings
- Transitions implemented with canvas/CSS animations

### Status
- ✅ Workspace created
- ⏳ Setting up project structure
