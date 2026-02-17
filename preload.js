const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  connect: (apiUrl, apiKey, apiUrl2, apiKey2) => ipcRenderer.invoke('connect', { apiUrl, apiKey, apiUrl2, apiKey2 }),
  saveAndConnectApi2: (apiUrl2, apiKey2) => ipcRenderer.invoke('save-connect-api2', { apiUrl2, apiKey2 }),
  disconnect: () => ipcRenderer.invoke('disconnect'),
  sendCommand: (serialNumber, command) => ipcRenderer.invoke('send-command', { serialNumber, command }),
  setTunnel: (tunnelUrl) => ipcRenderer.invoke('set-tunnel', tunnelUrl),
  getConfig: () => ipcRenderer.invoke('get-config'),

  // Update-Funktionen
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  restart: () => ipcRenderer.invoke('restart-app'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  onLog: (callback) => ipcRenderer.on('log', (event, msg) => callback(msg)),
  onApiStatus: (callback) => ipcRenderer.on('api-status', (event, status) => callback(status)),
  onPrintersUpdate: (callback) => ipcRenderer.on('printers-update', (event, printers) => callback(printers)),
  onConfigLoaded: (callback) => ipcRenderer.on('config-loaded', (event, config) => callback(config)),

  // Update-Events
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, version) => callback(version)),
  onUpdateProgress: (callback) => ipcRenderer.on('update-progress', (event, percent) => callback(percent)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', (event, version) => callback(version)),
  onUpdateReset: (callback) => ipcRenderer.on('update-reset', () => callback())
});
