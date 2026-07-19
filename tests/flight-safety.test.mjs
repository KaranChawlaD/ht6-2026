import assert from "node:assert/strict";
import test from "node:test";

import {
  canAdvanceBackflip,
  motorcyclePoseClearance,
  shouldArmBackflip,
} from "../app/flight-safety.js";

test("a small road-edge hop never enables the shared throttle/flip input", () => {
  assert.equal(
    shouldArmBackflip({
      designatedJump: false,
      airTime: 0.24,
      flightClearance: 0.9,
      verticalSpeed: 1.2,
    }),
    false,
  );
});

test("a high terrain launch can enable flipping when enough flight remains", () => {
  assert.equal(
    shouldArmBackflip({
      designatedJump: false,
      airTime: 0.32,
      flightClearance: 2.4,
      verticalSpeed: 2,
    }),
    true,
  );
});

test("a designated jump enables flipping earlier but never at takeoff", () => {
  assert.equal(
    shouldArmBackflip({
      designatedJump: true,
      airTime: 0.08,
      flightClearance: 1.1,
      verticalSpeed: 5,
    }),
    false,
  );
  assert.equal(
    shouldArmBackflip({
      designatedJump: true,
      airTime: 0.16,
      flightClearance: 0.9,
      verticalSpeed: 4,
    }),
    true,
  );
});

test("a late descent cannot newly enable a flip", () => {
  assert.equal(
    shouldArmBackflip({
      designatedJump: true,
      airTime: 1.4,
      flightClearance: 1.1,
      verticalSpeed: -8,
    }),
    false,
  );
});

test("the contact envelope follows the full motorcycle, not its origin", () => {
  assert.ok(motorcyclePoseClearance(0) <= 0.11);
  assert.ok(motorcyclePoseClearance(Math.PI / 2) > 1.7);
  assert.ok(motorcyclePoseClearance(Math.PI) > 2.6);
});

test("rotation pauses before any wheel or rider could enter the ground", () => {
  assert.equal(
    canAdvanceBackflip({
      heightAboveGround: 0.9,
      launchPitch: 0.1,
      flipAngle: Math.PI / 2,
      groundPitch: 0,
    }),
    false,
  );
  assert.equal(
    canAdvanceBackflip({
      heightAboveGround: 3,
      launchPitch: 0.1,
      flipAngle: Math.PI / 2,
      groundPitch: 0,
    }),
    true,
  );
});

