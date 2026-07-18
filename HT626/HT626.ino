/*
  HT626 — Potentiometers on A0/A1 (3.3V–GND).
  Pot 1 (A0): 5-band keyboard zones
    0.0–1.4 V → ; l k j h
    1.4–1.9 V → (dead zone, no key)
    1.9–3.3 V → g f d s a
  Pot 2 (A1): throttle
    0.0–0.3 V → glide (zero throttle, no key held, vehicle coasts)
    0.4–3.3 V → 5 equal throttle-level zones (z x c v b, low -> high)
  Each active zone holds down exactly one key for as long as the pot sits
  in that zone, so a game/app that only reads keypresses (no analog axis)
  still gets a graduated "throttle" input.
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
// 0.0-0.3 V: dead/"glide" band -> zero throttle, no key held.
// 0.4-3.3 V: active range, split into THROTTLE_ZONES equal levels.
const float THROTTLE_DEAD_MAX   = 0.3;
const float THROTTLE_ACTIVE_MIN = 0.4;
const float THROTTLE_ACTIVE_MAX = 3.3;
const char THROTTLE_KEYS[] = { 'z', 'x', 'c', 'v', 'b' }; // low -> high throttle
const int THROTTLE_ZONES = sizeof(THROTTLE_KEYS) / sizeof(THROTTLE_KEYS[0]);

// Hysteresis band (volts) added around a throttle zone's boundaries so pot
// jitter right at a boundary doesn't rapidly press/release neighboring keys.
const float THROTTLE_HYSTERESIS_V = 0.05;

// Zone values: -1 = glide (no key held), 0..THROTTLE_ZONES-1 = active level.
const int THROTTLE_GLIDE = -1;
const int THROTTLE_NOT_INIT = -2; // sentinel: no reading taken yet (startup)

int currentThrottleZone = THROTTLE_NOT_INIT;

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

// Step 1: convert a throttle voltage into a zone: THROTTLE_GLIDE for the
// 0.0-0.3 V dead band, otherwise an active level (0..THROTTLE_ZONES-1) by
// splitting THROTTLE_ACTIVE_MIN..THROTTLE_ACTIVE_MAX into equal slices.
int throttleZoneFromVoltage(float v) {
  if (v <= THROTTLE_DEAD_MAX) {
    return THROTTLE_GLIDE;
  }
  float t = (v - THROTTLE_ACTIVE_MIN) / (THROTTLE_ACTIVE_MAX - THROTTLE_ACTIVE_MIN);
  int zone = (int)(t * THROTTLE_ZONES);
  if (zone < 0) zone = 0; // readings just above the dead band -> lowest active level
  if (zone >= THROTTLE_ZONES) zone = THROTTLE_ZONES - 1; // clamp v == THROTTLE_ACTIVE_MAX
  return zone;
}

// Returns the [lower, upper) voltage bounds of a given zone (glide or
// active), used only to compute the hysteresis band around it.
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

// Step 2: apply hysteresis around the current zone's boundaries, then
// return the (possibly unchanged) zone to actually use this reading.
int applyThrottleHysteresis(int rawZone, float v) {
  if (currentThrottleZone == THROTTLE_NOT_INIT || rawZone == currentThrottleZone) {
    return rawZone;
  }
  float lowerBound, upperBound;
  throttleZoneBounds(currentThrottleZone, &lowerBound, &upperBound);
  if (v > lowerBound - THROTTLE_HYSTERESIS_V && v < upperBound + THROTTLE_HYSTERESIS_V) {
    return currentThrottleZone; // still within the hysteresis band, stay put
  }
  return rawZone;
}

// Step 3: map a (possibly glide) zone to the key that should be held —
// no key at all while gliding.
char throttleKeyForZone(int zone) {
  if (zone == THROTTLE_GLIDE) {
    return 0;
  }
  return THROTTLE_KEYS[zone];
}

void setup() {
  Serial.begin(9600);
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    ;
  }

  Keyboard.begin();
  Serial.println(F("HT626 pot1: 0-1.4=;lkjh  1.9-3.3=gfdsa | throttle: 0-0.3=glide 0.4-3.3=zxcvb"));
}

void loop() {
  int raw0 = analogRead(POT_A0);
  int raw1 = analogRead(POT_A1);
  float v0 = raw0 * (ADC_VREF / ADC_MAX);
  float v1 = raw1 * (ADC_VREF / ADC_MAX);

  // Pot 1 (A0): existing directional zone mapping.
  setKey(keyFromPot1(v0), &heldKey1);

  // Throttle (A1):
  // Step 4: raw zone for this reading (glide or an active level), then
  // debounce it with hysteresis against whichever zone is currently active.
  int rawZone = throttleZoneFromVoltage(v1);
  currentThrottleZone = applyThrottleHysteresis(rawZone, v1);

  // Step 5: hold the current zone's key (none while gliding); setKey()
  // only touches Keyboard.press/release when the key actually changes.
  setKey(throttleKeyForZone(currentThrottleZone), &heldThrottleKey);

  Serial.print(F("A0="));
  Serial.print(v0, 3);
  Serial.print(F(" V  A1="));
  Serial.print(v1, 3);
  Serial.print(F(" V  key="));
  Serial.print(heldKey1 ? heldKey1 : '-');
  Serial.print(F("  throttleZone="));
  Serial.print(currentThrottleZone == THROTTLE_GLIDE ? -1 : currentThrottleZone);
  Serial.print(currentThrottleZone == THROTTLE_GLIDE ? F("(glide)") : F(""));
  Serial.print(F("  throttleKey="));
  Serial.println(heldThrottleKey ? heldThrottleKey : '-');

  delay(20);
}
