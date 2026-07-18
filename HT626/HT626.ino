/*
  HT626 — Potentiometers on A0/A1 (3.3V–GND).
  Pot 1 (A0): 5-band keyboard zones
    0.0–1.4 V → ; l k j h
    1.4–1.9 V → (dead zone, no key)
    1.9–3.3 V → g f d s a
  Pot 2 (A1): throttle — degree of rotation over the full 0–3.3 V range is
  split into 5 equal zones, low rotation -> high rotation. Each zone holds
  down exactly one key (z x c v b) for as long as the pot sits in that
  zone, so a game/app that only reads keypresses (no analog axis) still
  gets a graduated "throttle" input.
*/

#include <Keyboard.h>

const int POT_A0 = A0;
const int POT_A1 = A1;
const float ADC_VREF = 5.0;   // Leonardo DEFAULT reference (AVCC)
const int ADC_MAX = 1023;     // 10-bit ADC

const float LOW_MIN  = 0.0;
const float LOW_MAX  = 1.4;
const float HIGH_MIN = 1.9;
const float HIGH_MAX = 3.3;

const char KEYS_LOW[]  = { ';', 'l', 'k', 'j', 'h' };
const char KEYS_HIGH[] = { 'g', 'f', 'd', 's', 'a' };

// ---- Throttle (pot 2 / A1) configuration ----
const float THROTTLE_MIN = 0.0;
const float THROTTLE_MAX = 3.3;
const char THROTTLE_KEYS[] = { 'z', 'x', 'c', 'v', 'b' }; // low -> high throttle
const int THROTTLE_ZONES = sizeof(THROTTLE_KEYS) / sizeof(THROTTLE_KEYS[0]);

// Hysteresis band (volts) added around a throttle zone's boundaries so pot
// jitter right at a boundary doesn't rapidly press/release neighboring keys.
const float THROTTLE_HYSTERESIS_V = 0.05;

int currentThrottleZone = -1; // -1 = no zone chosen yet / no key held yet

char heldKey1 = 0;       // key currently held for pot 1 (A0)
char heldThrottleKey = 0; // key currently held for throttle (A1)

// Generalized so each pot can hold its own key independently: releases
// whatever key *heldKeyVar currently points at (if any) and presses the
// new one, only when the key actually changes.
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

// Map v in [lo, hi] to one of 5 keys (equal sections).
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
  return 0;  // dead zone
}

// Step 1: convert a throttle voltage into a zone index (0..THROTTLE_ZONES-1)
// by splitting THROTTLE_MIN..THROTTLE_MAX into THROTTLE_ZONES equal slices.
int throttleZoneFromVoltage(float v) {
  float t = (v - THROTTLE_MIN) / (THROTTLE_MAX - THROTTLE_MIN);
  int zone = (int)(t * THROTTLE_ZONES);
  if (zone < 0) zone = 0;
  if (zone >= THROTTLE_ZONES) zone = THROTTLE_ZONES - 1; // clamp v == THROTTLE_MAX
  return zone;
}

// Step 2: apply hysteresis around the current zone's boundaries, then
// return the (possibly unchanged) zone to actually use this reading.
int applyThrottleHysteresis(int rawZone, float v) {
  if (currentThrottleZone == -1 || rawZone == currentThrottleZone) {
    return rawZone;
  }
  float zoneWidth = (THROTTLE_MAX - THROTTLE_MIN) / THROTTLE_ZONES;
  float lowerBound = THROTTLE_MIN + currentThrottleZone * zoneWidth;
  float upperBound = lowerBound + zoneWidth;
  if (v > lowerBound - THROTTLE_HYSTERESIS_V && v < upperBound + THROTTLE_HYSTERESIS_V) {
    return currentThrottleZone; // still within the hysteresis band, stay put
  }
  return rawZone;
}

void setup() {
  Serial.begin(9600);
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    ;
  }

  Keyboard.begin();
  Serial.println(F("HT626 pot1: 0-1.4=;lkjh  1.9-3.3=gfdsa"));
}

void loop() {
  int raw0 = analogRead(POT_A0);
  int raw1 = analogRead(POT_A1);
  float v0 = raw0 * (ADC_VREF / ADC_MAX);
  float v1 = raw1 * (ADC_VREF / ADC_MAX);

  // Pot 1 (A0): existing directional zone mapping.
  setKey(keyFromPot1(v0), &heldKey1);

  // Throttle (A1):
  // Step 3: raw zone for this reading, then debounce it with hysteresis
  // against whichever zone is currently active.
  int rawZone = throttleZoneFromVoltage(v1);
  int throttleZone = applyThrottleHysteresis(rawZone, v1);

  // Step 4: on a genuine zone change, hold the new zone's key (and release
  // the previous one) so exactly one throttle key is held at any time.
  if (throttleZone != currentThrottleZone) {
    currentThrottleZone = throttleZone;
  }
  setKey(THROTTLE_KEYS[currentThrottleZone], &heldThrottleKey);

  Serial.print(F("A0="));
  Serial.print(v0, 3);
  Serial.print(F(" V  A1="));
  Serial.print(v1, 3);
  Serial.print(F(" V  key="));
  Serial.print(heldKey1 ? heldKey1 : '-');
  Serial.print(F("  throttleZone="));
  Serial.print(currentThrottleZone);
  Serial.print(F("  throttleKey="));
  Serial.println(heldThrottleKey ? heldThrottleKey : '-');

  delay(20);
}
