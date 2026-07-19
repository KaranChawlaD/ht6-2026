import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateAudioMix,
  calculateLandingImpact,
} from "../app/game-audio.js";

const base = {
  speedRatio: 0.75,
  steering: 0,
  slipAngle: 0,
  drifting: false,
  airborne: false,
  paused: false,
};

test("engine loudness follows the five throttle levels", () => {
  const gains = [0.2, 0.4, 0.6, 0.8, 1].map(
    (throttle) => calculateAudioMix({ ...base, throttle }).engineGain,
  );
  for (let index = 1; index < gains.length; index += 1) {
    assert.ok(gains[index] > gains[index - 1]);
  }
});

test("airborne and paused states completely silence the engine and tyres", () => {
  for (const state of [
    { airborne: true, paused: false },
    { airborne: false, paused: true },
  ]) {
    const mix = calculateAudioMix({
      ...base,
      ...state,
      throttle: 1,
      steering: 1,
      drifting: true,
    });
    assert.equal(mix.engineGain, 0);
    assert.equal(mix.scrubGain, 0);
  }
});

test("hard high-speed turning creates more tyre scrub than straight driving", () => {
  const straight = calculateAudioMix({ ...base, throttle: 1 });
  const corner = calculateAudioMix({
    ...base,
    throttle: 1,
    steering: 1,
    drifting: true,
  });
  assert.equal(straight.scrubGain, 0);
  assert.ok(corner.scrubGain > 0.03);
});

test("landing collision is forceful even on laptop speakers", () => {
  const gentle = calculateLandingImpact(4);
  const hard = calculateLandingImpact(18);
  assert.ok(gentle.thumpGain >= 0.19);
  assert.ok(gentle.crackGain >= 0.09);
  assert.ok(gentle.gritGain >= 0.13);
  assert.ok(hard.thumpGain > gentle.thumpGain);
  assert.ok(hard.crackGain > gentle.crackGain);
  assert.ok(hard.gritGain > gentle.gritGain);
});
