/*
  HT626 — Potentiometers on A0/A1 (3.3V–GND).
  Pot 1 (A0): Keyboard A / D from voltage thresholds.
    > 1.9 V → hold 'A'
    < 1.0 V → hold 'D'
    else    → release both
*/

#include <Keyboard.h>

const int POT_A0 = A0;
const int POT_A1 = A1;
const float ADC_VREF = 5.0;   // Leonardo DEFAULT reference (AVCC)
const int ADC_MAX = 1023;     // 10-bit ADC

const float THRESH_A = 1.9;   // pot1 high → 'A'
const float THRESH_D = 1.4;   // pot1 low  → 'D'

char heldKey = 0;             // currently held key, or 0

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

void setup() {
  Serial.begin(9600);
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    ;
  }

  Keyboard.begin();
  Serial.println(F("HT626 pot1=A/D  (A0 >1.9=A, <1.0=D)"));
}

void loop() {
  int raw0 = analogRead(POT_A0);
  int raw1 = analogRead(POT_A1);
  float v0 = raw0 * (ADC_VREF / ADC_MAX);
  float v1 = raw1 * (ADC_VREF / ADC_MAX);

  char want = 0;
  if (v0 > THRESH_A) {
    want = 'a';
  } else if (v0 < THRESH_D) {
    want = 'd';
  }
  setKey(want);

  Serial.print(F("A0="));
  Serial.print(v0, 3);
  Serial.print(F(" V  A1="));
  Serial.print(v1, 3);
  Serial.print(F(" V  key="));
  Serial.println(heldKey ? heldKey : '-');

  delay(20);
}
