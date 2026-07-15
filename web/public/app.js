/**
 * VLC Audio Web App — Frontend Logic
 * =====================================
 * Handles: WebSocket comms, Audio decode/resample → 8kHz PCM,
 *          Waveform canvas, Oscilloscope, Spectrum analyser, RX playback
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────
const SAMPLE_RATE   = 8000;       // Must match ESP32 firmware
const CHUNK_SIZE    = 256;        // Bytes per WebSocket binary frame
const WS_URL        = `ws://${location.host}/ws`;
const MAX_RX_BUF    = 5 * 1024 * 1024; // 5 MB max RX buffer

// ── State ─────────────────────────────────────────────────────────────────────
let ws               = null;
let wsReady          = false;
let txConnected      = false;
let rxConnected      = false;

let audioCtx         = null;
let audioBuffer      = null;  // decoded source audio
let sourceNode       = null;
let isPlaying        = false;
let playStartTime    = 0;
let playOffset       = 0;

let transmitting     = false;
let txWorker         = null;  // ScriptProcessorNode alternative

let rxPCMChunks      = [];   // Collected Uint8Array chunks from RX ESP32
let rxTotalBytes     = 0;
let rxAudioCtx       = null;

let animFrame        = null;
let scopeData        = new Float32Array(512).fill(0.5);
let specData         = new Float32Array(64).fill(0);

// ── DOM References ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

const dropZone       = $('dropZone');
const fileInput      = $('audioFileInput');
const fileInfo       = $('fileInfo');
const fileNameEl     = $('fileName');
const fileSizeEl     = $('fileSize');
const fileRemove     = $('fileRemove');

const waveformCanvas = $('waveformCanvas');
const waveCtx        = waveformCanvas.getContext('2d');

const scopeCanvas    = $('scopeCanvas');
const scopeCtxEl     = scopeCanvas.getContext('2d');

const spectrumCanvas = $('spectrumCanvas');
const specCtx        = spectrumCanvas.getContext('2d');

const btnPlay        = $('btnPlay');
const btnSkipBack    = $('btnSkipBack');
const btnSkipFwd     = $('btnSkipFwd');
const seekBar        = $('seekBar');
const volumeSlider   = $('volumeSlider');
const currentTimeEl  = $('currentTime');
const totalTimeEl    = $('totalTime');
const waveformTime   = $('waveformTime');

const btnSend        = $('btnSend');
const btnStop        = $('btnStop');
const sendProgress   = $('sendProgress');
const sendBtnText    = $('sendBtnText');

const btnRxPlay      = $('btnRxPlay');
const btnRxSave      = $('btnRxSave');
const btnRxClear     = $('btnRxClear');
const rxBufferFill   = $('rxBufferFill');
const rxBufferLabel  = $('rxBufferLabel');

const logBody        = $('logBody');
const laserBeam      = $('laserBeam');
const scopeLed       = $('scopeLed');
const dominantFreq   = $('dominantFreq');

// ── Logging ────────────────────────────────────────────────────────────────────
function log(msg, type = '') {
  const ts   = new Date().toLocaleTimeString('en', { hour12: false });
  const el   = document.createElement('div');
  el.className = `log-entry ${type}`;
  el.textContent = `[${ts}] ${msg}`;
  logBody.appendChild(el);
  logBody.scrollTop = logBody.scrollHeight;
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Format helpers ─────────────────────────────────────────────────────────────
function fmtTime(sec) {
  sec = Math.max(0, sec);
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}
function fmtBytes(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function connectWS() {
  log('Connecting to server…', 'info');
  ws = new WebSocket(WS_URL);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    wsReady = true;
    ws.send(JSON.stringify({ role: 'BROWSER' }));
    $('serverBadge').querySelector('.pulse-dot').classList.add('connected');
    $('serverStatusText').textContent = 'Server Connected';
    log('Server connected', 'ok');
  };

  ws.onclose = () => {
    wsReady = false;
    txConnected = false; rxConnected = false;
    $('serverBadge').querySelector('.pulse-dot').classList.remove('connected');
    $('serverStatusText').textContent = 'Disconnected';
    updateDeviceUI();
    log('Server disconnected. Retrying in 3s…', 'warn');
    setTimeout(connectWS, 3000);
  };

  ws.onerror = () => log('WebSocket error', 'error');

  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      // Binary audio chunk from RX ESP32
      const chunk = new Uint8Array(evt.data);
      rxPCMChunks.push(chunk);
      rxTotalBytes += chunk.byteLength;
      if (rxTotalBytes > MAX_RX_BUF) {
        // Drop oldest chunk
        const old = rxPCMChunks.shift();
        rxTotalBytes -= old.byteLength;
      }
      updateScopeData(chunk);
      updateRxBufferUI();
      scopeLed.classList.add('active');
      clearTimeout(scopeLed._t);
      scopeLed._t = setTimeout(() => scopeLed.classList.remove('active'), 300);
    } else {
      // JSON control message
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'device_status') {
          txConnected = msg.tx_connected;
          rxConnected = msg.rx_connected;
          updateDeviceUI();
        }
        if (msg.type === 'stats') {
          $('statTxBytes').textContent  = fmtBytes(msg.tx_bytes);
          $('statRxBytes').textContent  = fmtBytes(msg.rx_bytes);
          $('statElapsed').textContent  = `${msg.elapsed_sec}s`;
          const kbps = msg.elapsed_sec > 0
            ? ((msg.tx_bytes * 8) / 1000 / msg.elapsed_sec).toFixed(1)
            : '0';
          $('statBitrate').textContent  = kbps;
        }
      } catch (_) {}
    }
  };
}

function updateDeviceUI() {
  // TX
  const txDot  = document.querySelector('#txStatus .status-dot');
  const txTxt  = $('txStatusText');
  const txCard = $('txCard');
  txDot.className  = `status-dot ${txConnected ? 'online' : 'offline'}`;
  txTxt.textContent = txConnected ? 'Online' : 'Offline';
  txCard.classList.toggle('online', txConnected);

  // RX
  const rxDot  = document.querySelector('#rxStatus .status-dot');
  const rxTxt  = $('rxStatusText');
  const rxCard = $('rxCard');
  rxDot.className  = `status-dot ${rxConnected ? 'online' : 'offline'}`;
  rxTxt.textContent = rxConnected ? 'Online' : 'Offline';
  rxCard.classList.toggle('online', rxConnected);

  updateSendBtn();
}

function updateSendBtn() {
  btnSend.disabled = !(audioBuffer && txConnected && !transmitting);
}

// ── Audio File Handling ────────────────────────────────────────────────────────
function initAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 44100 });
}

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => { e.preventDefault(); dropZone.classList.remove('drag-over'); loadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]));
fileRemove.addEventListener('click', clearFile);

function loadFile(file) {
  if (!file || !file.type.startsWith('audio/')) { toast('Please select a valid audio file'); return; }
  initAudioCtx();
  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      log(`Decoding "${file.name}"…`, 'info');
      const decoded = await audioCtx.decodeAudioData(e.target.result);
      audioBuffer = decoded;

      // UI
      dropZone.style.display = 'none';
      fileInfo.style.display = 'flex';
      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = `${fmtBytes(file.size)} · ${decoded.duration.toFixed(1)}s · ${decoded.sampleRate} Hz`;
      totalTimeEl.textContent = fmtTime(decoded.duration);
      btnPlay.disabled = false;

      drawWaveform(decoded);
      log(`Loaded: ${file.name} (${decoded.duration.toFixed(1)}s)`, 'ok');
      updateSendBtn();
    } catch (err) {
      log(`Decode error: ${err.message}`, 'error');
      toast('Failed to decode audio');
    }
  };
  reader.readAsArrayBuffer(file);
}

function clearFile() {
  stopPlayback();
  audioBuffer = null;
  btnPlay.disabled = true;
  dropZone.style.display = 'block';
  fileInfo.style.display = 'none';
  fileInput.value = '';
  waveCtx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
  updateSendBtn();
}

// ── Waveform Drawing ───────────────────────────────────────────────────────────
function drawWaveform(buffer) {
  const W = waveformCanvas.offsetWidth * devicePixelRatio;
  const H = 80 * devicePixelRatio;
  waveformCanvas.width  = W;
  waveformCanvas.height = H;

  const data = buffer.getChannelData(0);
  const step = Math.floor(data.length / W);
  const mid  = H / 2;

  waveCtx.clearRect(0, 0, W, H);
  waveCtx.strokeStyle = '#f9731680';
  waveCtx.lineWidth   = 1;
  waveCtx.beginPath();

  for (let x = 0; x < W; x++) {
    let min = 1, max = -1;
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    waveCtx.moveTo(x, mid + min * mid);
    waveCtx.lineTo(x, mid + max * mid);
  }
  waveCtx.stroke();
}

// ── Playback Controls ──────────────────────────────────────────────────────────
btnPlay.addEventListener('click', () => { isPlaying ? stopPlayback() : startPlayback(); });
btnSkipBack.addEventListener('click', () => seekTo(getCurrentPos() - 5));
btnSkipFwd.addEventListener('click',  () => seekTo(getCurrentPos() + 5));
seekBar.addEventListener('input', () => { if (audioBuffer) seekTo((seekBar.value / 100) * audioBuffer.duration); });
volumeSlider.addEventListener('input', () => { if (sourceNode) sourceNode.playbackRate.value = 1; });

function getCurrentPos() { return isPlaying ? audioCtx.currentTime - playStartTime + playOffset : playOffset; }

function startPlayback() {
  if (!audioBuffer) return;
  initAudioCtx();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  stopPlayback(true);

  sourceNode = audioCtx.createBufferSource();
  sourceNode.buffer = audioBuffer;

  const gainNode = audioCtx.createGain();
  gainNode.gain.value = parseFloat(volumeSlider.value);
  volumeSlider.addEventListener('input', () => { gainNode.gain.value = parseFloat(volumeSlider.value); });

  sourceNode.connect(gainNode).connect(audioCtx.destination);
  sourceNode.start(0, playOffset);
  sourceNode.onended = () => { if (isPlaying) stopPlayback(); };

  isPlaying     = true;
  playStartTime = audioCtx.currentTime;
  btnPlay.textContent = '⏸';
  requestAnimationFrame(seekRAF);
}

function stopPlayback(keepPos = false) {
  if (sourceNode) { try { sourceNode.stop(); } catch (_) {} sourceNode = null; }
  if (!keepPos) playOffset = 0;
  else playOffset = getCurrentPos();
  isPlaying = false;
  btnPlay.textContent = '▶';
}

function seekTo(sec) {
  sec = Math.max(0, Math.min(sec, audioBuffer?.duration || 0));
  playOffset = sec;
  if (isPlaying) { stopPlayback(true); startPlayback(); }
  seekBar.value = audioBuffer ? (sec / audioBuffer.duration) * 100 : 0;
  currentTimeEl.textContent = fmtTime(sec);
}

function seekRAF() {
  if (!isPlaying) return;
  const pos = getCurrentPos();
  const dur  = audioBuffer?.duration || 1;
  seekBar.value = (pos / dur) * 100;
  currentTimeEl.textContent = fmtTime(pos);
  waveformTime.textContent  = fmtTime(pos);
  requestAnimationFrame(seekRAF);
}

// ── Transmission ───────────────────────────────────────────────────────────────
btnSend.addEventListener('click', startTransmission);
btnStop.addEventListener('click', stopTransmission);

async function startTransmission() {
  if (!audioBuffer || !txConnected || transmitting) return;
  transmitting = true;
  btnSend.disabled = true;
  btnStop.disabled = false;
  laserBeam.classList.add('active');
  sendBtnText.textContent = 'Transmitting…';
  log('Starting transmission…', 'info');

  // Resample to 8 kHz mono PCM-8
  const pcm8 = await resampleTo8kMono(audioBuffer);
  log(`Resampled: ${pcm8.length} samples at 8 kHz`, 'ok');
  toast('⚡ Laser transmission started!');

  // Send in chunks with pacing (125µs × 256 = 32ms per chunk)
  let offset = 0;
  const totalSamples = pcm8.length;

  function sendNextChunk() {
    if (!transmitting || !wsReady) {
      stopTransmission();
      return;
    }
    if (offset >= totalSamples) {
      log('Transmission complete ✓', 'ok');
      toast('✅ Transmission complete!');
      stopTransmission();
      return;
    }

    const chunk = pcm8.subarray(offset, offset + CHUNK_SIZE);
    ws.send(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    offset += chunk.length;

    // Update progress bar
    const pct = (offset / totalSamples) * 100;
    sendProgress.style.width = `${pct}%`;

    // Pace: 32ms per 256-sample chunk at 8kHz
    setTimeout(sendNextChunk, 30);
  }

  sendNextChunk();
}

function stopTransmission() {
  transmitting = false;
  btnStop.disabled = true;
  btnSend.disabled = false;
  laserBeam.classList.remove('active');
  sendBtnText.textContent = 'Send via Laser';
  sendProgress.style.width = '0%';
  updateSendBtn();
}

// Resample AudioBuffer → 8kHz mono Uint8Array (8-bit unsigned PCM)
async function resampleTo8kMono(buffer) {
  const offlineCtx = new OfflineAudioContext(1, Math.ceil(buffer.duration * SAMPLE_RATE), SAMPLE_RATE);
  const src = offlineCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(offlineCtx.destination);
  src.start();
  const rendered = await offlineCtx.startRendering();
  const float32  = rendered.getChannelData(0);

  // Convert float32 (-1..1) → uint8 (0..255)
  const out = new Uint8Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    out[i] = Math.round(Math.max(-1, Math.min(1, float32[i])) * 127 + 128);
  }
  return out;
}

// ── RX Oscilloscope Feed ───────────────────────────────────────────────────────
function updateScopeData(uint8Chunk) {
  const n = Math.min(uint8Chunk.length, scopeData.length);
  // Shift existing data left
  scopeData.copyWithin(0, n);
  // Append new normalized samples
  for (let i = 0; i < n; i++) {
    scopeData[scopeData.length - n + i] = uint8Chunk[uint8Chunk.length - n + i] / 255;
  }
  // Simple FFT-like magnitude for spectrum (crude but fast)
  const blk = 64;
  for (let b = 0; b < blk; b++) {
    let sum = 0;
    const s = Math.floor((b / blk) * scopeData.length);
    const e = Math.floor(((b + 1) / blk) * scopeData.length);
    for (let i = s; i < e; i++) sum += Math.abs(scopeData[i] - 0.5);
    specData[b] = specData[b] * 0.7 + (sum / (e - s)) * 0.3;
  }
  // Find dominant band
  let maxIdx = 0;
  for (let i = 1; i < blk; i++) if (specData[i] > specData[maxIdx]) maxIdx = i;
  const freqHz = Math.round((maxIdx / blk) * (SAMPLE_RATE / 2));
  dominantFreq.textContent = `${freqHz} Hz`;
}

// ── Canvas Drawing Loop ────────────────────────────────────────────────────────
function resizeCanvases() {
  [scopeCanvas, spectrumCanvas].forEach(c => {
    c.width  = c.offsetWidth  * devicePixelRatio;
    c.height = c.offsetHeight * devicePixelRatio;
  });
}
window.addEventListener('resize', resizeCanvases);
resizeCanvases();

function drawLoop() {
  drawScope();
  drawSpectrum();
  animFrame = requestAnimationFrame(drawLoop);
}

function drawScope() {
  const W = scopeCanvas.width, H = scopeCanvas.height;
  scopeCtxEl.clearRect(0, 0, W, H);

  // Grid lines
  scopeCtxEl.strokeStyle = 'rgba(6,182,212,0.08)';
  scopeCtxEl.lineWidth = 1;
  for (let y = 0; y <= 4; y++) {
    const yy = (y / 4) * H;
    scopeCtxEl.beginPath(); scopeCtxEl.moveTo(0, yy); scopeCtxEl.lineTo(W, yy); scopeCtxEl.stroke();
  }
  for (let x = 0; x <= 8; x++) {
    const xx = (x / 8) * W;
    scopeCtxEl.beginPath(); scopeCtxEl.moveTo(xx, 0); scopeCtxEl.lineTo(xx, H); scopeCtxEl.stroke();
  }

  // Waveform
  scopeCtxEl.strokeStyle = '#06b6d4';
  scopeCtxEl.lineWidth = 2;
  scopeCtxEl.shadowBlur = 8;
  scopeCtxEl.shadowColor = '#06b6d4';
  scopeCtxEl.beginPath();

  const step = scopeData.length / W;
  for (let x = 0; x < W; x++) {
    const idx = Math.floor(x * step);
    const v   = (1 - scopeData[idx]) * H;
    if (x === 0) scopeCtxEl.moveTo(x, v);
    else scopeCtxEl.lineTo(x, v);
  }
  scopeCtxEl.stroke();
  scopeCtxEl.shadowBlur = 0;
}

function drawSpectrum() {
  const W = spectrumCanvas.width, H = spectrumCanvas.height;
  specCtx.clearRect(0, 0, W, H);

  const barW = W / specData.length - 1;
  for (let i = 0; i < specData.length; i++) {
    const barH = specData[i] * H * 3;
    const hue  = 180 + (i / specData.length) * 60;
    specCtx.fillStyle = `hsla(${hue}, 80%, 55%, 0.85)`;
    specCtx.fillRect(i * (barW + 1), H - barH, barW, barH);
  }
}

// ── RX Playback & Save ─────────────────────────────────────────────────────────
function updateRxBufferUI() {
  const pct = Math.min((rxTotalBytes / (200 * 1024)) * 100, 100); // 200KB = full bar
  rxBufferFill.style.width = `${pct}%`;
  rxBufferLabel.textContent = `Buffer: ${fmtBytes(rxTotalBytes)}`;
  btnRxPlay.disabled = rxTotalBytes === 0;
  btnRxSave.disabled = rxTotalBytes === 0;
}

btnRxPlay.addEventListener('click', playRxAudio);
btnRxSave.addEventListener('click', saveRxAudio);
btnRxClear.addEventListener('click', () => {
  rxPCMChunks = []; rxTotalBytes = 0;
  updateRxBufferUI();
  log('RX buffer cleared', 'warn');
});

function mergeRxChunks() {
  const all = new Uint8Array(rxTotalBytes);
  let offset = 0;
  for (const c of rxPCMChunks) { all.set(c, offset); offset += c.length; }
  return all;
}

function buildWavBlob(pcm8, sampleRate = SAMPLE_RATE) {
  const numSamples = pcm8.length;
  const buf = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buf);
  const write = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  write(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);   // PCM
  view.setUint16(22, 1, true);   // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);   // 8-bit
  write(36, 'data');
  view.setUint32(40, numSamples, true);
  for (let i = 0; i < numSamples; i++) view.setUint8(44 + i, pcm8[i]);
  return new Blob([buf], { type: 'audio/wav' });
}

function playRxAudio() {
  if (!rxTotalBytes) return;
  if (!rxAudioCtx) rxAudioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  const pcm8 = mergeRxChunks();
  const float32 = new Float32Array(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) float32[i] = (pcm8[i] - 128) / 128;
  const ab = rxAudioCtx.createBuffer(1, float32.length, SAMPLE_RATE);
  ab.copyToChannel(float32, 0);
  const src = rxAudioCtx.createBufferSource();
  src.buffer = ab;
  src.connect(rxAudioCtx.destination);
  src.start();
  log(`Playing ${fmtBytes(rxTotalBytes)} of received audio`, 'ok');
  toast('🔊 Playing received audio');
}

function saveRxAudio() {
  if (!rxTotalBytes) return;
  const blob = buildWavBlob(mergeRxChunks());
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `vlc_rx_${Date.now()}.wav`; a.click();
  URL.revokeObjectURL(url);
  log('RX audio saved as WAV', 'ok');
  toast('💾 Saved received audio');
}

// ── Log clear ─────────────────────────────────────────────────────────────────
$('btnClearLog').addEventListener('click', () => logBody.innerHTML = '');

// ── Init ───────────────────────────────────────────────────────────────────────
connectWS();
drawLoop();
log('VLC Audio System ready', 'info');
