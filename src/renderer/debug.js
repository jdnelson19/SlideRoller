const { ipcRenderer } = require('electron');

const logOutput = document.getElementById('log-output');
const clearBtn = document.getElementById('clear-btn');
const copyBtn = document.getElementById('copy-btn');
const pauseBtn = document.getElementById('pause-btn');
const statusText = document.getElementById('status-text');

let paused = false;
let lineCount = 0;

function formatEntry(entry) {
  const ts = entry && entry.timestamp ? entry.timestamp : new Date().toISOString();
  const level = entry && entry.level ? String(entry.level).toUpperCase() : 'LOG';
  const source = entry && entry.source ? entry.source : 'unknown';
  const message = entry && entry.message ? entry.message : '';
  return `[${ts}] [${source}] [${level}] ${message}`;
}

function appendLine(text) {
  if (paused) return;

  if (lineCount > 0) {
    logOutput.textContent += '\n';
  }
  logOutput.textContent += text;
  lineCount += 1;
  logOutput.scrollTop = logOutput.scrollHeight;
}

ipcRenderer.on('debug-log-buffer', (event, entries) => {
  if (!Array.isArray(entries)) return;
  logOutput.textContent = '';
  lineCount = 0;
  entries.forEach(entry => appendLine(formatEntry(entry)));
});

ipcRenderer.on('debug-log-entry', (event, entry) => {
  appendLine(formatEntry(entry));
});

clearBtn.addEventListener('click', () => {
  logOutput.textContent = '';
  lineCount = 0;
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(logOutput.textContent || '');
    statusText.textContent = 'Copied';
    setTimeout(() => {
      statusText.textContent = paused ? 'Paused' : 'Live';
    }, 1000);
  } catch (error) {
    statusText.textContent = 'Copy failed';
    setTimeout(() => {
      statusText.textContent = paused ? 'Paused' : 'Live';
    }, 1000);
  }
});

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  statusText.textContent = paused ? 'Paused' : 'Live';
});
