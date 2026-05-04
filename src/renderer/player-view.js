const { ipcRenderer } = require('electron');

function applyGridMode(gridMode) {
  document.body.classList.toggle('grid-2x1', gridMode === '2x1');
  document.body.classList.toggle('grid-2x2', gridMode !== '2x1');
}

function applyPlayerViewTile(playerId, payload = {}) {
  const tile = document.querySelector(`.player-view-tile[data-player-id="${playerId}"]`);
  if (!tile) return;

  const title = tile.querySelector('.player-view-title');
  const schedule = tile.querySelector('.player-view-schedule');
  const status = tile.querySelector('.player-view-status');
  const preview = tile.querySelector('.player-view-preview');
  const image = tile.querySelector('.player-view-image');
  const placeholder = tile.querySelector('.player-view-placeholder');

  title.textContent = payload.title || `Player ${playerId}`;
  if (schedule) {
    schedule.textContent = payload.scheduleText || 'No active schedule';
  }
  status.textContent = (payload.status || 'stopped').replace(/-/g, ' ');
  preview.style.background = payload.backgroundColor || '#000000';

  if (payload.imageSrc) {
    image.src = payload.imageSrc;
    image.style.objectFit = payload.objectFit || 'contain';
    image.classList.add('visible');
    placeholder.style.display = 'none';
  } else {
    image.removeAttribute('src');
    image.classList.remove('visible');
    placeholder.textContent = payload.placeholder || 'No output preview';
    placeholder.style.display = 'flex';
  }
}

ipcRenderer.on('multiview-state', (event, state) => {
  applyGridMode(state && state.gridMode ? state.gridMode : '2x2');
  for (let playerId = 1; playerId <= 4; playerId += 1) {
    const payload = state && state.players && state.players[playerId] ? state.players[playerId] : {};
    applyPlayerViewTile(playerId, payload);
  }
});

ipcRenderer.on('multiview-player-update', (event, { playerId, payload }) => {
  applyPlayerViewTile(playerId, payload);
});

ipcRenderer.on('multiview-grid-mode', (event, { gridMode }) => {
  applyGridMode(gridMode);
});