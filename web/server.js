/**
 * VLC Analog Audio Transmission Server
 * =====================================
 * Node.js + Express + WebSocket
 *
 * Roles:
 *  - "TX" client (ESP32 Transmitter): receives binary audio chunks, forwards to TX ESP32
 *  - "RX" client (ESP32 Receiver):    sends binary audio chunks from laser receiver
 *  - "BROWSER" client:                sends audio to TX, receives audio from RX for playback
 *
 * Protocol (JSON text messages):
 *  { "role": "TX" }      → ESP32 TX registers
 *  { "role": "RX" }      → ESP32 RX registers
 *  { "role": "BROWSER" } → Web browser registers
 *  { "type": "status" }  → request status from server
 *
 * Binary messages:
 *  BROWSER → Server → TX ESP32 : raw 8-bit PCM audio at 8000 Hz
 *  RX ESP32 → Server → BROWSER : raw 8-bit PCM audio at 8000 Hz
 */

const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });

const PORT = 3000;

// Connected clients by role
let txClient      = null; // ESP32 TX
let rxClient      = null; // ESP32 RX
let browserClient = null; // Web browser

// Stats
let txBytesSent = 0;
let rxBytesRecv = 0;
let sessionStart = null;

// Serve static files (the website)
app.use(express.static(path.join(__dirname, 'public')));

// ─── WebSocket connection handler ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WS] New connection from ${clientIp}`);
  let role = 'UNKNOWN';

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Binary audio data
      if (role === 'BROWSER') {
        // Browser → TX ESP32
        if (txClient && txClient.readyState === WebSocket.OPEN) {
          txClient.send(data, { binary: true });
          txBytesSent += data.length;
          // Echo stats to browser
          sendStats();
        }
      } else if (role === 'RX') {
        // RX ESP32 → Browser
        if (browserClient && browserClient.readyState === WebSocket.OPEN) {
          browserClient.send(data, { binary: true });
          rxBytesRecv += data.length;
        }
      }
    } else {
      // Text / JSON control message
      try {
        const msg = JSON.parse(data.toString());

        if (msg.role) {
          role = msg.role;
          console.log(`[WS] Client ${clientIp} registered as ${role}`);

          if (role === 'TX')      txClient      = ws;
          if (role === 'RX')      rxClient      = ws;
          if (role === 'BROWSER') { browserClient = ws; sessionStart = Date.now(); }

          broadcastDeviceStatus();
        }

        if (msg.type === 'status') {
          sendStats();
        }

        if (msg.type === 'reset_stats') {
          txBytesSent = 0;
          rxBytesRecv = 0;
          sessionStart = Date.now();
        }

      } catch (e) {
        // ignore non-JSON
      }
    }
  });

  ws.on('close', () => {
    console.log(`[WS] ${role} disconnected`);
    if (ws === txClient)      { txClient      = null; }
    if (ws === rxClient)      { rxClient      = null; }
    if (ws === browserClient) { browserClient = null; }
    broadcastDeviceStatus();
  });

  ws.on('error', (err) => {
    console.error(`[WS] Error (${role}):`, err.message);
  });

  // Heartbeat pong
  ws.on('pong', () => { ws.isAlive = true; });
  ws.isAlive = true;
});

// ─── Heartbeat to detect dead connections ─────────────────────────────────────
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { return ws.terminate(); }
    ws.isAlive = false;
    ws.ping();
  });
}, 10000);

wss.on('close', () => clearInterval(heartbeat));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function broadcastDeviceStatus() {
  const status = {
    type: 'device_status',
    tx_connected: txClient !== null && txClient.readyState === WebSocket.OPEN,
    rx_connected: rxClient !== null && rxClient.readyState === WebSocket.OPEN,
  };
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(status));
    }
  });
}

function sendStats() {
  if (browserClient && browserClient.readyState === WebSocket.OPEN) {
    const elapsed = sessionStart ? ((Date.now() - sessionStart) / 1000).toFixed(1) : 0;
    browserClient.send(JSON.stringify({
      type: 'stats',
      tx_bytes: txBytesSent,
      rx_bytes: rxBytesRecv,
      elapsed_sec: elapsed,
    }));
  }
}

// Periodic stats push every 2 seconds
setInterval(sendStats, 2000);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIp = net.address;
        break;
      }
    }
  }
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   VLC Audio Transmission Server          ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Local:   http://localhost:${PORT}           ║`);
  console.log(`║  Network: http://${localIp}:${PORT}   ║`);
  console.log(`║  WS:      ws://${localIp}:${PORT}/ws   ║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log('║  Configure ESP32 firmware with:          ║');
  console.log(`║  SERVER_IP = "${localIp}"         ║`);
  console.log('╚══════════════════════════════════════════╝');
});
