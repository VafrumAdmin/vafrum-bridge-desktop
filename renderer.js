// DOM Elements
const apiUrlInput = document.getElementById('apiUrl');
const apiKeyInput = document.getElementById('apiKey');
const apiUrl2Input = document.getElementById('apiUrl2');
const apiKey2Input = document.getElementById('apiKey2');
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

// Sekundären Server separat speichern & verbinden
const saveApi2Btn = document.getElementById('saveApi2Btn');
saveApi2Btn.addEventListener('click', () => {
  const url2 = apiUrl2Input.value.trim();
  const key2 = apiKey2Input.value.trim();
  window.bridge.saveAndConnectApi2(url2, key2);
  addLog('Sekundärer Server gespeichert' + (url2 ? ' & Verbindung gestartet' : ' (leer = deaktiviert)'));
});

// Event Listeners
connectBtn.addEventListener('click', () => {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!apiUrl || !apiKey) {
    addLog('Bitte API URL und Key eingeben', 'error');
    return;
  }

  const apiUrl2 = apiUrl2Input.value.trim();
  const apiKey2 = apiKey2Input.value.trim();
  window.bridge.connect(apiUrl, apiKey, apiUrl2, apiKey2);
});

disconnectBtn.addEventListener('click', () => {
  window.bridge.disconnect();
});

// Bridge Events
window.bridge.onConfigLoaded((config) => {
  if (config.apiUrl) apiUrlInput.value = config.apiUrl;
  if (config.apiKey) apiKeyInput.value = config.apiKey;
  if (config.apiUrl2) apiUrl2Input.value = config.apiUrl2;
  if (config.apiKey2) apiKey2Input.value = config.apiKey2;
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
  printersList.textContent = '';

  if (printers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Keine Drucker verbunden';
    printersList.appendChild(empty);
    return;
  }

  printers.forEach(p => {
    const isOnline = p.online;
    const isPrinting = p.gcodeState === 'RUNNING';
    const isPaused = p.gcodeState === 'PAUSE';

    const card = document.createElement('div');
    card.className = 'printer-card';

    const icon = document.createElement('div');
    icon.className = 'printer-icon';
    icon.textContent = isPrinting ? '\u{1F5A8}\uFE0F' : '\u{1F4E6}';
    card.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'printer-info';

    const name = document.createElement('div');
    name.className = 'printer-name';
    name.textContent = p.name;
    info.appendChild(name);

    const status = document.createElement('div');
    status.className = 'printer-status' + (isOnline ? ' online' : '');
    status.textContent = getStatusText(p.gcodeState, isOnline);
    info.appendChild(status);

    if (isOnline) {
      const temps = document.createElement('div');
      temps.className = 'printer-temps';

      if (p.nozzleTemp2 !== undefined) {
        temps.appendChild(createTempItem('Düse L:', Math.round(p.nozzleTemp || 0) + '\u00B0' + (p.nozzleTargetTemp ? '/' + p.nozzleTargetTemp + '\u00B0' : '')));
        temps.appendChild(createTempItem('Düse R:', Math.round(p.nozzleTemp2 || 0) + '\u00B0' + (p.nozzleTargetTemp2 ? '/' + p.nozzleTargetTemp2 + '\u00B0' : '')));
      } else {
        temps.appendChild(createTempItem('Düse:', Math.round(p.nozzleTemp || 0) + '\u00B0' + (p.nozzleTargetTemp ? '/' + p.nozzleTargetTemp + '\u00B0' : '')));
      }

      temps.appendChild(createTempItem('Bett:', Math.round(p.bedTemp || 0) + '\u00B0' + (p.bedTargetTemp ? '/' + p.bedTargetTemp + '\u00B0' : '')));

      if (p.chamberTemp !== undefined) {
        temps.appendChild(createTempItem('Kammer:', Math.round(p.chamberTemp) + '\u00B0'));
      }

      info.appendChild(temps);
    }

    if (isPrinting || isPaused) {
      const progress = document.createElement('div');
      progress.className = 'printer-progress';

      const bar = document.createElement('div');
      bar.className = 'progress-bar';
      const fill = document.createElement('div');
      fill.className = 'progress-fill';
      fill.style.width = (p.printProgress || 0) + '%';
      bar.appendChild(fill);
      progress.appendChild(bar);

      const text = document.createElement('div');
      text.className = 'progress-text';
      let progressStr = (p.printProgress || 0) + '% - ' + (p.currentFile || 'Unbekannt');
      if (p.remainingTime) progressStr += ' - ' + formatTime(p.remainingTime) + ' verbleibend';
      text.textContent = progressStr;
      progress.appendChild(text);
      info.appendChild(progress);

      const controls = document.createElement('div');
      controls.className = 'printer-controls';
      if (isPrinting) controls.appendChild(createCtrlBtn('Pause', p.serialNumber, 'pause', 'pause'));
      if (isPaused) controls.appendChild(createCtrlBtn('Fortsetzen', p.serialNumber, 'resume', 'resume'));
      controls.appendChild(createCtrlBtn('Stop', p.serialNumber, 'stop', 'stop'));
      info.appendChild(controls);
    }

    if (isOnline) {
      const controls2 = document.createElement('div');
      controls2.className = 'printer-controls';
      controls2.style.marginTop = '8px';
      controls2.appendChild(createCtrlBtn('Licht', p.serialNumber, 'light'));
      controls2.appendChild(createCtrlBtn('Home', p.serialNumber, 'home'));
      info.appendChild(controls2);
    }

    card.appendChild(info);
    printersList.appendChild(card);
  });
}

function createTempItem(label, value) {
  const item = document.createElement('div');
  item.className = 'temp-item';
  const lbl = document.createElement('span');
  lbl.className = 'temp-label';
  lbl.textContent = label;
  const val = document.createElement('span');
  val.className = 'temp-value';
  val.textContent = value;
  item.appendChild(lbl);
  item.appendChild(val);
  return item;
}

function createCtrlBtn(text, serial, cmd, extraClass) {
  const btn = document.createElement('button');
  btn.className = 'ctrl-btn' + (extraClass ? ' ' + extraClass : '');
  btn.dataset.serial = serial;
  btn.dataset.cmd = cmd;
  btn.textContent = text;
  return btn;
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
  window.bridge.checkUpdates();
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
  addLog('Update heruntergeladen: v' + version + ' - Installieren-Button sollte erscheinen');
  updateText.textContent = 'Update bereit: v' + version;
  updateProgress.classList.add('hidden');
  updateProgress.style.display = 'none';
  installUpdateBtn.classList.remove('hidden');
  installUpdateBtn.style.display = 'inline-block';
  addLog('installUpdateBtn display: ' + installUpdateBtn.style.display + ', classList: ' + installUpdateBtn.className);
});

installUpdateBtn.addEventListener('click', () => {
  window.bridge.installUpdate();
});

// Reset UI wenn neue Version verfügbar (alte verwerfen)
window.bridge.onUpdateReset(() => {
  addLog('Neues Update verfügbar - UI wird zurückgesetzt');
  installUpdateBtn.classList.add('hidden');
  installUpdateBtn.style.display = 'none';
  updateProgress.classList.remove('hidden');
  updateProgress.style.display = '';
  updateProgress.textContent = 'Wird heruntergeladen...';
});

// Initialize
window.bridge.getVersion().then(v => {
  document.getElementById('appVersion').textContent = 'v' + v;
  addLog('Vafrum Bridge v' + v + ' gestartet');
});
