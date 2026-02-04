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
let printers = new Map();
let config = { apiUrl: '', apiKey: '', tunnelUrl: '' };
let configPath = '';
let go2rtcProcess = null;
let go2rtcReady = false;
let cameraUrls = new Map();
let cameraStreams = new Map(); // Alle Kamera-Streams für go2rtc
let go2rtcRestartTimer = null; // Debounce für go2rtc Neustart
let localIp = 'localhost';

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
    reconnectionDelay: 5000,
    auth: { apiKey }
  });

  apiSocket.on('connect', () => {
    sendLog('API verbunden');
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-status', 'connected');
  });

  apiSocket.on('authenticated', () => {
    sendLog('Authentifiziert');
    apiSocket.emit('printers:request');
  });

  apiSocket.on('auth:error', (error) => {
    sendLog('Auth Fehler: ' + error);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('api-status', 'error');
  });

  apiSocket.on('printers:list', (list) => {
    sendLog(list.length + ' Drucker empfangen');
    list.forEach(p => {
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

function disconnectApi() {
  if (apiSocket) {
    apiSocket.disconnect();
    apiSocket = null;
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

  sendLog('Verbinde: ' + printer.name);

  const client = mqtt.connect('mqtts://' + printer.ipAddress + ':8883', {
    username: 'bblp',
    password: printer.accessCode,
    rejectUnauthorized: false,
    clientId: 'vafrum_' + printer.serialNumber + '_' + Date.now(),
    connectTimeout: 15000
  });

  client.on('connect', () => {
    sendLog('Drucker verbunden: ' + printer.name);
    mqttClients.set(printer.serialNumber, client);
    printers.set(printer.serialNumber, { ...printer, online: true });
    client.subscribe('device/' + printer.serialNumber + '/report');
    client.publish('device/' + printer.serialNumber + '/request', JSON.stringify({
      pushing: { command: 'pushall' }
    }));
    addCameraStream(printer.serialNumber, printer.accessCode, printer.ipAddress, printer.model);
    updatePrinters();
  });

  client.on('message', (topic, message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.print) {
        const p = data.print;

        // Debug: Log lights_report einmalig
        if (p.lights_report && !client._lightsLogged) {
          sendLog('LIGHTS_REPORT: ' + JSON.stringify(p.lights_report));
          client._lightsLogged = true;
        }

        // Parse AMS data
        let ams = null;
        if (p.ams) {
          ams = {
            humidity: p.ams.ams_humidity,
            trayNow: p.ams.tray_now,
            units: [],
            trays: []
          };
          if (Array.isArray(p.ams.ams)) {
            p.ams.ams.forEach((unit, unitIdx) => {
              // Store unit-level info (humidity per AMS)
              // humidity_raw = actual percentage, humidity = index 1-5
              ams.units.push({
                id: unitIdx,
                humidity: parseInt(unit.humidity_raw) || parseInt(unit.humidity) || 0,
                humidityIndex: parseInt(unit.humidity) || 0,
                temp: parseFloat(unit.temp) || 0
              });
              if (Array.isArray(unit.tray)) {
                unit.tray.forEach((tray, trayIdx) => {
                  if (tray && tray.tray_type) {
                    ams.trays.push({
                      id: unitIdx * 4 + trayIdx,
                      unitId: unitIdx,
                      slot: trayIdx,
                      type: tray.tray_type || '',
                      color: tray.tray_color || '',
                      name: tray.tray_sub_brands || tray.tray_type || '',
                      remain: tray.remain || 0,
                      k: tray.k || 0,
                      temp: tray.nozzle_temp_min ? `${tray.nozzle_temp_min}-${tray.nozzle_temp_max}` : ''
                    });
                  }
                });
              }
            });
          }
        }

        // Parse external spool (for printers without AMS)
        let externalSpool = null;
        if (p.vt_tray) {
          externalSpool = {
            type: p.vt_tray.tray_type || '',
            color: p.vt_tray.tray_color || '',
            name: p.vt_tray.tray_sub_brands || ''
          };
        }

        // Vorherigen Status holen für inkrementelle Updates
        const prevStatus = printers.get(printer.serialNumber) || {};

        const status = {
          online: true,
          gcodeState: p.gcode_state ?? prevStatus.gcodeState ?? 'IDLE',
          printProgress: p.mc_percent ?? prevStatus.printProgress ?? 0,
          remainingTime: p.mc_remaining_time ?? prevStatus.remainingTime ?? 0,
          currentFile: p.gcode_file || p.subtask_name || prevStatus.currentFile || '',
          layer: p.layer_num ?? prevStatus.layer ?? 0,
          totalLayers: p.total_layer_num ?? prevStatus.totalLayers ?? 0,
          nozzleTemp: p.nozzle_temper ?? prevStatus.nozzleTemp ?? 0,
          nozzleTargetTemp: p.nozzle_target_temper ?? prevStatus.nozzleTargetTemp ?? 0,
          nozzleTemp2: p.nozzle_temper_2 ?? prevStatus.nozzleTemp2,
          nozzleTargetTemp2: p.nozzle_target_temper_2 ?? prevStatus.nozzleTargetTemp2,
          bedTemp: p.bed_temper ?? prevStatus.bedTemp ?? 0,
          bedTargetTemp: p.bed_target_temper ?? prevStatus.bedTargetTemp ?? 0,
          chamberTemp: p.chamber_temper ?? prevStatus.chamberTemp,
          // Fan speeds
          partFan: p.cooling_fan_speed ?? prevStatus.partFan,
          auxFan: p.big_fan1_speed ?? prevStatus.auxFan,
          chamberFan: p.big_fan2_speed ?? prevStatus.chamberFan,
          // Lights - H2D/X1 nutzen chamber_light2 für workLight, A1/P1 nutzen work_light
          chamberLight: p.lights_report ? p.lights_report.find(l => l.node === 'chamber_light')?.mode === 'on' : prevStatus.chamberLight,
          workLight: p.lights_report ? (
            p.lights_report.find(l => l.node === 'chamber_light2')?.mode === 'on' ||
            p.lights_report.find(l => l.node === 'work_light')?.mode === 'on'
          ) : prevStatus.workLight,
          // Speed
          speedLevel: p.spd_lvl ?? prevStatus.speedLevel,
          speedMagnitude: p.spd_mag ?? prevStatus.speedMagnitude,
          // AMS
          ams: ams || prevStatus.ams,
          externalSpool: externalSpool || prevStatus.externalSpool,
          // Misc
          wifiSignal: p.wifi_signal ?? prevStatus.wifiSignal,
          printType: p.print_type ?? prevStatus.printType
        };
        printers.set(printer.serialNumber, { ...printers.get(printer.serialNumber), ...status });
        updatePrinters();

        if (apiSocket?.connected) {
          apiSocket.emit('printer:status', {
            printerId: printer.id,
            serialNumber: printer.serialNumber,
            ...status,
            cameraUrl: cameraUrls.get(printer.serialNumber) || undefined
          });
        }
      }
    } catch (e) {}
  });

  client.on('error', (err) => sendLog('Fehler: ' + err.message));
  client.on('close', () => {
    mqttClients.delete(printer.serialNumber);
    const pr = printers.get(printer.serialNumber);
    if (pr) {
      printers.set(printer.serialNumber, { ...pr, online: false });
      updatePrinters();
    }
  });
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
      // A1/A1 Mini: haben nur 1 Licht (Toolhead LED) = chamber_light
      // H2D/H2S/H2C/X1: nutzen chamber_light2 für Arbeitslicht
      // P1S: nutzt work_light
      const printerWL = printers.get(serialNumber);
      sendLog('workLight - Printer data: ' + JSON.stringify(printerWL ? { model: printerWL.model, name: printerWL.name } : 'nicht gefunden'));
      const modelUpper = printerWL?.model?.toUpperCase() || '';
      let workLightNode = 'work_light';
      if (modelUpper.includes('A1')) {
        workLightNode = 'chamber_light';
        sendLog('A1 erkannt -> chamber_light');
      } else if (modelUpper.includes('H2D') || modelUpper.includes('H2S') || modelUpper.includes('H2C') || modelUpper.includes('X1')) {
        workLightNode = 'chamber_light2';
        sendLog('H2/X1 erkannt -> chamber_light2');
      } else {
        sendLog('Standard -> work_light');
      }
      payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: workLightNode, led_mode: cmd.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 }, user_id: '1234567890' };
      sendLog('LED Payload: ' + JSON.stringify(payload));
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
      // Z-Achse invertieren (bei Bambu bedeutet Z+ Bett runter, wir wollen Z+ = Bett hoch)
      if (axis === 'Z') dist = -dist;
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

    default: return;
  }

  client.publish(topic, JSON.stringify(payload));
  sendLog('Befehl: ' + cmd.type);
}

function updatePrinters() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('printers-update', Array.from(printers.values()));
  }
}

ipcMain.handle('connect', (e, { apiUrl, apiKey }) => {
  saveConfig({ apiUrl, apiKey });
  connectToApi(apiUrl, apiKey);
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

  mjpegServer = expressApp.listen(MJPEG_PORT, () => {
    sendLog('MJPEG Server gestartet auf Port ' + MJPEG_PORT);
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
    clients: new Set(),
    reconnectAttempts: 0,
    buffer: Buffer.alloc(0)
  };
  jpegStreams.set(serial, streamData);

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

    // Reconnect nach 5 Sekunden
    if (streamData.reconnectAttempts < 12) {
      streamData.reconnectAttempts++;
      setTimeout(() => {
        if (jpegStreams.has(serial)) {
          sendLog('Reconnect Versuch ' + streamData.reconnectAttempts + ' für: ' + serial);
          connectJpegStream(serial, accessCode, ip, streamData);
        }
      }, 5000);
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
  fs.writeFileSync(configFile, 'api:\n  listen: ":1984"\nrtsp:\n  listen: ""\nstreams: {}\n');

  go2rtcProcess = spawn(go2rtcPath, ['-c', configFile], { stdio: 'ignore', windowsHide: true });
  go2rtcProcess.on('error', (e) => sendLog('go2rtc Fehler: ' + e.message));

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
      });
    }
  });

  tunnelProcess.on('error', (e) => sendLog('Tunnel Fehler: ' + e.message));
  tunnelProcess.on('close', () => {
    sendLog('Tunnel beendet');
    tunnelProcess = null;
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
  listen: ":1984"
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

  go2rtcProcess = spawn(go2rtcPath, ['-c', configPath], { stdio: 'pipe', windowsHide: true });
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

// Update-Handler
ipcMain.handle('check-updates', () => {
  autoUpdater.checkForUpdates().catch(e => sendLog('Update-Check fehlgeschlagen: ' + e.message));
});

ipcMain.handle('install-update', () => {
  sendLog('Update wird installiert, App startet neu...');
  autoUpdater.quitAndInstall(false, true);
});

ipcMain.handle('restart-app', () => {
  sendLog('App wird neu gestartet...');
  app.relaunch();
  app.exit(0);
});

app.whenReady().then(() => {
  configPath = path.join(app.getPath('userData'), 'config.json');
  localIp = getLocalIp();
  startMjpegServer(); // MJPEG Server für A1/P1
  startGo2rtc();      // go2rtc für X1/H2D
  createWindow();

  // Auto-Updater Setup
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    sendLog('Suche nach Updates...');
  });

  autoUpdater.on('update-available', (info) => {
    sendLog('Update verfügbar: v' + info.version);
    if (mainWindow) mainWindow.webContents.send('update-available', info.version);
  });

  autoUpdater.on('update-not-available', () => {
    sendLog('Keine Updates verfügbar');
  });

  autoUpdater.on('download-progress', (progress) => {
    const percent = Math.round(progress.percent);
    if (mainWindow) mainWindow.webContents.send('update-progress', percent);
  });

  autoUpdater.on('update-downloaded', (info) => {
    sendLog('Update heruntergeladen und bereit: v' + info.version);
    sendLog('Klicke auf "Jetzt installieren" um das Update zu installieren');
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', info.version);
      // Nochmal nach kurzer Verzögerung senden falls UI nicht bereit war
      setTimeout(() => {
        mainWindow.webContents.send('update-downloaded', info.version);
      }, 1000);
    }
  });

  autoUpdater.on('error', (err) => {
    sendLog('Update Fehler: ' + err.message);
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
