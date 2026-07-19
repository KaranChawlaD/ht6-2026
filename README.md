# HT626 — Poco Loco Moto

Physical motorcycle controller firmware plus a browser 3D motorcycle game. The Arduino Leonardo (HT626) reads potentiometers and emits keyboard HID events; **Poco Loco Moto** plays those same keys in a Three.js simulator.

## What’s in this repo

| Piece | Role |
| --- | --- |
| **HT626 firmware** (`HT626/`) | Leonardo sketch: steering + throttle pots → keyboard zones |
| **Infinite Moto Drift** (`app/`) | Client-side React + Three.js motorcycle game |
| **Static site build** | `npm run build` → `dist/` (HTML / CSS / JS) |

Branches historically split these (`main` ≈ firmware, `app-latest` ≈ game). This project is meant to be used together: flash the board, open the game, arm the keyboard, ride.

## How they connect

The firmware does **not** talk to the game over serial or USB custom protocol. It pretends to be a keyboard. The game already listens for those keys.

| Control | Hardware | Keys sent | Game use |
| --- | --- | --- | --- |
| Steering pot (A0) | Voltage bands | `; l k j h` / `g f d s a` | Graduated left / right steer |
| Throttle pot (A1) | Voltage bands | `z x c v b` | Graduated throttle |
| Button (pin 7 → GND) | Momentary | `r` | Reset |
| Arm switch (pin 2 → GND) | Safety | — | Keyboard off until armed |

Keyboard play without the board still works (same keys). Space = drift; `p` = pause.

## Safety (firmware)

**Keyboard output is off unless digital pin 2 is wired to GND.**

Leave pin 2 open while coding or uploading so the board cannot spam keys into your editor. For play, jumper pin 2 → GND (or use a switch).

If the board is stuck typing and you cannot upload:

```powershell
.\recover-upload.ps1
```

Or: `.\upload.ps1 -ManualReset` (double-tap Leonardo RESET when prompted).

---

## 1. Firmware (Arduino Leonardo)

### Hardware

- Arduino Leonardo (USB HID keyboard)
- Pot 1 on **A0** (3.3 V–GND): steering zones with a center dead band
- Pot 2 on **A1** (3.3 V–GND): throttle (low = glide / no key; higher = `z`→`b`)
- Button on **pin 7** to GND: tap `r`
- Enable jumper/switch: **pin 2** to GND

Voltage thresholds live at the top of `HT626/HT626.ino` (`LOW_*`, `HIGH_*`, throttle constants)—tune those if your pots don’t match the defaults.

### Prerequisites

- [Arduino CLI](https://arduino.github.io/arduino-cli/) (`winget install ArduinoSA.CLI`)
- Leonardo core / FQBN: `arduino:avr:leonardo` (see `HT626/sketch.yaml`)

### Build & upload (Windows)

```powershell
.\compile.ps1              # compile → build/
.\upload.ps1 COM10         # replace with your port
.\upload.ps1 -ManualReset  # if Keyboard HID blocks auto-reset
```

`.\upload.ps1` with no args lists COM ports and usage.

---

## 2. Game (Infinite Moto Drift)

Browser motorcycle simulator: procedural road, physics-ish riding, jumps / backflips, audio. Built as a **static** Vite + React app (no server required to host `dist/`).

### Prerequisites

- Node.js `>= 22.13`

### Commands

```powershell
npm install
npm run dev      # http://localhost:5173
npm run build    # → dist/index.html + assets
npm run start    # preview the dist/ build
npm test         # build + smoke-check dist HTML
```

Open `dist/index.html` via any static host, or use `npm run start` locally. Serve over HTTP(S); opening the file via `file://` can break ES modules depending on the browser.

### Source layout (game)

- `app/moto-game.tsx` — lazy loader for the engine
- `app/moto-game-engine-v2.tsx` — main Three.js game loop
- `app/flight-safety.js`, `jump-control.js`, `game-audio.js` — gameplay helpers
- `app/globals.css` — UI / HUD styles
- `public/` — favicon and static assets
- `index.html` — Vite entry

---

## Typical play session

1. Flash firmware (`.\upload.ps1 …`) with pin 2 **disconnected**.
2. `npm run dev` (or open a built `dist/`).
3. Focus the game window.
4. Connect pin 2 → GND to arm the keyboard.
5. Steer with A0, throttle with A1, reset with the pin 7 button.

When finished coding or uploading, disconnect pin 2 again.

---

## Project scripts summary

| Command | Purpose |
| --- | --- |
| `.\compile.ps1` | Compile Leonardo sketch |
| `.\upload.ps1 [COMx]` | Upload firmware |
| `.\upload.ps1 -ManualReset` | Recovery upload via bootloader |
| `.\recover-upload.ps1` | Guided recovery (GUI prompts) |
| `npm run dev` | Game development server |
| `npm run build` | Static site → `dist/` |
| `npm run start` | Preview `dist/` |
