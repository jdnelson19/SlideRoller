const { ipcRenderer } = require('electron');

// Player state management
const players = {
  1: { images: [], currentIndex: 0, isPlaying: false, folderPath: null, intervalId: null, currentImageIndex: 0, isFirstImage: true },
  2: { images: [], currentIndex: 0, isPlaying: false, folderPath: null, intervalId: null, currentImageIndex: 0, isFirstImage: true },
  3: { images: [], currentIndex: 0, isPlaying: false, folderPath: null, intervalId: null, currentImageIndex: 0, isFirstImage: true },
  4: { images: [], currentIndex: 0, isPlaying: false, folderPath: null, intervalId: null, currentImageIndex: 0, isFirstImage: true }
};

const DECKLINK_VIDEO_MODES = [
  { value: '1080i59.94', label: '1080i 59.94' },
  { value: '1080i50', label: '1080i 50' },
  { value: '1080p60', label: '1080p 60' },
  { value: '1080p59.94', label: '1080p 59.94' },
  { value: '1080p50', label: '1080p 50' },
  { value: '1080p30', label: '1080p 30' },
  { value: '1080p29.97', label: '1080p 29.97' },
  { value: '1080p25', label: '1080p 25' },
  { value: '1080p24', label: '1080p 24' },
  { value: '1080p23.98', label: '1080p 23.98' }
];

const DEFAULT_DECKLINK_VIDEO_MODE = '1080p59.94';
let debugLogBridgeInitialized = false;
const GLOBAL_TRANSITION_STORAGE_KEY = 'globalTransitionSettings';
const MULTIVIEW_STATE_STORAGE_KEY = 'multiviewState';

const globalTransitionState = {
  isVisible: false,
  enabled: false,
  transitionType: 'cut',
  fadeDuration: 1,
  displayTime: 5
};

const multiviewState = {
  outputSelection: '',
  gridMode: '2x2'
};

const multiviewUi = {
  modal: null,
  outputModal: null,
  outputSelect: null,
  gridSelect: null
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

function sendDebugLog(level, args) {
  const message = (Array.isArray(args) ? args : [args]).map(formatDebugArg).join(' ');
  ipcRenderer.send('debug-log', {
    level,
    source: 'renderer',
    message
  });
}

function setupDebugLogBridge() {
  if (debugLogBridgeInitialized) return;
  debugLogBridgeInitialized = true;

  const originalConsole = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  ['log', 'info', 'warn', 'error'].forEach(level => {
    console[level] = (...args) => {
      originalConsole[level](...args);
      sendDebugLog(level, args);
    };
  });

  window.addEventListener('error', event => {
    sendDebugLog('error', [`Uncaught error: ${event.message}`, event.error || '']);
  });

  window.addEventListener('unhandledrejection', event => {
    sendDebugLog('error', ['Unhandled promise rejection:', event.reason || 'Unknown reason']);
  });
}

// Initialize players
document.addEventListener('DOMContentLoaded', async () => {
  setupDebugLogBridge();
  initializePlayers();
  setupAppScaling();
  await loadOutputOptions();
  setupOutputSettingsModal();
  setupDeckLinkPanel();
  setupColorPickerModal();
  setupScheduleModal();
  setupHelpModal();
  setupGlobalTransitionFooter();
  setupMultiviewModal();
  await ensureFirstRunIsClean();
  await loadAllPlayerStates();
  await loadAllSchedules();
  updateTabPanelMinHeights();
  window.addEventListener('resize', () => {
    window.requestAnimationFrame(updateTabPanelMinHeights);
  });
  startScheduleChecker();
  
  // Listen for folder updates from file watcher
  ipcRenderer.on('folder-updated', (event, { playerId, images }) => {
    handleFolderUpdate(playerId, images);
  });
  
  ipcRenderer.on('displays-changed', async () => {
    await loadOutputOptions();
    await populateMultiviewOutputOptions();
  });

  ipcRenderer.on('open-output-settings', () => {
    openOutputSettingsModal();
  });

  ipcRenderer.on('open-multiview-settings', () => {
    openMultiviewSettingsModal();
  });

  ipcRenderer.on('always-on-top-changed', (event, payload) => {
    document.body.classList.toggle('always-on-top', !!(payload && payload.enabled));
    if (typeof window.__applyAppScale === 'function') {
      window.requestAnimationFrame(() => {
        window.__applyAppScale();
      });
    }
  });

  ipcRenderer.on('set-player-layout', (event, payload) => {
    const mode = payload && payload.mode ? payload.mode : 'four';
    applyPlayerLayout(mode);
  });

  ipcRenderer.on('set-global-tab', (event, payload) => {
    const tab = payload && payload.tab ? payload.tab : 'transition';
    setGlobalTab(tab);
  });

  ipcRenderer.on('toggle-global-transition-footer', () => {
    toggleGlobalTransitionFooter();
  });

  ipcRenderer.on('stop-all-players', () => {
    stopAllPlayers();
  });

  ipcRenderer.on('player-output-lost', (event, payload) => {
    const playerId = Number.parseInt(payload && payload.playerId, 10);
    if (!Number.isInteger(playerId)) return;

    const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
    if (!playerCard) return;

    if (players[playerId] && players[playerId].isPlaying) {
      stopPlayer(playerId, playerCard);
    }

    updatePlayerStatus(playerCard, 'lost-output');
    showPlayerNotification(playerCard, payload && payload.reason ? payload.reason : 'Output lost', 'warning');
  });

  ipcRenderer.on('player-configurations-imported', (event, payload) => {
    const importedFrom = payload && payload.filePath ? `\n\nSource: ${payload.filePath}` : '';
    alert(`Player configurations were imported. The app will now reload to apply them.${importedFrom}`);
    window.location.reload();
  });

  ipcRenderer.on('multiview-output-closed', () => {
    multiviewState.outputSelection = '';
    persistMultiviewState();
  });

  applyPlayerLayout(localStorage.getItem('playerLayoutMode') || 'four');
  syncAllPlayerViewTiles();
  await restoreMultiviewOutput();
});

function setupAppScaling() {
  const appContainer = document.querySelector('.app-container');
  if (!appContainer) return;

  const baseWidth = window.innerWidth;
  const baseHeight = window.innerHeight;

  const resize = () => {
    appContainer.style.transform = 'scale(1)';
    appContainer.style.width = '100%';
    appContainer.style.height = '100%';

    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const scaleX = viewportWidth / baseWidth;
    const scaleY = viewportHeight / baseHeight;
    const MIN_READABLE_SCALE = 0.86;
    const scale = Math.max(MIN_READABLE_SCALE, Math.min(1, scaleX, scaleY));

    appContainer.style.transform = `scale(${scale})`;
    appContainer.style.width = `${100 / scale}%`;
    appContainer.style.height = `${100 / scale}%`;
  };

  window.__applyAppScale = resize;

  window.addEventListener('resize', () => {
    window.requestAnimationFrame(resize);
  });

  resize();
}
function getPlayerViewPayload(playerId, playerCard) {
  const previewImages = Array.from(playerCard.querySelectorAll('.preview-image'));
  const visibleImage = previewImages.find(image => image.classList.contains('visible'))
    || previewImages.find(image => Boolean(image.currentSrc || image.src || image.getAttribute('src')))
    || previewImages[0]
    || null;
  const playerName = playerCard.querySelector('.player-name');
  const statusIndicator = playerCard.querySelector('.status-indicator');
  const scaleFillCheckbox = playerCard.querySelector('.scale-fill-checkbox');
  const imageSrc = visibleImage ? (visibleImage.currentSrc || visibleImage.src || visibleImage.getAttribute('src') || '') : '';

  const nextSchedule = getNextScheduleInfo(playerId);

  return {
    title: playerName ? playerName.textContent : `Player ${playerId}`,
    imageSrc,
    backgroundColor: playerCard.dataset.backgroundColor || '#000000',
    objectFit: scaleFillCheckbox && scaleFillCheckbox.checked ? 'cover' : 'contain',
    status: statusIndicator ? Array.from(statusIndicator.classList).find(className => className !== 'status-indicator') || 'stopped' : 'stopped',
    placeholder: imageSrc ? '' : 'No output preview',
    scheduleText: nextSchedule.label
  };
}

function syncPlayerViewTile(playerId, playerCard) {
  if (!playerCard) return;
  const payload = getPlayerViewPayload(playerId, playerCard);
  ipcRenderer.send('multiview-update', { playerId, payload });
}

function schedulePlayerViewSync(playerId, playerCard) {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      updateLayoutScheduleSummary(playerId, playerCard);
      syncPlayerViewTile(playerId, playerCard);
    });
  });
}

function syncAllPlayerViewTiles() {
  for (let playerId = 1; playerId <= 4; playerId += 1) {
    const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
    if (playerCard) {
      updateLayoutScheduleSummary(playerId, playerCard);
      syncPlayerViewTile(playerId, playerCard);
    }
  }
}

function ensureLayoutScheduleSummary(playerCard) {
  const header = playerCard.querySelector('.player-header');
  if (!header) return null;

  let summary = header.querySelector('.layout-schedule-summary');
  if (!summary) {
    summary = document.createElement('div');
    summary.className = 'layout-schedule-summary';
    const name = header.querySelector('.player-name');
    if (name && name.nextSibling) {
      header.insertBefore(summary, name.nextSibling);
    } else {
      header.appendChild(summary);
    }
  }

  return summary;
}

function updateLayoutScheduleSummary(playerId, playerCard) {
  const summary = ensureLayoutScheduleSummary(playerCard);
  if (!summary) return;

  const nextSchedule = getNextScheduleInfo(playerId);
  const compactText = nextSchedule.time || 'No active schedule';
  summary.textContent = compactText;
  summary.title = compactText;
}

function loadMultiviewState() {
  try {
    const raw = localStorage.getItem(MULTIVIEW_STATE_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;
    multiviewState.outputSelection = typeof saved.outputSelection === 'string' ? saved.outputSelection : '';
    multiviewState.gridMode = saved.gridMode === '2x1' ? '2x1' : '2x2';
  } catch (error) {
    console.error('Failed to load multiview state:', error);
  }
}

function persistMultiviewState() {
  try {
    localStorage.setItem(MULTIVIEW_STATE_STORAGE_KEY, JSON.stringify(multiviewState));
  } catch (error) {
    console.error('Failed to persist multiview state:', error);
  }
}

function setupHelpModal() {
  const modal = document.getElementById('help-modal');
  const closeBtn = document.getElementById('help-close');
  const controlsTabBtn = document.getElementById('help-tab-controls');
  const shortcutsTabBtn = document.getElementById('help-tab-shortcuts');
  const controlsSection = document.getElementById('help-controls-section');
  const shortcutsSection = document.getElementById('help-shortcuts-section');

  if (!modal || !closeBtn) return;

  const setHelpSection = (section) => {
    const useShortcuts = section === 'shortcuts';

    if (controlsTabBtn) {
      controlsTabBtn.classList.toggle('active', !useShortcuts);
      controlsTabBtn.setAttribute('aria-selected', useShortcuts ? 'false' : 'true');
    }
    if (shortcutsTabBtn) {
      shortcutsTabBtn.classList.toggle('active', useShortcuts);
      shortcutsTabBtn.setAttribute('aria-selected', useShortcuts ? 'true' : 'false');
    }
    if (controlsSection) controlsSection.classList.toggle('active', !useShortcuts);
    if (shortcutsSection) shortcutsSection.classList.toggle('active', useShortcuts);
  };

  if (controlsTabBtn) {
    controlsTabBtn.addEventListener('click', () => setHelpSection('controls'));
  }
  if (shortcutsTabBtn) {
    shortcutsTabBtn.addEventListener('click', () => setHelpSection('shortcuts'));
  }

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  });

  ipcRenderer.on('open-help', () => {
    setHelpSection('controls');
    modal.classList.add('active');
  });
}

function loadGlobalTransitionState() {
  try {
    const raw = localStorage.getItem(GLOBAL_TRANSITION_STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;

    globalTransitionState.isVisible = !!saved.isVisible;
    globalTransitionState.enabled = !!saved.enabled;
    globalTransitionState.transitionType = saved.transitionType === 'crossfade' ? 'crossfade' : 'cut';

    const fadeDuration = parseFloat(saved.fadeDuration);
    const displayTime = parseInt(saved.displayTime, 10);
    if (!Number.isNaN(fadeDuration)) {
      globalTransitionState.fadeDuration = Math.max(0.5, Math.min(5, fadeDuration));
    }
    if (!Number.isNaN(displayTime)) {
      globalTransitionState.displayTime = Math.max(3, Math.min(20, displayTime));
    }
  } catch (error) {
    console.error('Failed to load global transition state:', error);
  }
}

function persistGlobalTransitionState() {
  try {
    localStorage.setItem(GLOBAL_TRANSITION_STORAGE_KEY, JSON.stringify(globalTransitionState));
  } catch (error) {
    console.error('Failed to persist global transition state:', error);
  }
}

function applyGlobalTransitionFooterUI() {
  const footer = document.getElementById('global-transition-footer');
  const enabledCheckbox = document.getElementById('global-transition-enabled');
  const fadeSlider = document.getElementById('global-fade-duration');
  const fadeValue = document.getElementById('global-fade-duration-value');
  const displaySlider = document.getElementById('global-display-time');
  const displayValue = document.getElementById('global-display-time-value');
  const cutBtn = document.getElementById('global-transition-cut');
  const fadeBtn = document.getElementById('global-transition-fade');

  if (!footer) return;

  footer.hidden = !globalTransitionState.isVisible;
  document.body.classList.toggle('global-transition-footer-visible', globalTransitionState.isVisible);

  if (enabledCheckbox) {
    enabledCheckbox.checked = globalTransitionState.enabled;
  }
  if (fadeSlider) {
    fadeSlider.value = String(globalTransitionState.fadeDuration);
  }
  if (fadeValue) {
    fadeValue.textContent = `${globalTransitionState.fadeDuration.toFixed(1)}s`;
  }
  if (displaySlider) {
    displaySlider.value = String(globalTransitionState.displayTime);
  }
  if (displayValue) {
    displayValue.textContent = `${globalTransitionState.displayTime}s`;
  }
  if (cutBtn) {
    cutBtn.classList.toggle('active', globalTransitionState.transitionType === 'cut');
  }
  if (fadeBtn) {
    fadeBtn.classList.toggle('active', globalTransitionState.transitionType === 'crossfade');
  }
}

function toggleGlobalTransitionFooter(forceVisible = null) {
  const shouldShow = forceVisible === null ? !globalTransitionState.isVisible : !!forceVisible;
  globalTransitionState.isVisible = shouldShow;
  persistGlobalTransitionState();
  applyGlobalTransitionFooterUI();
  updateTabPanelMinHeights();
  window.dispatchEvent(new Event('resize'));
}

function setupGlobalTransitionFooter() {
  const footer = document.getElementById('global-transition-footer');
  const enabledCheckbox = document.getElementById('global-transition-enabled');
  const fadeSlider = document.getElementById('global-fade-duration');
  const displaySlider = document.getElementById('global-display-time');
  const cutBtn = document.getElementById('global-transition-cut');
  const fadeBtn = document.getElementById('global-transition-fade');

  if (!footer || !enabledCheckbox || !fadeSlider || !displaySlider || !cutBtn || !fadeBtn) return;

  loadGlobalTransitionState();
  applyGlobalTransitionFooterUI();

  enabledCheckbox.addEventListener('change', () => {
    globalTransitionState.enabled = enabledCheckbox.checked;
    persistGlobalTransitionState();
  });

  fadeSlider.addEventListener('input', (event) => {
    globalTransitionState.fadeDuration = parseFloat(event.target.value);
    applyGlobalTransitionFooterUI();
    persistGlobalTransitionState();
  });

  displaySlider.addEventListener('input', (event) => {
    globalTransitionState.displayTime = parseInt(event.target.value, 10);
    applyGlobalTransitionFooterUI();
    persistGlobalTransitionState();
  });

  cutBtn.addEventListener('click', () => {
    globalTransitionState.transitionType = 'cut';
    applyGlobalTransitionFooterUI();
    persistGlobalTransitionState();
  });

  fadeBtn.addEventListener('click', () => {
    globalTransitionState.transitionType = 'crossfade';
    applyGlobalTransitionFooterUI();
    persistGlobalTransitionState();
  });
}

function getEffectiveTransitionSettings(playerCard) {
  if (globalTransitionState.enabled) {
    return {
      transitionType: globalTransitionState.transitionType,
      duration: globalTransitionState.fadeDuration,
      displayTime: globalTransitionState.displayTime
    };
  }

  return {
    transitionType: playerCard.querySelector('.transition-type').value,
    duration: parseFloat(playerCard.querySelector('.duration-slider').value),
    displayTime: parseInt(playerCard.querySelector('.timing-slider').value, 10)
  };
}

ipcRenderer.on('reset-all-to-default', () => {
  try {
    clearPersistedLocalState();
    resetAllPlayersToDefaults();
    resetAllSchedulesToDefaults();
    console.log('Reset all to default complete');
  } catch (error) {
    console.error('Failed to reset all to default:', error);
  }
});

async function ensureFirstRunIsClean() {
  try {
    const result = await ipcRenderer.invoke('ensure-fresh-first-run');
    if (result && result.cleared) {
      clearPersistedLocalState();
      resetAllPlayersToDefaults();
      resetAllSchedulesToDefaults();
      console.log('First-run cleanup complete');
    }
  } catch (error) {
    console.error('Failed to ensure first-run clean state:', error);
  }
}

function clearPersistedLocalState() {
  for (let i = 1; i <= 4; i++) {
    localStorage.removeItem(`player${i}State`);
    localStorage.removeItem(`player${i}Schedules`);
  }
}

function resetAllPlayersToDefaults() {
  for (let i = 1; i <= 4; i++) {
    resetPlayerToDefaults(i);
  }
}

function resetPlayerToDefaults(playerId) {
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!playerCard) return;

  players[playerId] = { images: [], currentIndex: 0, isPlaying: false, folderPath: null, intervalId: null, currentImageIndex: 0, isFirstImage: true };

  // Reset folder UI
  const folderPath = playerCard.querySelector('.folder-path');
  if (folderPath) {
    folderPath.textContent = 'No folder selected';
    folderPath.title = '';
  }

  // Reset preview images and placeholder
  const previewImages = playerCard.querySelectorAll('.preview-image');
  previewImages.forEach(img => {
    img.src = '';
    img.classList.remove('visible', 'fade');
  });
  const placeholder = playerCard.querySelector('.preview-placeholder');
  if (placeholder) placeholder.style.display = 'block';

  // Reset playback buttons
  setPlayToggleState(playerCard, false, false);

  updatePlayerStatus(playerCard, 'stopped');

  // Reset transition controls
  const transitionType = playerCard.querySelector('.transition-type');
  if (transitionType) transitionType.value = 'cut';
  const durationGroup = playerCard.querySelector('.duration-group');
  if (durationGroup) durationGroup.style.display = 'flex';
  const durationSlider = playerCard.querySelector('.duration-slider');
  const durationValue = playerCard.querySelector('.duration-value');
  if (durationSlider) durationSlider.value = 1;
  if (durationValue) durationValue.textContent = '1.0s';

  const timingSlider = playerCard.querySelector('.timing-slider');
  const timingValue = playerCard.querySelector('.timing-value');
  if (timingSlider) timingSlider.value = 5;
  if (timingValue) timingValue.textContent = '5s';

  const scaleFillCheckbox = playerCard.querySelector('.scale-fill-checkbox');
  if (scaleFillCheckbox) scaleFillCheckbox.checked = false;

  const autoStartCheckbox = playerCard.querySelector('.auto-start-checkbox');
  if (autoStartCheckbox) autoStartCheckbox.checked = false;

  // Reset background color
  playerCard.dataset.backgroundColor = '#000000';
  const colorPreview = playerCard.querySelector('.color-preview');
  if (colorPreview) colorPreview.style.background = '#000000';
  const previewContainer = playerCard.querySelector('.player-preview');
  if (previewContainer) previewContainer.style.background = '#1a1a1a';

  // Reset output selection
  const outputSelect = playerCard.querySelector('.output-select');
  if (outputSelect) outputSelect.value = '';

  // Reset custom title
  resetToDefaultTitle(playerId, playerCard);
  schedulePlayerViewSync(playerId, playerCard);
}

function resetAllSchedulesToDefaults() {
  for (let playerId = 1; playerId <= 4; playerId++) {
    scheduleState.schedulesByPlayer[playerId] = [createDefaultSchedule()];
    renderScheduleList(playerId);
  }
}

const ALL_SCHEDULE_DAYS = [0, 1, 2, 3, 4, 5, 6];
// MTWRFSU order: Mon Tue Wed Thu Fri Sat Sun
const SCHEDULE_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SCHEDULE_DAY_CODES = { 0: 'U', 1: 'M', 2: 'T', 3: 'W', 4: 'R', 5: 'F', 6: 'S' };
const SCHEDULE_DAY_NAMES = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday'
};

function createDefaultSchedule() {
  return { name: '', time: '', folderPath: '', lastRunDate: '', enabled: true, daysOfWeek: [] };
}

function normalizeSchedule(item = {}) {
  const normalizedDays = Array.isArray(item.daysOfWeek)
    ? Array.from(new Set(item.daysOfWeek
      .map(day => Number.parseInt(day, 10))
      .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)))
    : [...ALL_SCHEDULE_DAYS];

  return {
    name: item.name || '',
    time: item.time || '',
    folderPath: item.folderPath || '',
    lastRunDate: item.lastRunDate || '',
    enabled: !!item.enabled,
    daysOfWeek: Array.isArray(item.daysOfWeek) ? normalizedDays : [...ALL_SCHEDULE_DAYS]
  };
}

function getSelectedScheduleDays() {
  return Array.from(document.querySelectorAll('.schedule-days input:checked'))
    .map(input => Number.parseInt(input.value, 10))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((left, right) => left - right);
}

function setSelectedScheduleDays(daysOfWeek) {
  const selected = new Set(normalizeSchedule({ daysOfWeek }).daysOfWeek);
  document.querySelectorAll('.schedule-days input').forEach(input => {
    const day = Number.parseInt(input.value, 10);
    input.checked = selected.has(day);
  });
}

function formatScheduleDays(daysOfWeek) {
  const normalized = normalizeSchedule({ daysOfWeek }).daysOfWeek;
  if (normalized.length === 0) return 'No days';
  if (normalized.length === ALL_SCHEDULE_DAYS.length) return 'Every day';
  if (normalized.length === 1) return SCHEDULE_DAY_NAMES[normalized[0]];
  const selected = new Set(normalized);
  return SCHEDULE_DAY_ORDER.filter(d => selected.has(d)).map(d => SCHEDULE_DAY_CODES[d]).join('');
}

function getNextScheduleInfo(playerId) {
  const schedules = scheduleState.schedulesByPlayer[playerId] || [];
  const now = new Date();
  let nextRun = null;

  schedules.forEach((schedule, index) => {
    const normalized = normalizeSchedule(schedule);
    if (!normalized.enabled || !normalized.time || !normalized.folderPath || normalized.daysOfWeek.length === 0) {
      return;
    }

    const [hourStr, minuteStr] = normalized.time.split(':');
    const hour = Number.parseInt(hourStr, 10);
    const minute = Number.parseInt(minuteStr, 10);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;

    for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
      const candidate = new Date(now);
      candidate.setSeconds(0, 0);
      candidate.setDate(now.getDate() + dayOffset);
      candidate.setHours(hour, minute, 0, 0);

      if (!normalized.daysOfWeek.includes(candidate.getDay())) continue;
      if (candidate <= now) continue;

      if (!nextRun || candidate < nextRun.date) {
        nextRun = {
          date: candidate,
          time: normalized.time,
          name: normalized.name || `Schedule ${index + 1}`
        };
      }
      break;
    }
  });

  if (!nextRun) {
    return {
      name: '',
      time: '',
      label: 'No active schedule'
    };
  }

  const sameDay = nextRun.date.toDateString() === now.toDateString();
  const dayLabel = sameDay
    ? 'Today'
    : nextRun.date.toLocaleDateString('en-US', { weekday: 'short' });

  const timeLabel = `${dayLabel} ${formatTimeLabel(nextRun.time)}`;
  return {
    name: nextRun.name,
    time: timeLabel,
    label: `${nextRun.name} · ${timeLabel}`
  };
}

// Scheduling (all players)
const scheduleState = {
  activePlayerId: 1,
  activeSlot: 1,
  schedulesByPlayer: {
    1: [createDefaultSchedule()],
    2: [createDefaultSchedule()],
    3: [createDefaultSchedule()],
    4: [createDefaultSchedule()]
  },
  checkerId: null
};

function setupScheduleModal() {
  const modal = document.getElementById('schedule-modal');
  const closeBtn = document.getElementById('schedule-close');
  const pickFolderBtn = document.getElementById('schedule-pick-folder');
  const applyBtn = document.getElementById('schedule-apply');
  const clearBtn = document.getElementById('schedule-clear');
  const timeControls = modal.querySelectorAll('.time-adjust');

  document.addEventListener('click', event => {
    const scheduleButton = event.target.closest('.schedule-btn');
    if (scheduleButton) {
      const slot = parseInt(scheduleButton.dataset.scheduleSlot, 10);
      const playerId = parseInt(scheduleButton.dataset.playerId, 10);
      openScheduleModal(playerId, slot);
      return;
    }

    const addButton = event.target.closest('.schedule-add-btn');
    if (addButton) {
      const playerId = parseInt(addButton.dataset.playerId, 10);
      addScheduleSlot(playerId);
    }
  });

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  });

  pickFolderBtn.addEventListener('click', async () => {
    try {
      const result = await ipcRenderer.invoke('pick-folder');
      if (result && result.path) {
        updateScheduleFolderPath(result.path);
        return;
      }
    } catch (error) {
      console.error('Pick-folder IPC failed, falling back to select-folder:', error);
    }

    try {
      const fallback = await ipcRenderer.invoke('select-folder', scheduleState.activePlayerId);
      if (fallback && fallback.path) {
        updateScheduleFolderPath(fallback.path);
      }
    } catch (error) {
      console.error('Fallback select-folder failed:', error);
      alert('Unable to open folder picker. Please restart the app and try again.');
    }
  });

  timeControls.forEach(btn => {
    btn.addEventListener('click', () => adjustScheduleTime(btn.dataset.timeAction));
  });

  modal.addEventListener('keydown', event => {
    const isSelectAll = event.metaKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'a';
    if (!isSelectAll) return;

    event.preventDefault();
    document.querySelectorAll('.schedule-days input').forEach(input => {
      input.checked = true;
    });
  });

  applyBtn.addEventListener('click', () => {
    if (saveScheduleFromModal()) {
      modal.classList.remove('active');
    }
  });

  clearBtn.addEventListener('click', () => {
    clearScheduleSlot(scheduleState.activeSlot);
    modal.classList.remove('active');
  });
}

function openScheduleModal(playerId, slot) {
  scheduleState.activePlayerId = playerId;
  scheduleState.activeSlot = slot;
  const schedule = scheduleState.schedulesByPlayer[playerId][slot - 1];
  const modal = document.getElementById('schedule-modal');
  const title = document.getElementById('schedule-modal-title');
  const enabledCheckbox = document.getElementById('schedule-enabled');
  const folderPath = document.getElementById('schedule-folder-path');

  if (!schedule) return;

  const nameInput = document.getElementById('schedule-name');
  title.textContent = `Player ${playerId} • Schedule ${slot}`;
  if (nameInput) nameInput.value = schedule.name || '';
  const { hour12, minute, ampm } = parseTimeToParts(schedule.time);
  setScheduleTimeDisplay(hour12, minute, ampm);
  enabledCheckbox.checked = !!schedule.enabled;
  setSelectedScheduleDays(schedule.daysOfWeek);
  folderPath.textContent = schedule.folderPath || 'No folder selected';
  folderPath.title = schedule.folderPath || '';

  modal.classList.add('active');
}

function updateScheduleFolderPath(path) {
  const folderPath = document.getElementById('schedule-folder-path');
  folderPath.textContent = path;
  folderPath.title = path;
}

function addScheduleSlot(playerId) {
  const schedules = scheduleState.schedulesByPlayer[playerId] || [];
  schedules.push(createDefaultSchedule());
  scheduleState.schedulesByPlayer[playerId] = schedules;
  persistSchedules(playerId);
  renderScheduleList(playerId);
  openScheduleModal(playerId, schedules.length);
}

function saveScheduleFromModal() {
  const playerId = scheduleState.activePlayerId;
  const slot = scheduleState.activeSlot;
  const folderPath = document.getElementById('schedule-folder-path').textContent;
  const normalizedFolderPath = (folderPath || '').trim();
  const time24 = getScheduleTime24();
  const enabledCheckbox = document.getElementById('schedule-enabled');
  const previousSchedule = scheduleState.schedulesByPlayer[playerId][slot - 1];
  const daysOfWeek = getSelectedScheduleDays();

  if (daysOfWeek.length === 0) {
    alert('Select at least one day for this schedule.');
    return false;
  }

  if (!normalizedFolderPath || normalizedFolderPath === 'No folder selected') {
    alert('Select a content folder for this schedule.');
    return false;
  }

  const nameInput = document.getElementById('schedule-name');
  const scheduleName = nameInput ? nameInput.value.trim() : '';

  scheduleState.schedulesByPlayer[playerId][slot - 1] = {
    name: scheduleName,
    time: time24,
    folderPath: normalizedFolderPath,
    lastRunDate: previousSchedule.lastRunDate || '',
    enabled: !!enabledCheckbox.checked,
    daysOfWeek
  };

  persistSchedules(playerId);
  renderScheduleList(playerId);
  return true;
}

function clearScheduleSlot(slot) {
  const playerId = scheduleState.activePlayerId;
  const schedules = scheduleState.schedulesByPlayer[playerId] || [];
  if (schedules.length > 1) {
    schedules.splice(slot - 1, 1);
  } else {
    schedules[0] = createDefaultSchedule();
  }

  scheduleState.activeSlot = Math.min(slot, schedules.length);
  persistSchedules(playerId);
  renderScheduleList(playerId);
}

function persistSchedules(playerId) {
  const schedules = scheduleState.schedulesByPlayer[playerId];
  localStorage.setItem(`player${playerId}Schedules`, JSON.stringify(schedules));
  ipcRenderer.invoke('set-player-schedules', { playerId, schedules }).catch(error => {
    console.error(`Failed to persist schedules for player ${playerId}:`, error);
  });
}

async function loadAllSchedules() {
  for (let playerId = 1; playerId <= 4; playerId++) {
    let stored = null;
    try {
      stored = await ipcRenderer.invoke('get-player-schedules', playerId);
    } catch (error) {
      console.error(`Failed to load schedules for player ${playerId}:`, error);
    }

    if (!stored) {
      const local = localStorage.getItem(`player${playerId}Schedules`);
      if (local) {
        try {
          stored = JSON.parse(local);
          ipcRenderer.invoke('set-player-schedules', { playerId, schedules: stored }).catch(error => {
            console.error(`Failed to migrate schedules for player ${playerId}:`, error);
          });
        } catch (error) {
          console.error(`Failed to parse localStorage schedules for player ${playerId}:`, error);
        }
      }
    }

    if (stored) {
      try {
        const parsed = Array.isArray(stored) ? stored : JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          scheduleState.schedulesByPlayer[playerId] = parsed.map(item => normalizeSchedule(item));
        }
      } catch (error) {
        console.error(`Failed to load schedules for player ${playerId}:`, error);
      }
    }

    renderScheduleList(playerId);
  }
}

function renderScheduleList(playerId) {
  const container = document.querySelector(`.schedule-list[data-player-id="${playerId}"]`);
  const emptyState = document.querySelector(`.schedule-empty-state[data-player-id="${playerId}"]`);
  if (!container) return;

  const schedules = scheduleState.schedulesByPlayer[playerId] || [];
  container.replaceChildren();

  schedules.forEach((schedule, index) => {
    const slot = index + 1;
    const hasConfig = schedule.time && schedule.folderPath;
    const isActive = hasConfig && schedule.enabled;
    const daySummary = formatScheduleDays(schedule.daysOfWeek);
    const scheduleButton = document.createElement('button');
    scheduleButton.className = 'schedule-btn';
    scheduleButton.dataset.playerId = String(playerId);
    scheduleButton.dataset.scheduleSlot = String(slot);
    scheduleButton.classList.toggle('configured', hasConfig);
    scheduleButton.classList.toggle('active', isActive);
    const displayName = schedule.name || `Schedule ${slot}`;
    const folderName = schedule.folderPath
      ? (schedule.folderPath.replace(/\/+$/, '').split('/').pop() || schedule.folderPath)
      : '';
    const metaText = hasConfig
      ? `${formatTimeLabel(schedule.time)} ${daySummary}${folderName ? ' · ' + folderName : ''}`
      : 'Not configured yet';

    scheduleButton.title = hasConfig
      ? `${displayName}: ${formatTimeLabel(schedule.time)} ${daySummary} → ${schedule.folderPath}`
      : displayName;

    const contentEl = document.createElement('span');
    contentEl.className = 'schedule-btn-content';
    const titleEl = document.createElement('span');
    titleEl.className = 'schedule-btn-title';
    titleEl.textContent = displayName;
    const metaEl = document.createElement('span');
    metaEl.className = 'schedule-btn-meta';
    metaEl.textContent = metaText;
    contentEl.append(titleEl, metaEl);
    scheduleButton.appendChild(contentEl);

    const item = document.createElement('div');
    item.className = 'schedule-list-item';
    item.appendChild(scheduleButton);
    container.appendChild(item);
  });

  if (emptyState) {
    emptyState.hidden = schedules.length > 0;
  }

  updateScheduleIndicator(playerId);
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (playerCard) {
    schedulePlayerViewSync(playerId, playerCard);
  }
}

function ensureScheduleIndicator(playerCard) {
  const playerStatus = playerCard.querySelector('.player-status');
  if (!playerStatus) return null;

  let badge = playerStatus.querySelector('.schedule-activity-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'schedule-activity-badge inactive';
    badge.textContent = 'Schedules (0)';
    playerStatus.prepend(badge);
  }

  return badge;
}

function updateScheduleIndicator(playerId) {
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!playerCard) return;

  const badge = ensureScheduleIndicator(playerCard);
  if (!badge) return;

  const schedules = scheduleState.schedulesByPlayer[playerId] || [];
  const activeScheduleCount = schedules.filter(schedule => (
    schedule && schedule.enabled && schedule.time && schedule.folderPath
  )).length;
  const hasActiveSchedule = activeScheduleCount > 0;

  badge.classList.toggle('active', hasActiveSchedule);
  badge.classList.toggle('inactive', !hasActiveSchedule);
  badge.textContent = `Schedules (${activeScheduleCount})`;
  badge.title = `${activeScheduleCount} enabled schedule${activeScheduleCount === 1 ? '' : 's'}`;
}

function startScheduleChecker() {
  if (scheduleState.checkerId) {
    clearInterval(scheduleState.checkerId);
  }
  scheduleState.checkerId = setInterval(checkSchedules, 30000);
  checkSchedules();
}

function checkSchedules() {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  const today = now.toISOString().slice(0, 10);
  const currentDay = now.getDay();

  Object.keys(scheduleState.schedulesByPlayer).forEach(playerKey => {
    const playerId = parseInt(playerKey, 10);
    const schedules = scheduleState.schedulesByPlayer[playerId];
    schedules.forEach(async (schedule, index) => {
      if (!schedule.enabled) return;
      if (!schedule.time || !schedule.folderPath) return;
      if (!normalizeSchedule(schedule).daysOfWeek.includes(currentDay)) return;
      if (schedule.time !== currentTime) return;
      if (schedule.lastRunDate === today) return;

      schedule.lastRunDate = today;
      persistSchedules(playerId);

      await switchPlayerFolder(playerId, schedule.folderPath);
      console.log(`Schedule ${index + 1} executed for Player ${playerId}`);
    });
  });
}

function adjustScheduleTime(action) {
  const hourEl = document.getElementById('schedule-hour');
  const minuteEl = document.getElementById('schedule-minute');
  const ampmEl = document.getElementById('schedule-ampm');

  let hour = parseInt(hourEl.textContent, 10);
  let minute = parseInt(minuteEl.textContent, 10);
  let ampm = ampmEl.textContent;

  switch (action) {
    case 'hour-up':
      hour = hour === 12 ? 1 : hour + 1;
      break;
    case 'hour-down':
      hour = hour === 1 ? 12 : hour - 1;
      break;
    case 'minute-up':
      minute = (minute + 5) % 60;
      break;
    case 'minute-down':
      minute = (minute - 5 + 60) % 60;
      break;
    case 'ampm-up':
    case 'ampm-down':
      ampm = ampm === 'AM' ? 'PM' : 'AM';
      break;
    default:
      break;
  }

  setScheduleTimeDisplay(hour, minute, ampm);
}

function setScheduleTimeDisplay(hour12, minute, ampm) {
  const hourEl = document.getElementById('schedule-hour');
  const minuteEl = document.getElementById('schedule-minute');
  const ampmEl = document.getElementById('schedule-ampm');

  hourEl.textContent = `${hour12}`.padStart(2, '0');
  minuteEl.textContent = `${minute}`.padStart(2, '0');
  ampmEl.textContent = ampm;
}

function getScheduleTime24() {
  const hourEl = document.getElementById('schedule-hour');
  const minuteEl = document.getElementById('schedule-minute');
  const ampmEl = document.getElementById('schedule-ampm');

  let hour = parseInt(hourEl.textContent, 10);
  const minute = parseInt(minuteEl.textContent, 10);
  const ampm = ampmEl.textContent;

  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseTimeToParts(time24) {
  if (!time24) {
    return { hour12: 12, minute: 0, ampm: 'AM' };
  }

  const [hourStr, minuteStr] = time24.split(':');
  const hour24 = parseInt(hourStr, 10);
  const minute = parseInt(minuteStr, 10) || 0;
  const ampm = hour24 >= 12 ? 'PM' : 'AM';
  let hour12 = hour24 % 12;
  if (hour12 === 0) hour12 = 12;

  return { hour12, minute, ampm };
}

function formatTimeLabel(time24) {
  const { hour12, minute, ampm } = parseTimeToParts(time24);
  return `${hour12}:${String(minute).padStart(2, '0')} ${ampm}`;
}

function formatTimeShort(time24) {
  if (!time24) return '—';
  const { hour12, minute, ampm } = parseTimeToParts(time24);
  const suffix = ampm === 'PM' ? 'P' : 'A';
  return `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

async function switchPlayerFolder(playerId, folderPath) {
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!playerCard) return;

  const wasPlaying = players[playerId].isPlaying;

  if (players[playerId].intervalId) {
    clearTimeout(players[playerId].intervalId);
    players[playerId].intervalId = null;
  }

  players[playerId].isFirstImage = true;
  players[playerId].currentIndex = 0;

  await loadFolderFromPath(playerId, playerCard, folderPath);
  savePlayerState(playerId);

  if (wasPlaying) {
    updatePlayerStatus(playerCard, 'playing');
    setPlayToggleState(playerCard, true, players[playerId].images.length > 0);
    playerCard.querySelector('.folder-btn').disabled = true;

    if (players[playerId].images.length > 0) {
      playNextImage(playerId, playerCard);
    }
  } else {
    updatePlayerStatus(playerCard, 'stopped');
    setPlayToggleState(playerCard, false, players[playerId].images.length > 0);
    playerCard.querySelector('.folder-btn').disabled = false;
  }
}

function initializePlayers() {
  for (let i = 1; i <= 4; i++) {
    const playerCard = document.querySelector(`[data-player-id="${i}"]`);
    
    if (!playerCard) {
      console.error(`Player card ${i} not found`);
      continue;
    }

    ensureScheduleIndicator(playerCard);

    // Folder selection
    const folderBtn = playerCard.querySelector('.folder-btn');
    if (folderBtn) {
      folderBtn.addEventListener('click', () => selectFolder(i, playerCard));
    } else {
      console.error(`Folder button not found for player ${i}`);
    }

    // Start/Stop toggle button
    const playToggleBtn = playerCard.querySelector('.play-toggle-btn');
    if (playToggleBtn) {
      playToggleBtn.addEventListener('click', () => {
        if (players[i].isPlaying) {
          stopPlayer(i, playerCard);
        } else {
          startPlayer(i, playerCard);
        }
      });
    }

    // Transition type
    const transitionType = playerCard.querySelector('.transition-type');
    if (transitionType) {
      transitionType.addEventListener('change', () => {
        savePlayerState(i);
      });
    }

    // Transition toggle buttons
    const transitionToggleButtons = playerCard.querySelectorAll('.transition-toggle-btn');
    if (transitionToggleButtons.length > 0 && transitionType) {
      transitionToggleButtons.forEach(btn => {
        btn.addEventListener('click', () => {
          const nextValue = btn.dataset.transition || 'cut';
          transitionType.value = nextValue;
          transitionType.dispatchEvent(new Event('change'));
          syncTransitionToggle(playerCard, nextValue);
        });
      });
      syncTransitionToggle(playerCard, transitionType.value || 'cut');
    }

    // Duration slider
    const durationSlider = playerCard.querySelector('.duration-slider');
    const durationValue = playerCard.querySelector('.duration-value');
    if (durationSlider && durationValue) {
      durationSlider.addEventListener('input', (e) => {
        durationValue.textContent = `${parseFloat(e.target.value).toFixed(1)}s`;
      });
      durationSlider.addEventListener('change', () => savePlayerState(i));
    }

    // Timing slider
    const timingSlider = playerCard.querySelector('.timing-slider');
    const timingValue = playerCard.querySelector('.timing-value');
    if (timingSlider && timingValue) {
      timingSlider.addEventListener('input', (e) => {
        timingValue.textContent = `${parseInt(e.target.value)}s`;
      });
      timingSlider.addEventListener('change', () => savePlayerState(i));
    }

    // Scale to fill checkbox
    const scaleCheckbox = playerCard.querySelector('.scale-fill-checkbox');
    if (scaleCheckbox) {
      scaleCheckbox.addEventListener('change', (e) => {
        const previewImages = playerCard.querySelectorAll('.preview-image');
        previewImages.forEach(img => {
          img.style.objectFit = e.target.checked ? 'cover' : 'contain';
        });
        
        savePlayerState(i);
      });
    } else {
      console.error(`Scale checkbox not found for player ${i}`);
    }

    // Color picker button
    const colorPickerBtn = playerCard.querySelector('.color-picker-btn');
    if (colorPickerBtn) {
      colorPickerBtn.addEventListener('click', () => openColorPicker(i, playerCard));
    }

    // Output selection
    const outputSelect = playerCard.querySelector('.output-select');
    if (outputSelect) {
      outputSelect.addEventListener('change', async (e) => {
        try {
          await handleOutputChange(i, e.target.value, playerCard);
          savePlayerState(i);
        } catch (error) {
          console.error('Error handling output change:', error);
          alert(`Error: ${error.message}`);
        }
      });
    }
    
    // Auto-start checkbox
    const autoStartCheckbox = playerCard.querySelector('.auto-start-checkbox');
    if (autoStartCheckbox) {
      autoStartCheckbox.addEventListener('change', () => {
        savePlayerState(i);
      });
    }

    setupPlayerTabs(playerCard);
    
    // Double-click on player name to edit title inline
    const playerName = playerCard.querySelector('.player-name');
    if (playerName) {
      playerName.addEventListener('dblclick', () => enableTitleEdit(i, playerCard, playerName));
      playerName.style.cursor = 'pointer';
      playerName.style.userSelect = 'none';
    }
  }
}

async function selectFolder(playerId, playerCard) {
  const result = await ipcRenderer.invoke('select-folder', playerId);
  
  if (result) {
    players[playerId].images = result.images;
    players[playerId].currentIndex = 0;
    players[playerId].folderPath = result.path;

    // Update UI
    const folderPath = playerCard.querySelector('.folder-path');
    folderPath.textContent = result.path;
    folderPath.title = result.path;

    // Enable start button if images are available
    setPlayToggleState(playerCard, players[playerId].isPlaying, result.images.length > 0);

    // Show first image in preview
    if (result.images.length > 0) {
      const previewImage = playerCard.querySelector('.preview-image-1');
      const placeholder = playerCard.querySelector('.preview-placeholder');
      
      previewImage.src = `file://${result.images[0]}`;
      previewImage.classList.add('visible');
      placeholder.style.display = 'none';
    }
    schedulePlayerViewSync(playerId, playerCard);
    
    // Save state
    savePlayerState(playerId);
  }
}

function startPlayer(playerId, playerCard) {
  const player = players[playerId];
  
  if (player.images.length === 0) return;

  player.isPlaying = true;

  // Update UI
  updatePlayerStatus(playerCard, 'playing');
  setPlayToggleState(playerCard, true, true);
  playerCard.querySelector('.folder-btn').disabled = true;

  // Start playback
  playNextImage(playerId, playerCard);
  schedulePlayerViewSync(playerId, playerCard);
}

function stopPlayer(playerId, playerCard) {
  const player = players[playerId];
  
  player.isPlaying = false;
  player.isFirstImage = true;  // Reset for next playback
  
  if (player.intervalId) {
    clearTimeout(player.intervalId);
    player.intervalId = null;
  }

  // Update UI
  updatePlayerStatus(playerCard, 'stopped');
  setPlayToggleState(playerCard, false, player.images.length > 0);
  playerCard.querySelector('.folder-btn').disabled = false;
  schedulePlayerViewSync(playerId, playerCard);
}

function stopAllPlayers() {
  for (let playerId = 1; playerId <= 4; playerId += 1) {
    const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
    if (!playerCard || !players[playerId] || !players[playerId].isPlaying) continue;
    stopPlayer(playerId, playerCard);
  }
}

function handleFolderUpdate(playerId, newImages) {
  const player = players[playerId];
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  
  if (!playerCard) return;
  
  const oldImageCount = player.images.length;
  const newImageCount = newImages.length;
  
  // Update images list
  player.images = newImages;
  
  // If currently playing, adjust currentIndex if needed
  if (player.isPlaying && player.currentIndex >= newImages.length) {
    player.currentIndex = Math.max(0, newImages.length - 1);
  }
  
  // Update UI
  if (!player.isPlaying) {
    setPlayToggleState(playerCard, false, newImages.length > 0);
  }
  
  // Show notification if images were added or removed
  if (newImageCount > oldImageCount) {
    console.log(`Player ${playerId}: ${newImageCount - oldImageCount} new image(s) added`);
    showPlayerNotification(playerCard, `+${newImageCount - oldImageCount} image(s)`, 'success');
  } else if (newImageCount < oldImageCount) {
    console.log(`Player ${playerId}: ${oldImageCount - newImageCount} image(s) removed`);
    showPlayerNotification(playerCard, `-${oldImageCount - newImageCount} image(s)`, 'warning');
  }
  
  // Update preview if not playing and we have images
  if (!player.isPlaying && newImages.length > 0) {
    const previewImage = playerCard.querySelector('.preview-image-1');
    const placeholder = playerCard.querySelector('.preview-placeholder');
    const currentImagePath = newImages[Math.min(player.currentIndex, newImages.length - 1)];
    
    previewImage.src = `file://${currentImagePath}`;
    previewImage.classList.add('visible');
    placeholder.style.display = 'none';
  }

  schedulePlayerViewSync(playerId, playerCard);
}

function showPlayerNotification(playerCard, message, type = 'info') {
  // Create notification element
  const notification = document.createElement('div');
  notification.className = `player-notification ${type}`;
  notification.textContent = message;
  notification.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    padding: 8px 12px;
    background: ${type === 'success' ? '#4caf50' : type === 'warning' ? '#ff9800' : '#2196f3'};
    color: white;
    border-radius: 4px;
    font-size: 12px;
    font-weight: 500;
    z-index: 1000;
    animation: slideInRight 0.3s ease-out;
  `;
  
  playerCard.style.position = 'relative';
  playerCard.appendChild(notification);
  
  // Remove after 3 seconds
  setTimeout(() => {
    notification.style.animation = 'slideOutRight 0.3s ease-in';
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function playNextImage(playerId, playerCard) {
  const player = players[playerId];
  
  if (!player.isPlaying || player.images.length === 0) return;

  const imagePath = player.images[player.currentIndex];
  const { transitionType, duration, displayTime } = getEffectiveTransitionSettings(playerCard);
  const scaleFill = playerCard.querySelector('.scale-fill-checkbox').checked;

  // Get both preview images
  const previewImages = playerCard.querySelectorAll('.preview-image');
  const currentImage = previewImages[player.currentImageIndex];
  const nextImageIndex = (player.currentImageIndex + 1) % 2;
  const nextImage = previewImages[nextImageIndex];

  // Apply scale setting to both images
  currentImage.style.objectFit = scaleFill ? 'cover' : 'contain';
  nextImage.style.objectFit = scaleFill ? 'cover' : 'contain';

  if (transitionType === 'crossfade') {
    // For first image, just show it without transition
    if (player.isFirstImage) {
      nextImage.src = `file://${imagePath}`;
      nextImage.classList.remove('fade');
      nextImage.classList.add('visible');
      player.currentImageIndex = nextImageIndex;
      player.isFirstImage = false;
    } else {
      // Subsequent images: crossfade
      const performCrossfade = () => {
        // Set the transition duration dynamically
        nextImage.style.transitionDuration = `${duration}s`;
        currentImage.style.transitionDuration = `${duration}s`;
        
        // Force reflow
        void nextImage.offsetHeight;
        
        // Use requestAnimationFrame to ensure smooth transition
        requestAnimationFrame(() => {
          // Add fade class and toggle visibility
          currentImage.classList.add('fade');
          nextImage.classList.add('fade');
          
          requestAnimationFrame(() => {
            currentImage.classList.remove('visible');
            nextImage.classList.add('visible');
            
            // Update index after transition completes
            setTimeout(() => {
              player.currentImageIndex = nextImageIndex;
            }, duration * 1000);
          });
        });
      };
      
      // Ensure next image starts hidden
      nextImage.classList.remove('visible', 'fade');
      nextImage.src = `file://${imagePath}`;
      
      // Handle both onload (new image) and already loaded (cached image)
      if (nextImage.complete && nextImage.naturalHeight !== 0) {
        performCrossfade();
      } else {
        nextImage.onload = () => {
          performCrossfade();
        };
      }
    }
  } else {
    // Cut transition (instant)
    currentImage.classList.remove('fade', 'visible');
    nextImage.classList.remove('fade');
    currentImage.style.transitionDuration = '0s';
    nextImage.style.transitionDuration = '0s';
    nextImage.src = `file://${imagePath}`;
    nextImage.classList.add('visible');
    player.currentImageIndex = nextImageIndex;
    player.isFirstImage = false;
  }

  // Send to output window
  ipcRenderer.send('update-output-image', {
    playerId,
    imagePath,
    transition: transitionType,
    duration,
    scaleFill
  });

  // Move to next image
  player.currentIndex = (player.currentIndex + 1) % player.images.length;
  schedulePlayerViewSync(playerId, playerCard);

  // Schedule next image (display time only, transition happens during next cycle)
  const nextDelay = displayTime * 1000;
  player.intervalId = setTimeout(() => playNextImage(playerId, playerCard), nextDelay);
}

function updatePlayerStatus(playerCard, status) {
  const indicator = playerCard.querySelector('.status-indicator');
  const text = playerCard.querySelector('.status-text');

  indicator.className = `status-indicator ${status}`;
  const label = status
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
  text.textContent = label;

  const playerId = Number.parseInt(playerCard.dataset.playerId, 10);
  if (Number.isInteger(playerId)) {
    schedulePlayerViewSync(playerId, playerCard);
  }
}

function setPlayToggleState(playerCard, isPlaying, hasImages = true) {
  const toggleBtn = playerCard.querySelector('.play-toggle-btn');
  if (!toggleBtn) return;

  toggleBtn.disabled = !hasImages;
  toggleBtn.classList.toggle('is-playing', isPlaying);
  toggleBtn.classList.toggle('is-stopped', !isPlaying);
  toggleBtn.textContent = isPlaying ? 'Stop' : 'Start';
}

function setupPlayerTabs(playerCard) {
  const tabButtons = playerCard.querySelectorAll('.tab-btn');
  const tabPanels = playerCard.querySelectorAll('.tab-panel');
  if (tabButtons.length === 0 || tabPanels.length === 0) return;

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tab;
      tabButtons.forEach(btn => {
        const isActive = btn === button;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });

      tabPanels.forEach(panel => {
        panel.classList.toggle('active', panel.dataset.panel === tabName);
      });

      updateTabPanelMinHeights();
    });
  });
}

function setGlobalTab(tabName) {
  const allowedTabs = new Set(['transition', 'schedule', 'output']);
  const targetTab = allowedTabs.has(tabName) ? tabName : 'transition';

  document.querySelectorAll('.player-card').forEach(playerCard => {
    const tabButtons = playerCard.querySelectorAll('.tab-btn');
    const tabPanels = playerCard.querySelectorAll('.tab-panel');

    tabButtons.forEach(button => {
      const isActive = button.dataset.tab === targetTab;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });

    tabPanels.forEach(panel => {
      panel.classList.toggle('active', panel.dataset.panel === targetTab);
    });
  });

  updateTabPanelMinHeights();
}

function syncTransitionToggle(playerCard, transitionType) {
  const transitionToggleButtons = playerCard.querySelectorAll('.transition-toggle-btn');
  transitionToggleButtons.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.transition === transitionType);
  });
}

function updateTabPanelMinHeights() {
  document.querySelectorAll('.player-card').forEach(card => {
    const panels = card.querySelectorAll('.tab-panel');
    if (panels.length === 0) return;

    const container = card.querySelector('.tab-panels');
    if (!container) return;

    let maxHeight = 0;
    const activePanel = card.querySelector('.tab-panel.active');
    if (activePanel) {
      maxHeight = Math.max(maxHeight, activePanel.getBoundingClientRect().height);
    }

    panels.forEach(panel => {
      if (panel === activePanel) return;
      panel.classList.add('measuring');
      maxHeight = Math.max(maxHeight, panel.getBoundingClientRect().height);
      panel.classList.remove('measuring');
    });

    if (maxHeight > 0) {
      container.style.minHeight = `${Math.ceil(maxHeight)}px`;
    }
  });
}

async function loadOutputOptions() {
  const playerOutputSelects = document.querySelectorAll('.player-card .output-select');
  const previousSelections = new Map();
  playerOutputSelects.forEach(select => {
    const playerId = select.closest('.player-card')?.dataset.playerId;
    if (playerId) {
      previousSelections.set(playerId, select.value);
    }
  });

  const displays = await ipcRenderer.invoke('get-displays');
  let decklinkDevices = [];

  try {
    const decklinkResult = await ipcRenderer.invoke('decklink-list-devices');
    if (decklinkResult && decklinkResult.ok && Array.isArray(decklinkResult.devices)) {
      decklinkDevices = decklinkResult.devices;
    }
  } catch (error) {
    console.warn('DeckLink device enumeration failed:', error);
  }
  
  // Populate all output selects
  const activeOutputs = new Map();
  playerOutputSelects.forEach(select => {
    const playerId = select.closest('.player-card')?.dataset.playerId;
    if (playerId && select.value) {
      activeOutputs.set(playerId, select.value);
    }
  });

  playerOutputSelects.forEach(select => {
    // Clear existing options except "None"
    select.innerHTML = '<option value="">None</option>';
    
    // Add display options
    if (displays.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No displays detected';
      option.disabled = true;
      select.appendChild(option);
    } else {
      displays.forEach(display => {
        const option = document.createElement('option');
        option.value = `display:${display.id}`;
        option.textContent = display.label;
        select.appendChild(option);
      });
    }

    if (decklinkDevices.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'DeckLink Outputs';
      decklinkDevices.forEach((deviceName, index) => {
        const option = document.createElement('option');
        option.value = `decklink:${index}`;
        option.textContent = deviceName;
        const playerId = select.closest('.player-card')?.dataset.playerId;
        const isSelectedElsewhere = Array.from(activeOutputs.entries()).some(([otherPlayerId, value]) => {
          return otherPlayerId !== playerId && value === option.value;
        });
        if (isSelectedElsewhere) {
          option.disabled = true;
          option.textContent = `${deviceName} (In use)`;
        }
        group.appendChild(option);
      });
      select.appendChild(group);
    }

    const playerId = select.closest('.player-card')?.dataset.playerId;
    const previousValue = playerId ? previousSelections.get(playerId) : null;
    if (previousValue && select.querySelector(`option[value="${previousValue}"]`)) {
      select.value = previousValue;
    }

  });
}

async function handleOutputChange(playerId, outputValue, playerCard) {
  try {
    if (!outputValue) {
      // Close output window
      await ipcRenderer.invoke('close-output-window', playerId);
      await ipcRenderer.invoke('decklink-clear-output', { playerId });
      updatePlayerStatus(playerCard, players[playerId].isPlaying ? 'playing' : 'stopped');
      await loadOutputOptions();
      return;
    }

    if (outputValue.startsWith('display:')) {
      const displayId = parseInt(outputValue.split(':')[1]);
      const result = await ipcRenderer.invoke('create-output-window', {
        playerId,
        displayId,
        outputType: 'display',
        streamName: null
      });

      if (!result.success) {
        alert('Failed to create output window: ' + result.error);
        playerCard.querySelector('.output-select').value = '';
      }
      updatePlayerStatus(playerCard, players[playerId].isPlaying ? 'playing' : 'stopped');
      await ipcRenderer.invoke('decklink-clear-output', { playerId });
      await loadOutputOptions();
      return;
    }

    if (outputValue.startsWith('decklink:')) {
      const deviceIndex = parseInt(outputValue.split(':')[1]);
      const result = await ipcRenderer.invoke('decklink-set-output', { playerId, deviceIndex });

      if (!result.success) {
        alert('Failed to set DeckLink output: ' + result.error);
        playerCard.querySelector('.output-select').value = '';
      }
      updatePlayerStatus(playerCard, players[playerId].isPlaying ? 'playing' : 'stopped');
      await loadOutputOptions();
      return;
    }
  } catch (error) {
    console.error('Error in handleOutputChange:', error);
    throw error;
  }
}

async function refreshDeckLinkDevices() {
  const list = document.getElementById('decklink-device-list');
  const status = document.getElementById('decklink-status');
  const button = document.getElementById('decklink-refresh-btn');

  if (!list || !status) return;

  if (button) button.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Checking DeckLink devices...';
  list.innerHTML = '';

  try {
    const result = await ipcRenderer.invoke('decklink-list-devices');

    if (result && result.ok) {
      const devices = Array.isArray(result.devices) ? result.devices : [];
      if (devices.length === 0) {
        status.textContent = 'No DeckLink devices found.';
      } else {
        status.textContent = `Found ${devices.length} DeckLink device${devices.length === 1 ? '' : 's'}.`;
        devices.forEach(device => {
          const li = document.createElement('li');
          li.textContent = device;
          list.appendChild(li);
        });
      }
    } else {
      const message = result && result.error ? result.error : 'DeckLink enumeration failed.';
      status.textContent = `Error: ${message}`;
      status.classList.add('error');
    }
  } catch (error) {
    status.textContent = `Error: ${error.message}`;
    status.classList.add('error');
  } finally {
    if (button) button.disabled = false;
  }
}

async function populateMultiviewOutputOptions() {
  const select = document.getElementById('multiview-output-select');
  if (!select) return;

  const displays = await ipcRenderer.invoke('get-displays');
  const activeOutputs = new Set();
  document.querySelectorAll('.player-card .output-select, #multiview-output-select').forEach(outputSelect => {
    if (outputSelect.value && outputSelect.value.startsWith('display:')) {
      activeOutputs.add(outputSelect.value);
    }
  });

  select.innerHTML = '<option value="">None</option>';
  displays.forEach(display => {
    const option = document.createElement('option');
    option.value = `display:${display.id}`;
    option.textContent = display.label;
    if (activeOutputs.has(option.value) && multiviewState.outputSelection !== option.value) {
      option.disabled = true;
      option.textContent = `${display.label} (In use)`;
    }
    select.appendChild(option);
  });

  if (multiviewState.outputSelection && select.querySelector(`option[value="${multiviewState.outputSelection}"]`)) {
    select.value = multiviewState.outputSelection;
  }
}

async function applyMultiviewOutput() {
  if (!multiviewState.outputSelection) {
    await ipcRenderer.invoke('clear-multiview-output');
    persistMultiviewState();
    return true;
  }

  if (!multiviewState.outputSelection.startsWith('display:')) {
    alert('Multiview currently supports display outputs.');
    return false;
  }

  const displayId = Number.parseInt(multiviewState.outputSelection.split(':')[1], 10);
  const result = await ipcRenderer.invoke('set-multiview-output', {
    displayId,
    gridMode: multiviewState.gridMode
  });

  if (!result || !result.success) {
    alert(`Failed to enable multiview: ${result && result.error ? result.error : 'Unknown error'}`);
    return false;
  }

  ipcRenderer.send('multiview-grid-mode', { gridMode: multiviewState.gridMode });
  persistMultiviewState();
  return true;
}

async function restoreMultiviewOutput() {
  loadMultiviewState();
  await populateMultiviewOutputOptions();
  if (multiviewState.outputSelection) {
    await applyMultiviewOutput();
  }
}

function setupMultiviewModal() {
  const outputModal = document.getElementById('output-modal');
  const multiviewModal = document.getElementById('multiview-modal');
  const closeBtn = document.getElementById('multiview-close');
  const applyBtn = document.getElementById('multiview-apply');
  const disableBtn = document.getElementById('multiview-disable');
  const outputSelect = document.getElementById('multiview-output-select');
  const gridSelect = document.getElementById('multiview-grid-select');

  if (!multiviewModal || !closeBtn || !applyBtn || !disableBtn || !outputSelect || !gridSelect) {
    return;
  }

  multiviewUi.modal = multiviewModal;
  multiviewUi.outputModal = outputModal;
  multiviewUi.outputSelect = outputSelect;
  multiviewUi.gridSelect = gridSelect;

  const syncForm = async () => {
    loadMultiviewState();
    await populateMultiviewOutputOptions();
    gridSelect.value = multiviewState.gridMode;
  };

  openMultiviewSettingsModal = async () => {
    if (outputModal) outputModal.classList.remove('active');
    await syncForm();
    multiviewModal.classList.add('active');
  };

  closeBtn.addEventListener('click', () => {
    multiviewModal.classList.remove('active');
  });

  multiviewModal.addEventListener('click', event => {
    if (event.target === multiviewModal) {
      multiviewModal.classList.remove('active');
    }
  });

  applyBtn.addEventListener('click', async () => {
    multiviewState.outputSelection = outputSelect.value;
    multiviewState.gridMode = gridSelect.value === '2x1' ? '2x1' : '2x2';
    const success = await applyMultiviewOutput();
    if (success) {
      multiviewModal.classList.remove('active');
    }
  });

  disableBtn.addEventListener('click', async () => {
    multiviewState.outputSelection = '';
    outputSelect.value = '';
    await applyMultiviewOutput();
    multiviewModal.classList.remove('active');
  });
}

let openMultiviewSettingsModal = async () => {
  const modal = multiviewUi.modal;
  if (modal) {
    modal.classList.add('active');
  }
};
function openOutputSettingsModal() {
  const modal = document.getElementById('output-modal');
  if (!modal) return;
  modal.classList.add('active');
}

function setupOutputSettingsModal() {
  const modal = document.getElementById('output-modal');
  const btn = document.getElementById('output-settings-btn');
  if (!modal) return;
  const closeBtn = modal.querySelector('.close-btn');

  if (btn) {
    btn.addEventListener('click', () => {
      openOutputSettingsModal();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  // Close on outside click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.classList.remove('active');
    }
  });
}

function applyPlayerLayout(mode) {
  const allowedModes = new Set(['two', 'four', 'grid-2x2', 'stack-1x4']);
  const nextMode = allowedModes.has(mode) ? mode : 'four';
  document.body.classList.toggle('layout-two', nextMode === 'two');
  document.body.classList.toggle('layout-four', nextMode === 'four');
  document.body.classList.toggle('layout-grid-2x2', nextMode === 'grid-2x2');
  document.body.classList.toggle('layout-stack-1x4', nextMode === 'stack-1x4');
  localStorage.setItem('playerLayoutMode', nextMode);
  updateTabPanelMinHeights();
}

function getDeckLinkVideoModeSetting() {
  return localStorage.getItem('decklinkVideoMode') || DEFAULT_DECKLINK_VIDEO_MODE;
}

function applyDeckLinkVideoModeSetting(value) {
  const videoMode = value || DEFAULT_DECKLINK_VIDEO_MODE;
  localStorage.setItem('decklinkVideoMode', videoMode);
  ipcRenderer.invoke('decklink-set-video-mode', { videoMode }).catch(error => {
    console.warn('Failed to persist DeckLink video mode:', error);
  });
}

function populateDeckLinkVideoModeOptions() {
  const select = document.getElementById('decklink-video-mode');
  if (!select) return;

  select.innerHTML = '';
  DECKLINK_VIDEO_MODES.forEach(mode => {
    const option = document.createElement('option');
    option.value = mode.value;
    option.textContent = mode.label;
    select.appendChild(option);
  });

  const savedValue = getDeckLinkVideoModeSetting();
  if (select.querySelector(`option[value="${savedValue}"]`)) {
    select.value = savedValue;
  } else {
    select.value = DEFAULT_DECKLINK_VIDEO_MODE;
  }

  applyDeckLinkVideoModeSetting(select.value);
}

function setupDeckLinkPanel() {
  const refreshBtn = document.getElementById('decklink-refresh-btn');
  const videoModeSelect = document.getElementById('decklink-video-mode');

  if (!refreshBtn) return;

  refreshBtn.addEventListener('click', () => {
    refreshDeckLinkDevices();
  });

  populateDeckLinkVideoModeOptions();

  if (videoModeSelect) {
    videoModeSelect.addEventListener('change', (event) => {
      applyDeckLinkVideoModeSetting(event.target.value);
    });
  }
}

// Color picker functionality
let currentColorPlayerId = null;
let currentColorPlayerCard = null;
let currentColor = { r: 0, g: 0, b: 0 };

function setupColorPickerModal() {
  const modal = document.getElementById('color-picker-modal');
  const closeBtn = document.getElementById('color-picker-close');
  const applyBtn = document.getElementById('apply-color');
  
  const redSlider = document.getElementById('red-slider');
  const greenSlider = document.getElementById('green-slider');
  const blueSlider = document.getElementById('blue-slider');
  
  const redValue = document.getElementById('red-value');
  const greenValue = document.getElementById('green-value');
  const blueValue = document.getElementById('blue-value');
  
  const hexInput = document.getElementById('hex-input');
  const previewBox = document.getElementById('color-preview-box');

  if (!modal || !closeBtn || !applyBtn || !redSlider || !greenSlider || !blueSlider || !hexInput || !previewBox) {
    return;
  }

  // Update color from sliders
  function updateFromSliders() {
    currentColor.r = parseInt(redSlider.value);
    currentColor.g = parseInt(greenSlider.value);
    currentColor.b = parseInt(blueSlider.value);
    
    redValue.textContent = currentColor.r;
    greenValue.textContent = currentColor.g;
    blueValue.textContent = currentColor.b;
    
    const hex = rgbToHex(currentColor.r, currentColor.g, currentColor.b);
    hexInput.value = hex;
    previewBox.style.background = hex;
  }

  // Update color from hex input
  function updateFromHex() {
    const hex = hexInput.value;
    if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
      const rgb = hexToRgb(hex);
      currentColor = rgb;
      
      redSlider.value = rgb.r;
      greenSlider.value = rgb.g;
      blueSlider.value = rgb.b;
      
      redValue.textContent = rgb.r;
      greenValue.textContent = rgb.g;
      blueValue.textContent = rgb.b;
      
      previewBox.style.background = hex;
    }
  }

  redSlider.addEventListener('input', updateFromSliders);
  greenSlider.addEventListener('input', updateFromSliders);
  blueSlider.addEventListener('input', updateFromSliders);
  hexInput.addEventListener('input', updateFromHex);

  closeBtn.addEventListener('click', () => {
    modal.classList.remove('active');
  });

  applyBtn.addEventListener('click', () => {
    if (currentColorPlayerId && currentColorPlayerCard) {
      const hex = rgbToHex(currentColor.r, currentColor.g, currentColor.b);
      applyBackgroundColor(currentColorPlayerId, currentColorPlayerCard, hex);
    }
    modal.classList.remove('active');
  });

  modal.addEventListener('click', (event) => {
    if (event.target === modal) {
      modal.classList.remove('active');
    }
  });
}

function openColorPicker(playerId, playerCard) {
  currentColorPlayerId = playerId;
  currentColorPlayerCard = playerCard;
  
  // Get current background color
  const previewContainer = playerCard.querySelector('.player-preview');
  const currentBg = previewContainer ? window.getComputedStyle(previewContainer).backgroundColor : 'rgb(0, 0, 0)';
  
  // Parse RGB color
  const match = currentBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (match) {
    currentColor = {
      r: parseInt(match[1]),
      g: parseInt(match[2]),
      b: parseInt(match[3])
    };
  }
  
  // Update modal with current color
  document.getElementById('red-slider').value = currentColor.r;
  document.getElementById('green-slider').value = currentColor.g;
  document.getElementById('blue-slider').value = currentColor.b;
  
  document.getElementById('red-value').textContent = currentColor.r;
  document.getElementById('green-value').textContent = currentColor.g;
  document.getElementById('blue-value').textContent = currentColor.b;
  
  const hex = rgbToHex(currentColor.r, currentColor.g, currentColor.b);
  document.getElementById('hex-input').value = hex;
  document.getElementById('color-preview-box').style.background = hex;
  
  // Show modal
  document.getElementById('color-picker-modal').classList.add('active');
}

function applyBackgroundColor(playerId, playerCard, hexColor) {
  // Store in data attribute for persistence
  playerCard.dataset.backgroundColor = hexColor;
  
  // Update color preview in button
  const colorPreview = playerCard.querySelector('.color-preview');
  if (colorPreview) {
    colorPreview.style.background = hexColor;
  }
  
  // Update preview background
  const previewContainer = playerCard.querySelector('.player-preview');
  if (previewContainer) {
    previewContainer.style.background = hexColor;
  }
  
  // Send to output window
  ipcRenderer.send('update-background-color', { playerId, color: hexColor });
  schedulePlayerViewSync(playerId, playerCard);
  
  // Save state
  savePlayerState(playerId);
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => {
    const hex = x.toString(16);
    return hex.length === 1 ? '0' + hex : hex;
  }).join('');
}

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

// State persistence functions
function savePlayerState(playerId) {
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!playerCard) return;

  const state = {
    folderPath: players[playerId].folderPath,
    transitionType: playerCard.querySelector('.transition-type')?.value || 'cut',
    fadeDuration: playerCard.querySelector('.duration-slider')?.value || 1,
    displayTime: playerCard.querySelector('.timing-slider')?.value || 5,
    scaleFill: playerCard.querySelector('.scale-fill-checkbox')?.checked || false,
    backgroundColor: playerCard.dataset.backgroundColor || '#000000',
    outputSelection: playerCard.querySelector('.output-select')?.value || '',
    autoStart: playerCard.querySelector('.auto-start-checkbox')?.checked || false,
    customTitle: playerCard.dataset.customTitle || ''
  };

  localStorage.setItem(`player${playerId}State`, JSON.stringify(state));
  ipcRenderer.invoke('set-player-state', { playerId, state }).catch(error => {
    console.error(`Failed to persist player ${playerId} state to main store:`, error);
  });
  console.log(`Saved state for player ${playerId}`);
}

async function getPersistedPlayerState(playerId) {
  let savedState = null;
  try {
    savedState = await ipcRenderer.invoke('get-player-state', playerId);
  } catch (error) {
    console.error(`Failed to load player ${playerId} state from main store:`, error);
  }

  if (!savedState) {
    savedState = localStorage.getItem(`player${playerId}State`);
  }

  if (!savedState) return null;

  try {
    return typeof savedState === 'string' ? JSON.parse(savedState) : savedState;
  } catch (error) {
    console.error(`Failed to parse persisted state for player ${playerId}:`, error);
    return null;
  }
}

function migrateLegacyPlayerState(state) {
  if (!state || typeof state !== 'object') return { state, changed: false };

  const migratedState = { ...state };
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(migratedState, 'backgroundImage')) {
    delete migratedState.backgroundImage;
    changed = true;
  }

  return { state: migratedState, changed };
}

async function loadPlayerState(playerId) {
  const persistedState = await getPersistedPlayerState(playerId);
  if (!persistedState) return;

  const { state, changed } = migrateLegacyPlayerState(persistedState);

  // Keep localStorage in sync for downstream restore paths
  try {
    localStorage.setItem(`player${playerId}State`, JSON.stringify(state));
  } catch (error) {
    console.error(`Failed to sync localStorage for player ${playerId}:`, error);
  }

  if (changed) {
    ipcRenderer.invoke('set-player-state', { playerId, state }).catch(error => {
      console.error(`Failed to persist migrated state for player ${playerId}:`, error);
    });
  }

  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!playerCard) return;

  // Restore transition type
  const transitionType = playerCard.querySelector('.transition-type');
  if (transitionType && state.transitionType) {
    transitionType.value = state.transitionType;
    syncTransitionToggle(playerCard, state.transitionType);
  }

  // Restore fade duration
  const durationSlider = playerCard.querySelector('.duration-slider');
  const durationValue = playerCard.querySelector('.duration-value');
  if (durationSlider && state.fadeDuration) {
    durationSlider.value = state.fadeDuration;
    if (durationValue) durationValue.textContent = `${state.fadeDuration}s`;
  }

  // Restore display time
  const timingSlider = playerCard.querySelector('.timing-slider');
  const timingValue = playerCard.querySelector('.timing-value');
  if (timingSlider && state.displayTime) {
    timingSlider.value = state.displayTime;
    if (timingValue) timingValue.textContent = `${state.displayTime}s`;
  }

  // Restore scale to fill
  const scaleFillCheckbox = playerCard.querySelector('.scale-fill-checkbox');
  if (scaleFillCheckbox && state.scaleFill !== undefined) {
    scaleFillCheckbox.checked = state.scaleFill;
  }

  // Restore auto-start checkbox
  const autoStartCheckbox = playerCard.querySelector('.auto-start-checkbox');
  if (autoStartCheckbox && state.autoStart !== undefined) {
    autoStartCheckbox.checked = state.autoStart;
  }
  
  // Restore custom title
  if (state.customTitle) {
    applyCustomTitle(playerId, playerCard, state.customTitle);
  }

  // Restore background color
  if (state.backgroundColor) {
    playerCard.dataset.backgroundColor = state.backgroundColor;
    // Update color preview button
    const colorPreview = playerCard.querySelector('.color-preview');
    if (colorPreview) {
      colorPreview.style.background = state.backgroundColor;
    }
    // Update preview container
    const previewContainer = playerCard.querySelector('.player-preview');
    if (previewContainer) {
      previewContainer.style.background = state.backgroundColor;
    }
    // Send to output window if it exists
    ipcRenderer.send('update-background-color', { playerId, color: state.backgroundColor });
  }

  // Restore folder path and auto-start if folder has images AND auto-start is enabled
  if (state.folderPath) {
    await loadFolderFromPath(playerId, playerCard, state.folderPath);
    
    // Auto-start player if folder was successfully loaded with images AND auto-start is enabled
    if (state.autoStart && players[playerId].images && players[playerId].images.length > 0) {
      console.log(`Auto-starting player ${playerId}`);
      startPlayer(playerId, playerCard);
    }
  }

  schedulePlayerViewSync(playerId, playerCard);

  console.log(`Loaded state for player ${playerId}`);
}

async function restorePlayerOutput(playerId) {
  const state = await getPersistedPlayerState(playerId);
  if (!state) return;
  const playerCard = document.querySelector(`[data-player-id="${playerId}"]`);
  if (!playerCard) return;

  // Restore output selection
  const outputSelect = playerCard.querySelector('.output-select');
  if (outputSelect && state.outputSelection && state.outputSelection.startsWith('display:')) {
    outputSelect.value = state.outputSelection;
    // Re-trigger the output setup if it was previously configured
    await handleOutputChange(playerId, state.outputSelection, playerCard);
  }
}

async function loadAllPlayerStates() {
  console.log('Loading all player states...');
  const loadPromises = [];
  for (let i = 1; i <= 4; i++) {
    loadPromises.push(loadPlayerState(i));
  }
  await Promise.all(loadPromises);
  console.log('All player states loaded');

  console.log('Starting output restoration...');
  // Now restore outputs after the buffer period
  for (let i = 1; i <= 4; i++) {
    await restorePlayerOutput(i);
  }
  console.log('All outputs restored');
}

async function loadFolderFromPath(playerId, playerCard, folderPath) {
  try {
    // Use IPC to reload the folder (this will also start the watcher)
    const result = await ipcRenderer.invoke('reload-folder', { playerId, folderPath });
    
    if (!result || !result.images || result.images.length === 0) {
      console.log(`Could not reload folder: ${folderPath}`);
      return;
    }

    // Update player state
    players[playerId].images = result.images;
    players[playerId].currentIndex = 0;
    players[playerId].folderPath = folderPath;

    // Update UI
    const folderPathEl = playerCard.querySelector('.folder-path');
    if (folderPathEl) {
      folderPathEl.textContent = folderPath;
      folderPathEl.title = folderPath;
    }
    
    setPlayToggleState(playerCard, false, true);

    // Show preview of first image
    const preview = playerCard.querySelector('.preview-image-1');
    const placeholder = playerCard.querySelector('.preview-placeholder');
    if (preview && result.images.length > 0) {
      preview.src = `file://${result.images[0]}`;
      preview.classList.add('visible');
      if (placeholder) {
        placeholder.style.display = 'none';
      }
    }

    schedulePlayerViewSync(playerId, playerCard);

    console.log(`Restored folder for player ${playerId}: ${folderPath} (${result.images.length} images)`);
  } catch (error) {
    console.error(`Error loading saved folder for player ${playerId}:`, error);
  }
}

// Inline Title Editing functionality
function enableTitleEdit(playerId, playerCard, playerName) {
  // Store original text
  const originalText = playerName.textContent;
  const defaultTitle = `Player ${playerId}`;
  
  // Make editable
  playerName.contentEditable = true;
  playerName.style.userSelect = 'text';
  playerName.focus();
  
  // Select all text
  const range = document.createRange();
  range.selectNodeContents(playerName);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  
  // Function to finish editing
  const finishEdit = () => {
    playerName.contentEditable = false;
    playerName.style.userSelect = 'none';
    
    const newTitle = playerName.textContent.trim();
    
    if (newTitle === '' || newTitle === defaultTitle) {
      // Reset to default if empty or same as default
      playerName.textContent = defaultTitle;
      playerCard.dataset.customTitle = '';
    } else if (newTitle !== originalText) {
      // Save custom title
      playerName.textContent = newTitle;
      playerCard.dataset.customTitle = newTitle;
    } else {
      // No change, restore original
      playerName.textContent = originalText;
    }
    
    savePlayerState(playerId);
  };
  
  // Handle blur (clicking away)
  const blurHandler = () => {
    finishEdit();
    playerName.removeEventListener('blur', blurHandler);
    playerName.removeEventListener('keydown', keyHandler);
  };
  
  // Handle keyboard events
  const keyHandler = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      playerName.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      playerName.textContent = originalText;
      playerName.blur();
    }
  };
  
  playerName.addEventListener('blur', blurHandler);
  playerName.addEventListener('keydown', keyHandler);
}

function applyCustomTitle(playerId, playerCard, customTitle) {
  // Store in data attribute
  playerCard.dataset.customTitle = customTitle;
  
  // Update the h2 text
  const playerName = playerCard.querySelector('.player-name');
  if (playerName) {
    playerName.textContent = customTitle;
  }
  schedulePlayerViewSync(playerId, playerCard);
  
  // Save state
  savePlayerState(playerId);
}

function resetToDefaultTitle(playerId, playerCard) {
  // Clear data attribute
  playerCard.dataset.customTitle = '';
  
  // Reset to default title
  const playerName = playerCard.querySelector('.player-name');
  if (playerName) {
    playerName.textContent = `Player ${playerId}`;
  }
  schedulePlayerViewSync(playerId, playerCard);
  
  // Save state
  savePlayerState(playerId);
}
