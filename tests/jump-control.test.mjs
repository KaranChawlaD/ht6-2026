import assert from "node:assert/strict";
import test from "node:test";

import {
  DRAMATIC_LAUNCH_ANGLE,
  DRAMATIC_TAKEOFF_SLOPE,
  createClimbRateWindow,
  dramaticLaunchVerticalSpeed,
  nextDramaticBackflipAngle,
  shouldTriggerDramaticLaunch,
} from "../app/jump-control.js";
import {
  canAdvanceBackflip,
  motorcyclePoseClearance,
  shouldArmBackflip,
} from "../app/flight-safety.js";

const FIXED_STEP = 1 / 120;
const MAX_SPEED = 200 / 3.6;

function simulateHill({ amplitude, width, baselineSlope, speed, designated }) {
  const history = createClimbRateWindow(2, FIXED_STEP);
  let previousSlope = baselineSlope;
  let trigger = null;

  const slopeAt = (distance) =>
    baselineSlope +
    (amplitude * Math.PI) / width *
      Math.sin((2 * Math.PI * distance) / width);
  const curvatureAt = (distance) =>
    (2 * amplitude * Math.PI * Math.PI) /
    (width * width) *
    Math.cos((2 * Math.PI * distance) / width);

  for (
    let distance = -speed * 2;
    distance <= width / 2;
    distance += speed * FIXED_STEP
  ) {
    const slope = distance < 0 ? baselineSlope : slopeAt(distance);
    const averageClimbRate = history.push(Math.max(0, slope * speed));
    const verticalCurvature =
      distance < 0 ? 0 : curvatureAt(distance);

    if (
      shouldTriggerDramaticLaunch({
        isDesignatedRoad: designated,
        speed,
        maxSpeed: MAX_SPEED,
        previousSlope,
        currentSlope: slope,
        verticalCurvature,
        averageClimbRate,
      })
    ) {
      trigger = { distance, slope, averageClimbRate };
      break;
    }
    previousSlope = slope;
  }

  return trigger;
}

test("every generated big-hill extreme triggers at full speed", () => {
  for (const amplitude of [30, 32, 34]) {
    for (const width of [180, 200, 220]) {
      for (const baselineSlope of [-0.145, -0.1, -0.05, 0, 0.05, 0.1, 0.145]) {
        const trigger = simulateHill({
          amplitude,
          width,
          baselineSlope,
          speed: MAX_SPEED,
          designated: true,
        });
        assert.ok(
          trigger,
          `missed amplitude=${amplitude}, width=${width}, baseline=${baselineSlope}`,
        );
        assert.ok(Math.abs(trigger.slope - DRAMATIC_TAKEOFF_SLOPE) < 0.025);
      }
    }
  }
});

test("the same hill cannot trigger below the high-speed gate", () => {
  assert.equal(
    simulateHill({
      amplitude: 34,
      width: 180,
      baselineSlope: 0.1,
      speed: MAX_SPEED * 0.89,
      designated: true,
    }),
    null,
  );
});

test("road-edge and ordinary terrain hops are never dramatic launches", () => {
  assert.equal(
    shouldTriggerDramaticLaunch({
      isDesignatedRoad: false,
      speed: MAX_SPEED,
      maxSpeed: MAX_SPEED,
      previousSlope: 0.3,
      currentSlope: 0.25,
      verticalCurvature: -0.02,
      averageClimbRate: 20,
    }),
    false,
  );
});

test("the boost produces an exact 15-degree launch vector", () => {
  const verticalSpeed = dramaticLaunchVerticalSpeed(MAX_SPEED);
  assert.ok(
    Math.abs(Math.atan2(verticalSpeed, MAX_SPEED) - DRAMATIC_LAUNCH_ANGLE) <
      1e-12,
  );
});

test("all full-speed showcase hills keep flipping safely until touchdown", () => {
  for (const amplitude of [30, 32, 34]) {
    for (const width of [180, 200, 220]) {
      for (const baselineSlope of [-0.145, -0.1, 0, 0.1, 0.145]) {
        const trigger = simulateHill({
          amplitude,
          width,
          baselineSlope,
          speed: MAX_SPEED,
          designated: true,
        });
        assert.ok(trigger);

        const groundAt = (distance) =>
          baselineSlope * distance +
          (distance >= 0 && distance <= width
            ? amplitude * Math.sin((Math.PI * distance) / width) ** 2
            : 0);
        const slopeAt = (distance) =>
          baselineSlope +
          (distance >= 0 && distance <= width
            ? (amplitude * Math.PI) /
              width *
              Math.sin((2 * Math.PI * distance) / width)
            : 0);

        let distance = trigger.distance;
        let height = groundAt(distance) + 0.1;
        let verticalSpeed = dramaticLaunchVerticalSpeed(MAX_SPEED);
        let airTime = 0;
        let flipAngle = 0;
        let flipReady = false;
        let landed = false;
        let minimumRenderedClearance = Number.POSITIVE_INFINITY;

        while (airTime < 6 && !landed) {
          distance += MAX_SPEED * FIXED_STEP;
          const ground = groundAt(distance);
          const groundPitch = Math.atan(slopeAt(distance));
          height += verticalSpeed * FIXED_STEP;
          verticalSpeed -= 13.2 * FIXED_STEP;
          airTime += FIXED_STEP;
          const flightClearance = height - ground - 0.1;

          if (
            !flipReady &&
            shouldArmBackflip({
              designatedJump: true,
              airTime,
              flightClearance,
              verticalSpeed,
            })
          ) {
            flipReady = true;
          }
          if (flipReady) {
            const nextAngle = nextDramaticBackflipAngle(
              flipAngle,
              1,
              FIXED_STEP,
            );
            if (
              canAdvanceBackflip({
                heightAboveGround: height - ground,
                launchPitch: DRAMATIC_LAUNCH_ANGLE,
                flipAngle: nextAngle,
                groundPitch,
              })
            ) {
              flipAngle = nextAngle;
            }
          }

          const requiredClearance = motorcyclePoseClearance(
            DRAMATIC_LAUNCH_ANGLE + flipAngle - groundPitch,
          );
          if (
            airTime > 0.08 &&
            verticalSpeed <= 0.25 &&
            height <= ground + requiredClearance
          ) {
            landed = true;
          } else if (verticalSpeed <= 0.25) {
            minimumRenderedClearance = Math.min(
              minimumRenderedClearance,
              height - ground - requiredClearance,
            );
          }
        }

        assert.equal(flipReady, true);
        assert.equal(landed, true);
        assert.ok(flipAngle > Math.PI * 2);
        assert.ok(minimumRenderedClearance >= 0);
      }
    }
  }
});
