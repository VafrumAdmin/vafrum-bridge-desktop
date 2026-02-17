const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const { autoUpdater } = require('electron-updater');
const tls = require('tls');
const express = require('express');
let mainWindow;
let tunnelProcess = null;
let mqttClients = new Map();
let apiSocket = null;
let apiSocket2 = null;
let printers = new Map();
let config = { apiUrl: '', apiKey: '', apiUrl2: '', apiKey2: '', tunnelUrl: '' };
let configPath = '';
let go2rtcProcess = null;
let logsDir = '';
let rawMqttLogStream = null;
let go2rtcReady = false;
let cameraUrls = new Map();
let cameraStreams = new Map(); // Alle Kamera-Streams für go2rtc
let go2rtcRestartTimer = null; // Debounce für go2rtc Neustart
let localIp = 'localhost';

// === Auto-Reconnect & Resilience ===
let tunnelRestartAttempts = 0;
let tunnelRestartTimer = null;
let go2rtcWatchdogTimer = null;
let mqttErrorThrottle = new Map(); // serial -> lastLogTime (Fehler-Spam vermeiden)
let printerReconnectTimers = new Map(); // serial -> timer (Reconnect-Timer pro Drucker)
let printerDataCache = new Map(); // serial -> printer data (für Reconnect nach Verlust)

// JPEG Streaming für A1/P1 Drucker
let jpegStreams = new Map(); // serial -> { socket, lastFrame, clients }
let mjpegServer = null;
const MJPEG_PORT = 8765;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    backgroundColor: '#1a1a1a',
    title: 'Vafrum Bridge',
    autoHideMenuBar: true
  });

  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('did-finish-load', () => {
    loadConfig();
    mainWindow.webContents.send('config-loaded', config);

    // Auto-Connect wenn Zugangsdaten gespeichert
    if (config.apiUrl && config.apiKey) {
      setTimeout(() => {
        sendLog('Auto-Verbindung...');
        connectToApi(config.apiUrl, config.apiKey);
      }, 1000);
    }
  });
}

function loadConfig() {
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
  } catch (e) {
    console.error('Config error:', e);
  }
}

// === Debug Logging für Entwicklung ===
function initLogging() {
  logsDir = path.join(app.getPath('userData'), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Raw MQTT Log Stream (append mode)
  const rawLogPath = path.join(logsDir, 'mqtt-raw.log');
  rawMqttLogStream = fs.createWriteStream(rawLogPath, { flags: 'a' });
  sendLog('Logging initialisiert: ' + logsDir);
}

function logRawMqtt(serialNumber, topic, data) {
  if (!rawMqttLogStream) return;
  const timestamp = new Date().toISOString();
  const entry = `[${timestamp}] [${serialNumber}] ${topic}\n${JSON.stringify(data, null, 2)}\n${'='.repeat(80)}\n`;
  rawMqttLogStream.write(entry);
}

function logLatestStatus() {
  if (!logsDir) return;
  const statusObj = {};
  printers.forEach((printer, serial) => {
    statusObj[serial] = printer;
  });

  try {
    const statusPath = path.join(logsDir, 'latest-status.json');
    fs.writeFileSync(statusPath, JSON.stringify(statusObj, null, 2));
  } catch (e) {
    // Ignore write errors
  }
}

function saveConfig(newConfig) {
  config = { ...config, ...newConfig };
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error('Save error:', e);
  }
}

function sendLog(msg) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('log', msg);
  }
}

function connectToApi(apiUrl, apiKey) {
  if (apiSocket) apiSocket.disconnect();

  sendLog('Verbinde mit API...');
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-status', 'connecting');

  apiSocket = io(apiUrl, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
    timeout: 20000,
    auth: { apiKey }
  });

  apiSocket.on('connect', () => {
    sendLog('API verbunden');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-status', 'connected');
  });

  apiSocket.on('authenticated', () => {
    sendLog('Authentifiziert');
    apiSocket.emit('printers:request');

    // Sekundären Server verbinden falls konfiguriert
    if (config.apiUrl2 && config.apiKey2) {
      connectToApi2(config.apiUrl2, config.apiKey2);
    }
  });

  apiSocket.on('auth:error', (error) => {
    sendLog('Auth Fehler: ' + error);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-status', 'error');
  });

  apiSocket.on('printers:list', (list) => {
    sendLog(list.length + ' Drucker empfangen');
    list.forEach(p => {
      sendLog('Drucker von API: ' + p.name + ' | Model: ' + (p.model || 'FEHLT!') + ' | SN: ' + p.serialNumber);
      if (p.serialNumber && p.ipAddress && p.accessCode) {
        connectPrinter(p);
      }
    });
  });

  // New printer added - connect automatically
  apiSocket.on('printer:add', (p) => {
    sendLog('Neuer Drucker: ' + p.name);
    if (p.serialNumber && p.ipAddress && p.accessCode) {
      connectPrinter(p);
    }
  });

  // Printer removed - disconnect
  apiSocket.on('printer:remove', (data) => {
    sendLog('Drucker entfernt: ' + data.serialNumber);
    const client = mqttClients.get(data.serialNumber);
    if (client) {
      client.end();
      mqttClients.delete(data.serialNumber);
      printers.delete(data.serialNumber);
      cameraUrls.delete(data.serialNumber);
      cameraStreams.delete('cam_' + data.serialNumber);
      stopJpegStream(data.serialNumber); // JPEG Stream stoppen
      updatePrinters();
    }
  });

  apiSocket.on('printer:command', (data) => {
    sendLog('API Befehl empfangen: ' + JSON.stringify(data.command) + ' für ' + data.serialNumber);
    executeCommand(data.serialNumber, data.command);
  });

  apiSocket.on('disconnect', () => {
    sendLog('API getrennt');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-status', 'disconnected');
  });
}

function connectToApi2(apiUrl2, apiKey2) {
  if (apiSocket2) apiSocket2.disconnect();

  sendLog('Verbinde mit sekundärem Server...');

  apiSocket2 = io(apiUrl2, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 3000,
    reconnectionDelayMax: 30000,
    reconnectionAttempts: Infinity,
    timeout: 20000,
    auth: { apiKey: apiKey2 }
  });

  apiSocket2.on('connect', () => {
    sendLog('API2 verbunden');
  });

  apiSocket2.on('authenticated', () => {
    sendLog('API2 authentifiziert');
    apiSocket2.emit('printers:request');
  });

  apiSocket2.on('auth:error', (error) => {
    sendLog('API2 Auth Fehler: ' + error);
  });

  apiSocket2.on('printers:list', (list) => {
    sendLog('API2: ' + list.length + ' Drucker empfangen');
  });

  // Befehle vom sekundären Server ebenfalls ausführen
  apiSocket2.on('printer:command', (data) => {
    sendLog('API2 Befehl empfangen: ' + JSON.stringify(data.command) + ' für ' + data.serialNumber);
    executeCommand(data.serialNumber, data.command);
  });

  apiSocket2.on('disconnect', () => {
    sendLog('API2 getrennt');
  });
}

function disconnectApi() {
  if (apiSocket) {
    apiSocket.disconnect();
    apiSocket = null;
  }
  if (apiSocket2) {
    apiSocket2.disconnect();
    apiSocket2 = null;
  }
  mqttClients.forEach(c => c.end());
  mqttClients.clear();
  printers.clear();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('api-status', 'disconnected');
    mainWindow.webContents.send('printers-update', []);
  }
}

function connectPrinter(printer) {
  if (mqttClients.has(printer.serialNumber)) return;

  // Druckerdaten cachen für späteres Reconnect
  printerDataCache.set(printer.serialNumber, printer);

  // Eventuellen alten Reconnect-Timer löschen
  if (printerReconnectTimers.has(printer.serialNumber)) {
    clearTimeout(printerReconnectTimers.get(printer.serialNumber));
    printerReconnectTimers.delete(printer.serialNumber);
  }

  sendLog('Verbinde: ' + printer.name);

  const client = mqtt.connect('mqtts://' + printer.ipAddress + ':8883', {
    username: 'bblp',
    password: printer.accessCode,
    rejectUnauthorized: false,
    clientId: 'vafrum_' + printer.serialNumber + '_' + Date.now(),
    connectTimeout: 15000,
    reconnectPeriod: 0 // Wir machen eigenes Reconnect mit Backoff
  });

  client.on('connect', () => {
    sendLog('Drucker verbunden: ' + printer.name);
    mqttClients.set(printer.serialNumber, client);
    printers.set(printer.serialNumber, { ...printer, online: true });
    resetReconnectCounter(printer.serialNumber);
    client.subscribe('device/' + printer.serialNumber + '/report');
    // get_version + pushall senden (wie HA-Integration - triggert device-Daten inkl. CTC)
    const reqTopic = 'device/' + printer.serialNumber + '/request';
    client.publish(reqTopic, JSON.stringify({ info: { sequence_id: '0', command: 'get_version' } }));
    client.publish(reqTopic, JSON.stringify({ pushing: { sequence_id: '0', command: 'pushall' } }));
    addCameraStream(printer.serialNumber, printer.accessCode, printer.ipAddress, printer.model);
    updatePrinters();
  });

  client.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());

      // Debug: Raw MQTT data to file
      logRawMqtt(printer.serialNumber, topic, data);

      // DEBUG: Log ALL messages when AMS debug mode is active
      if (client._debugAmsCmd) {
        // Don't log huge pushall responses fully, just the keys and AMS section
        const keys = Object.keys(data);
        if (data.print?.ams) {
          const amsData = data.print.ams;
          const trays = [];
          if (Array.isArray(amsData.ams)) {
            amsData.ams.forEach((unit, ui) => {
              if (Array.isArray(unit.tray)) {
                unit.tray.forEach((t, ti) => {
                  if (t) trays.push('U' + ui + 'T' + ti + ':' + (t.tray_type || '?') + '/' + (t.tray_color || '?'));
                });
              }
            });
          }
          sendLog('DEBUG MQTT AMS: trays=[' + trays.join(', ') + ']');
        } else if (data.print?.command) {
          // Command response from printer
          sendLog('DEBUG MQTT RESPONSE: ' + JSON.stringify(data).substring(0, 500));
        } else {
          sendLog('DEBUG MQTT keys: ' + keys.join(',') + (data.print ? ' print.keys=' + Object.keys(data.print).join(',') : ''));
        }
      }

      // Log system responses (errors, command results)
      if (data.system) {
        sendLog('SYSTEM RESPONSE von ' + printer.name + ': ' + JSON.stringify(data.system));
      }

      // H2D/H2C: Kammertemperatur via CTC-Modul
      // Liegt in data.print.device.ctc.info.temp (NICHT data.device!)
      const ctcTemp = data.print?.device?.ctc?.info?.temp;
      if (ctcTemp !== undefined && ctcTemp !== null) {
        const ctcValue = ctcTemp & 0xFFFF;
        const prev = printers.get(printer.serialNumber) || {};
        prev.chamberTemp = ctcValue;
        printers.set(printer.serialNumber, prev);
        if (!client._ctcLogged) {
          sendLog('[CTC] ' + printer.name + ' Kammertemp: ' + ctcValue + '° (raw=' + ctcTemp + ')');
          client._ctcLogged = true;
        }
      }

      // H2-DEBUG: Erste MQTT-Nachrichten komplett loggen (um CTC/device-Felder zu finden)
      const isH2 = printers.get(printer.serialNumber)?.model?.toUpperCase()?.includes('H2');
      if (isH2) {
        if (!client._h2DumpCount) client._h2DumpCount = 0;
        if (client._h2DumpCount < 3) {
          // Komplette Nachricht dumpen (max 1500 Zeichen um nicht zu überladen)
          const fullDump = JSON.stringify(data).substring(0, 1500);
          sendLog('[H2-DUMP] ' + printer.name + ' MSG#' + client._h2DumpCount + ': ' + fullDump);
          client._h2DumpCount++;
        }
        // Auch nicht-print Nachrichten loggen (device, info, system)
        const topKeys = Object.keys(data);
        if (!topKeys.includes('print') || topKeys.length > 1) {
          sendLog('[H2-NONPRINT] ' + printer.name + ': topKeys=' + topKeys.join(',') + ' data=' + JSON.stringify(data).substring(0, 500));
        }
      }

      if (data.print) {
        const p = data.print;

        // Debug: Log lights_report (zeigt welche LED-Nodes der Drucker hat)
        if (p.lights_report) {
          const nodes = p.lights_report.map(l => l.node + '=' + l.mode).join(', ');
          if (!client._lightsLogged || client._lastLightsNodes !== nodes) {
            sendLog('LED-Nodes von ' + printer.name + ': ' + nodes);
            client._lightsLogged = true;
            client._lastLightsNodes = nodes;
          }
        }

        // Vorherigen Status holen (MUSS vor AMS-Parsing stehen!)
        const prevStatus = printers.get(printer.serialNumber) || {};

        // Parse AMS data (merge with previous to handle incremental MQTT updates)
        let ams = null;
        if (p.ams) {
          const prevAms = prevStatus.ams || { units: [], trays: [] };
          ams = {
            humidity: p.ams.ams_humidity ?? prevAms.humidity,
            trayNow: p.ams.tray_now ?? prevAms.trayNow,
            units: prevAms.units || [],
            trays: prevAms.trays || []
          };
          if (Array.isArray(p.ams.ams)) {
            // Full tray update received - rebuild units and trays
            ams.units = [];
            ams.trays = [];
            p.ams.ams.forEach((unit, unitIdx) => {
              // Store unit-level info (humidity per AMS)
              // humidity_raw = actual percentage (AMS 2 Pro)
              // humidity = index 1-5 (AMS Pro 1st Gen)
              // AMS Lite hat keinen Sensor - nicht senden!

              // Prüfe ob überhaupt Feuchtigkeitsdaten vorhanden sind
              const hasHumidityRaw = unit.humidity_raw !== undefined && unit.humidity_raw !== '';
              const hasHumidityIndex = unit.humidity !== undefined && unit.humidity !== '' && parseInt(unit.humidity) > 0;

              const unitData = {
                id: unitIdx,
                temp: parseFloat(unit.temp) || 0
              };

              // Nur Feuchtigkeit senden wenn tatsächlich Daten vorhanden
              if (hasHumidityRaw) {
                // AMS 2 Pro: Exakte Prozentwerte
                unitData.humidity = parseInt(unit.humidity_raw);
                unitData.humidityIndex = parseInt(unit.humidity) || 0;
              } else if (hasHumidityIndex) {
                // AMS Pro 1st Gen: Nur Index 1-5
                unitData.humidity = parseInt(unit.humidity);
                unitData.humidityIndex = parseInt(unit.humidity);
              }
              // AMS Lite: Keine Feuchtigkeit (humidity bleibt undefined)

              ams.units.push(unitData);
              if (Array.isArray(unit.tray)) {
                unit.tray.forEach((tray, trayIdx) => {
                  // Tray einschließen wenn tray_type ODER tray_color vorhanden
                  // (AMS HT kann tray_color ohne tray_type melden)
                  const hasData = tray && (tray.tray_type || (tray.tray_color && tray.tray_color !== '00000000'));
                  if (hasData) {
                    ams.trays.push({
                      id: unitIdx * 4 + trayIdx,
                      unitId: unitIdx,
                      slot: trayIdx,
                      type: tray.tray_type || '',
                      color: tray.tray_color || '',
                      name: tray.tray_sub_brands || tray.tray_type || '',
                      remain: tray.remain != null ? parseInt(tray.remain) : -1,
                      k: tray.k || 0,
                      nozzleTempMin: tray.nozzle_temp_min || 0,
                      nozzleTempMax: tray.nozzle_temp_max || 0,
                      trayInfoIdx: tray.tray_info_idx || '',
                      tagUid: tray.tag_uid || '',
                      trayUuid: tray.tray_uuid || '',
                      trayWeight: tray.tray_weight ? parseInt(tray.tray_weight) : 0,
                      dryingTemp: tray.drying_temp ? parseInt(tray.drying_temp) : 0,
                      dryingTime: tray.drying_time ? parseInt(tray.drying_time) : 0
                    });
                  }
                });
              }
            });
          }
        }

        // Parse external spool: vt_tray (Standard) oder vir_slot (H2D Dual-Nozzle)
        let externalSpool = null;
        let externalSpools = []; // Für H2D: mehrere externe Spulen
        if (Array.isArray(p.vir_slot) && p.vir_slot.length > 0) {
          // H2D/H2C: vir_slot Array – id 254 = Nozzle 0 (links), id 253 = Nozzle 1 (rechts)
          for (const slot of p.vir_slot) {
            const vtType = slot.tray_type || '';
            const vtColor = slot.tray_color || '';
            if (vtType || (vtColor && vtColor !== '00000000')) {
              const spoolData = {
                id: slot.id != null ? parseInt(slot.id) : 254,
                type: vtType,
                color: vtColor,
                name: slot.tray_sub_brands || '',
                remain: slot.remain != null ? parseInt(slot.remain) : -1,
                k: slot.k || 0,
                nozzleTempMin: slot.nozzle_temp_min || 0,
                nozzleTempMax: slot.nozzle_temp_max || 0,
                trayInfoIdx: slot.tray_info_idx || '',
                tagUid: slot.tag_uid || '',
                trayWeight: slot.tray_weight ? parseInt(slot.tray_weight) : 0
              };
              externalSpools.push(spoolData);
              // Rückwärtskompatibel: erste Spule als externalSpool
              if (!externalSpool) externalSpool = spoolData;
            }
          }
        } else if (p.vt_tray) {
          // Standard: einzelnes vt_tray Objekt
          const vtType = p.vt_tray.tray_type || '';
          const vtColor = p.vt_tray.tray_color || '';
          if (vtType || (vtColor && vtColor !== '00000000')) {
            externalSpool = {
              type: vtType,
              color: vtColor,
              name: p.vt_tray.tray_sub_brands || '',
              remain: p.vt_tray.remain != null ? parseInt(p.vt_tray.remain) : -1,
              k: p.vt_tray.k || 0,
              nozzleTempMin: p.vt_tray.nozzle_temp_min || 0,
              nozzleTempMax: p.vt_tray.nozzle_temp_max || 0,
              trayInfoIdx: p.vt_tray.tray_info_idx || '',
              tagUid: p.vt_tray.tag_uid || '',
              trayWeight: p.vt_tray.tray_weight ? parseInt(p.vt_tray.tray_weight) : 0
            };
            externalSpools = [externalSpool];
          }
        }

        // prevStatus wurde oben bereits geholt (vor AMS-Parsing)

        // Stale-Data Fix: Wenn gcode_state IDLE oder FINISH ist, alte Print-Daten bereinigen
        const currentState = p.gcode_state ?? prevStatus.gcodeState;
        if (currentState === 'IDLE' || currentState === 'FINISH') {
          // Fehler-Flags bereinigen wenn kein aktiver Fehler gemeldet wird
          if (p.print_error === undefined || p.print_error === null || p.print_error === 0) {
            prevStatus.printError = 0;
            prevStatus.printErrorCode = '';
          }
          prevStatus.printProgress = 0;
          prevStatus.remainingTime = 0;
          // Target-Temperaturen auf 0 setzen wenn nicht aktiv gedruckt wird
          prevStatus.nozzleTargetTemp = 0;
          prevStatus.nozzleTargetTemp2 = 0;
          prevStatus.bedTargetTemp = 0;
          prevStatus.hms = [];
        }

        // State-Transition: Wenn Drucker von RUNNING/PAUSE/PREPARE zu IDLE/FINISH wechselt,
        // einmalig die gecachten Ist-Temperaturen zurücksetzen damit keine 230° hängen bleiben
        const prevState = prevStatus.gcodeState;
        const wasPrinting = prevState === 'RUNNING' || prevState === 'PAUSE' || prevState === 'PREPARE';
        const nowIdle = currentState === 'IDLE' || currentState === 'FINISH';
        if (wasPrinting && nowIdle) {
          prevStatus.nozzleTemp = 0;
          prevStatus.nozzleTemp2 = undefined;
          prevStatus.bedTemp = 0;
          prevStatus.chamberTemp = 0;
        }

        // Temperatur-Dekodierung: (target << 16) | current (32-bit encoded)
        const decodeTemp = (encoded) => {
          if (encoded === undefined || encoded === null || encoded === 0) return { current: 0, target: 0 };
          return { current: encoded & 0xFFFF, target: (encoded >> 16) & 0xFFFF };
        };

        // H2-Erkennung
        const printerInfoH2 = printers.get(printer.serialNumber);
        const isH2Model = printerInfoH2?.model?.toUpperCase()?.includes('H2');

        // Temperaturen: H2 nutzt device.extruder.info (kodiert), NICHT nozzle_temper!
        // nozzle_temper bei H2 = Standby-Düse (Raumtemp), nicht die aktive Düse
        // Deshalb: H2 nimmt prevStatus (bewahrt device.extruder-Wert), andere nehmen nozzle_temper
        let nozzle1Temp = isH2Model ? (prevStatus.nozzleTemp ?? 0) : (p.nozzle_temper ?? prevStatus.nozzleTemp ?? 0);
        let nozzle1Target = isH2Model ? (prevStatus.nozzleTargetTemp ?? 0) : (p.nozzle_target_temper ?? prevStatus.nozzleTargetTemp ?? 0);
        let nozzle2Temp = isH2Model ? (prevStatus.nozzleTemp2) : (p.nozzle_temper_2 ?? prevStatus.nozzleTemp2);
        let nozzle2Target = isH2Model ? (prevStatus.nozzleTargetTemp2) : (p.nozzle_target_temper_2 ?? prevStatus.nozzleTargetTemp2);

        // H2D/H2C: Echte Düsentemps aus p.device.extruder.info (kodiert)
        const deviceExtruder = p.device?.extruder?.info;
        if (Array.isArray(deviceExtruder) && deviceExtruder.length >= 1) {
          const left = decodeTemp(deviceExtruder[0]?.temp);
          nozzle1Temp = left.current;
          nozzle1Target = left.target;
          if (deviceExtruder.length >= 2) {
            const right = decodeTemp(deviceExtruder[1]?.temp);
            nozzle2Temp = right.current;
            nozzle2Target = right.target;
          }
          if (!client._extruderLogged) {
            const n1 = decodeTemp(deviceExtruder[0]?.temp);
            const n2 = deviceExtruder.length >= 2 ? decodeTemp(deviceExtruder[1]?.temp) : null;
            sendLog('[H2-EXTRUDER] ' + printer.name + ' Düse1: ' + n1.current + '°/' + n1.target + '°' + (n2 ? ' Düse2: ' + n2.current + '°/' + n2.target + '°' : ''));
            client._extruderLogged = true;
          }
        }
        // Fallback: p.extruder.info (älteres Format)
        else if (p.extruder && Array.isArray(p.extruder.info) && p.extruder.info.length >= 2) {
          const left = decodeTemp(p.extruder.info[0]?.temp);
          const right = decodeTemp(p.extruder.info[1]?.temp);
          nozzle1Temp = left.current;
          nozzle1Target = left.target;
          nozzle2Temp = right.current;
          nozzle2Target = right.target;
        }

        // Kammertemperatur: chamber_temper (X1C/P1S) oder p.info.temp (H2 Fallback)
        // p.info.temp bei H2 = Kammertemperatur, NICHT Düse 2!
        const chamberTempValue = p.chamber_temper ?? (printerInfoH2?.model?.toUpperCase()?.includes('H2') ? p.info?.temp : undefined);

        const status = {
          online: true,
          gcodeState: p.gcode_state ?? prevStatus.gcodeState ?? 'IDLE',
          printProgress: p.mc_percent ?? prevStatus.printProgress ?? 0,
          remainingTime: p.mc_remaining_time ?? prevStatus.remainingTime ?? 0,
          currentFile: p.gcode_file || p.subtask_name || prevStatus.currentFile || '',
          layer: p.layer_num ?? prevStatus.layer ?? 0,
          totalLayers: p.total_layer_num ?? prevStatus.totalLayers ?? 0,
          nozzleTemp: nozzle1Temp,
          nozzleTargetTemp: nozzle1Target,
          nozzleTemp2: nozzle2Temp,
          nozzleTargetTemp2: nozzle2Target,
          bedTemp: p.bed_temper ?? prevStatus.bedTemp ?? 0,
          bedTargetTemp: p.bed_target_temper ?? prevStatus.bedTargetTemp ?? 0,
          chamberTemp: chamberTempValue ?? prevStatus.chamberTemp ?? 0,
          // Fan speeds
          partFan: p.cooling_fan_speed ?? prevStatus.partFan,
          auxFan: p.big_fan1_speed ?? prevStatus.auxFan,
          chamberFan: p.big_fan2_speed ?? prevStatus.chamberFan,
          // Lights - verschiedene Drucker nutzen verschiedene Nodes
          // A1: nur chamber_light (wird als workLight angezeigt)
          // P1S: chamber_light + work_light
          // X1/H2: chamber_light + chamber_light2
          chamberLight: p.lights_report ? p.lights_report.find(l => l.node === 'chamber_light')?.mode === 'on' : prevStatus.chamberLight,
          workLight: p.lights_report ? (
            p.lights_report.find(l => l.node === 'chamber_light')?.mode === 'on' ||
            p.lights_report.find(l => l.node === 'chamber_light2')?.mode === 'on' ||
            p.lights_report.find(l => l.node === 'work_light')?.mode === 'on'
          ) : prevStatus.workLight,
          // Speed
          speedLevel: p.spd_lvl ?? prevStatus.speedLevel,
          speedMagnitude: p.spd_mag ?? prevStatus.speedMagnitude,
          // AMS
          ams: ams || prevStatus.ams,
          externalSpool: externalSpool || prevStatus.externalSpool,
          externalSpools: externalSpools.length > 0 ? externalSpools : prevStatus.externalSpools,
          // Misc
          wifiSignal: p.wifi_signal ?? prevStatus.wifiSignal,
          printType: p.print_type ?? prevStatus.printType,
          // Error info
          printError: p.print_error ?? prevStatus.printError ?? 0,
          printErrorCode: p.mc_print_error_code ?? prevStatus.printErrorCode ?? '',
          printStage: p.mc_print_stage ?? prevStatus.printStage,
          hms: Array.isArray(p.hms) ? p.hms : (prevStatus.hms || []),
          // Debug-Feld für H2-Diagnose (bleibt dauerhaft drin)
          _h2debug: isH2 ? {
            printKeys: Object.keys(p).join(','),
            topKeys: Object.keys(data).join(','),
            device: p.device ? JSON.stringify(p.device).substring(0, 800) : undefined,
            '2D': p['2D'] ? JSON.stringify(p['2D']).substring(0, 300) : undefined,
            '3D': p['3D'] ? JSON.stringify(p['3D']).substring(0, 300) : undefined,
            info: p.info ? JSON.stringify(p.info).substring(0, 300) : undefined
          } : undefined
        };
        printers.set(printer.serialNumber, { ...printers.get(printer.serialNumber), ...status });
        updatePrinters();
        logLatestStatus(); // Debug: Write current status to file

        if (apiSocket?.connected) {
          apiSocket.emit('printer:status', {
            printerId: printer.id,
            serialNumber: printer.serialNumber,
            ...status,
            cameraUrl: cameraUrls.get(printer.serialNumber) || undefined
          });
        }
        if (apiSocket2?.connected) {
          apiSocket2.emit('printer:status', {
            printerId: printer.id,
            serialNumber: printer.serialNumber,
            ...status,
            cameraUrl: cameraUrls.get(printer.serialNumber) || undefined
          });
        }
      }
    } catch (e) {}
  });

  client.on('error', (err) => {
    // Fehler-Throttling: gleiche Meldung nur alle 60s loggen
    const now = Date.now();
    const lastLog = mqttErrorThrottle.get(printer.serialNumber) || 0;
    if (now - lastLog > 60000) {
      sendLog('Fehler ' + printer.name + ': ' + err.message);
      mqttErrorThrottle.set(printer.serialNumber, now);
    }
  });

  client.on('close', () => {
    mqttClients.delete(printer.serialNumber);
    const pr = printers.get(printer.serialNumber);
    if (pr) {
      printers.set(printer.serialNumber, { ...pr, online: false });
      updatePrinters();

      // Status an API senden
      if (apiSocket?.connected) {
        apiSocket.emit('printer:status', {
          printerId: printer.id,
          serialNumber: printer.serialNumber,
          online: false
        });
      }
      if (apiSocket2?.connected) {
        apiSocket2.emit('printer:status', {
          printerId: printer.id,
          serialNumber: printer.serialNumber,
          online: false
        });
      }
    }

    // Auto-Reconnect mit Exponential Backoff
    scheduleReconnect(printer.serialNumber);
  });
}

// Intelligentes Reconnect mit Exponential Backoff
let reconnectAttempts = new Map(); // serial -> attempts count

function scheduleReconnect(serialNumber) {
  const cached = printerDataCache.get(serialNumber);
  if (!cached) return; // Kein Reconnect ohne gespeicherte Daten

  // Nicht reconnecten wenn bereits verbunden
  if (mqttClients.has(serialNumber)) return;

  const attempts = reconnectAttempts.get(serialNumber) || 0;
  // Backoff: 5s, 10s, 20s, 40s, 60s, dann max 120s
  const delay = Math.min(5000 * Math.pow(2, attempts), 120000);
  const delaySec = Math.round(delay / 1000);

  reconnectAttempts.set(serialNumber, attempts + 1);

  // Nur loggen bei erstem Versuch oder selten
  if (attempts === 0 || attempts % 5 === 0) {
    sendLog('Reconnect ' + cached.name + ' in ' + delaySec + 's (Versuch ' + (attempts + 1) + ')');
  }

  const timer = setTimeout(() => {
    printerReconnectTimers.delete(serialNumber);
    if (!mqttClients.has(serialNumber)) {
      connectPrinter(cached);
    }
  }, delay);

  printerReconnectTimers.set(serialNumber, timer);
}

// Reconnect-Counter zurücksetzen bei erfolgreicher Verbindung
function resetReconnectCounter(serialNumber) {
  reconnectAttempts.delete(serialNumber);
  mqttErrorThrottle.delete(serialNumber);
}

function executeCommand(serialNumber, command) {
  sendLog('executeCommand aufgerufen: ' + serialNumber + ' -> ' + JSON.stringify(command));
  const client = mqttClients.get(serialNumber);
  if (!client) {
    sendLog('FEHLER: Kein MQTT Client für ' + serialNumber + ' gefunden! Verfügbare: ' + Array.from(mqttClients.keys()).join(', '));
    return;
  }

  const topic = 'device/' + serialNumber + '/request';
  const cmd = typeof command === 'string' ? { type: command } : command;
  let payload = {};

  switch (cmd.type) {
    // Print control
    case 'pause': payload = { print: { command: 'pause', sequence_id: '0' } }; break;
    case 'resume': payload = { print: { command: 'resume', sequence_id: '0' } }; break;
    case 'stop': payload = { print: { command: 'stop', sequence_id: '0' } }; break;

    // Lights
    case 'chamberLight':
    case 'light':
      payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: cmd.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 }, user_id: '1234567890' };
      break;
    case 'workLight':
      // A1/A1 Mini: haben nur 1 Licht (Toolhead LED) - nutzt chamber_light
      // H2D/H2S/H2C/X1: nutzen chamber_light2 für Arbeitslicht
      // P1S: nutzt work_light
      const printerWL = printers.get(serialNumber);
      const modelUpperWL = printerWL?.model?.toUpperCase() || '';
      const ledModeWL = cmd.on ? 'on' : 'off';
      sendLog('workLight für ' + (printerWL?.name || serialNumber) + ' (Model: ' + modelUpperWL + ') -> ' + ledModeWL);

      if (modelUpperWL.includes('A1')) {
        // A1/A1 Mini: Sende an BEIDE nodes - chamber_light UND work_light
        sendLog('A1 -> sende an chamber_light UND work_light');
        const payloadChamber = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
        const payloadWork = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'work_light', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
        client.publish(topic, JSON.stringify(payloadChamber));
        sendLog('Gesendet: chamber_light');
        client.publish(topic, JSON.stringify(payloadWork));
        sendLog('Gesendet: work_light');
        return;
      } else if (modelUpperWL.includes('H2D') || modelUpperWL.includes('H2S') || modelUpperWL.includes('H2C') || modelUpperWL.includes('X1')) {
        payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light2', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
        sendLog('H2/X1 -> chamber_light2');
      } else {
        payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'work_light', led_mode: ledModeWL, led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
        sendLog('Standard -> work_light');
      }
      break;

    // Temperature (sequence_id 2006 + user_id + \n required for gcode_line)
    case 'nozzleTemp': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M104 S' + cmd.temp + '\n' }, user_id: '1234567890' }; break;
    case 'nozzle2Temp': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M104 T1 S' + cmd.temp + '\n' }, user_id: '1234567890' }; break;
    case 'bedTemp': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M140 S' + cmd.temp + '\n' }, user_id: '1234567890' }; break;

    // Fan control (0-100 mapped to 0-255)
    case 'partFan': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M106 P1 S' + Math.round((cmd.speed || 0) * 2.55) + '\n' }, user_id: '1234567890' }; break;
    case 'auxFan': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M106 P2 S' + Math.round((cmd.speed || 0) * 2.55) + '\n' }, user_id: '1234567890' }; break;
    case 'chamberFan': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'M106 P3 S' + Math.round((cmd.speed || 0) * 2.55) + '\n' }, user_id: '1234567890' }; break;

    // Speed level (1=silent, 2=standard, 3=sport, 4=ludicrous)
    case 'speedLevel': payload = { print: { command: 'print_speed', sequence_id: '0', param: String(cmd.level) } }; break;

    // AMS
    case 'amsUnload':
    case 'unloadFilament':
      payload = { print: { command: 'ams_change_filament', sequence_id: '0', target: 255, curr_temp: 220, tar_temp: 220 } };
      break;
    case 'amsLoad':
    case 'loadFilament':
      payload = { print: { command: 'ams_change_filament', sequence_id: '0', target: cmd.slot ?? cmd.trayId ?? 0, curr_temp: 220, tar_temp: 220 } };
      break;

    // Custom G-code
    case 'gcode': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: cmd.gcode + '\n' }, user_id: '1234567890' }; break;

    // Home
    case 'home': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G28\n' }, user_id: '1234567890' }; break;

    // Calibration
    case 'calibration':
      switch (cmd.calibrationType) {
        case 'home': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G28\n' }, user_id: '1234567890' }; break;
        case 'bed_level': payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G29\n' }, user_id: '1234567890' }; break;
        default: return;
      }
      break;

    // Move axes - relative move then back to absolute
    case 'move':
      let dist = cmd.distance || 10;
      const axis = cmd.axis || 'X';
      sendLog('Move Befehl: Achse=' + axis + ', Distanz=' + dist);
      // Bambu requires sequence_id 2006 for gcode, user_id, and \n at end
      payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G91\n' }, user_id: '1234567890' };
      sendLog('Sende G-Code: G91 (relative mode)');
      client.publish(topic, JSON.stringify(payload));
      payload = { print: { command: 'gcode_line', sequence_id: '2006', param: `G0 ${axis}${dist} F3000\n` }, user_id: '1234567890' };
      sendLog('Sende G-Code: G0 ' + axis + dist + ' F3000');
      client.publish(topic, JSON.stringify(payload));
      payload = { print: { command: 'gcode_line', sequence_id: '2006', param: 'G90\n' }, user_id: '1234567890' };
      sendLog('Sende G-Code: G90 (absolute mode)');
      break;

    // AMS Filament Setting - matching OpenSpool/ha-bambulab working format
    case 'amsFilamentSetting':
      const filamentCodeMap = {
        'PLA': 'GFL99', 'PLA-S': 'GFL96', 'PLA-CF': 'GFL98',
        'PETG': 'GFG99', 'PETG-CF': 'GFG98',
        'ABS': 'GFB99', 'ASA': 'GFB98',
        'TPU': 'GFU99', 'PA': 'GFN99', 'PA-CF': 'GFN98',
        'PC': 'GFC99', 'PVA': 'GFS99', 'HIPS': 'GFS98'
      };
      // Use specific Bambu code if provided (from catalog), otherwise fall back to generic
      const filamentCode = cmd.trayInfoIdx || filamentCodeMap[cmd.trayType] || 'GFL99';
      // Debug: Log printer info
      const printerInfo = printers.get(serialNumber);
      sendLog('DEBUG Drucker: Model=' + (printerInfo?.model || 'UNBEKANNT') + ' SN=' + serialNumber);
      sendLog('DEBUG AMS tray info: amsId=' + cmd.amsId + ' trayId=' + cmd.trayId + ' type=' + cmd.trayType + ' color=' + cmd.trayColor + ' trayInfoIdx=' + (cmd.trayInfoIdx || 'generic:' + filamentCode));
      // Enable debug mode - log ALL incoming MQTT messages for 10 seconds
      client._debugAmsCmd = true;
      setTimeout(() => { client._debugAmsCmd = false; sendLog('DEBUG: AMS Debug-Modus Ende'); }, 10000);
      payload = {
        print: {
          sequence_id: '0',
          command: 'ams_filament_setting',
          ams_id: cmd.amsId,
          slot_id: cmd.trayId,
          tray_id: cmd.trayId,
          tray_info_idx: filamentCode,
          setting_id: '',
          tray_color: cmd.trayColor,
          nozzle_temp_min: cmd.nozzleTempMin,
          nozzle_temp_max: cmd.nozzleTempMax,
          tray_type: cmd.trayType
        }
      };
      sendLog('AMS Filament Setting payload: ' + JSON.stringify(payload));
      client.publish(topic, JSON.stringify(payload), (err) => {
        if (err) {
          sendLog('AMS Filament Setting FEHLER: ' + err.message);
        } else {
          sendLog('AMS Filament Setting ERFOLG gesendet');
          // Request pushall after 2s to get immediate AMS status update
          setTimeout(() => {
            client.publish(topic, JSON.stringify({ pushing: { command: 'pushall' } }));
            sendLog('pushall gesendet nach filament setting');
          }, 2000);
        }
      });
      return;

    default: return;
  }

  sendLog('MQTT Publish an Topic: ' + topic);
  client.publish(topic, JSON.stringify(payload), (err) => {
    if (err) {
      sendLog('MQTT Publish FEHLER: ' + err.message);
    } else {
      sendLog('MQTT Publish ERFOLG für: ' + cmd.type);
    }
  });
}

function updatePrinters() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('printers-update', Array.from(printers.values()));
  }
}

ipcMain.handle('connect', (e, { apiUrl, apiKey, apiUrl2, apiKey2 }) => {
  saveConfig({ apiUrl, apiKey, apiUrl2: apiUrl2 || '', apiKey2: apiKey2 || '' });
  connectToApi(apiUrl, apiKey);
});

ipcMain.handle('save-connect-api2', (e, { apiUrl2, apiKey2 }) => {
  saveConfig({ apiUrl2: apiUrl2 || '', apiKey2: apiKey2 || '' });
  // Alten Socket trennen
  if (apiSocket2) {
    apiSocket2.disconnect();
    apiSocket2 = null;
  }
  // Neu verbinden falls URL+Key vorhanden
  if (apiUrl2 && apiKey2) {
    connectToApi2(apiUrl2, apiKey2);
  } else {
    sendLog('Sekundärer Server deaktiviert');
  }
});

ipcMain.handle('disconnect', () => disconnectApi());
ipcMain.handle('send-command', (e, { serialNumber, command }) => {
  sendLog('Befehl empfangen: ' + JSON.stringify(command) + ' für ' + serialNumber);
  executeCommand(serialNumber, command);
});

// Camera / go2rtc
function getLocalIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

let pendingStreams = []; // Streams die vor go2rtc-Start ankommen

// MJPEG Server für A1/P1 Kameras
function startMjpegServer() {
  const expressApp = express();

  // MJPEG Stream Endpoint
  expressApp.get('/stream/:serial', (req, res) => {
    const serial = req.params.serial;
    const stream = jpegStreams.get(serial);

    if (!stream) {
      res.status(404).send('Stream nicht gefunden');
      return;
    }

    res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Client registrieren
    stream.clients.add(res);
    sendLog('MJPEG Client verbunden: ' + serial);

    // Aktuelles Frame senden falls vorhanden
    if (stream.lastFrame) {
      sendJpegFrame(res, stream.lastFrame);
    }

    req.on('close', () => {
      stream.clients.delete(res);
      sendLog('MJPEG Client getrennt: ' + serial);
    });
  });

  // Einzelbild Endpoint
  expressApp.get('/frame/:serial', (req, res) => {
    const serial = req.params.serial;
    const stream = jpegStreams.get(serial);

    if (!stream || !stream.lastFrame) {
      res.status(404).send('Kein Frame verfügbar');
      return;
    }

    res.setHeader('Content-Type', 'image/jpeg');
    res.send(stream.lastFrame);
  });

  mjpegServer = expressApp.listen(MJPEG_PORT, '127.0.0.1', () => {
    sendLog('MJPEG Server gestartet auf 127.0.0.1:' + MJPEG_PORT);
  });

  mjpegServer.on('error', (e) => {
    sendLog('MJPEG Server Fehler: ' + e.message);
  });
}

function sendJpegFrame(res, frameData) {
  try {
    res.write('--frame\r\n');
    res.write('Content-Type: image/jpeg\r\n');
    res.write('Content-Length: ' + frameData.length + '\r\n');
    res.write('\r\n');
    res.write(frameData);
    res.write('\r\n');
  } catch (e) {
    // Client disconnected
  }
}

// A1/P1 JPEG Stream über TLS Port 6000
function startJpegStream(serial, accessCode, ip) {
  if (jpegStreams.has(serial)) {
    sendLog('JPEG Stream bereits aktiv: ' + serial);
    return;
  }

  sendLog('Starte JPEG Stream für A1/P1: ' + serial + ' (' + ip + ')');

  const streamData = {
    socket: null,
    lastFrame: null,
    lastFrameTime: 0,
    clients: new Set(),
    reconnectAttempts: 0,
    buffer: Buffer.alloc(0),
    watchdogTimer: null,
    accessCode: accessCode,
    ip: ip
  };
  jpegStreams.set(serial, streamData);

  // Watchdog: Prüft alle 30s ob Frames kommen, reconnected nach 60s Stille
  streamData.watchdogTimer = setInterval(() => {
    if (!jpegStreams.has(serial)) {
      clearInterval(streamData.watchdogTimer);
      return;
    }
    const now = Date.now();
    const silent = now - streamData.lastFrameTime;
    if (streamData.lastFrameTime > 0 && silent > 60000 && streamData.socket) {
      sendLog('JPEG Watchdog: Kein Frame seit ' + Math.round(silent / 1000) + 's, reconnect: ' + serial);
      streamData.socket.destroy();
      streamData.socket = null;
      streamData.buffer = Buffer.alloc(0);
      streamData.receivedData = false;
      streamData.reconnectAttempts = 0;
      connectJpegStream(serial, accessCode, ip, streamData);
    } else if (streamData.lastFrameTime === 0 && streamData.socket && streamData.receivedData === false) {
      // Auth gesendet aber nie Daten empfangen → nach 30s reconnect
      const socketAge = now - (streamData.connectTime || now);
      if (socketAge > 30000) {
        sendLog('JPEG Watchdog: Nie Daten empfangen nach ' + Math.round(socketAge / 1000) + 's, reconnect: ' + serial);
        streamData.socket.destroy();
        streamData.socket = null;
        streamData.buffer = Buffer.alloc(0);
        streamData.receivedData = false;
        streamData.reconnectAttempts = 0;
        connectJpegStream(serial, accessCode, ip, streamData);
      }
    }
  }, 30000);

  connectJpegStream(serial, accessCode, ip, streamData);

  // go2rtc als Proxy für den lokalen MJPEG Stream nutzen
  // So funktioniert alles über den Cloudflare Tunnel
  const streamName = 'cam_' + serial;
  const localMjpegUrl = 'http://127.0.0.1:' + MJPEG_PORT + '/stream/' + serial;

  // Stream zu go2rtc hinzufügen (falls go2rtc bereit)
  if (go2rtcReady) {
    addMjpegToGo2rtc(streamName, localMjpegUrl);
  } else {
    // Später hinzufügen wenn go2rtc bereit
    pendingStreams.push({ serial, accessCode, ip, model: 'A1', mjpegUrl: localMjpegUrl });
  }

  // URL über go2rtc setzen
  const baseUrl = config.tunnelUrl || ('http://' + localIp + ':1984');
  const mjpegUrl = baseUrl + '/api/stream.mjpeg?src=' + streamName;
  cameraUrls.set(serial, mjpegUrl);
  sendLog('A1/P1 Stream URL (via go2rtc): ' + mjpegUrl);
}

function addMjpegToGo2rtc(streamName, mjpegUrl) {
  const apiUrl = 'http://127.0.0.1:1984/api/streams?name=' + encodeURIComponent(streamName) + '&src=' + encodeURIComponent(mjpegUrl);

  const req = http.request(apiUrl, { method: 'PUT' }, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
      if (res.statusCode === 200) {
        sendLog('MJPEG Stream zu go2rtc hinzugefügt: ' + streamName);
      } else {
        sendLog('go2rtc MJPEG Status: ' + res.statusCode);
        // Fallback: go2rtc Config nutzen
        cameraStreams.set(streamName, mjpegUrl);
        if (go2rtcRestartTimer) clearTimeout(go2rtcRestartTimer);
        go2rtcRestartTimer = setTimeout(() => restartGo2rtcWithAllStreams(), 2000);
      }
    });
  });

  req.on('error', (e) => {
    sendLog('go2rtc MJPEG Fehler: ' + e.message);
    cameraStreams.set(streamName, mjpegUrl);
    if (go2rtcRestartTimer) clearTimeout(go2rtcRestartTimer);
    go2rtcRestartTimer = setTimeout(() => restartGo2rtcWithAllStreams(), 2000);
  });

  req.end();
}

function connectJpegStream(serial, accessCode, ip, streamData) {
  const options = {
    host: ip,
    port: 6000,
    rejectUnauthorized: false
  };

  streamData.connectTime = Date.now();
  streamData.receivedData = false;

  const socket = tls.connect(options, () => {
    sendLog('TLS verbunden: ' + serial);
    streamData.reconnectAttempts = 0;

    // Auth-Paket senden (80 bytes)
    // Format: 4 bytes 0x40 + 4 bytes 0x3000 + 4 bytes 0 + 4 bytes 0 + 32 bytes username + 32 bytes accesscode
    const authPacket = Buffer.alloc(80);
    authPacket.writeUInt32LE(0x40, 0);       // Header marker
    authPacket.writeUInt32LE(0x3000, 4);     // Protocol identifier
    authPacket.writeUInt32LE(0, 8);          // Reserved
    authPacket.writeUInt32LE(0, 12);         // Reserved
    // Username "bblp" at offset 16 (32 bytes field)
    Buffer.from('bblp').copy(authPacket, 16);
    // Access code at offset 48 (32 bytes field)
    Buffer.from(accessCode).copy(authPacket, 48);

    socket.write(authPacket);
    sendLog('Auth gesendet (80 bytes): ' + serial);
  });

  socket.on('data', (data) => {
    if (!streamData.receivedData) {
      sendLog('Erste Daten empfangen von ' + serial + ': ' + data.length + ' bytes');
      sendLog('Erste 20 bytes: ' + data.slice(0, 20).toString('hex'));
      streamData.receivedData = true;
    }
    streamData.buffer = Buffer.concat([streamData.buffer, data]);
    processJpegBuffer(serial, streamData);
  });

  socket.on('error', (err) => {
    sendLog('JPEG Stream Fehler (' + serial + '): ' + err.message + ' (Code: ' + err.code + ')');
  });

  socket.on('close', (hadError) => {
    sendLog('JPEG Stream geschlossen: ' + serial + ' (Fehler: ' + hadError + ', Daten empfangen: ' + !!streamData.receivedData + ')');
    streamData.socket = null;

    // Reconnect solange Stream aktiv - mit exponential backoff (max 30s)
    if (jpegStreams.has(serial)) {
      streamData.reconnectAttempts++;
      const delay = Math.min(5000 * Math.pow(1.5, Math.min(streamData.reconnectAttempts - 1, 6)), 30000);
      sendLog('Reconnect in ' + Math.round(delay / 1000) + 's (Versuch ' + streamData.reconnectAttempts + '): ' + serial);
      setTimeout(() => {
        if (jpegStreams.has(serial)) {
          connectJpegStream(serial, accessCode, ip, streamData);
        }
      }, delay);
    }
  });

  streamData.socket = socket;
}

function processJpegBuffer(serial, streamData) {
  // Suche nach JPEG-Frames direkt über Marker
  // JPEG Start: FF D8 FF E0 (oder FF D8 FF E1 für EXIF)
  // JPEG Ende: FF D9

  const JPEG_START = Buffer.from([0xFF, 0xD8]);
  const JPEG_END = Buffer.from([0xFF, 0xD9]);

  while (true) {
    // Suche Start-Marker
    const startIdx = streamData.buffer.indexOf(JPEG_START);
    if (startIdx === -1) {
      // Kein Start gefunden, Buffer leeren
      streamData.buffer = Buffer.alloc(0);
      return;
    }

    // Wenn Start nicht am Anfang, davor liegende Daten entfernen
    if (startIdx > 0) {
      streamData.buffer = streamData.buffer.slice(startIdx);
    }

    // Suche End-Marker (nach dem Start)
    const endIdx = streamData.buffer.indexOf(JPEG_END, 2);
    if (endIdx === -1) {
      // Noch kein Ende gefunden, warten auf mehr Daten
      return;
    }

    // Komplettes JPEG extrahieren (inklusive End-Marker)
    const jpegData = streamData.buffer.slice(0, endIdx + 2);
    streamData.buffer = streamData.buffer.slice(endIdx + 2);

    // Validieren und speichern
    if (jpegData.length > 100) { // Mindestgröße für gültiges JPEG
      streamData.lastFrame = jpegData;
      streamData.lastFrameTime = Date.now();
      streamData.frameCount = (streamData.frameCount || 0) + 1;

      // Nur alle 10 Frames loggen um Spam zu vermeiden
      if (streamData.frameCount % 10 === 1) {
        sendLog('Frame empfangen: ' + serial + ' (' + jpegData.length + ' bytes)');
      }

      // An alle verbundenen Clients senden
      streamData.clients.forEach(client => {
        sendJpegFrame(client, jpegData);
      });
    }
  }
}

function stopJpegStream(serial) {
  const stream = jpegStreams.get(serial);
  if (stream) {
    if (stream.watchdogTimer) {
      clearInterval(stream.watchdogTimer);
      stream.watchdogTimer = null;
    }
    if (stream.socket) {
      stream.socket.destroy();
    }
    stream.clients.forEach(client => {
      try { client.end(); } catch (e) {}
    });
    jpegStreams.delete(serial);
    sendLog('JPEG Stream gestoppt: ' + serial);
  }
}

// Prüfen ob Drucker A1/P1 Serie ist (kein RTSP)
function isA1P1Model(model) {
  if (!model) return false;
  const m = model.toUpperCase();
  return m.includes('A1') || m.includes('P1');
}

function startGo2rtc() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR || process.cwd();
  const locations = [
    path.join(process.resourcesPath || '', 'go2rtc.exe'),
    path.join(portableDir, 'go2rtc.exe'),
    path.join(path.dirname(process.execPath), 'go2rtc.exe'),
    path.join(__dirname, 'go2rtc.exe')
  ];

  let go2rtcPath = null;
  for (const loc of locations) {
    if (loc && fs.existsSync(loc)) { go2rtcPath = loc; break; }
  }

  if (!go2rtcPath) {
    setTimeout(() => sendLog('go2rtc.exe nicht gefunden! Geprüft: ' + locations.join(', ')), 2000);
    return;
  }

  sendLog('go2rtc gefunden: ' + go2rtcPath);

  // Config in userData schreiben (dort haben wir Schreibrechte)
  const configFile = path.join(app.getPath('userData'), 'go2rtc.yaml');
  // Custom www-Ordner mit eigenem stream.html (ohne controls, volle Breite)
  const wwwDir = path.join(app.getPath('userData'), 'www');
  if (!fs.existsSync(wwwDir)) fs.mkdirSync(wwwDir, { recursive: true });
  fs.writeFileSync(path.join(wwwDir, 'stream.html'), `<!DOCTYPE html>
<html><head><style>
*{margin:0;padding:0}
html,body{width:100%;height:100%;overflow:hidden;background:#000;display:flex}
header,nav{display:none!important}
video-stream{display:block;width:100%!important;height:100%!important;flex:1 1 100%!important}
video{width:100%!important;height:100%!important;object-fit:contain!important;display:block!important}
</style>
<script type="module" src="video-stream.js"></script>
</head><body>
<script>
var p=new URLSearchParams(location.search);
var src=p.get('src');
if(src){
  function init(){
    var v=document.createElement('video-stream');
    v.src=new URL('api/ws?src='+src,location.href).href;
    v.style.cssText='width:100%;height:100%';
    document.body.appendChild(v);
    // Header/Nav entfernen + Controls aus
    var obs=new MutationObserver(function(){
      var h=document.querySelector('header');if(h)h.remove();
      var vid=document.querySelector('video');
      if(vid){vid.controls=false;obs.disconnect();}
    });
    obs.observe(document.body,{childList:true,subtree:true});
  }
  if(customElements.get('video-stream'))init();
  else customElements.whenDefined('video-stream').then(init);
}
</script>
</body></html>`);
  fs.writeFileSync(configFile, 'api:\n  listen: "127.0.0.1:1984"\n  static_dir: "' + wwwDir.replace(/\\/g, '/') + '"\nrtsp:\n  listen: ""\nstreams: {}\n');

  go2rtcProcess = spawn(go2rtcPath, ['-c', configFile], { stdio: 'ignore', windowsHide: true, cwd: app.getPath('userData') });
  go2rtcProcess.on('error', (e) => sendLog('go2rtc Fehler: ' + e.message));

  // Watchdog: go2rtc bei Crash automatisch neu starten
  go2rtcProcess.on('close', (code) => {
    sendLog('go2rtc beendet (Code: ' + code + ')');
    go2rtcProcess = null;
    go2rtcReady = false;

    // Nur neu starten wenn App noch läuft
    if (!app.isQuitting) {
      sendLog('go2rtc Neustart in 3s...');
      go2rtcWatchdogTimer = setTimeout(() => {
        go2rtcWatchdogTimer = null;
        startGo2rtc();
      }, 3000);
    }
  });

  setTimeout(() => {
    go2rtcReady = true;
    sendLog('go2rtc gestartet');

    // Pending Streams hinzufügen
    if (pendingStreams.length > 0) {
      sendLog('Füge ' + pendingStreams.length + ' wartende Streams hinzu...');
      pendingStreams.forEach(s => {
        if (s.mjpegUrl) {
          // A1/P1 MJPEG Stream
          addMjpegToGo2rtc('cam_' + s.serial, s.mjpegUrl);
        } else {
          // X1/H2D RTSP Stream
          addCameraStream(s.serial, s.accessCode, s.ip, s.model);
        }
      });
      pendingStreams = [];
    }

    // Auto-start tunnel
    startTunnel();
  }, 2000);
}

function startTunnel() {
  const locations = [
    path.join(process.resourcesPath, 'cloudflared.exe'),
    path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'cloudflared.exe'),
    path.join(path.dirname(process.execPath), 'cloudflared.exe'),
    path.join(__dirname, 'cloudflared.exe')
  ];

  let cfPath = null;
  for (const loc of locations) {
    if (loc && fs.existsSync(loc)) { cfPath = loc; break; }
  }

  if (!cfPath) {
    sendLog('cloudflared.exe nicht gefunden');
    return;
  }

  sendLog('Starte Tunnel...');
  tunnelProcess = spawn(cfPath, ['tunnel', '--url', 'http://localhost:1984'], { windowsHide: true });

  tunnelProcess.stderr.on('data', (data) => {
    const output = data.toString();
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      config.tunnelUrl = match[0];
      tunnelRestartAttempts = 0; // Erfolgreich - Counter zurücksetzen
      sendLog('Tunnel aktiv: ' + config.tunnelUrl);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('config-loaded', config);
      }
      // Update camera URLs - alles geht über go2rtc
      printers.forEach((printer, serial) => {
        const mjpegUrl = config.tunnelUrl + '/api/stream.mjpeg?src=cam_' + serial;
        cameraUrls.set(serial, mjpegUrl);
        sendLog('URL aktualisiert: ' + serial + ' -> ' + mjpegUrl);

        // Status mit neuer URL an API senden
        if (apiSocket?.connected) {
          apiSocket.emit('printer:status', {
            printerId: printer.id,
            serialNumber: serial,
            cameraUrl: mjpegUrl
          });
        }
        if (apiSocket2?.connected) {
          apiSocket2.emit('printer:status', {
            printerId: printer.id,
            serialNumber: serial,
            cameraUrl: mjpegUrl
          });
        }
      });
    }
  });

  tunnelProcess.on('error', (e) => sendLog('Tunnel Fehler: ' + e.message));
  tunnelProcess.on('close', (code) => {
    sendLog('Tunnel beendet (Code: ' + code + ')');
    tunnelProcess = null;

    // Auto-Restart mit Backoff: 5s, 15s, 30s, 60s, max 300s
    const delay = Math.min(5000 * Math.pow(2, tunnelRestartAttempts), 300000);
    const delaySec = Math.round(delay / 1000);
    tunnelRestartAttempts++;

    sendLog('Tunnel Neustart in ' + delaySec + 's (Versuch ' + tunnelRestartAttempts + ')');
    tunnelRestartTimer = setTimeout(() => {
      tunnelRestartTimer = null;
      startTunnel();
    }, delay);
  });
}

function addCameraStream(serial, accessCode, ip, model) {
  sendLog('Kamera-Setup für: ' + serial + ' (Modell: ' + (model || 'unbekannt') + ')');

  // A1/P1 nutzen JPEG Streaming auf Port 6000
  if (isA1P1Model(model)) {
    sendLog('A1/P1 erkannt - nutze JPEG Streaming auf Port 6000');
    startJpegStream(serial, accessCode, ip);
    return;
  }

  // X1/H2D nutzen RTSP auf Port 322 via go2rtc
  if (!go2rtcReady) {
    sendLog('go2rtc nicht bereit, Stream ' + serial + ' wird in Warteschlange gestellt');
    pendingStreams.push({ serial, accessCode, ip, model });
    return;
  }

  const streamName = 'cam_' + serial;
  const streamUrl = 'rtspx://bblp:' + accessCode + '@' + ip + ':322/streaming/live/1';

  sendLog('RTSP Stream konfiguriert: ' + streamName);

  // Stream zur Map hinzufügen
  cameraStreams.set(streamName, streamUrl);

  // URL sofort setzen (unabhängig vom API-Erfolg)
  const baseUrl = config.tunnelUrl || ('http://' + localIp + ':1984');
  const mjpegUrl = baseUrl + '/api/stream.mjpeg?src=' + streamName;
  cameraUrls.set(serial, mjpegUrl);
  sendLog('Stream URL gesetzt: ' + streamName + ' -> ' + mjpegUrl);

  // Stream via API hinzufügen (ohne Neustart)
  const apiUrl = 'http://127.0.0.1:1984/api/streams?name=' + encodeURIComponent(streamName) + '&src=' + encodeURIComponent(streamUrl);

  const req = http.request(apiUrl, { method: 'PUT' }, (res) => {
    // Response data muss konsumiert werden
    res.on('data', () => {});
    res.on('end', () => {
      if (res.statusCode === 200) {
        sendLog('Stream via API hinzugefügt: ' + streamName);
      } else {
        sendLog('Stream API Status: ' + res.statusCode + ', nutze Fallback');
        // Fallback: go2rtc mit Config neustarten
        if (go2rtcRestartTimer) clearTimeout(go2rtcRestartTimer);
        go2rtcRestartTimer = setTimeout(() => restartGo2rtcWithAllStreams(), 2000);
      }
    });
  });

  req.on('error', (e) => {
    sendLog('Stream API Fehler: ' + e.message + ', nutze Fallback');
    // Fallback: go2rtc mit Config neustarten
    if (go2rtcRestartTimer) clearTimeout(go2rtcRestartTimer);
    go2rtcRestartTimer = setTimeout(() => restartGo2rtcWithAllStreams(), 2000);
  });

  req.end();
}

function restartGo2rtcWithAllStreams() {
  const go2rtcConfigPath = path.join(path.dirname(configPath), 'go2rtc.yaml');

  // Alle Streams in die Config schreiben
  let streamsConfig = '';
  cameraStreams.forEach((url, name) => {
    streamsConfig += `  ${name}: "${url}"\n`;
  });

  const configContent = `api:
  listen: "127.0.0.1:1984"
streams:
${streamsConfig}`;

  try {
    fs.writeFileSync(go2rtcConfigPath, configContent);
    sendLog('go2rtc Config geschrieben mit ' + cameraStreams.size + ' Streams');

    // Alten Prozess beenden
    if (go2rtcProcess) {
      go2rtcProcess.kill();
      go2rtcProcess = null;
    }

    // Kurz warten bis Port frei ist, dann neu starten
    setTimeout(() => {
      startGo2rtcWithConfig(go2rtcConfigPath);
      // URLs für alle Streams aktualisieren
      const baseUrl = config.tunnelUrl || ('http://' + localIp + ':1984');
      cameraStreams.forEach((url, name) => {
        const serialFromName = name.replace('cam_', '');
        const mjpegUrl = baseUrl + '/api/stream.mjpeg?src=' + name;
        cameraUrls.set(serialFromName, mjpegUrl);
      });
      sendLog('Kamera URLs aktualisiert für ' + cameraStreams.size + ' Streams');
    }, 500);
  } catch (e) {
    sendLog('Kamera Config Fehler: ' + e.message);
  }
}

function startGo2rtcWithConfig(configPath) {
  const locations = [
    path.join(process.resourcesPath, 'go2rtc.exe'),
    path.join(process.env.PORTABLE_EXECUTABLE_DIR || '', 'go2rtc.exe'),
    path.join(path.dirname(process.execPath), 'go2rtc.exe'),
    path.join(__dirname, 'go2rtc.exe')
  ];

  let go2rtcPath = null;
  for (const loc of locations) {
    if (loc && fs.existsSync(loc)) { go2rtcPath = loc; break; }
  }

  if (!go2rtcPath) return;

  go2rtcProcess = spawn(go2rtcPath, ['-c', configPath], { stdio: 'pipe', windowsHide: true, cwd: app.getPath('userData') });
  go2rtcProcess.stdout.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) sendLog('go2rtc: ' + msg.substring(0, 200));
  });
  go2rtcProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) sendLog('go2rtc: ' + msg.substring(0, 200));
  });
  go2rtcProcess.on('error', (e) => sendLog('go2rtc Fehler: ' + e.message));
  sendLog('go2rtc neu gestartet');
}

ipcMain.handle('set-tunnel', (e, tunnelUrl) => {
  config.tunnelUrl = tunnelUrl;
  saveConfig({ tunnelUrl });
  sendLog('Tunnel URL: ' + tunnelUrl);
  // Update camera URLs - alles geht über go2rtc
  printers.forEach((printer, serial) => {
    if (cameraUrls.has(serial)) {
      const baseUrl = tunnelUrl || ('http://' + localIp + ':1984');
      cameraUrls.set(serial, baseUrl + '/api/stream.mjpeg?src=cam_' + serial);
    }
  });
});

// Version-Handler
ipcMain.handle('get-version', () => {
  return app.getVersion();
});

// Update-Handler
ipcMain.handle('check-updates', () => {
  autoUpdater.checkForUpdates().catch(e => sendLog('Update-Check fehlgeschlagen: ' + e.message));
});

ipcMain.handle('install-update', () => {
  sendLog('Update wird installiert...');
  // isSilent=false (zeigt Installer), isForceRunAfter=true (startet App nach Install)
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
});

ipcMain.handle('restart-app', () => {
  sendLog('App wird neu gestartet...');
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(() => {
  configPath = path.join(app.getPath('userData'), 'config.json');
  localIp = getLocalIp();
  initLogging();      // Debug Logging initialisieren
  startMjpegServer(); // MJPEG Server für A1/P1
  startGo2rtc();      // go2rtc für X1/H2D
  createWindow();

  // Auto-Start bei Windows-Login (kein UAC-Dialog)
  app.setLoginItemSettings({
    openAtLogin: true,
    path: process.execPath,
    args: ['--autostart']
  });
  sendLog('Auto-Start bei Windows-Login aktiviert');

  // Auto-Updater Setup
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  let downloadedVersion = null; // Track which version is downloaded

  autoUpdater.on('checking-for-update', () => {
    sendLog('Suche nach Updates...');
  });

  autoUpdater.on('update-available', (info) => {
    sendLog('Update verfügbar: v' + info.version);
    // Wenn bereits eine andere Version heruntergeladen wurde, diese verwerfen
    if (downloadedVersion && downloadedVersion !== info.version) {
      sendLog('Neue Version verfügbar - lade v' + info.version + ' (verwerfe v' + downloadedVersion + ')');
      downloadedVersion = null;
      if (mainWindow) mainWindow.webContents.send('update-reset'); // UI zurücksetzen
    }
    if (mainWindow) mainWindow.webContents.send('update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    sendLog('Bereits auf neuestem Stand');
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    if (mainWindow) mainWindow.webContents.send('update-progress', percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    sendLog('Update v' + info.version + ' bereit zur Installation');
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', info.version);
    }
  });

  autoUpdater.on('error', (err) => {
    sendLog('Update Fehler: ' + err.message);
    downloadedVersion = null;
    if (mainWindow) mainWindow.webContents.send('update-reset');
  });

  // Nach 5 Sekunden nach Updates suchen
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e => sendLog('Update-Check fehlgeschlagen: ' + e.message));
  }, 5000);

  // Alle 5 Minuten automatisch nach Updates suchen
  setInterval(() => {
    sendLog('Automatischer Update-Check...');
    autoUpdater.checkForUpdates().catch(e => sendLog('Auto-Update-Check fehlgeschlagen: ' + e.message));
  }, 5 * 60 * 1000);
});

app.on('window-all-closed', () => {
  app.isQuitting = true;

  // Alle Reconnect-Timer stoppen
  printerReconnectTimers.forEach(timer => clearTimeout(timer));
  printerReconnectTimers.clear();
  if (tunnelRestartTimer) { clearTimeout(tunnelRestartTimer); tunnelRestartTimer = null; }
  if (go2rtcWatchdogTimer) { clearTimeout(go2rtcWatchdogTimer); go2rtcWatchdogTimer = null; }

  // Log Stream schließen
  if (rawMqttLogStream) {
    rawMqttLogStream.end();
    rawMqttLogStream = null;
  }
  // JPEG Streams stoppen
  jpegStreams.forEach((stream, serial) => {
    stopJpegStream(serial);
  });
  // MJPEG Server stoppen
  if (mjpegServer) {
    mjpegServer.close();
  }
  // go2rtc stoppen
  if (go2rtcProcess) {
    go2rtcProcess.kill();
  }
  // Tunnel stoppen
  if (tunnelProcess) {
    tunnelProcess.kill();
  }
  disconnectApi();
  app.quit();
});
