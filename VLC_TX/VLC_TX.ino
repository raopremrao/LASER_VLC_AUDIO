/*
 * VLC Analog Audio Transmitter (TX) Firmware
 * ============================================
 * ESP32 - Laser Driver via DAC
 *
 * Architecture:
 *  - Connects to Wi-Fi and then to the VLC Web Server via WebSocket
 *  - Role: "TX" - receives raw 8-bit PCM audio samples from the server
 *  - Outputs audio to laser via DAC1 (GPIO 25) at 8000 Hz sample rate
 *
 * Hardware:
 *  - Laser module connected via your custom laser driver circuit to GPIO 25 (DAC1)
 *  - LM358 TIA on the RX side limits bandwidth, so we use 8 kHz sample rate
 *
 * Dependencies (install via Arduino Library Manager):
 *  - ArduinoWebsockets by Gil Maimon
 */

#include <WiFi.h>
#include <ArduinoWebsockets.h>

using namespace websockets;

// ─── USER CONFIGURATION ──────────────────────────────────────────────────────
const char* WIFI_SSID     = "YOUR_WIFI_SSID";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* SERVER_IP     = "192.168.1.100"; // IP of the PC running the web server
const int   SERVER_PORT   = 3000;
// ─────────────────────────────────────────────────────────────────────────────

const char* WS_URL_TEMPLATE = "ws://%s:%d/ws";
char wsUrl[64];

WebsocketsClient wsClient;

// Audio buffer (circular)
#define AUDIO_BUFFER_SIZE 2048
volatile uint8_t audioBuffer[AUDIO_BUFFER_SIZE];
volatile int bufHead = 0; // write index
volatile int bufTail = 0; // read index
volatile int bufCount = 0;

// Hardware timer for 8 kHz DAC output
hw_timer_t* audioTimer = NULL;
portMUX_TYPE timerMux = portMUX_INITIALIZER_UNLOCKED;

const int DAC_PIN = 25; // DAC1 - connected to laser driver

// ─── Timer ISR: outputs one sample at 8000 Hz ────────────────────────────────
void IRAM_ATTR onAudioTimer() {
  portENTER_CRITICAL_ISR(&timerMux);
  if (bufCount > 0) {
    uint8_t sample = audioBuffer[bufTail];
    bufTail = (bufTail + 1) % AUDIO_BUFFER_SIZE;
    bufCount--;
    portEXIT_CRITICAL_ISR(&timerMux);
    dacWrite(DAC_PIN, sample);
  } else {
    portEXIT_CRITICAL_ISR(&timerMux);
    // Buffer empty: output mid-rail (silence = 128)
    dacWrite(DAC_PIN, 128);
  }
}

// ─── WebSocket callbacks ──────────────────────────────────────────────────────
void onMessage(WebsocketsMessage msg) {
  if (msg.isBinary()) {
    const char* data = msg.c_str();
    size_t len = msg.length();

    portENTER_CRITICAL(&timerMux);
    for (size_t i = 0; i < len; i++) {
      if (bufCount < AUDIO_BUFFER_SIZE) {
        audioBuffer[bufHead] = (uint8_t)data[i];
        bufHead = (bufHead + 1) % AUDIO_BUFFER_SIZE;
        bufCount++;
      }
      // If buffer is full, drop the sample (backpressure)
    }
    portEXIT_CRITICAL(&timerMux);
  }
}

void onEvent(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    Serial.println("[WS] Connected to server");
    // Register as TX
    wsClient.send("{\"role\":\"TX\"}");
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    Serial.println("[WS] Disconnected. Reconnecting...");
  } else if (event == WebsocketsEvent::GotPing) {
    wsClient.pong();
  }
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[VLC-TX] Booting...");

  // Set DAC to mid-rail (silence)
  dacWrite(DAC_PIN, 128);

  // Connect to Wi-Fi
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Connecting");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.printf("\n[WiFi] Connected! IP: %s\n", WiFi.localIP().toString().c_str());

  // Build WebSocket URL and connect
  snprintf(wsUrl, sizeof(wsUrl), WS_URL_TEMPLATE, SERVER_IP, SERVER_PORT);
  Serial.printf("[WS] Connecting to %s\n", wsUrl);

  wsClient.onMessage(onMessage);
  wsClient.onEvent(onEvent);
  wsClient.connect(wsUrl);

  // Setup 8 kHz hardware timer (125 µs period)
  // Timer 0, divider 80 → 1 µs per tick
  audioTimer = timerBegin(0, 80, true);
  timerAttachInterrupt(audioTimer, &onAudioTimer, true);
  timerAlarmWrite(audioTimer, 125, true); // 125 µs = 8000 Hz
  timerAlarmEnable(audioTimer);

  Serial.println("[VLC-TX] Ready. Waiting for audio...");
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
void loop() {
  // Reconnect if disconnected
  if (!wsClient.available()) {
    Serial.println("[WS] Reconnecting...");
    wsClient.connect(wsUrl);
    delay(2000);
  }
  wsClient.poll();
  delay(1);
}