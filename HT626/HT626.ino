/*
  HT626 — Read potentiometer on A0 (wiper), supplied from 3.3V–GND.
  Leonardo ADC uses 5V AVCC, so max pot voltage (~3.3V) is below full scale.
*/

const int POT_PIN = A0;
const float ADC_VREF = 5.0;   // Leonardo DEFAULT reference (AVCC)
const int ADC_MAX = 1023;     // 10-bit ADC

void setup() {
  Serial.begin(9600);
  // Leonardo USB CDC: wait briefly for host
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    ;
  }
  Serial.println(F("HT626 pot voltage on A0 (3.3V supply)"));
}

void loop() {
  int raw = analogRead(POT_PIN);
  float volts = raw * (ADC_VREF / ADC_MAX);

  Serial.print(F("raw="));
  Serial.print(raw);
  Serial.print(F("  V="));
  Serial.print(volts, 3);
  Serial.println(F(" V"));

  delay(200);
}
