/*
  HT626 — Read potentiometers on A0 and A1 (wipers), supplied from 3.3V–GND.
  Leonardo ADC uses 5V AVCC, so max pot voltage (~3.3V) is below full scale.
*/

const int POT_A0 = A0;
const int POT_A1 = A1;
const float ADC_VREF = 5.0;   // Leonardo DEFAULT reference (AVCC)
const int ADC_MAX = 1023;     // 10-bit ADC

void setup() {
  Serial.begin(9600);
  // Leonardo USB CDC: wait briefly for host
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    ;
  }
  Serial.println(F("HT626 pot voltage on A0, A1 (3.3V supply)"));
}

void loop() {
  int raw0 = analogRead(POT_A0);
  int raw1 = analogRead(POT_A1);
  float v0 = raw0 * (ADC_VREF / ADC_MAX);
  float v1 = raw1 * (ADC_VREF / ADC_MAX);

  Serial.print(F("A0 raw="));
  Serial.print(raw0);
  Serial.print(F("  V="));
  Serial.print(v0, 3);
  Serial.print(F(" V  |  A1 raw="));
  Serial.print(raw1);
  Serial.print(F("  V="));
  Serial.print(v1, 3);
  Serial.println(F(" V"));

  delay(200);
}
