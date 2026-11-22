const tabControls = document.getElementById('tab-controls');
const tabShortcuts = document.getElementById('tab-shortcuts');
const panelControls = document.getElementById('panel-controls');
const panelShortcuts = document.getElementById('panel-shortcuts');

function setTab(mode) {
  const shortcutsActive = mode === 'shortcuts';
  tabControls.classList.toggle('active', !shortcutsActive);
  tabShortcuts.classList.toggle('active', shortcutsActive);
  tabControls.setAttribute('aria-selected', shortcutsActive ? 'false' : 'true');
  tabShortcuts.setAttribute('aria-selected', shortcutsActive ? 'true' : 'false');
  panelControls.classList.toggle('active', !shortcutsActive);
  panelShortcuts.classList.toggle('active', shortcutsActive);
}

tabControls.addEventListener('click', () => setTab('controls'));
tabShortcuts.addEventListener('click', () => setTab('shortcuts'));
