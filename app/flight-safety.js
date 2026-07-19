const BIKE_CLEARANCE = 0.1;
const GRAVITY = 13.2;
const DESIGNATED_FLIP_ARM_HEIGHT = 0.78;
const TERRAIN_FLIP_ARM_HEIGHT = 2.2;
const FLIP_ARM_TIME = 0.12;
const MIN_FLIP_TIME_REMAINING = 0.72;
const POSE_SAFETY_MARGIN = 0.035;

// Centre Y, centre Z, half-height, half-length, and local pitch for every
// visible motorcycle part that can become the lowest point during a backflip.
const MOTORCYCLE_SUPPORT_BOUNDS = [
  [0.48, -1.28, 0.57, 0.57, 0],
  [0.48, 1.25, 0.57, 0.57, 0],
  [0.78, -0.05, 0.31, 1.125, -0.08],
  [1.05, -0.42, 0.41, 0.7, 0],
  [1.17, 0.67, 0.1, 0.525, 0],
  [0.93, -1.05, 0.6, 0.055, -0.25],
  [1.48, -0.92, 0.045, 0.045, 0],
  [1.76, 0.1, 0.69, 0.33, -0.3],
  [2.3, -0.22, 0.35, 0.35, 0],
  [2.32, -0.53, 0.08, 0.04, -0.13],
];

/** @param {number} relativePitch */
export function motorcyclePoseClearance(relativePitch) {
  const cosine = Math.cos(relativePitch);
  const sine = Math.sin(relativePitch);
  let lowestPoint = Number.POSITIVE_INFINITY;

  for (const [centerY, centerZ, halfY, halfZ, localPitch] of
    MOTORCYCLE_SUPPORT_BOUNDS) {
    const rotatedY = centerY * cosine - centerZ * sine;
    const shapePitch = relativePitch + localPitch;
    const verticalExtent =
      halfY * Math.abs(Math.cos(shapePitch)) +
      halfZ * Math.abs(Math.sin(shapePitch));
    lowestPoint = Math.min(lowestPoint, rotatedY - verticalExtent);
  }

  return Math.max(BIKE_CLEARANCE, -lowestPoint + 0.01);
}

/**
 * @param {{
 *   designatedJump: boolean,
 *   airTime: number,
 *   flightClearance: number,
 *   verticalSpeed: number,
 * }} flight
 */
export function shouldArmBackflip(flight) {
  const requiredHeight = flight.designatedJump
    ? DESIGNATED_FLIP_ARM_HEIGHT
    : TERRAIN_FLIP_ARM_HEIGHT;
  if (
    flight.airTime < FLIP_ARM_TIME ||
    flight.flightClearance < requiredHeight
  ) {
    return false;
  }

  const clearance = Math.max(0, flight.flightClearance);
  const timeRemaining =
    (flight.verticalSpeed +
      Math.sqrt(
        Math.max(
          0,
          flight.verticalSpeed * flight.verticalSpeed +
            2 * GRAVITY * clearance,
        ),
      )) /
    GRAVITY;
  return timeRemaining >= MIN_FLIP_TIME_REMAINING;
}

/**
 * @param {{
 *   heightAboveGround: number,
 *   launchPitch: number,
 *   flipAngle: number,
 *   groundPitch: number,
 * }} pose
 */
export function canAdvanceBackflip(pose) {
  const requiredClearance = motorcyclePoseClearance(
    pose.launchPitch + pose.flipAngle - pose.groundPitch,
  );
  return pose.heightAboveGround >= requiredClearance + POSE_SAFETY_MARGIN;
}

