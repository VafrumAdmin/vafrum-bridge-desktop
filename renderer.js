// DOM Elements
const apiUrlInput = document.getElementById('apiUrl');
const apiKeyInput = document.getElementById('apiKey');
const tunnelUrlInput = document.getElementById('tunnelUrl');
const saveTunnelBtn = document.getElementById('saveTunnelBtn');
const connectBtn = document.getElementById('connectBtn');
const disconnectBtn = document.getElementById('disconnectBtn');
const statusIndicator = document.getElementById('statusIndicator');
const printersList = document.getElementById('printersList');
const logArea = document.getElementById('logArea');

let printers = [];

// Tunnel URL save
saveTunnelBtn.addEventListener('click', () => {
  const url = tunnelUrlInput.value.trim();
  window.bridge.setTunnel(url);
});

// Event Listeners
connectBtn.addEventListener('click', () => {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!apiUrl || !apiKey) {
    addLog('Bitte API URL und Key eingeben', 'error');
    return;
  }

  window.bridge.connect(apiUrl, apiKey);
});

disconnectBtn.addEventListener('click', () => {
  window.bridge.disconnect();
});

// Bridge Events
window.bridge.onConfigLoaded((config) => {
  if (config.apiUrl) apiUrlInput.value = config.apiUrl;
  if (config.apiKey) apiKeyInput.value = config.apiKey;
  if (config.tunnelUrl) tunnelUrlInput.value = config.tunnelUrl;
});

window.bridge.onLog((msg) => {
  addLog(msg);
});

window.bridge.onApiStatus((status) => {
  statusIndicator.className = 'status-indicator ' + status;

  const statusText = statusIndicator.querySelector('.status-text');
  switch (status) {
    case 'connected':
      statusText.textContent = 'Verbunden';
      connectBtn.disabled = true;
      disconnectBtn.disabled = false;
      break;
    case 'connecting':
      statusText.textContent = 'Verbinde...';
      connectBtn.disabled = true;
      disconnectBtn.disabled = true;
      break;
    case 'disconnected':
      statusText.textContent = 'Getrennt';
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      break;
    case 'error':
      statusText.textContent = 'Fehler';
      connectBtn.disabled = false;
      disconnectBtn.disabled = true;
      break;
  }
});

window.bridge.onPrintersUpdate((updatedPrinters) => {
  printers = updatedPrinters;
  renderPrinters();
});

// Functions
function addLog(msg, type = '') {
  const entry = document.createElement('div');
  entry.className = 'log-entry ' + type;
  const time = new Date().toLocaleTimeString('de-DE');
  entry.textContent = `[${time}] ${msg}`;
  logArea.appendChild(entry);
  logArea.scrollTop = logArea.scrollHeight;

  // Keep only last 100 entries
  while (logArea.children.length > 100) {
    logArea.removeChild(logArea.firstChild);
  }
}

function renderPrinters() {
  if (printers.length === 0) {
    printersList.innerHTML = '<div class="empty-state">Keine Drucker verbunden</div>';
    return;
  }

  printersList.innerHTML = printers.map(p => {
    const isOnline = p.online;
    const isPrinting = p.gcodeState === 'RUNNING';
    const isPaused = p.gcodeState === 'PAUSE';

    return `
      <div class="printer-card">
        <div class="printer-icon">${isPrinting ? '🖨️' : '📦'}</div>
        <div class="printer-info">
          <div class="printer-name">${p.name}</div>
          <div class="printer-status ${isOnline ? 'online' : ''}">${getStatusText(p.gcodeState, isOnline)}</div>
          ${isOnline ? `
            <div class="printer-temps">
              ${p.nozzleTemp2 !== undefined ? `
                <div class="temp-item">
                  <span class="temp-label">Düse L:</span>
                  <span class="temp-value">${Math.round(p.nozzleTemp || 0)}°${p.nozzleTargetTemp ? '/' + p.nozzleTargetTemp + '°' : ''}</span>
                </div>
                <div class="temp-item">
                  <span class="temp-label">Düse R:</span>
                  <span class="temp-value">${Math.round(p.nozzleTemp2 || 0)}°${p.nozzleTargetTemp2 ? '/' + p.nozzleTargetTemp2 + '°' : ''}</span>
                </div>
              ` : `
                <div class="temp-item">
                  <span class="temp-label">Düse:</span>
                  <span class="temp-value">${Math.round(p.nozzleTemp || 0)}°${p.nozzleTargetTemp ? '/' + p.nozzleTargetTemp + '°' : ''}</span>
                </div>
              `}
              <div class="temp-item">
                <span class="temp-label">Bett:</span>
                <span class="temp-value">${Math.round(p.bedTemp || 0)}°${p.bedTargetTemp ? '/' + p.bedTargetTemp + '°' : ''}</span>
              </div>
              ${p.chamberTemp !== undefined ? `
                <div class="temp-item">
                  <span class="temp-label">Kammer:</span>
                  <span class="temp-value">${Math.round(p.chamberTemp)}°</span>
                </div>
              ` : ''}
            </div>
          ` : ''}
          ${(isPrinting || isPaused) ? `
            <div class="printer-progress">
              <div class="progress-bar">
                <div class="progress-fill" style="width: ${p.printProgress || 0}%"></div>
              </div>
              <div class="progress-text">
                ${p.printProgress || 0}% - ${p.currentFile || 'Unbekannt'}
                ${p.remainingTime ? ' - ' + formatTime(p.remainingTime) + ' verbleibend' : ''}
              </div>
            </div>
            <div class="printer-controls">
              ${isPrinting ? `
                <button class="ctrl-btn pause" data-serial="${p.serialNumber}" data-cmd="pause">Pause</button>
              ` : ''}
              ${isPaused ? `
                <button class="ctrl-btn resume" data-serial="${p.serialNumber}" data-cmd="resume">Fortsetzen</button>
              ` : ''}
              <button class="ctrl-btn stop" data-serial="${p.serialNumber}" data-cmd="stop">Stop</button>
            </div>
          ` : ''}
          ${isOnline ? `
            <div class="printer-controls" style="margin-top: 8px;">
              <button class="ctrl-btn" data-serial="${p.serialNumber}" data-cmd="light">Licht</button>
              <button class="ctrl-btn" data-serial="${p.serialNumber}" data-cmd="home">Home</button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function getStatusText(state, online) {
  if (!online) return 'Offline';
  const states = {
    'IDLE': 'Bereit',
    'RUNNING': 'Druckt',
    'PAUSE': 'Pausiert',
    'FINISH': 'Fertig',
    'FAILED': 'Fehler',
    'PREPARE': 'Vorbereitung'
  };
  return states[state] || state || 'Bereit';
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

let lightState = {};

// Event delegation for all printer control buttons
printersList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-cmd]');
  if (!btn) return;

  const serial = btn.dataset.serial;
  const cmd = btn.dataset.cmd;

  addLog('Button: ' + cmd + ' für ' + serial);

  switch (cmd) {
    case 'pause':
    case 'resume':
    case 'stop':
      window.bridge.sendCommand(serial, { type: cmd });
      break;
    case 'light':
      lightState[serial] = !lightState[serial];
      window.bridge.sendCommand(serial, { type: 'light', on: lightState[serial] });
      addLog('Licht: ' + (lightState[serial] ? 'AN' : 'AUS'));
      break;
    case 'home':
      window.bridge.sendCommand(serial, { type: 'gcode', gcode: 'G28' });
      break;
  }
});

// Update Elements
const updateBanner = document.getElementById('updateBanner');
const updateText = document.getElementById('updateText');
const updateProgress = document.getElementById('updateProgress');
const installUpdateBtn = document.getElementById('installUpdateBtn');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const restartBtn = document.getElementById('restartBtn');

// Restart Button
restartBtn.addEventListener('click', () => {
  addLog('App wird neu gestartet...');
  window.bridge.restart();
});

// Manual update check
checkUpdateBtn.addEventListener('click', () => {
  addLog('Suche nach Updates...');
  checkUpdateBtn.disabled = true;
  checkUpdateBtn.textContent = 'Prüfe...';
  window.bridge.checkUpdates();
  setTimeout(() => {
    checkUpdateBtn.disabled = false;
    checkUpdateBtn.textContent = 'Updates prüfen';
  }, 5000);
});

// Update Events
window.bridge.onUpdateAvailable((version) => {
  updateBanner.classList.remove('hidden');
  updateText.textContent = 'Update verfügbar: v' + version;
  updateProgress.classList.remove('hidden');
  updateProgress.textContent = 'Wird heruntergeladen...';
});

window.bridge.onUpdateProgress((percent) => {
  updateProgress.textContent = percent + '%';
});

window.bridge.onUpdateDownloaded((version) => {
  updateText.textContent = 'Update bereit: v' + version;
  updateProgress.classList.add('hidden');
  installUpdateBtn.classList.remove('hidden');
});

installUpdateBtn.addEventListener('click', () => {
  window.bridge.installUpdate();
});

// Initialize
addLog('Vafrum Bridge gestartet');
