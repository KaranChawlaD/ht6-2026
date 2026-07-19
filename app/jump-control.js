export const DRAMATIC_LAUNCH_ANGLE = Math.PI / 12;
export const DRAMATIC_TAKEOFF_SLOPE = Math.tan(DRAMATIC_LAUNCH_ANGLE);
export const DRAMATIC_BACKFLIP_RATE = 6.25;
export const MIN_DRAMATIC_SPEED_RATIO = 0.9;
// Five vertical metres per second over the exact two-second window means the
// bike has gained at least ten metres of altitude before reaching the lip.
// The shallowest/widest generated jump still measures 5.34 m/s at full speed.
export const MIN_TWO_SECOND_CLIMB_RATE = 5;

/**
 * Exact fixed-step rolling average for the previous time window.
 * @param {number} durationSeconds
 * @param {number} fixedStep
 */
export function createClimbRateWindow(durationSeconds, fixedStep) {
  const sampleCount = Math.max(1, Math.round(durationSeconds / fixedStep));
  const samples = new Float32Array(sampleCount);
  let cursor = 0;
  let sum = 0;

  return {
    /** @param {number} rate */
    push(rate) {
      sum += rate - samples[cursor];
      samples[cursor] = rate;
      cursor = (cursor + 1) % sampleCount;
      return sum / sampleCount;
    },
    reset() {
      samples.fill(0);
      cursor = 0;
      sum = 0;
    },
  };
}

/**
 * @param {{
 *   isDesignatedRoad: boolean,
 *   speed: number,
 *   maxSpeed: number,
 *   previousSlope: number,
 *   currentSlope: number,
 *   verticalCurvature: number,
 *   averageClimbRate: number,
 * }} sample
 */
export function shouldTriggerDramaticLaunch(sample) {
  const crossedTakeoffSlope =
    sample.previousSlope > DRAMATIC_TAKEOFF_SLOPE &&
    sample.currentSlope <= DRAMATIC_TAKEOFF_SLOPE &&
    sample.currentSlope >= DRAMATIC_TAKEOFF_SLOPE - 0.025;

  return (
    sample.isDesignatedRoad &&
    sample.speed >= sample.maxSpeed * MIN_DRAMATIC_SPEED_RATIO &&
    sample.averageClimbRate >= MIN_TWO_SECOND_CLIMB_RATE &&
    sample.verticalCurvature < -0.0004 &&
    crossedTakeoffSlope
  );
}

/** @param {number} horizontalSpeed */
export function dramaticLaunchVerticalSpeed(horizontalSpeed) {
  return horizontalSpeed * DRAMATIC_TAKEOFF_SLOPE;
}

/**
 * @param {number} currentAngle
 * @param {number} throttle
 * @param {number} fixedStep
 */
export function nextDramaticBackflipAngle(currentAngle, throttle, fixedStep) {
  return currentAngle + DRAMATIC_BACKFLIP_RATE * throttle * fixedStep;
}
