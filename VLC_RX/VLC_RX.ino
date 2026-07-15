/*
 * VLC Analog Audio Receiver (RX) Firmware
 * =========================================
 * ESP32 - TIA output via ADC → WebSocket stream
 *
 * Architecture:
 *  - Connects to Wi-Fi and then to the VLC Web Server via WebSocket
 *  - Role: "RX" - reads ADC on GPIO 34 (TIA output from LM358) at 8000 Hz
 *  - Streams raw 8-bit PCM audio samples to the server for browser playback
 *
 * Hardware:
 *  - LM358 TIA output connected to GPIO 34 (ADC1_CH6) - input only pin
 *  - Keep TIA output voltage within 0-3.3V range (add voltage divider if needed)
 *  - LM358 bandwidth limits us to ~8 kHz audio (this is our target)
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
bool wsConnected = false;

// ADC pin: GPIO 34 = ADC1_CH6 (input-only, no DAC conflict)
const int ADC_PIN = 34;

// Audio capture buffer (send in 256-sample chunks = 32ms at 8kHz)
#define CHUNK_SIZE 256
uint8_t audioChunk[CHUNK_SIZE];
int chunkIdx = 0;

// Hardware timer for 8 kHz ADC sampling
hw_timer_t* adcTimer = NULL;
portMUX_TYPE timerMux = portMUX_INITIALIZER_UNLOCKED;

// Sample ring buffer for ISR → main loop handoff
#define SAMPLE_BUFFER_SIZE 2048
volatile uint8_t sampleBuffer[SAMPLE_BUFFER_SIZE];
volatile int sampleHead = 0;
volatile int sampleTail = 0;
volatile int sampleCount = 0;

// ─── Timer ISR: sample ADC at 8000 Hz ────────────────────────────────────────
void IRAM_ATTR onAdcTimer() {
  portENTER_CRITICAL_ISR(&timerMux);
  
  // Read 12-bit ADC and scale to 8-bit (0-255)
  // ESP32 ADC is 12-bit (0-4095), map to 0-255
  int raw = analogRead(ADC_PIN); // This is safe in ISR for ESP32
  uint8_t sample = (uint8_t)(raw >> 4); // 12-bit → 8-bit

  if (sampleCount < SAMPLE_BUFFER_SIZE) {
    sampleBuffer[sampleHead] = sample;
    sampleHead = (sampleHead + 1) % SAMPLE_BUFFER_SIZE;
    sampleCount++;
  }
  
  portEXIT_CRITICAL_ISR(&timerMux);
}

// ─── WebSocket callbacks ──────────────────────────────────────────────────────
void onEvent(WebsocketsEvent event, String data) {
  if (event == WebsocketsEvent::ConnectionOpened) {
    Serial.println("[WS] Connected to server");
    wsConnected = true;
    // Register as RX
    wsClient.send("{\"role\":\"RX\"}");
  } else if (event == WebsocketsEvent::ConnectionClosed) {
    Serial.println("[WS] Disconnected");
    wsConnected = false;
  } else if (event == WebsocketsEvent::GotPing) {
    wsClient.pong();
  }
}

void onMessage(WebsocketsMessage msg) {
  // RX doesn't expect audio data from server, ignore
}

// ─── Setup ────────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[VLC-RX] Booting...");

  // Configure ADC
  analogReadResolution(12);       // 12-bit ADC
  analogSetAttenuation(ADC_11db); // 0-3.3V range
  pinMode(ADC_PIN, INPUT);

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

  // Setup 8 kHz hardware timer
  adcTimer = timerBegin(0, 80, true); // 1 µs per tick
  timerAttachInterrupt(adcTimer, &onAdcTimer, true);
  timerAlarmWrite(adcTimer, 125, true); // 125 µs = 8000 Hz
  timerAlarmEnable(adcTimer);

  Serial.println("[VLC-RX] Sampling started at 8 kHz");
}

// ─── Loop ─────────────────────────────────────────────────────────────────────
void loop() {
  // Poll WebSocket
  if (wsClient.available()) {
    wsClient.poll();
  } else {
    // Reconnect
    Serial.println("[WS] Reconnecting...");
    wsConnected = false;
    wsClient.connect(wsUrl);
    delay(2000);
    return;
  }

  // Drain samples from ISR buffer and send in chunks
  while (true) {
    portENTER_CRITICAL(&timerMux);
    int count = sampleCount;
    portEXIT_CRITICAL(&timerMux);

    if (count == 0) break;

    portENTER_CRITICAL(&timerMux);
    uint8_t sample = sampleBuffer[sampleTail];
    sampleTail = (sampleTail + 1) % SAMPLE_BUFFER_SIZE;
    sampleCount--;
    portEXIT_CRITICAL(&timerMux);

    if (wsConnected) {
      audioChunk[chunkIdx++] = sample;

      if (chunkIdx >= CHUNK_SIZE) {
        // Send chunk as binary WebSocket message
        wsClient.sendBinary((const char*)audioChunk, CHUNK_SIZE);
        chunkIdx = 0;
      }
    }
  }
}
