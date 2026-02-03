const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const http = require('http');
const os = require('os');
const mqtt = require('mqtt');
const { io } = require('socket.io-client');
const { autoUpdater } = require('electron-updater');
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
  mainWindow.webContents.send('api-status', 'connecting');

  apiSocket = io(apiUrl, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 5000,
    auth: { apiKey }
  });

  apiSocket.on('connect', () => {
    sendLog('API verbunden');
    mainWindow.webContents.send('api-status', 'connected');
  });

  apiSocket.on('authenticated', () => {
    sendLog('Authentifiziert');
    apiSocket.emit('printers:request');
  });

  apiSocket.on('auth:error', (error) => {
    sendLog('Auth Fehler: ' + error);
    mainWindow.webContents.send('api-status', 'error');
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
      updatePrinters();
    }
  });

  apiSocket.on('printer:command', (data) => {
    sendLog('API Befehl empfangen: ' + JSON.stringify(data.command) + ' für ' + data.serialNumber);
    executeCommand(data.serialNumber, data.command);
  });

  apiSocket.on('disconnect', () => {
    sendLog('API getrennt');
    mainWindow.webContents.send('api-status', 'disconnected');
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
  mainWindow.webContents.send('api-status', 'disconnected');
  mainWindow.webContents.send('printers-update', []);
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
          // Lights
          chamberLight: p.lights_report ? p.lights_report.find(l => l.node === 'chamber_light')?.mode === 'on' : prevStatus.chamberLight,
          workLight: p.lights_report ? p.lights_report.find(l => l.node === 'work_light')?.mode === 'on' : prevStatus.workLight,
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
      payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light', led_mode: cmd.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
      sendLog('chamberLight Payload: ' + JSON.stringify(payload));
      break;
    case 'workLight':
      payload = { system: { sequence_id: '0', command: 'ledctrl', led_node: 'chamber_light2', led_mode: cmd.on ? 'on' : 'off', led_on_time: 500, led_off_time: 500, loop_times: 0, interval_time: 0 } };
      sendLog('workLight Payload: ' + JSON.stringify(payload));
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
  mainWindow.webContents.send('printers-update', Array.from(printers.values()));
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
      pendingStreams.forEach(s => addCameraStream(s.serial, s.accessCode, s.ip, s.model));
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
      // Update camera URLs for connected printers
      printers.forEach((printer, serial) => {
        if (cameraUrls.has(serial)) {
          const hlsUrl = config.tunnelUrl + '/api/stream.mjpeg?src=cam_' + serial;
          cameraUrls.set(serial, hlsUrl);
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
  if (!go2rtcReady) {
    sendLog('go2rtc nicht bereit, Stream ' + serial + ' wird in Warteschlange gestellt');
    pendingStreams.push({ serial, accessCode, ip, model });
    return;
  }

  // A1/A1 Mini nutzen Port 6000, andere Modelle Port 322
  const isA1 = model && (model.includes('A1') || model.toLowerCase().includes('a1'));
  const port = isA1 ? 6000 : 322;

  const streamName = 'cam_' + serial;
  const streamUrl = 'rtspx://bblp:' + accessCode + '@' + ip + ':' + port + '/streaming/live/1';

  sendLog('Stream für ' + (model || 'unbekannt') + ' auf Port ' + port);

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
  // Update camera URLs for connected printers
  printers.forEach((printer, serial) => {
    if (cameraUrls.has(serial)) {
      const baseUrl = tunnelUrl || ('http://' + localIp + ':1984');
      const hlsUrl = baseUrl + '/api/stream.mjpeg?src=cam_' + serial;
      cameraUrls.set(serial, hlsUrl);
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

app.whenReady().then(() => {
  configPath = path.join(app.getPath('userData'), 'config.json');
  localIp = getLocalIp();
  startGo2rtc();
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
    sendLog('Update heruntergeladen: v' + info.version);
    if (mainWindow) mainWindow.webContents.send('update-downloaded', info.version);
  });

  autoUpdater.on('error', (err) => {
    sendLog('Update Fehler: ' + err.message);
  });

  // Nach 5 Sekunden nach Updates suchen
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(e => sendLog('Update-Check fehlgeschlagen: ' + e.message));
  }, 5000);
});

app.on('window-all-closed', () => {
  disconnectApi();
  app.quit();
});
