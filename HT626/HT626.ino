/*
  HT626 — Potentiometers on A0/A1 (3.3V–GND).
  Pot 1 (A0): 5-band keyboard zones
    0.0–1.4 V → ; l k j h
    1.4–1.9 V → (dead zone, no key)
    1.9–3.3 V → g f d s a
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

char heldKey = 0;

void setKey(char key) {
  if (key == heldKey) {
    return;
  }
  if (heldKey) {
    Keyboard.release(heldKey);
  }
  if (key) {
    Keyboard.press(key);
  }
  heldKey = key;
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

  setKey(keyFromPot1(v0));

  Serial.print(F("A0="));
  Serial.print(v0, 3);
  Serial.print(F(" V  A1="));
  Serial.print(v1, 3);
  Serial.print(F(" V  key="));
  Serial.println(heldKey ? heldKey : '-');

  delay(20);
}
