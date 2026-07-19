"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import {
  canAdvanceBackflip,
  motorcyclePoseClearance,
  shouldArmBackflip,
} from "./flight-safety.js";
import { createGameAudio } from "./game-audio.js";
import {
  DRAMATIC_LAUNCH_ANGLE,
  createClimbRateWindow,
  dramaticLaunchVerticalSpeed,
  nextDramaticBackflipAngle,
  shouldTriggerDramaticLaunch,
} from "./jump-control.js";

const ROAD_WIDTH = 13;
const ROAD_STEP = 6;
const ROUTE_LENGTH = 14000;
// The wheel centres sit 0.48 m above the bike origin and their outer radius is
// 0.57 m, so a 0.10 m origin offset leaves the tyres almost exactly touching.
const BIKE_CLEARANCE = 0.1;
const MAX_SPEED = 200 / 3.6;
const FIXED_STEP = 1 / 120;
const TERRAIN_SIZE = 1440;
const TERRAIN_SEGMENTS = 60;
const TERRAIN_SHIFT = 240;
const ROAD_GRID_SIZE = 100;
const GRID_OFFSET = 50000;
const TIGHT_CURVE = 0.0065;
const ROAD_SURFACE_OFFSET = 0.22;
const ENGINE_FORCE = 11.08;
const ROLLING_RESISTANCE = 1.8;
const AERO_DRAG = 0.0015;
const BIKE_COLLISION_RADIUS = 0.82;
const MAX_BACKFLIP_RATE = 5.4;
const GRAVITY = 13.2;
const LAUNCH_LOOKAHEAD = 16;
const MIN_TERRAIN_TAKEOFF_SLOPE = 0.06;
const MAX_TERRAIN_TAKEOFF_SLOPE = 0.15;
const JUMP_LIFT_BONUS = 0.6;

const STEERING_LEVELS = [
  ["a", -1],
  ["s", -0.8],
  ["d", -0.6],
  ["f", -0.4],
  ["g", -0.2],
  ["h", 0.2],
  ["j", 0.4],
  ["k", 0.6],
  ["l", 0.8],
  [";", 1],
] as const;

const THROTTLE_LEVELS = [
  ["z", 0.2],
  ["x", 0.4],
  ["c", 0.6],
  ["v", 0.8],
  ["b", 1],
] as const;

const GAME_KEYS = new Set([
  "z",
  "x",
  "c",
  "v",
  "b",
  "a",
  "s",
  "d",
  "f",
  "g",
  "h",
  "j",
  "k",
  "l",
  ";",
  "r",
  "p",
  " ",
]);

type RoadSample = {
  s: number;
  x: number;
  y: number;
  z: number;
  heading: number;
  curvature: number;
  jumpZone: boolean;
};

type RoadGrid = Map<number, number[]>;

type ObstacleCollider = {
  x: number;
  z: number;
  radius: number;
};

type ObstacleGrid = Map<number, ObstacleCollider[]>;

type RoadQuery = {
  index: number;
  t: number;
  distance: number;
  x: number;
  y: number;
  z: number;
  heading: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function smootherstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function wrapAngle(value: number) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function angleDifference(target: number, current: number) {
  return wrapAngle(target - current);
}

function steeringInput(keys: Set<string>) {
  let strongestLeft = 0;
  let strongestRight = 0;

  for (let index = 0; index < STEERING_LEVELS.length; index += 1) {
    const [key, value] = STEERING_LEVELS[index];
    if (!keys.has(key)) continue;
    if (value < strongestLeft) strongestLeft = value;
    if (value > strongestRight) strongestRight = value;
  }

  return clamp(strongestLeft + strongestRight, -1, 1);
}

function throttleInput(keys: Set<string>) {
  let strongest = 0;
  for (let index = 0; index < THROTTLE_LEVELS.length; index += 1) {
    const [key, value] = THROTTLE_LEVELS[index];
    if (keys.has(key)) strongest = Math.max(strongest, value);
  }
  return strongest;
}

function mulberry32(seed: number) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

function pseudoRandom(value: number) {
  const result = Math.sin(value * 127.1 + 311.7) * 43758.5453;
  return result - Math.floor(result);
}

function generateRoute(seed: number) {
  const random = mulberry32(seed);
  const samples: RoadSample[] = [];
  let x = 0;
  let y = 2;
  let z = 70;
  let heading = 0;
  let targetHeading = 0;
  let turnDistance = 0;
  let turnResponse = 110;
  let slope = 0;
  let targetSlope = 0.025;
  let elevationDistance = 0;
  let activeHairpin = false;
  let distanceSinceHairpin = 850;

  for (let s = 0; s <= ROUTE_LENGTH; s += ROAD_STEP) {
    if (turnDistance <= 0) {
      activeHairpin =
        distanceSinceHairpin > 520 &&
        (distanceSinceHairpin > 1350 || random() > 0.84);
      if (activeHairpin) distanceSinceHairpin = 0;
      const tightTurn = !activeHairpin && random() > 0.66;
      let change: number;

      if (activeHairpin) {
        const turnDirection =
          heading > 0.72 ? -1 : heading < -0.72 ? 1 : random() < 0.5 ? -1 : 1;
        change = turnDirection * (1.28 + random() * 0.34);
      } else {
        const maximumChange = tightTurn ? 1.08 : 0.7;
        change = (random() * 2 - 1) * maximumChange;
        if (Math.abs(change) < 0.2) {
          change = (change < 0 ? -1 : 1) * (0.2 + random() * 0.22);
        }
      }

      targetHeading = clamp(heading + change, -1.46, 1.46);
      turnResponse = activeHairpin
        ? 58 + random() * 25
        : tightTurn
          ? 48 + random() * 34
          : 92 + random() * 85;
      turnDistance = activeHairpin
        ? 210 + random() * 155
        : 150 + random() * 340;
    }

    if (elevationDistance <= 0) {
      const largeHill = random() > 0.62;
      targetSlope =
        (random() * 2 - 1) * (largeHill ? 0.145 : 0.078);
      elevationDistance = 130 + random() * 300;
    }

    const headingDelta = angleDifference(targetHeading, heading);
    const plannedCurvature = headingDelta / turnResponse;
    let boundedSlopeTarget = targetSlope;
    if (y > 28) boundedSlopeTarget = -Math.max(0.035, Math.abs(targetSlope));
    if (y < -2) boundedSlopeTarget = Math.max(0.035, Math.abs(targetSlope));
    if (activeHairpin) boundedSlopeTarget = 0;
    const safeSlopeTarget =
      Math.abs(plannedCurvature) > TIGHT_CURVE
        ? boundedSlopeTarget * 0.12
        : boundedSlopeTarget;

    slope +=
      (safeSlopeTarget - slope) *
      (activeHairpin
        ? 0.62
        : Math.abs(plannedCurvature) > TIGHT_CURVE
          ? 0.42
          : 0.035);
    heading = wrapAngle(
      heading + headingDelta * (ROAD_STEP / turnResponse),
    );

    samples.push({
      s,
      x,
      y,
      z,
      heading,
      curvature: 0,
      jumpZone: false,
    });

    x += Math.sin(heading) * ROAD_STEP;
    z -= Math.cos(heading) * ROAD_STEP;
    y += slope * ROAD_STEP;
    turnDistance -= ROAD_STEP;
    elevationDistance -= ROAD_STEP;
    distanceSinceHairpin += ROAD_STEP;
  }

  for (let index = 0; index < samples.length; index += 1) {
    const before = samples[Math.max(0, index - 1)];
    const after = samples[Math.min(samples.length - 1, index + 1)];
    samples[index].curvature =
      angleDifference(after.heading, before.heading) /
      Math.max(ROAD_STEP, after.s - before.s);
  }

  // Shape the most demanding corners into short plateaus with smooth approach
  // and exit grades. Hairpins stay dramatic horizontally without also hiding
  // a steep descent or launch ramp inside the turn.
  let curveCursor = 1;
  while (curveCursor < samples.length - 1) {
    if (Math.abs(samples[curveCursor].curvature) < 0.012) {
      curveCursor += 1;
      continue;
    }

    const curveStart = curveCursor;
    while (
      curveCursor < samples.length - 1 &&
      Math.abs(samples[curveCursor].curvature) > 0.0075
    ) {
      curveCursor += 1;
    }
    const curveEnd = curveCursor;
    const blendSamples = 12;
    const first = Math.max(0, curveStart - blendSamples);
    const last = Math.min(samples.length - 1, curveEnd + blendSamples);
    const plateauHeight =
      (samples[curveStart].y + samples[curveEnd].y) / 2;
    const firstHeight = samples[first].y;
    const lastHeight = samples[last].y;

    for (let index = first; index < curveStart; index += 1) {
      const blend = smootherstep(
        (index - first) / Math.max(1, curveStart - first),
      );
      samples[index].y =
        firstHeight + (plateauHeight - firstHeight) * blend;
    }
    for (let index = curveStart; index <= curveEnd; index += 1) {
      samples[index].y = plateauHeight;
    }
    for (let index = curveEnd + 1; index <= last; index += 1) {
      const blend = smootherstep(
        (index - curveEnd) / Math.max(1, last - curveEnd),
      );
      samples[index].y =
        plateauHeight + (lastHeight - plateauHeight) * blend;
    }
    curveCursor = last + 1;
  }

  // Add occasional, deliberate jump crests. The safety scan reserves a long,
  // nearly straight downhill and landing zone after every crest.
  const hillRandom = mulberry32(seed ^ 0x34f921ad);
  let nextHill = 620 + hillRandom() * 360;
  while (nextHill < ROUTE_LENGTH - 320) {
    let centerIndex = Math.round(nextHill / ROAD_STEP);
    const width = 180 + hillRandom() * 40;
    let foundSafeSection = false;

    for (let attempt = 0; attempt < 32; attempt += 1) {
      const approachSamples = Math.ceil((width / 2 + 55) / ROAD_STEP);
      const landingSamples = Math.ceil((width / 2 + 180) / ROAD_STEP);
      const first = Math.max(2, centerIndex - approachSamples);
      const last = Math.min(samples.length - 3, centerIndex + landingSamples);
      let maximumCurve = 0;
      for (let index = first; index <= last; index += 1) {
        maximumCurve = Math.max(
          maximumCurve,
          Math.abs(samples[index].curvature),
        );
      }
      if (maximumCurve < 0.0045) {
        foundSafeSection = true;
        break;
      }
      centerIndex += Math.ceil(54 / ROAD_STEP);
    }

    if (foundSafeSection && centerIndex < samples.length - 55) {
      const centerS = samples[centerIndex].s;
      // These deliberately tall, smooth hills always exceed the 15-degree
      // launch tangent even when the underlying route is descending at its
      // steepest allowed grade. Ordinary road hills remain unchanged.
      const amplitude = 30 + hillRandom() * 4;
      const startS = centerS - width / 2;
      const endS = centerS + width / 2;
      const first = Math.max(0, Math.floor(startS / ROAD_STEP));
      const last = Math.min(samples.length - 1, Math.ceil(endS / ROAD_STEP));
      for (let index = first; index <= last; index += 1) {
        const progress = clamp((samples[index].s - startS) / width, 0, 1);
        const profile = Math.sin(progress * Math.PI);
        samples[index].y += amplitude * profile * profile;
        samples[index].jumpZone = true;
      }
      nextHill = centerS + 720 + hillRandom() * 500;
    } else {
      nextHill += 270 + hillRandom() * 220;
    }
  }

  return samples;
}

function gridKey(x: number, z: number) {
  const cellX = Math.floor(x / ROAD_GRID_SIZE) + GRID_OFFSET;
  const cellZ = Math.floor(z / ROAD_GRID_SIZE) + GRID_OFFSET;
  return cellX * 100000 + cellZ;
}

function buildRoadGrid(route: RoadSample[]) {
  const grid: RoadGrid = new Map();
  for (let index = 0; index < route.length; index += 1) {
    const sample = route[index];
    const key = gridKey(sample.x, sample.z);
    const bucket = grid.get(key);
    if (bucket) bucket.push(index);
    else grid.set(key, [index]);
  }
  return grid;
}

function setRoadQueryFromSegment(
  route: RoadSample[],
  segmentIndex: number,
  t: number,
  distance: number,
  target: RoadQuery,
) {
  const start = route[segmentIndex];
  const end = route[Math.min(route.length - 1, segmentIndex + 1)];
  target.index = segmentIndex;
  target.t = t;
  target.distance = distance;
  target.x = start.x + (end.x - start.x) * t;
  target.y = start.y + (end.y - start.y) * t;
  target.z = start.z + (end.z - start.z) * t;
  target.heading = wrapAngle(
    start.heading + angleDifference(end.heading, start.heading) * t,
  );
}

function queryRoad(
  route: RoadSample[],
  grid: RoadGrid,
  x: number,
  z: number,
  target: RoadQuery,
  globalSearch = false,
) {
  let nearestIndex = -1;
  let nearestDistanceSquared = Number.POSITIVE_INFINITY;

  if (globalSearch) {
    for (let index = 0; index < route.length; index += 1) {
      const dx = x - route[index].x;
      const dz = z - route[index].z;
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared < nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestIndex = index;
      }
    }
  } else {
    const centerCellX = Math.floor(x / ROAD_GRID_SIZE);
    const centerCellZ = Math.floor(z / ROAD_GRID_SIZE);
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
        const key =
          (centerCellX + offsetX + GRID_OFFSET) * 100000 +
          (centerCellZ + offsetZ + GRID_OFFSET);
        const bucket = grid.get(key);
        if (!bucket) continue;
        for (let item = 0; item < bucket.length; item += 1) {
          const index = bucket[item];
          const dx = x - route[index].x;
          const dz = z - route[index].z;
          const distanceSquared = dx * dx + dz * dz;
          if (distanceSquared < nearestDistanceSquared) {
            nearestDistanceSquared = distanceSquared;
            nearestIndex = index;
          }
        }
      }
    }
  }

  if (nearestIndex < 0) {
    target.distance = Number.POSITIVE_INFINITY;
    return false;
  }

  let bestSegment = Math.max(0, Math.min(route.length - 2, nearestIndex));
  let bestT = 0;
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  const firstSegment = Math.max(0, nearestIndex - 1);
  const lastSegment = Math.min(route.length - 2, nearestIndex);

  for (let segment = firstSegment; segment <= lastSegment; segment += 1) {
    const start = route[segment];
    const end = route[segment + 1];
    const segmentX = end.x - start.x;
    const segmentZ = end.z - start.z;
    const lengthSquared = segmentX * segmentX + segmentZ * segmentZ;
    const t = clamp(
      ((x - start.x) * segmentX + (z - start.z) * segmentZ) /
        Math.max(lengthSquared, 0.001),
      0,
      1,
    );
    const closestX = start.x + segmentX * t;
    const closestZ = start.z + segmentZ * t;
    const dx = x - closestX;
    const dz = z - closestZ;
    const distanceSquared = dx * dx + dz * dz;
    if (distanceSquared < bestDistanceSquared) {
      bestDistanceSquared = distanceSquared;
      bestSegment = segment;
      bestT = t;
    }
  }

  setRoadQueryFromSegment(
    route,
    bestSegment,
    bestT,
    Math.sqrt(bestDistanceSquared),
    target,
  );
  return true;
}

function rawTerrainHeight(x: number, z: number) {
  const rolling =
    Math.sin(x * 0.009 + 0.7) * 2.8 +
    Math.sin(z * 0.006 - 0.4) * 3.4 +
    Math.sin((x + z) * 0.0031) * 3.8 +
    Math.sin(x * 0.031 + z * 0.017) * 0.8 +
    Math.cos(z * 0.024 - x * 0.012) * 0.55;
  const ridgeSignal =
    (Math.sin(x * 0.0022 + Math.cos(z * 0.0013) * 1.5) +
      Math.sin(z * 0.00175 - x * 0.00075) +
      Math.cos((x + z) * 0.00115 + 1.1)) /
    3;
  const ridge = Math.max(0, ridgeSignal - 0.02);
  const mesaSignal =
    (Math.cos(x * 0.00105 - z * 0.00142 + 0.8) +
      Math.sin((x - z) * 0.00082 - 0.3)) /
    2;
  const mesa = Math.max(0, mesaSignal - 0.28);
  return rolling + ridge * ridge * 92 + mesa * mesa * 38 - 5.5;
}

function groundHeight(
  route: RoadSample[],
  grid: RoadGrid,
  x: number,
  z: number,
  query: RoadQuery,
  roadSurface: boolean,
) {
  const terrain = rawTerrainHeight(x, z);
  if (!queryRoad(route, grid, x, z, query)) return terrain;

  const roadEdge = ROAD_WIDTH / 2 + 1.4;
  const blendEnd = roadEdge + 70;
  if (query.distance >= blendEnd) return terrain;

  const roadHeight = query.y + (roadSurface ? ROAD_SURFACE_OFFSET : -0.76);
  if (query.distance <= roadEdge) return roadHeight;
  const blend = smootherstep(
    (query.distance - roadEdge) / (blendEnd - roadEdge),
  );
  return roadHeight + (terrain - roadHeight) * blend;
}

function sampleTerrainLattice(
  route: RoadSample[],
  grid: RoadGrid,
  x: number,
  z: number,
  query: RoadQuery,
) {
  const cell = TERRAIN_SIZE / TERRAIN_SEGMENTS;
  const baseX = Math.floor(x / cell) * cell;
  const baseZ = Math.floor(z / cell) * cell;
  const fractionX = (x - baseX) / cell;
  const fractionZ = (z - baseZ) / cell;
  const h00 = groundHeight(route, grid, baseX, baseZ, query, false);
  const h10 = groundHeight(route, grid, baseX + cell, baseZ, query, false);
  const h01 = groundHeight(route, grid, baseX, baseZ + cell, query, false);
  const h11 = groundHeight(
    route,
    grid,
    baseX + cell,
    baseZ + cell,
    query,
    false,
  );

  if (fractionX + fractionZ <= 1) {
    return (
      h00 +
      (h10 - h00) * fractionX +
      (h01 - h00) * fractionZ
    );
  }
  return (
    h11 +
    (h01 - h11) * (1 - fractionX) +
    (h10 - h11) * (1 - fractionZ)
  );
}

function createTerrain(
  route: RoadSample[],
  grid: RoadGrid,
  centerX: number,
  centerZ: number,
) {
  const side = TERRAIN_SEGMENTS + 1;
  const vertexCount = side * side;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices: number[] = [];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  for (let zIndex = 0; zIndex < TERRAIN_SEGMENTS; zIndex += 1) {
    for (let xIndex = 0; xIndex < TERRAIN_SEGMENTS; xIndex += 1) {
      const topLeft = zIndex * side + xIndex;
      const bottomLeft = topLeft + side;
      indices.push(
        topLeft,
        bottomLeft,
        topLeft + 1,
        topLeft + 1,
        bottomLeft,
        bottomLeft + 1,
      );
    }
  }
  geometry.setIndex(indices);

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const terrainQuery: RoadQuery = {
    index: 0,
    t: 0,
    distance: 0,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
  };
  let currentCenterX = centerX;
  let currentCenterZ = centerZ;

  const update = (newCenterX: number, newCenterZ: number) => {
    currentCenterX = newCenterX;
    currentCenterZ = newCenterZ;
    mesh.position.set(newCenterX, 0, newCenterZ);
    let vertex = 0;
    for (let zIndex = 0; zIndex < side; zIndex += 1) {
      const localZ =
        (zIndex / TERRAIN_SEGMENTS - 0.5) * TERRAIN_SIZE;
      for (let xIndex = 0; xIndex < side; xIndex += 1) {
        const localX =
          (xIndex / TERRAIN_SEGMENTS - 0.5) * TERRAIN_SIZE;
        const worldX = newCenterX + localX;
        const worldZ = newCenterZ + localZ;
        const height = groundHeight(
          route,
          grid,
          worldX,
          worldZ,
          terrainQuery,
          false,
        );
        const positionIndex = vertex * 3;
        positions[positionIndex] = localX;
        positions[positionIndex + 1] = height;
        positions[positionIndex + 2] = localZ;

        const rock = smoothstep((height - 11) / 24);
        const duneVariation =
          Math.sin(worldX * 0.021 + worldZ * 0.008) * 0.035 +
          Math.cos(worldZ * 0.027 - worldX * 0.006) * 0.025;
        const scrub = smoothstep((Math.sin(worldX * 0.017) + 0.45) / 1.45);
        colors[positionIndex] =
          0.54 * (1 - rock) + 0.31 * rock + duneVariation;
        colors[positionIndex + 1] =
          0.32 * (1 - rock) + 0.27 * rock + duneVariation * 0.55 + scrub * 0.035;
        colors[positionIndex + 2] =
          0.16 * (1 - rock) + 0.22 * rock + duneVariation * 0.3;
        vertex += 1;
      }
    }
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.color.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
  };

  const sampleHeight = (worldX: number, worldZ: number) => {
    const gridX =
      ((worldX - currentCenterX) / TERRAIN_SIZE + 0.5) *
      TERRAIN_SEGMENTS;
    const gridZ =
      ((worldZ - currentCenterZ) / TERRAIN_SIZE + 0.5) *
      TERRAIN_SEGMENTS;
    if (
      gridX < 0 ||
      gridZ < 0 ||
      gridX >= TERRAIN_SEGMENTS ||
      gridZ >= TERRAIN_SEGMENTS
    ) {
      return sampleTerrainLattice(route, grid, worldX, worldZ, terrainQuery);
    }

    const xIndex = Math.floor(gridX);
    const zIndex = Math.floor(gridZ);
    const fractionX = gridX - xIndex;
    const fractionZ = gridZ - zIndex;
    const heightAt = (ix: number, iz: number) =>
      positions[(iz * side + ix) * 3 + 1];
    const h00 = heightAt(xIndex, zIndex);
    const h10 = heightAt(xIndex + 1, zIndex);
    const h01 = heightAt(xIndex, zIndex + 1);
    const h11 = heightAt(xIndex + 1, zIndex + 1);
    if (fractionX + fractionZ <= 1) {
      return (
        h00 +
        (h10 - h00) * fractionX +
        (h01 - h00) * fractionZ
      );
    }
    return (
      h11 +
      (h01 - h11) * (1 - fractionX) +
      (h10 - h11) * (1 - fractionZ)
    );
  };

  update(centerX, centerZ);
  return { mesh, update, sampleHeight };
}

function makeRoadStrip(
  route: RoadSample[],
  halfWidth: number,
  yOffset: number,
) {
  const positions = new Float32Array(route.length * 2 * 3);
  const indices: number[] = [];

  for (let index = 0; index < route.length; index += 1) {
    const sample = route[index];
    const rightX = Math.cos(sample.heading);
    const rightZ = Math.sin(sample.heading);
    const leftIndex = index * 6;
    positions[leftIndex] = sample.x - rightX * halfWidth;
    positions[leftIndex + 1] = sample.y + yOffset;
    positions[leftIndex + 2] = sample.z - rightZ * halfWidth;
    positions[leftIndex + 3] = sample.x + rightX * halfWidth;
    positions[leftIndex + 4] = sample.y + yOffset;
    positions[leftIndex + 5] = sample.z + rightZ * halfWidth;

    if (index < route.length - 1) {
      const base = index * 2;
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function buildRoad(route: RoadSample[]) {
  const group = new THREE.Group();
  const shoulder = new THREE.Mesh(
    makeRoadStrip(route, ROAD_WIDTH / 2 + 1.15, 0.08),
    new THREE.MeshStandardMaterial({
      color: 0x90785b,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  shoulder.receiveShadow = true;
  group.add(shoulder);

  const road = new THREE.Mesh(
    makeRoadStrip(route, ROAD_WIDTH / 2, ROAD_SURFACE_OFFSET),
    new THREE.MeshStandardMaterial({
      color: 0x343a3b,
      roughness: 0.88,
      metalness: 0.02,
      side: THREE.DoubleSide,
    }),
  );
  road.receiveShadow = true;
  group.add(road);

  const markerGeometry = new THREE.BoxGeometry(0.15, 0.035, 5.2);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xf7e8b5 });
  const markerCount = Math.floor(route.length / 3);
  const markers = new THREE.InstancedMesh(
    markerGeometry,
    markerMaterial,
    markerCount,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const yAxis = new THREE.Vector3(0, 1, 0);
  const position = new THREE.Vector3();

  for (let instance = 0; instance < markerCount; instance += 1) {
    const sample = route[instance * 3 + 1];
    position.set(sample.x, sample.y + ROAD_SURFACE_OFFSET + 0.05, sample.z);
    quaternion.setFromAxisAngle(yAxis, -sample.heading);
    matrix.compose(position, quaternion, scale);
    markers.setMatrixAt(instance, matrix);
  }
  markers.instanceMatrix.needsUpdate = true;
  group.add(markers);

  const postSpacing = 8;
  const postCount = Math.ceil(route.length / postSpacing) * 2;
  const postGeometry = new THREE.BoxGeometry(0.18, 1.05, 0.18);
  const postMaterial = new THREE.MeshStandardMaterial({
    color: 0xf4f0df,
    roughness: 0.85,
  });
  const posts = new THREE.InstancedMesh(
    postGeometry,
    postMaterial,
    postCount,
  );
  let postInstance = 0;
  for (let index = 0; index < route.length; index += postSpacing) {
    const sample = route[index];
    const rightX = Math.cos(sample.heading);
    const rightZ = Math.sin(sample.heading);
    for (let side = -1; side <= 1; side += 2) {
      position.set(
        sample.x + rightX * side * (ROAD_WIDTH / 2 + 1.65),
        sample.y + 0.5,
        sample.z + rightZ * side * (ROAD_WIDTH / 2 + 1.65),
      );
      quaternion.setFromAxisAngle(yAxis, -sample.heading);
      matrix.compose(position, quaternion, scale);
      posts.setMatrixAt(postInstance, matrix);
      postInstance += 1;
    }
  }
  posts.instanceMatrix.needsUpdate = true;
  group.add(posts);
  return group;
}

function buildScenery(
  route: RoadSample[],
  grid: RoadGrid,
  seed: number,
) {
  const group = new THREE.Group();
  const obstacleGrid: ObstacleGrid = new Map();
  const random = mulberry32(seed ^ 0x8b51f2d3);
  const treeSamples = Math.floor(route.length / 8);
  const treeGeometry = new THREE.ConeGeometry(1.7, 6.8, 7);
  const treeMaterial = new THREE.MeshStandardMaterial({
    color: 0x315c3b,
    roughness: 1,
  });
  const trees = new THREE.InstancedMesh(
    treeGeometry,
    treeMaterial,
    treeSamples,
  );
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const position = new THREE.Vector3();
  const sceneryQuery: RoadQuery = {
    index: 0,
    t: 0,
    distance: 0,
    x: 0,
    y: 0,
    z: 0,
    heading: 0,
  };
  const sceneryHeight = (x: number, z: number) =>
    sampleTerrainLattice(route, grid, x, z, sceneryQuery);
  const addCollider = (x: number, z: number, radius: number) => {
    const collider = { x, z, radius };
    const key = gridKey(x, z);
    const bucket = obstacleGrid.get(key);
    if (bucket) bucket.push(collider);
    else obstacleGrid.set(key, [collider]);
  };
  const upAxis = new THREE.Vector3(0, 1, 0);

  for (let instance = 0; instance < treeSamples; instance += 1) {
    const sample = route[Math.min(route.length - 1, instance * 8 + 3)];
    const side = instance % 2 === 0 ? -1 : 1;
    const offset = 28 + random() * 138;
    const rightX = Math.cos(sample.heading);
    const rightZ = Math.sin(sample.heading);
    const x = sample.x + rightX * side * offset;
    const z = sample.z + rightZ * side * offset;
    const y = sceneryHeight(x, z);
    const size = 0.6 + random() * 1.25;
    position.set(x, y + size * 2.4, z);
    quaternion.setFromAxisAngle(
      upAxis,
      random() * Math.PI * 2,
    );
    scale.set(size, size, size);
    matrix.compose(position, quaternion, scale);
    trees.setMatrixAt(instance, matrix);
    addCollider(x, z, 1.25 * size);
  }
  trees.instanceMatrix.needsUpdate = true;
  trees.castShadow = false;
  group.add(trees);

  const rockCount = Math.floor(route.length / 10);
  const rockGeometry = new THREE.DodecahedronGeometry(2.8, 0);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x6b5545,
    roughness: 1,
  });
  const rocks = new THREE.InstancedMesh(
    rockGeometry,
    rockMaterial,
    rockCount,
  );
  for (let instance = 0; instance < rockCount; instance += 1) {
    const sample = route[Math.min(route.length - 1, instance * 10 + 4)];
    const side = instance % 2 === 0 ? 1 : -1;
    const offset = 34 + random() * 205;
    const rightX = Math.cos(sample.heading);
    const rightZ = Math.sin(sample.heading);
    const x = sample.x + rightX * side * offset;
    const z = sample.z + rightZ * side * offset;
    const y = sceneryHeight(x, z);
    const size = 0.45 + random() * 1.45;
    position.set(x, y + size * 1.15, z);
    quaternion.setFromEuler(
      new THREE.Euler(random(), random() * Math.PI * 2, random()),
    );
    scale.set(size * 1.4, size, size * 1.1);
    matrix.compose(position, quaternion, scale);
    rocks.setMatrixAt(instance, matrix);
    addCollider(x, z, 2.35 * size);
  }
  rocks.instanceMatrix.needsUpdate = true;
  group.add(rocks);

  const cactusCount = Math.floor(route.length / 7);
  const cactusGeometry = new THREE.CylinderGeometry(0.42, 0.55, 3.8, 7);
  const cactusMaterial = new THREE.MeshStandardMaterial({
    color: 0x497143,
    roughness: 0.96,
  });
  const cacti = new THREE.InstancedMesh(
    cactusGeometry,
    cactusMaterial,
    cactusCount,
  );
  for (let instance = 0; instance < cactusCount; instance += 1) {
    const sample = route[Math.min(route.length - 1, instance * 7 + 2)];
    const side = instance % 2 === 0 ? -1 : 1;
    const offset = 20 + random() * 118;
    const rightX = Math.cos(sample.heading);
    const rightZ = Math.sin(sample.heading);
    const x = sample.x + rightX * side * offset;
    const z = sample.z + rightZ * side * offset;
    const y = sceneryHeight(x, z);
    const size = 0.62 + random() * 1.15;
    position.set(x, y + 1.9 * size, z);
    quaternion.setFromAxisAngle(upAxis, random() * Math.PI * 2);
    scale.set(size, size, size);
    matrix.compose(position, quaternion, scale);
    cacti.setMatrixAt(instance, matrix);
    addCollider(x, z, 0.58 * size);
  }
  cacti.instanceMatrix.needsUpdate = true;
  group.add(cacti);

  const scrubCount = Math.floor(route.length / 5);
  const scrubGeometry = new THREE.IcosahedronGeometry(0.72, 0);
  const scrubMaterial = new THREE.MeshStandardMaterial({
    color: 0x756b37,
    roughness: 1,
  });
  const scrub = new THREE.InstancedMesh(
    scrubGeometry,
    scrubMaterial,
    scrubCount,
  );
  for (let instance = 0; instance < scrubCount; instance += 1) {
    const sample = route[Math.min(route.length - 1, instance * 5 + 1)];
    const side = instance % 2 === 0 ? 1 : -1;
    const offset = 14 + random() * 132;
    const rightX = Math.cos(sample.heading);
    const rightZ = Math.sin(sample.heading);
    const x = sample.x + rightX * side * offset;
    const z = sample.z + rightZ * side * offset;
    const y = sceneryHeight(x, z);
    const size = 0.35 + random() * 1.05;
    position.set(x, y + 0.46 * size, z);
    quaternion.setFromEuler(
      new THREE.Euler(random() * 0.2, random() * Math.PI * 2, random() * 0.2),
    );
    scale.set(size * 1.55, size * 0.72, size * 1.15);
    matrix.compose(position, quaternion, scale);
    scrub.setMatrixAt(instance, matrix);
  }
  scrub.instanceMatrix.needsUpdate = true;
  group.add(scrub);

  return { group, obstacleGrid };
}

function createMotorcycle() {
  const bike = new THREE.Group();
  bike.rotation.order = "YXZ";
  const red = new THREE.MeshStandardMaterial({
    color: 0xff4d37,
    metalness: 0.46,
    roughness: 0.28,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: 0x11181c,
    metalness: 0.3,
    roughness: 0.5,
  });
  const silver = new THREE.MeshStandardMaterial({
    color: 0xb8c5c9,
    metalness: 0.8,
    roughness: 0.2,
  });
  const cyan = new THREE.MeshBasicMaterial({ color: 0x9ff6ff });

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.62, 2.25), red);
  body.position.set(0, 0.78, -0.05);
  body.rotation.x = -0.08;
  bike.add(body);

  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.56, 14, 9), red);
  tank.scale.set(0.86, 0.72, 1.25);
  tank.position.set(0, 1.05, -0.42);
  bike.add(tank);

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 1.05), dark);
  seat.position.set(0, 1.17, 0.67);
  bike.add(seat);

  const wheelGeometry = new THREE.TorusGeometry(0.46, 0.11, 8, 18);
  const frontWheel = new THREE.Mesh(wheelGeometry, dark);
  frontWheel.rotation.y = Math.PI / 2;
  frontWheel.position.set(0, 0.48, -1.28);
  bike.add(frontWheel);
  const rearWheel = frontWheel.clone();
  rearWheel.position.z = 1.25;
  bike.add(rearWheel);

  const fork = new THREE.Mesh(
    new THREE.CylinderGeometry(0.055, 0.055, 1.2, 8),
    silver,
  );
  fork.rotation.x = -0.25;
  fork.position.set(0, 0.93, -1.05);
  bike.add(fork);

  const handlebar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 1.28, 8),
    silver,
  );
  handlebar.rotation.z = Math.PI / 2;
  handlebar.position.set(0, 1.48, -0.92);
  bike.add(handlebar);

  const rider = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.33, 0.72, 5, 8),
    dark,
  );
  rider.position.set(0, 1.76, 0.1);
  rider.rotation.x = -0.3;
  bike.add(rider);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.35, 14, 10), red);
  helmet.position.set(0, 2.3, -0.22);
  bike.add(helmet);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.16, 0.08), cyan);
  visor.position.set(0, 2.32, -0.53);
  visor.rotation.x = -0.13;
  bike.add(visor);

  bike.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return { bike, wheels: [frontWheel, rearWheel] };
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      for (let index = 0; index < mesh.material.length; index += 1) {
        mesh.material[index].dispose();
      }
    } else {
      mesh.material?.dispose();
    }
  });
}

export default function MotoGameV2() {
  const mountRef = useRef<HTMLDivElement>(null);
  const speedReadoutRef = useRef<HTMLOutputElement>(null);
  const [graphicsUnavailable, setGraphicsUnavailable] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const seed = (Date.now() ^ 0x51a73c9d) >>> 0;
    const route = generateRoute(seed);
    const roadGrid = buildRoadGrid(route);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xa9d8e7);
    scene.fog = new THREE.FogExp2(0xa9d8e7, 0.00185);

    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2100);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      const fallbackTimer = window.setTimeout(
        () => setGraphicsUnavailable(true),
        0,
      );
      return () => window.clearTimeout(fallbackTimer);
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.35));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.04;
    mount.appendChild(renderer.domElement);

    const hemisphere = new THREE.HemisphereLight(0xd8f7ff, 0x6a3f26, 2.45);
    scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xfff0d0, 3.8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -85;
    sun.shadow.camera.right = 85;
    sun.shadow.camera.top = 85;
    sun.shadow.camera.bottom = -85;
    scene.add(sun, sun.target);

    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(11, 16, 10),
      new THREE.MeshBasicMaterial({ color: 0xffe3a1 }),
    );
    scene.add(sunDisc);

    const spawn = route[7];
    const initialTerrainCenterX =
      Math.round(spawn.x / TERRAIN_SHIFT) * TERRAIN_SHIFT;
    const initialTerrainCenterZ =
      Math.round(spawn.z / TERRAIN_SHIFT) * TERRAIN_SHIFT;
    const roadGroup = buildRoad(route);
    const scenery = buildScenery(route, roadGrid, seed);
    scene.add(roadGroup, scenery.group);

    const terrain = createTerrain(
      route,
      roadGrid,
      initialTerrainCenterX,
      initialTerrainCenterZ,
    );
    scene.add(terrain.mesh);

    const { bike, wheels } = createMotorcycle();
    scene.add(bike);

    // A tight contact shadow removes the visual ambiguity created by the
    // directional sun shadow, especially on pale sand and sloped terrain.
    const contactShadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x160f0b,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
    });
    const contactShadow = new THREE.Mesh(
      new THREE.CircleGeometry(1, 24),
      contactShadowMaterial,
    );
    contactShadow.renderOrder = 4;
    scene.add(contactShadow);
    const shadowFlatQuaternion = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      -Math.PI / 2,
    );
    const shadowSurfaceQuaternion = new THREE.Quaternion();
    const shadowSurfaceEuler = new THREE.Euler(0, 0, 0, "YXZ");

    const smokeCount = 38;
    const smokePositions = new Float32Array(smokeCount * 3);
    const smokeGeometry = new THREE.BufferGeometry();
    smokeGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(smokePositions, 3),
    );
    const smokeMaterial = new THREE.PointsMaterial({
      color: 0xe4ecec,
      size: 0.48,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const smoke = new THREE.Points(smokeGeometry, smokeMaterial);
    scene.add(smoke);

    const runtimeRoadQuery: RoadQuery = {
      index: 0,
      t: 0,
      distance: 0,
      x: 0,
      y: 0,
      z: 0,
      heading: 0,
    };
    const aheadRoadQuery: RoadQuery = { ...runtimeRoadQuery };
    const behindRoadQuery: RoadQuery = { ...runtimeRoadQuery };
    const farAheadRoadQuery: RoadQuery = { ...runtimeRoadQuery };
    const resetRoadQuery: RoadQuery = { ...runtimeRoadQuery };
    const sampleWorldSurface = (
      worldX: number,
      worldZ: number,
      roadQuery: RoadQuery,
    ) => {
      const terrainHeight = terrain.sampleHeight(worldX, worldZ);
      if (!queryRoad(route, roadGrid, worldX, worldZ, roadQuery)) {
        return terrainHeight;
      }
      if (roadQuery.distance <= ROAD_WIDTH / 2) {
        return roadQuery.y + ROAD_SURFACE_OFFSET;
      }
      if (roadQuery.distance <= ROAD_WIDTH / 2 + 1.15) {
        return roadQuery.y + 0.08;
      }
      return terrainHeight;
    };
    const initialGround = sampleWorldSurface(
      spawn.x,
      spawn.z,
      runtimeRoadQuery,
    );

    const state = {
      running: true,
      paused: false,
      x: spawn.x,
      y: initialGround + BIKE_CLEARANCE,
      z: spawn.z,
      heading: spawn.heading,
      travelHeading: spawn.heading,
      yawRate: 0,
      speed: 0,
      verticalSpeed: 0,
      airborne: false,
      airTime: 0,
      flipReady: false,
      designatedJump: false,
      launchPitch: 0,
      flipAngle: 0,
      distance: 0,
      onRoad: true,
      drifting: false,
      groundHeight: initialGround,
      groundSlope: 0,
      previousRoadSlope: 0,
      terrainCenterX: initialTerrainCenterX,
      terrainCenterZ: initialTerrainCenterZ,
    };

    const keys = new Set<string>();
    const climbRateWindow = createClimbRateWindow(2, FIXED_STEP);
    const audio = createGameAudio();
    const reset = () => {
      queryRoad(
        route,
        roadGrid,
        state.x,
        state.z,
        resetRoadQuery,
        true,
      );
      state.x = resetRoadQuery.x;
      state.z = resetRoadQuery.z;
      state.heading = resetRoadQuery.heading;
      state.travelHeading = resetRoadQuery.heading;
      state.yawRate = 0;
      state.speed = 0;
      state.verticalSpeed = 0;
      state.airborne = false;
      state.airTime = 0;
      state.flipReady = false;
      state.designatedJump = false;
      state.launchPitch = 0;
      state.flipAngle = 0;
      state.drifting = false;
      state.onRoad = true;
      state.groundHeight = resetRoadQuery.y + ROAD_SURFACE_OFFSET;
      state.y = state.groundHeight + BIKE_CLEARANCE;
      state.groundSlope = 0;
      state.previousRoadSlope = 0;
      state.paused = false;
      climbRateWindow.reset();
      if (speedReadoutRef.current) speedReadoutRef.current.value = "0";
      state.terrainCenterX =
        Math.round(state.x / TERRAIN_SHIFT) * TERRAIN_SHIFT;
      state.terrainCenterZ =
        Math.round(state.z / TERRAIN_SHIFT) * TERRAIN_SHIFT;
      terrain.update(state.terrainCenterX, state.terrainCenterZ);
      camera.position.set(
        state.x - Math.sin(state.heading) * 11,
        state.y + 5,
        state.z + Math.cos(state.heading) * 11,
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (GAME_KEYS.has(key)) {
        event.preventDefault();
        audio.ensureStarted();
      }
      if (key === "r" && !event.repeat) reset();
      if (key === "p" && !event.repeat && state.running) {
        state.paused = !state.paused;
      }
      keys.add(key);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      keys.delete(event.key.toLowerCase());
    };
    const onBlur = () => keys.clear();
    window.addEventListener("keydown", onKeyDown, { passive: false });
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);

    const resize = () => {
      const width = mount.clientWidth;
      const height = mount.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(height, 1);
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);
    resize();

    const probeDistance = 4;
    const stepPhysics = (dt: number) => {
      if (!state.running || state.paused) return;

      const steer = state.airborne ? 0 : steeringInput(keys);
      const throttle = throttleInput(keys);
      const driveFactor = state.airborne ? 0 : state.onRoad ? 1 : 0.9;
      const rolling = state.airborne
        ? 0
        : ROLLING_RESISTANCE * (state.onRoad ? 1 : 1.05);
      const aerodynamic =
        AERO_DRAG *
        state.speed *
        state.speed *
        (state.onRoad ? 1 : 1.08);
      const gradeResistance = state.airborne
        ? 0
        : 9.81 * Math.sin(Math.atan(state.groundSlope));
      const acceleration =
        ENGINE_FORCE * throttle * driveFactor -
        rolling -
        aerodynamic -
        gradeResistance;
      state.speed += acceleration * dt;
      state.speed = clamp(state.speed, 0, MAX_SPEED);

      state.drifting =
        keys.has(" ") &&
        Math.abs(steer) > 0.05 &&
        state.speed > 12 &&
        !state.airborne;

      if (state.airborne) {
        // With no tyre contact there is no steering torque: preserve both the
        // launch heading and the existing travel direction until touchdown.
        state.yawRate = 0;
      } else {
        const speedSteerFactor = smoothstep(state.speed / 5);
        const desiredYawRate =
          steer *
          (0.12 + state.speed * 0.014) *
          speedSteerFactor *
          (state.drifting ? 1.18 : 1);
        const yawResponse = Math.abs(steer) > 0.01 ? 9 : 16;
        state.yawRate +=
          (desiredYawRate - state.yawRate) *
          (1 - Math.exp(-yawResponse * dt));
        state.heading = wrapAngle(state.heading + state.yawRate * dt);

        const groundSlip = angleDifference(
          state.heading,
          state.travelHeading,
        );
        const gripRate = state.drifting ? 0.72 : state.onRoad ? 3.45 : 1.35;
        state.travelHeading = wrapAngle(
          state.travelHeading +
            clamp(groundSlip, -gripRate * dt, gripRate * dt),
        );
      }

      const forwardX = Math.sin(state.travelHeading);
      const forwardZ = -Math.cos(state.travelHeading);
      state.x += forwardX * state.speed * dt;
      state.z += forwardZ * state.speed * dt;
      state.distance += state.speed * dt;

      const centerCellX = Math.floor(state.x / ROAD_GRID_SIZE);
      const centerCellZ = Math.floor(state.z / ROAD_GRID_SIZE);
      let collided = false;
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        for (let offsetZ = -1; offsetZ <= 1; offsetZ += 1) {
          const key =
            (centerCellX + offsetX + GRID_OFFSET) * 100000 +
            (centerCellZ + offsetZ + GRID_OFFSET);
          const bucket = scenery.obstacleGrid.get(key);
          if (!bucket) continue;
          for (let index = 0; index < bucket.length; index += 1) {
            const obstacle = bucket[index];
            let deltaX = state.x - obstacle.x;
            let deltaZ = state.z - obstacle.z;
            const minimumDistance =
              BIKE_COLLISION_RADIUS + obstacle.radius;
            const distanceSquared = deltaX * deltaX + deltaZ * deltaZ;
            if (distanceSquared >= minimumDistance * minimumDistance) continue;
            let distance = Math.sqrt(distanceSquared);
            if (distance < 0.001) {
              deltaX = Math.cos(state.heading);
              deltaZ = Math.sin(state.heading);
              distance = 1;
            }
            const push = minimumDistance - distance;
            state.x += (deltaX / distance) * push;
            state.z += (deltaZ / distance) * push;
            collided = true;
          }
        }
      }
      if (collided) {
        state.speed = Math.min(state.speed * 0.32, 7);
        state.yawRate *= 0.3;
      }

      const newGround = sampleWorldSurface(
        state.x,
        state.z,
        runtimeRoadQuery,
      );
      state.onRoad = runtimeRoadQuery.distance <= ROAD_WIDTH / 2;

      const aheadGround = sampleWorldSurface(
        state.x + forwardX * probeDistance,
        state.z + forwardZ * probeDistance,
        aheadRoadQuery,
      );
      const behindGround = sampleWorldSurface(
        state.x - forwardX * probeDistance,
        state.z - forwardZ * probeDistance,
        behindRoadQuery,
      );
      const farAheadGround = sampleWorldSurface(
        state.x + forwardX * LAUNCH_LOOKAHEAD,
        state.z + forwardZ * LAUNCH_LOOKAHEAD,
        farAheadRoadQuery,
      );
      const sampledSlope =
        (aheadGround - behindGround) / (probeDistance * 2);
      const verticalCurvature =
        (aheadGround - 2 * newGround + behindGround) /
        (probeDistance * probeDistance);
      const downwardGroundDemand =
        -verticalCurvature * state.speed * state.speed;
      const upcomingDrop =
        newGround + sampledSlope * LAUNCH_LOOKAHEAD - farAheadGround;
      const averageClimbRate = climbRateWindow.push(
        !state.airborne && state.onRoad
          ? Math.max(0, sampledSlope * state.speed)
          : 0,
      );
      const isDesignatedRoad =
        state.onRoad && route[runtimeRoadQuery.index]?.jumpZone === true;

      if (state.airborne) {
        state.airTime += dt;
        state.y += state.verticalSpeed * dt;
        state.verticalSpeed -= GRAVITY * dt;
        const flightClearance =
          state.y - newGround - BIKE_CLEARANCE;

        if (
          !state.flipReady &&
          shouldArmBackflip({
            designatedJump: state.designatedJump,
            airTime: state.airTime,
            flightClearance,
            verticalSpeed: state.verticalSpeed,
          })
        ) {
          state.flipReady = true;
        }
        if (state.flipReady) {
          // Keep rotating for as long as the airborne throttle/flip input is
          // held. Touchdown is the only event that resets the accumulated turn.
          const nextFlipAngle = state.designatedJump
            ? nextDramaticBackflipAngle(state.flipAngle, throttle, dt)
            : state.flipAngle + MAX_BACKFLIP_RATE * throttle * dt;
          const groundPitch = Math.atan(sampledSlope);

          // Never advance the rotation into the terrain. The backflip may
          // briefly wait for more altitude near takeoff or touchdown, but no
          // visible part of the motorcycle can tunnel below the surface.
          if (
            canAdvanceBackflip({
              heightAboveGround: state.y - newGround,
              launchPitch: state.launchPitch,
              flipAngle: nextFlipAngle,
              groundPitch,
            })
          ) {
            state.flipAngle = nextFlipAngle;
          }
        }

        const groundPitch = Math.atan(sampledSlope);
        const poseClearance = motorcyclePoseClearance(
          state.launchPitch + state.flipAngle - groundPitch,
        );
        if (
          state.airTime > 0.08 &&
          state.verticalSpeed <= 0.25 &&
          state.y <= newGround + poseClearance
        ) {
          audio.playLanding(Math.max(0, -state.verticalSpeed));
          state.y = newGround + BIKE_CLEARANCE;
          state.airborne = false;
          state.airTime = 0;
          state.flipReady = false;
          state.designatedJump = false;
          state.launchPitch = 0;
          const alignment = Math.abs(wrapAngle(state.flipAngle));
          if (
            Math.abs(state.flipAngle) > 0.65 &&
            !(
              Math.abs(state.flipAngle) > Math.PI * 1.65 &&
              alignment < 0.9
            )
          ) {
            state.speed *= 0.58;
          }
          state.flipAngle = 0;
        }
      } else {
        const dramaticLaunch = shouldTriggerDramaticLaunch({
          isDesignatedRoad,
          speed: state.speed,
          maxSpeed: MAX_SPEED,
          previousSlope: state.previousRoadSlope,
          currentSlope: sampledSlope,
          verticalCurvature,
          averageClimbRate,
        });
        const terrainLaunch =
          state.speed > 35 &&
          !state.onRoad &&
          state.groundSlope > 0.018 &&
          sampledSlope <= MAX_TERRAIN_TAKEOFF_SLOPE &&
          sampledSlope >= MIN_TERRAIN_TAKEOFF_SLOPE &&
          downwardGroundDemand > GRAVITY * 1.08 &&
          upcomingDrop > 0.75;

        if (dramaticLaunch || terrainLaunch) {
          state.airborne = true;
          state.airTime = 0;
          state.flipReady = false;
          state.designatedJump = dramaticLaunch;
          state.launchPitch = dramaticLaunch
            ? DRAMATIC_LAUNCH_ANGLE
            : Math.atan(sampledSlope);
          state.yawRate = 0;
          state.verticalSpeed = dramaticLaunch
            ? dramaticLaunchVerticalSpeed(state.speed)
            : Math.max(
                0.65,
                sampledSlope * state.speed + JUMP_LIFT_BONUS,
              );
          climbRateWindow.reset();
          if (dramaticLaunch) audio.playAirWhoosh();
        } else {
          state.y = newGround + BIKE_CLEARANCE;
          state.verticalSpeed = (newGround - state.groundHeight) / dt;
        }
      }

      state.groundHeight = newGround;
      state.groundSlope +=
        (sampledSlope - state.groundSlope) * (1 - Math.exp(-7 * dt));
      state.previousRoadSlope = sampledSlope;
    };

    const clock = new THREE.Clock();
    const cameraTarget = new THREE.Vector3();
    const cameraLook = new THREE.Vector3();
    let accumulator = 0;
    let animationFrame = 0;
    let lastSpeedReadout = 0;

    const updateSmoke = (frameTime: number) => {
      const active = state.drifting && !state.airborne;
      smokeMaterial.opacity = THREE.MathUtils.lerp(
        smokeMaterial.opacity,
        active ? 0.46 : 0,
        0.11,
      );
      const forwardX = Math.sin(state.travelHeading);
      const forwardZ = -Math.cos(state.travelHeading);
      const rightX = Math.cos(state.travelHeading);
      const rightZ = Math.sin(state.travelHeading);
      const slipSign = Math.sign(
        angleDifference(state.heading, state.travelHeading),
      );
      for (let index = 0; index < smokeCount; index += 1) {
        const positionIndex = index * 3;
        const trail = pseudoRandom(index * 4.7 + frameTime * 0.012) * 8;
        const spread = (pseudoRandom(index * 8.1 + 3.4) - 0.5) * 3.4;
        smokePositions[positionIndex] =
          state.x - forwardX * trail + rightX * (spread - slipSign * 0.7);
        smokePositions[positionIndex + 1] =
          state.groundHeight + 0.12 + pseudoRandom(index * 2.9) * 0.46;
        smokePositions[positionIndex + 2] =
          state.z - forwardZ * trail + rightZ * (spread - slipSign * 0.7);
      }
      smokeGeometry.attributes.position.needsUpdate = true;
    };

    const animate = () => {
      animationFrame = requestAnimationFrame(animate);
      const frameDt = Math.min(clock.getDelta(), 0.05);
      accumulator = Math.min(accumulator + frameDt, FIXED_STEP * 7);
      let steps = 0;
      while (accumulator >= FIXED_STEP && steps < 7) {
        stepPhysics(FIXED_STEP);
        accumulator -= FIXED_STEP;
        steps += 1;
      }

      const steer = state.airborne ? 0 : steeringInput(keys);
      const slip = angleDifference(state.heading, state.travelHeading);
      const forwardX = Math.sin(state.heading);
      const forwardZ = -Math.cos(state.heading);
      const rightX = Math.cos(state.heading);
      const rightZ = Math.sin(state.heading);

      bike.position.set(state.x, state.y, state.z);
      const pitch = state.airborne
        ? state.launchPitch + state.flipAngle
        : Math.atan(state.groundSlope);
      const lean =
        -steer * (state.drifting ? 0.58 : 0.42) -
        clamp(slip, -0.55, 0.55) * 0.32;
      bike.rotation.set(pitch, -state.heading, lean);

      const heightAboveGround = Math.max(
        0,
        state.y - state.groundHeight - BIKE_CLEARANCE,
      );
      const shadowSpread = 1 + clamp(heightAboveGround / 14, 0, 0.5);
      contactShadow.position.set(
        state.x,
        state.groundHeight + 0.018,
        state.z,
      );
      contactShadow.scale.set(
        0.72 * shadowSpread,
        1.5 * shadowSpread,
        1,
      );
      shadowSurfaceEuler.set(
        state.airborne ? Math.atan(state.groundSlope) : pitch,
        -state.heading,
        0,
      );
      shadowSurfaceQuaternion.setFromEuler(shadowSurfaceEuler);
      contactShadow.quaternion
        .copy(shadowSurfaceQuaternion)
        .multiply(shadowFlatQuaternion);
      contactShadowMaterial.opacity = state.airborne
        ? clamp(0.18 - heightAboveGround * 0.012, 0.035, 0.18)
        : 0.3;
      for (let index = 0; index < wheels.length; index += 1) {
        wheels[index].rotation.x -= state.speed * frameDt * 2.2;
      }

      const now = performance.now();
      updateSmoke(now);
      audio.update({
        throttle: throttleInput(keys),
        speedRatio: state.speed / MAX_SPEED,
        steering: steer,
        slipAngle: slip,
        drifting: state.drifting,
        airborne: state.airborne,
        paused: state.paused,
      });
      if (now - lastSpeedReadout >= 90 && speedReadoutRef.current) {
        lastSpeedReadout = now;
        speedReadoutRef.current.value = String(Math.round(state.speed * 3.6));
      }

      const cameraSide = state.drifting ? -Math.sign(slip || steer) * 2.2 : 1.2;
      cameraTarget.set(
        state.x - forwardX * 11 + rightX * cameraSide,
        state.y + (state.airborne ? 6.2 : 5.1),
        state.z - forwardZ * 11 + rightZ * cameraSide,
      );
      camera.position.lerp(cameraTarget, 1 - Math.exp(-6.5 * frameDt));
      cameraLook.set(
        state.x + forwardX * 18,
        state.y + 1.15,
        state.z + forwardZ * 18,
      );
      camera.lookAt(cameraLook);
      const targetFov = 61 + (state.speed / MAX_SPEED) * 7 + (state.drifting ? 3 : 0);
      camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-5 * frameDt));
      camera.updateProjectionMatrix();

      sun.position.set(state.x - 45, state.y + 85, state.z + 35);
      sun.target.position.set(state.x, state.y, state.z);
      sunDisc.position.set(state.x - 120, state.y + 105, state.z - 420);

      if (
        Math.abs(state.x - state.terrainCenterX) > TERRAIN_SHIFT ||
        Math.abs(state.z - state.terrainCenterZ) > TERRAIN_SHIFT
      ) {
        state.terrainCenterX =
          Math.round(state.x / TERRAIN_SHIFT) * TERRAIN_SHIFT;
        state.terrainCenterZ =
          Math.round(state.z / TERRAIN_SHIFT) * TERRAIN_SHIFT;
        terrain.update(state.terrainCenterX, state.terrainCenterZ);
      }

      renderer.render(scene, camera);
    };

    camera.position.set(
      spawn.x - Math.sin(spawn.heading) * 11,
      state.y + 5,
      spawn.z + Math.cos(spawn.heading) * 11,
    );
    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      disposeObject(scene);
      audio.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <main className="game-shell">
      <div className="game-canvas" ref={mountRef} aria-label="3D motorcycle simulator" />
      <div
        className="speed-readout"
        aria-label="Current speed in kilometres per hour"
      >
        <output ref={speedReadoutRef}>0</output>
        <span aria-hidden="true">KM/H</span>
      </div>

      {graphicsUnavailable && (
        <section className="graphics-fallback" role="alert">
          <div>
            <p className="eyebrow">3D ENGINE CHECK</p>
            <h2>WEBGL IS OFF.</h2>
            <p>
              Open this simulator in current Chrome or Safari with hardware
              acceleration enabled. This browser has disabled its 3D context.
            </p>
          </div>
        </section>
      )}

      <div className="scanlines" aria-hidden="true" />
    </main>
  );
}
