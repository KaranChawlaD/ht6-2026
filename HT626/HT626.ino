/*
  HT626 — Potentiometers on A0/A1 (3.3V–GND).

  SAFETY: Keyboard is OFF unless pin 2 is wired to GND.
  Leave pin 2 unconnected while coding/uploading. For play, jumper
  digital pin 2 → GND (or use a switch).

  Pot 1 (A0): 5-band keyboard zones
    0.0–1.4 V → ; l k j h
    1.4–1.9 V → (dead zone, no key)
    1.9–3.3 V → g f d s a
  Pot 2 (A1): throttle
    0.0–0.3 V → glide (zero throttle, no key held)
    0.4–3.3 V → 5 equal throttle-level zones (z x c v b, low -> high)
  Button on pin 7 (to GND): taps 'r' on each press (while armed).
*/

#include <Keyboard.h>

const int POT_A0 = A0;
const int POT_A1 = A1;
// Pull-up: HIGH = safe (no typing). Connect pin 2 to GND to enable keys.
const int KEYBOARD_ENABLE_PIN = 2;
// Pull-up button: press connects pin 7 to GND.
const int BUTTON_R_PIN = 7;
const unsigned long BUTTON_DEBOUNCE_MS = 30;

const float ADC_VREF = 5.0;   // Leonardo DEFAULT reference (AVCC)
const int ADC_MAX = 1023;     // 10-bit ADC

const float LOW_MIN  = 0.0;
const float LOW_MAX  = 1.4;
const float HIGH_MIN = 1.9;
const float HIGH_MAX = 3.3;

const char KEYS_LOW[]  = { ';', 'l', 'k', 'j', 'h' };
const char KEYS_HIGH[] = { 'g', 'f', 'd', 's', 'a' };

const float THROTTLE_DEAD_MAX   = 0.3;
const float THROTTLE_ACTIVE_MIN = 0.4;
const float THROTTLE_ACTIVE_MAX = 3.3;
const char THROTTLE_KEYS[] = { 'z', 'x', 'c', 'v', 'b' };
const int THROTTLE_ZONES = sizeof(THROTTLE_KEYS) / sizeof(THROTTLE_KEYS[0]);
const float THROTTLE_HYSTERESIS_V = 0.05;

const int THROTTLE_GLIDE = -1;
const int THROTTLE_NOT_INIT = -2;

int currentThrottleZone = THROTTLE_NOT_INIT;
char heldKey1 = 0;
char heldThrottleKey = 0;
bool keyboardArmed = false;

bool buttonRLastStable = HIGH;   // INPUT_PULLUP idle
bool buttonRLastRaw = HIGH;
unsigned long buttonRLastChangeMs = 0;

void releaseAllKeys() {
  if (heldKey1 || heldThrottleKey) {
    Keyboard.releaseAll();
    heldKey1 = 0;
    heldThrottleKey = 0;
  }
}

void setKey(char key, char *heldKeyVar) {
  if (key == *heldKeyVar) {
    return;
  }
  if (*heldKeyVar) {
    Keyboard.release(*heldKeyVar);
  }
  if (key) {
    Keyboard.press(key);
  }
  *heldKeyVar = key;
}

char keyFromRange(float v, float lo, float hi, const char keys[5]) {
  float t = (v - lo) / (hi - lo);
  int idx = (int)(t * 5.0);
  if (idx < 0) idx = 0;
  if (idx > 4) idx = 4;
  return keys[idx];
}

char keyFromPot1(float v) {
  if (v <= LOW_MAX) {
    return keyFromRange(v, LOW_MIN, LOW_MAX, KEYS_LOW);
  }
  if (v >= HIGH_MIN) {
    return keyFromRange(v, HIGH_MIN, HIGH_MAX, KEYS_HIGH);
  }
  return 0;
}

int throttleZoneFromVoltage(float v) {
  if (v <= THROTTLE_DEAD_MAX) {
    return THROTTLE_GLIDE;
  }
  float t = (v - THROTTLE_ACTIVE_MIN) / (THROTTLE_ACTIVE_MAX - THROTTLE_ACTIVE_MIN);
  int zone = (int)(t * THROTTLE_ZONES);
  if (zone < 0) zone = 0;
  if (zone >= THROTTLE_ZONES) zone = THROTTLE_ZONES - 1;
  return zone;
}

void throttleZoneBounds(int zone, float *lower, float *upper) {
  if (zone == THROTTLE_GLIDE) {
    *lower = 0.0;
    *upper = THROTTLE_DEAD_MAX;
    return;
  }
  float zoneWidth = (THROTTLE_ACTIVE_MAX - THROTTLE_ACTIVE_MIN) / THROTTLE_ZONES;
  *lower = THROTTLE_ACTIVE_MIN + zone * zoneWidth;
  *upper = *lower + zoneWidth;
}

int applyThrottleHysteresis(int rawZone, float v) {
  if (currentThrottleZone == THROTTLE_NOT_INIT || rawZone == currentThrottleZone) {
    return rawZone;
  }
  float lowerBound, upperBound;
  throttleZoneBounds(currentThrottleZone, &lowerBound, &upperBound);
  if (v > lowerBound - THROTTLE_HYSTERESIS_V && v < upperBound + THROTTLE_HYSTERESIS_V) {
    return currentThrottleZone;
  }
  return rawZone;
}

char throttleKeyForZone(int zone) {
  if (zone == THROTTLE_GLIDE) {
    return 0;
  }
  return THROTTLE_KEYS[zone];
}

bool keyboardEnableRequested() {
  return digitalRead(KEYBOARD_ENABLE_PIN) == LOW;
}

// Debounced falling edge on pin 7 -> one 'r' keystroke.
void pollButtonR() {
  bool raw = digitalRead(BUTTON_R_PIN);
  unsigned long now = millis();

  if (raw != buttonRLastRaw) {
    buttonRLastRaw = raw;
    buttonRLastChangeMs = now;
  }

  if ((now - buttonRLastChangeMs) < BUTTON_DEBOUNCE_MS) {
    return;
  }

  if (raw != buttonRLastStable) {
    buttonRLastStable = raw;
    if (raw == LOW) {
      Keyboard.write('r');
    }
  }
}

void setup() {
  pinMode(KEYBOARD_ENABLE_PIN, INPUT_PULLUP);
  pinMode(BUTTON_R_PIN, INPUT_PULLUP);

  delay(2500);

  Serial.begin(9600);
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    ;
  }

  Serial.println(F("HT626 SAFE: keyboard OFF until pin 2 -> GND"));
  Serial.println(F("pot1: 0-1.4=;lkjh  1.9-3.3=gfdsa | throttle: zxcvb | btn7=r"));
}

void loop() {
  int raw0 = analogRead(POT_A0);
  int raw1 = analogRead(POT_A1);
  float v0 = raw0 * (ADC_VREF / ADC_MAX);
  float v1 = raw1 * (ADC_VREF / ADC_MAX);

  bool wantKeys = keyboardEnableRequested();

  if (wantKeys && !keyboardArmed) {
    Keyboard.begin();
    keyboardArmed = true;
    Serial.println(F("Keyboard ARMED (pin 2 grounded)"));
  } else if (!wantKeys && keyboardArmed) {
    releaseAllKeys();
    Keyboard.end();
    keyboardArmed = false;
    Serial.println(F("Keyboard SAFE (pin 2 open)"));
  }

  if (keyboardArmed) {
    setKey(keyFromPot1(v0), &heldKey1);

    int rawZone = throttleZoneFromVoltage(v1);
    currentThrottleZone = applyThrottleHysteresis(rawZone, v1);
    setKey(throttleKeyForZone(currentThrottleZone), &heldThrottleKey);

    pollButtonR();
  } else {
    heldKey1 = 0;
    heldThrottleKey = 0;
    currentThrottleZone = THROTTLE_NOT_INIT;
    buttonRLastStable = HIGH;
    buttonRLastRaw = HIGH;
  }

  Serial.print(F("A0="));
  Serial.print(v0, 3);
  Serial.print(F(" V  A1="));
  Serial.print(v1, 3);
  Serial.print(F(" V  armed="));
  Serial.print(keyboardArmed ? F("Y") : F("N"));
  Serial.print(F("  key="));
  Serial.print(heldKey1 ? heldKey1 : '-');
  Serial.print(F("  throttleKey="));
  Serial.println(heldThrottleKey ? heldThrottleKey : '-');

  delay(20);
}
