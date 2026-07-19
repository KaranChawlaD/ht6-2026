"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

const ROAD_WIDTH = 14;
// The wheels (TorusGeometry, center at local y=0.48, outer radius 0.57) sit
// with their bottom at local y=-0.09, so this is what puts the wheel bottom
// exactly on the ground rather than floating the whole bike above it.
const BIKE_CLEARANCE = 0.1;
// ~200 km/h, raised so coasting through a sharp turn at top speed without
// drifting is no longer free — see GRIP_LATERAL_ACCEL below.
const MAX_SPEED = 55.6;

// Engine force is constant per throttle level; drag grows with the square of
// speed (real aerodynamic drag), so full throttle (B) climbs toward an
// equilibrium at exactly MAX_SPEED and a lighter throttle settles at its own,
// lower equilibrium once drag catches up to that smaller push — instead of
// every throttle level eventually reaching the same top speed.
const ENGINE_ACCEL = 18.5;
const DRAG_COEFF = ENGINE_ACCEL / (MAX_SPEED * MAX_SPEED);
const COAST_DECEL = 3.1;

// Mid-air, the throttle keys are repurposed as the only flip control (no
// spare sensor for a separate flip input on the hardware side) — backflip
// only, rate scaled by throttle magnitude. 5.5 rad/s matches the old full-
// deflection Q/E rate, so B flips exactly as fast as the previous control.
const FLIP_RATE = 5.5;

// Steering is analog, modeled on a 10-key rig for hardware sensor testing:
// each key reports a fixed deflection amount, mirrored outward from the
// keyboard center (G/H = lightest touch, A/; = full lock) so a steering
// sensor's angle can be bucketed onto the matching key.
const LEFT_STEER_KEYS: [string, number][] = [
  ["a", 1],
  ["s", 0.8],
  ["d", 0.6],
  ["f", 0.4],
  ["g", 0.2],
];
const RIGHT_STEER_KEYS: [string, number][] = [
  [";", 1],
  ["l", 0.8],
  ["k", 0.6],
  ["j", 0.4],
  ["h", 0.2],
];
const STEER_KEYS = [
  ...LEFT_STEER_KEYS.map(([key]) => key),
  ...RIGHT_STEER_KEYS.map(([key]) => key),
];

function computeSteer(keys: Set<string>) {
  let left = 0;
  for (const [key, magnitude] of LEFT_STEER_KEYS) {
    if (keys.has(key)) left = Math.max(left, magnitude);
  }
  let right = 0;
  for (const [key, magnitude] of RIGHT_STEER_KEYS) {
    if (keys.has(key)) right = Math.max(right, magnitude);
  }
  return right - left;
}

// Throttle is analog too, on the same 10-key-rig idea: five keys walking
// outward from the steering cluster, B reporting full throttle (what W used
// to do) down to Z at 20%. Paired with a quadratic drag term below, holding
// a fixed throttle converges on a genuine equilibrium speed rather than
// either "no effect" or "still hits max eventually" — see ENGINE_ACCEL.
const THROTTLE_KEYS: [string, number][] = [
  ["z", 0.2],
  ["x", 0.4],
  ["c", 0.6],
  ["v", 0.8],
  ["b", 1],
];
const THROTTLE_KEY_NAMES = THROTTLE_KEYS.map(([key]) => key);

function computeThrottle(keys: Set<string>) {
  let throttle = 0;
  for (const [key, magnitude] of THROTTLE_KEYS) {
    if (keys.has(key)) throttle = Math.max(throttle, magnitude);
  }
  return throttle;
}

// Grip is modeled as a max lateral acceleration; the max heading turn RATE it
// buys you is that budget divided by speed, so the same steering input carves
// a much wider radius the faster you're going (real bike/car cornering).
// Drifting trades grip for slip and unlocks a far higher turn rate, letting
// you carve a tight corner at speed that would otherwise run you off-road.
// Critically there is no self-centering: heading only changes while a
// steer key is held, and holds wherever you left it once released — a real
// bike doesn't snap itself back to pointing straight when you let go.
const GRIP_LATERAL_ACCEL = 5;
const DRIFT_LATERAL_ACCEL = 15;
const MIN_TURN_SPEED = 6;
const MAX_HEADING = 1.1;

// Off-road is just softer ground, not a wall — a gentle drag, never a clamp.
const GRASS_DRAG = 9;

// Minimum speed to actually launch off a scripted jump hill — below this you
// just drive up and over the ramp following its contour.
const JUMP_MIN_SPEED = 20;

// Upward launch impulse on takeoff. Tuned so the bike visibly rises above
// its launch height before gravity brings it back down — a real parabola,
// not just a coast off the crest that immediately sinks.
const FLIP_LAUNCH_BASE = 8;
const FLIP_LAUNCH_SPEED_FACTOR = 0.19;

// The road is a reference line, not a boundary: terrain is generated on both
// sides and rises into mountains further from the road, so drifting wide or
// deliberately riding off-road onto the shoulder always lands on real ground.
const TERRAIN_HALF_WIDTH = 260;
const TERRAIN_STEP = 8;
const TERRAIN_Y_OFFSET = 1.4;
const MOUNTAIN_RISE_START = 30;
const MOUNTAIN_RISE_RANGE = 110;

// A jump can only trigger inside the flat, gentle corridor right around the
// road (short of MOUNTAIN_RISE_START) — never out where the ground is
// jagged mountain terrain the launch/landing math wasn't designed for.
const JUMP_MAX_LATERAL = MOUNTAIN_RISE_START - 6;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function smoothstep(value: number) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

// Value noise: interpolate a smooth curve through the pseudoRandom hash at
// each integer, giving an aperiodic, organic wander with no fixed loop
// length — the "Winding" feel, instead of a scripted repeating track.
function valueNoise1D(x: number) {
  const i = Math.floor(x);
  const f = x - i;
  const a = pseudoRandom(i);
  const b = pseudoRandom(i + 1);
  return a + smoothstep(f) * (b - a);
}

function signedNoise(x: number) {
  return (valueNoise1D(x) - 0.5) * 2;
}

// Gentle ambient rolling — deliberately kept well short of jump-worthy on its
// own. Whether a jump is possible is decided entirely by hillEvent() below,
// not by how steep any local slope happens to look; ordinary noise ripples
// used to cross the same slope thresholds a real hill needed, which is what
// launched the bike over minor bumps and made it dig into the ground.
function roadHeightAmbient(distance: number) {
  return (
    signedNoise(distance * 0.006) * 9 +
    signedNoise(distance * 0.017 + 400) * 5 +
    signedNoise(distance * 0.05 + 900) * 1.8
  );
}

// Rise-hold-fall bump: 0 at the edges, flat at 1 through the middle.
function turnBump(t: number) {
  if (t <= 0 || t >= 1) return 0;
  if (t < 0.35) return smoothstep(t / 0.35);
  if (t < 0.65) return 1;
  return smoothstep((1 - t) / 0.35);
}

// Occasional sharp corners, dropped into ~40% of fixed-length cells along
// the route at a randomized position and direction. The gentle noise wander
// below has nowhere near this curvature on its own (a hairpin needs far more
// turn-per-distance than lazily drifting side to side) — this is what gives
// "mostly easy winding, with real hairpins now and then" instead of both, or
// neither, everywhere.
const SHARP_TURN_CELL = 260;
const SHARP_TURN_LENGTH = 55;
const SHARP_TURN_AMPLITUDE = 42;
const SHARP_TURN_CHANCE = 0.4;

function sharpTurnOffset(distance: number) {
  const cell = Math.floor(distance / SHARP_TURN_CELL);
  const cellStart = cell * SHARP_TURN_CELL;
  if (pseudoRandom(cell * 13 + 7) > SHARP_TURN_CHANCE) return 0;
  const center =
    cellStart + SHARP_TURN_CELL * (0.3 + pseudoRandom(cell * 13 + 11) * 0.4);
  const t = (distance - (center - SHARP_TURN_LENGTH / 2)) / SHARP_TURN_LENGTH;
  const dir = pseudoRandom(cell * 13 + 17) > 0.5 ? 1 : -1;
  return dir * SHARP_TURN_AMPLITUDE * turnBump(t);
}

// Explicit, scripted jump hills — the only thing that can put the bike in
// the air. Each 480-unit cell has a 45% chance of containing one: a ramp up,
// a short flat crest, then a real drop, entirely contained within the cell
// with margin to spare either side. Landing/launch physics reads this shape
// directly rather than inferring "is this a hill" from local slope, which is
// unreliable on noisy terrain and was the source of both false triggers on
// tiny bumps and never firing on some real hills.
const HILL_CELL = 480;
const HILL_CHANCE = 0.45;
const HILL_RAMP = 85;
const HILL_CREST = 18;
const HILL_DROP = 115;
const HILL_HEIGHT = 24;
// Landing runway is much longer than the approach runway on purpose: most of
// a jump's flight distance comes from the hill's own 24-unit drop falling
// away beneath the bike (measured empirically — even a zero-impulse coast
// off the crest covers ~85 units before the ground catches back up), not
// just from the launch impulse. A symmetric margin here badly undersized
// the landing side and let jumps land past the guaranteed-straight zone.
const HILL_APPROACH_MARGIN = 45;
const HILL_LANDING_MARGIN = 145;
const HILL_LATERAL_BLEND = 35;

type HillEvent = {
  cell: number;
  rampStart: number;
  crestStart: number;
  dropStart: number;
  dropEnd: number;
  straightFrom: number;
  straightTo: number;
};

function hillEvent(distance: number): HillEvent | null {
  const cell = Math.floor(distance / HILL_CELL);
  if (pseudoRandom(cell * 29 + 3) > HILL_CHANCE) return null;
  const cellStart = cell * HILL_CELL;
  const totalLength = HILL_RAMP + HILL_CREST + HILL_DROP;
  const maxOffset = Math.max(
    0,
    HILL_CELL - totalLength - HILL_APPROACH_MARGIN - HILL_LANDING_MARGIN,
  );
  const rampStart =
    cellStart + HILL_APPROACH_MARGIN + maxOffset * pseudoRandom(cell * 29 + 9);
  const crestStart = rampStart + HILL_RAMP;
  const dropStart = crestStart + HILL_CREST;
  const dropEnd = dropStart + HILL_DROP;
  return {
    cell,
    rampStart,
    crestStart,
    dropStart,
    dropEnd,
    straightFrom: rampStart - HILL_APPROACH_MARGIN,
    straightTo: dropEnd + HILL_LANDING_MARGIN,
  };
}

function hillProfile(distance: number, hill: HillEvent | null) {
  if (!hill || distance < hill.rampStart || distance > hill.dropEnd) return 0;
  if (distance < hill.crestStart) {
    return smoothstep((distance - hill.rampStart) / HILL_RAMP) * HILL_HEIGHT;
  }
  if (distance < hill.dropStart) return HILL_HEIGHT;
  return HILL_HEIGHT * (1 - smoothstep((distance - hill.dropStart) / HILL_DROP));
}

function roadHeight(distance: number) {
  return roadHeightAmbient(distance) + hillProfile(distance, hillEvent(distance));
}

function roadLateralBase(distance: number) {
  return (
    signedNoise(distance * 0.0035) * 18 +
    signedNoise(distance * 0.011 + 500) * 8 +
    sharpTurnOffset(distance)
  );
}

// Inside a hill's ramp/crest/drop (plus margin), the road is held straight —
// frozen at the offset it had on entry, faded in/out so there's no kink —
// so a bike launched off the top always has a straight strip to land back
// on, whatever the ambient wander or a sharp-turn roll would otherwise have
// put there.
function roadLateralX(distance: number) {
  const hill = hillEvent(distance);
  if (!hill || distance < hill.straightFrom || distance > hill.straightTo) {
    return roadLateralBase(distance);
  }
  const frozen = roadLateralBase(hill.straightFrom);
  const fadeIn = smoothstep((distance - hill.straightFrom) / HILL_LATERAL_BLEND);
  const fadeOut = smoothstep((hill.straightTo - distance) / HILL_LATERAL_BLEND);
  const blend = Math.min(fadeIn, fadeOut);
  return roadLateralBase(distance) * (1 - blend) + frozen * blend;
}

function roadCenter(distance: number, target = new THREE.Vector3()) {
  return target.set(roadLateralX(distance), roadHeight(distance), -distance);
}

function roadFrame(distance: number) {
  const center = roadCenter(distance);
  const before = roadCenter(distance - 1.2);
  const after = roadCenter(distance + 1.2);
  const tangent = after.sub(before).normalize();
  const right = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
  return { center, tangent, right };
}

// Mountains: a second noise field, blended in only once you're well clear of
// the pavement, so the terrain matches the road's own elevation right at its
// edge and rises into peaks further out — the road reads as a pass cut
// through the high ground rather than a ramp floating over flat land. Kept
// low-frequency/low-slope on purpose: the rendered mesh only samples this at
// TERRAIN_STEP intervals, and a steep per-unit slope here would let the
// faceted mesh drift away from the exact curve the physics drives the bike
// against, reading as the bike floating or clipping into the hillside.
function mountainNoise(x: number, z: number) {
  return (
    signedNoise(x * 0.01 + z * 0.008) * 42 +
    signedNoise(x * 0.028 - z * 0.023 + 77) * 10
  );
}

// The rise contribution only (0 near the road, growing with distance out),
// kept separate from the absolute height. Coloring off absolute height was a
// bug: roadHeight's own wandering baseline (part of ordinary hilly terrain,
// unrelated to altitude) routinely crossed a "high ground" threshold, so
// patches of perfectly flat grass right next to the road kept flashing to
// rock/snow tint for no reason a driver could see.
function terrainSample(x: number, z: number) {
  const distance = -z;
  const away = Math.abs(x - roadLateralX(distance));
  const rise = smoothstep((away - MOUNTAIN_RISE_START) / MOUNTAIN_RISE_RANGE);
  const mountainAmount = rise * mountainNoise(x, z);
  return { height: roadHeight(distance) + mountainAmount, mountainAmount };
}

function groundHeight(x: number, z: number) {
  return terrainSample(x, z).height;
}

function patchNoise(x: number, z: number) {
  return valueNoise1D(x * 0.012 + z * 0.009 + 3000);
}

const GRASS_COLOR = new THREE.Color(0x4c7a45);
const SAND_COLOR = new THREE.Color(0xcbb686);
const ROCK_COLOR = new THREE.Color(0x847a67);
const SNOW_COLOR = new THREE.Color(0xf2f5f7);

// Grass blends toward loose sand patches (desert scrub, broken up rather
// than one flat color) before rising through rock into snow at altitude.
function terrainColorAt(mountainAmount: number, patch: number, target: THREE.Color) {
  target.copy(GRASS_COLOR).lerp(SAND_COLOR, patch * 0.45);
  if (mountainAmount > 2) {
    target.lerp(ROCK_COLOR, smoothstep((mountainAmount - 2) / 18));
  }
  if (mountainAmount > 20) {
    target.lerp(SNOW_COLOR, smoothstep((mountainAmount - 20) / 20));
  }
  return target;
}

function makeStripGeometry(
  from: number,
  to: number,
  halfWidth: number,
  yOffset: number,
  step = 6,
) {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const count = Math.ceil((to - from) / step);

  for (let i = 0; i <= count; i += 1) {
    const distance = from + ((to - from) * i) / count;
    const { center, right } = roadFrame(distance);
    const leftPoint = center.clone().addScaledVector(right, -halfWidth);
    const rightPoint = center.clone().addScaledVector(right, halfWidth);
    leftPoint.y += yOffset;
    rightPoint.y += yOffset;
    positions.push(...leftPoint.toArray(), ...rightPoint.toArray());

    const stripe = i % 2 === 0 ? 0.95 : 0.82;
    colors.push(stripe, stripe, stripe, stripe, stripe, stripe);

    if (i < count) {
      const base = i * 2;
      indices.push(base, base + 2, base + 1, base + 2, base + 3, base + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function pseudoRandom(index: number) {
  const value = Math.sin(index * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material) => material.dispose());
    } else {
      mesh.material?.dispose();
    }
  });
}

function buildRoadSection(from: number, to: number) {
  const group = new THREE.Group();

  const shoulder = new THREE.Mesh(
    makeStripGeometry(from, to, ROAD_WIDTH / 2 + 1.2, -0.12),
    new THREE.MeshStandardMaterial({
      color: 0xd34b36,
      roughness: 0.92,
      side: THREE.DoubleSide,
    }),
  );
  shoulder.receiveShadow = true;
  group.add(shoulder);

  const road = new THREE.Mesh(
    makeStripGeometry(from, to, ROAD_WIDTH / 2, 0),
    new THREE.MeshStandardMaterial({
      color: 0x252c31,
      roughness: 0.78,
      metalness: 0.08,
      vertexColors: true,
      side: THREE.DoubleSide,
    }),
  );
  road.receiveShadow = true;
  group.add(road);

  const markerGeometry = new THREE.BoxGeometry(0.17, 0.045, 5.5);
  const markerMaterial = new THREE.MeshBasicMaterial({ color: 0xfff3bb });
  const markerCount = Math.max(1, Math.floor((to - from) / 17));
  const markers = new THREE.InstancedMesh(
    markerGeometry,
    markerMaterial,
    markerCount,
  );
  const forward = new THREE.Vector3(0, 0, -1);
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);

  for (let i = 0; i < markerCount; i += 1) {
    const distance = from + i * 17 + 8;
    const { center, tangent } = roadFrame(distance);
    center.y += 0.07;
    quaternion.setFromUnitVectors(forward, tangent);
    matrix.compose(center, quaternion, scale);
    markers.setMatrixAt(i, matrix);
  }
  markers.instanceMatrix.needsUpdate = true;
  group.add(markers);

  const edgeGeometry = new THREE.BufferGeometry();
  const edgePositions: number[] = [];
  for (let distance = from; distance <= to; distance += 6) {
    const { center, right } = roadFrame(distance);
    const left = center.clone().addScaledVector(right, -ROAD_WIDTH / 2 + 0.22);
    const rightEdge = center
      .clone()
      .addScaledVector(right, ROAD_WIDTH / 2 - 0.22);
    left.y += 0.08;
    rightEdge.y += 0.08;
    edgePositions.push(...left.toArray(), ...rightEdge.toArray());
  }
  edgeGeometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(edgePositions, 3),
  );
  const edges = new THREE.Points(
    edgeGeometry,
    new THREE.PointsMaterial({ color: 0xffffff, size: 0.13 }),
  );
  group.add(edges);

  const treeCount = Math.max(30, Math.floor((to - from) / 10));
  const treeGeometry = new THREE.ConeGeometry(1.8, 6, 7);
  const treeMaterial = new THREE.MeshStandardMaterial({
    color: 0x315e47,
    roughness: 1,
  });
  const trees = new THREE.InstancedMesh(treeGeometry, treeMaterial, treeCount);
  trees.castShadow = true;

  for (let i = 0; i < treeCount; i += 1) {
    const distance = from + pseudoRandom(i + Math.floor(from)) * (to - from);
    const { center, right } = roadFrame(distance);
    const side = i % 2 === 0 ? -1 : 1;
    const offset = ROAD_WIDTH / 2 + 7 + pseudoRandom(i * 5 + 9) * 30;
    const position = center.addScaledVector(right, side * offset);
    position.y = groundHeight(position.x, position.z) - TERRAIN_Y_OFFSET;
    const treeScale = 0.65 + pseudoRandom(i * 11 + 2) * 1.35;
    scale.set(treeScale, treeScale, treeScale);
    quaternion.identity();
    matrix.compose(position, quaternion, scale);
    trees.setMatrixAt(i, matrix);
  }
  trees.instanceMatrix.needsUpdate = true;
  group.add(trees);

  // Scattered desert boulders — decoration to break up the ground color,
  // spread wider than the trees so they read across the shoulder and out
  // toward the foothills.
  const rockCount = Math.max(40, Math.floor((to - from) / 7));
  const rockGeometry = new THREE.DodecahedronGeometry(1, 0);
  const rockMaterial = new THREE.MeshStandardMaterial({
    color: 0x8c8172,
    roughness: 1,
    flatShading: true,
  });
  const rocks = new THREE.InstancedMesh(rockGeometry, rockMaterial, rockCount);
  rocks.castShadow = true;
  rocks.receiveShadow = true;

  for (let i = 0; i < rockCount; i += 1) {
    const distance = from + pseudoRandom(i * 3 + 41 + Math.floor(from)) * (to - from);
    const { center, right } = roadFrame(distance);
    const side = pseudoRandom(i * 13 + 5) > 0.5 ? 1 : -1;
    const offset = ROAD_WIDTH / 2 + 3 + pseudoRandom(i * 9 + 17) * 90;
    const position = center.addScaledVector(right, side * offset);
    position.y = groundHeight(position.x, position.z) - TERRAIN_Y_OFFSET * 0.5;
    const rockScale = 0.4 + pseudoRandom(i * 17 + 23) * 1.6;
    scale.set(
      rockScale * (0.7 + pseudoRandom(i * 4) * 0.6),
      rockScale * (0.5 + pseudoRandom(i * 6 + 1) * 0.5),
      rockScale * (0.7 + pseudoRandom(i * 8 + 2) * 0.6),
    );
    quaternion.setFromAxisAngle(forward, pseudoRandom(i * 19 + 3) * Math.PI * 2);
    matrix.compose(position, quaternion, scale);
    rocks.setMatrixAt(i, matrix);
  }
  rocks.instanceMatrix.needsUpdate = true;
  group.add(rocks);

  return group;
}

// Heightmapped ground either side of the road, standing in for the flat
// recentered plane the game used before — the terrain here is real geometry
// (it's what groundHeight() also drives the bike's own height off of), so
// riding off-road or over a mountain shoulder is actually drivable, not a
// texture painted under an invisible wall.
function buildTerrainSection(from: number, to: number) {
  const zCount = Math.max(1, Math.ceil((to - from) / TERRAIN_STEP));
  const xCount = Math.max(1, Math.ceil((2 * TERRAIN_HALF_WIDTH) / TERRAIN_STEP));
  const rowLength = xCount + 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const color = new THREE.Color();

  for (let zi = 0; zi <= zCount; zi += 1) {
    const distance = from + ((to - from) * zi) / zCount;
    const z = -distance;
    for (let xi = 0; xi <= xCount; xi += 1) {
      const x = -TERRAIN_HALF_WIDTH + (2 * TERRAIN_HALF_WIDTH * xi) / xCount;
      const { height, mountainAmount } = terrainSample(x, z);
      // A generous vertical gap (not the ~0.4 this used before) so the
      // terrain never z-fights with the road/shoulder strips at distance —
      // with a 2400-unit camera far plane the depth buffer has little
      // precision left out there, and a thin gap flickered through as the
      // road looking "covered" by the ground mesh.
      positions.push(x, height - TERRAIN_Y_OFFSET, z);
      terrainColorAt(mountainAmount, patchNoise(x, z), color);
      colors.push(color.r, color.g, color.b);
    }
  }

  for (let zi = 0; zi < zCount; zi += 1) {
    for (let xi = 0; xi < xCount; xi += 1) {
      const a = zi * rowLength + xi;
      const b = a + 1;
      const c = a + rowLength;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 1,
      side: THREE.DoubleSide,
    }),
  );
  mesh.receiveShadow = true;
  return mesh;
}

function createMotorcycle() {
  const bike = new THREE.Group();
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
  body.position.y = 0.78;
  body.position.z = -0.05;
  body.rotation.x = -0.08;
  bike.add(body);

  const tank = new THREE.Mesh(new THREE.SphereGeometry(0.56, 16, 10), red);
  tank.scale.set(0.86, 0.72, 1.25);
  tank.position.set(0, 1.05, -0.42);
  bike.add(tank);

  const seat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 1.05), dark);
  seat.position.set(0, 1.17, 0.67);
  bike.add(seat);

  const wheelGeometry = new THREE.TorusGeometry(0.46, 0.11, 10, 22);
  const frontWheel = new THREE.Mesh(wheelGeometry, dark);
  frontWheel.rotation.y = Math.PI / 2;
  frontWheel.position.set(0, 0.48, -1.28);
  bike.add(frontWheel);

  const rearWheel = frontWheel.clone();
  rearWheel.position.z = 1.25;
  bike.add(rearWheel);

  const fork = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.055, 1.2), silver);
  fork.rotation.x = -0.25;
  fork.position.set(0, 0.93, -1.05);
  bike.add(fork);

  const handlebar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.045, 0.045, 1.28),
    silver,
  );
  handlebar.rotation.z = Math.PI / 2;
  handlebar.position.set(0, 1.48, -0.92);
  bike.add(handlebar);

  const riderBody = new THREE.Mesh(new THREE.CapsuleGeometry(0.33, 0.72, 6, 10), dark);
  riderBody.position.set(0, 1.76, 0.1);
  riderBody.rotation.x = -0.3;
  bike.add(riderBody);

  const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), red);
  helmet.position.set(0, 2.3, -0.22);
  bike.add(helmet);

  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.16, 0.08), cyan);
  visor.position.set(0, 2.32, -0.53);
  visor.rotation.x = -0.13;
  bike.add(visor);

  const headlight = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), cyan);
  headlight.scale.set(1, 0.72, 0.45);
  headlight.position.set(0, 1.23, -1.24);
  bike.add(headlight);

  bike.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });

  return { bike, wheels: [frontWheel, rearWheel] };
}

export default function MotoGame() {
  const mountRef = useRef<HTMLDivElement>(null);
  const [graphicsUnavailable, setGraphicsUnavailable] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9fd8ec);
    scene.fog = new THREE.FogExp2(0x9fd8ec, 0.0024);

    const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2400);
    camera.position.set(7, 5.5, 12);

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        powerPreference: "high-performance",
      });
    } catch {
      setGraphicsUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    mount.appendChild(renderer.domElement);

    const hemisphere = new THREE.HemisphereLight(0xc9f4ff, 0x31513c, 2.4);
    scene.add(hemisphere);
    const sun = new THREE.DirectionalLight(0xfff2d4, 4.2);
    sun.position.set(-35, 70, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1536, 1536);
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    scene.add(sun);

    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(12, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe5a6 }),
    );
    sunDisc.position.set(-105, 92, -360);
    scene.add(sunDisc);

    let roadStart = -80;
    let roadGroup = buildRoadSection(roadStart, 1450);
    scene.add(roadGroup);
    let terrainMesh = buildTerrainSection(roadStart, 1450);
    scene.add(terrainMesh);

    const { bike, wheels } = createMotorcycle();
    scene.add(bike);

    const sparkCount = 90;
    const sparkPositions = new Float32Array(sparkCount * 3);
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute(
      "position",
      new THREE.BufferAttribute(sparkPositions, 3),
    );
    const sparks = new THREE.Points(
      sparkGeometry,
      new THREE.PointsMaterial({
        color: 0x68e9ff,
        size: 0.14,
        transparent: true,
        opacity: 0,
      }),
    );
    scene.add(sparks);

    const keys = new Set<string>();
    const state = {
      running: true,
      paused: false,
      distance: 0,
      speed: 0,
      worldX: roadLateralX(0),
      worldZ: 0,
      heading: 0,
      lateral: 0,
      bikeY: roadHeight(0) + BIKE_CLEARANCE,
      verticalSpeed: 0,
      airborne: false,
      airborneBlend: 0,
      flipAngle: 0,
      drifting: false,
      lastHillCell: NaN,
    };

    const rebuildWorld = () => {
      scene.remove(roadGroup);
      disposeObject(roadGroup);
      scene.remove(terrainMesh);
      disposeObject(terrainMesh);
      roadStart = -80;
      roadGroup = buildRoadSection(roadStart, 1450);
      terrainMesh = buildTerrainSection(roadStart, 1450);
      scene.add(roadGroup);
      scene.add(terrainMesh);
    };

    const reset = () => {
      state.distance = 0;
      state.speed = 0;
      state.worldX = roadLateralX(0);
      state.worldZ = 0;
      state.heading = 0;
      state.lateral = 0;
      state.bikeY = roadHeight(0) + BIKE_CLEARANCE;
      state.verticalSpeed = 0;
      state.airborne = false;
      state.airborneBlend = 0;
      state.flipAngle = 0;
      state.drifting = false;
      state.lastHillCell = NaN;
      state.paused = false;
      rebuildWorld();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (["r", "p", " ", ...STEER_KEYS, ...THROTTLE_KEY_NAMES].includes(key)) {
        event.preventDefault();
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

    const clock = new THREE.Clock();
    const bikePosition = new THREE.Vector3();
    const cameraTarget = new THREE.Vector3();
    const cameraLook = new THREE.Vector3();
    let animationFrame = 0;

    const updateSparks = (active: boolean, right: THREE.Vector3, tangent: THREE.Vector3) => {
      const material = sparks.material as THREE.PointsMaterial;
      material.opacity = THREE.MathUtils.lerp(material.opacity, active ? 0.9 : 0, 0.12);
      for (let i = 0; i < sparkCount; i += 1) {
        const index = i * 3;
        const trail = pseudoRandom(i * 3 + performance.now() * 0.015) * 8;
        const spread = (pseudoRandom(i * 7 + 3) - 0.5) * 3;
        const point = bikePosition
          .clone()
          .addScaledVector(tangent, trail)
          .addScaledVector(right, spread);
        point.y -= 0.45 + pseudoRandom(i * 5) * 0.8;
        sparkPositions[index] = point.x;
        sparkPositions[index + 1] = point.y;
        sparkPositions[index + 2] = point.z;
      }
      sparkGeometry.attributes.position.needsUpdate = true;
    };

    const animate = () => {
      animationFrame = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.034);
      const steer = computeSteer(keys);

      if (state.running && !state.paused) {
        const throttle = computeThrottle(keys);
        const wantsDrift =
          keys.has(" ") && steer !== 0 && state.speed > 12 && !state.airborne;

        // Mid-air, the same 5 keys instead control flip rate (see below) and
        // there's no steering or throttle input — you can't kick a bike's
        // heading around or gas it while it's airborne with no wheel on the
        // ground, so the ground driving model is fully disabled while
        // state.airborne is true, not just steering.
        if (!state.airborne) {
          if (throttle > 0) {
            state.speed += throttle * ENGINE_ACCEL * dt;
            state.speed -= DRAG_COEFF * state.speed * state.speed * dt;
          } else {
            state.speed -= COAST_DECEL * dt;
          }
          state.speed = clamp(state.speed, 0, MAX_SPEED);

          const gripAccel = wantsDrift ? DRIFT_LATERAL_ACCEL : GRIP_LATERAL_ACCEL;
          const maxHeadingRate = gripAccel / Math.max(state.speed, MIN_TURN_SPEED);

          // No self-centering: heading only moves while a steer key is held,
          // and simply holds when you let go — the bike keeps going wherever
          // it was last pointed, exactly like a real vehicle coasting.
          if (steer !== 0) {
            state.heading = clamp(
              state.heading + steer * maxHeadingRate * dt,
              -MAX_HEADING,
              MAX_HEADING,
            );
          }
        }

        const forwardSpeed = state.speed * Math.cos(state.heading);
        const sidewaysSpeed = state.speed * Math.sin(state.heading);
        state.worldZ -= forwardSpeed * dt;
        state.worldX += sidewaysSpeed * dt;
        state.distance = -state.worldZ;

        // The road is only a reference line here — going wide never gets
        // clamped or repositioned, it's just a status read for the HUD/grass
        // drag below. The shoulder and mountains beyond are real, drivable
        // terrain generated by buildTerrainSection.
        state.lateral = state.worldX - roadLateralX(state.distance);
        const offroad = Math.abs(state.lateral) > ROAD_WIDTH / 2;
        if (offroad && !state.airborne) {
          state.speed = Math.max(0, state.speed - GRASS_DRAG * dt);
        }

        state.drifting = wantsDrift;

        // Jumping is only ever decided by an explicit hillEvent, never by
        // how steep the ground happens to look locally — that's what let
        // ordinary noise ripples trigger it before. lastHillCell guarantees
        // exactly one launch per hill instance regardless of frame timing.
        // Also require being reasonably close to the road (inside the flat
        // corridor, short of where mountains start rising): triggering deep
        // off-road meant a hill's launch/landing math — tuned for the clean,
        // gentle road profile — was instead colliding with jagged mountain
        // terrain, which is what produced the underground-clipping glitch.
        const hill = hillEvent(state.distance);
        if (
          !state.airborne &&
          hill &&
          state.distance >= hill.dropStart &&
          state.distance < hill.dropEnd &&
          state.speed > JUMP_MIN_SPEED &&
          Math.abs(state.lateral) < JUMP_MAX_LATERAL &&
          state.lastHillCell !== hill.cell
        ) {
          state.airborne = true;
          state.lastHillCell = hill.cell;
          // A real upward launch impulse (not just "coasts off the crest") —
          // peaks roughly 4.5-11 units above launch height depending on
          // speed, a genuine rise-then-fall parabola rather than a hop.
          state.verticalSpeed = FLIP_LAUNCH_BASE + state.speed * FLIP_LAUNCH_SPEED_FACTOR;
          state.flipAngle = 0;
        }

        if (state.airborne) {
          // Flight physics reference the road's own elevation only — never
          // the full (mountain-inclusive) terrain at the bike's actual
          // lateral position. Heading is frozen while airborne but the bike
          // still carries sideways momentum, so it can drift well off the
          // clean flat corridor mid-flight; landing against the smooth,
          // gentle road profile instead of whatever jagged mountain shape
          // it drifted over guarantees it never lands underground.
          const airRoadY = roadHeight(state.distance);
          const airRoadAhead = roadHeight(state.distance + 2);
          const airRoadBehind = roadHeight(state.distance - 2);
          const airSlope = (airRoadAhead - airRoadBehind) / 4;

          state.bikeY += state.verticalSpeed * dt;
          state.verticalSpeed -= 15.5 * dt;
          // Mid-air the throttle keys double as the only flip control — a
          // hardware constraint (one sensor, shared with throttle) that also
          // matches the physics: only a backflip, rate set by which key/how
          // far the sensor is deflected, same as it sets ground throttle.
          if (throttle > 0) state.flipAngle += throttle * FLIP_RATE * dt;

          const landingY = airRoadY + BIKE_CLEARANCE;
          if (state.bikeY <= landingY && state.verticalSpeed < airSlope * state.speed) {
            state.bikeY = landingY;
            state.airborne = false;
            const alignment = Math.abs(
              Math.atan2(Math.sin(state.flipAngle), Math.cos(state.flipAngle)),
            );
            const rotations = Math.floor(
              (Math.abs(state.flipAngle) + Math.PI * 0.32) / (Math.PI * 2),
            );
            if (!(rotations >= 1 && alignment < 0.9) && Math.abs(state.flipAngle) > 0.65) {
              state.speed *= 0.56;
            }
            state.flipAngle = 0;
          }
        } else {
          state.bikeY = groundHeight(state.worldX, state.worldZ) + BIKE_CLEARANCE;
        }

        // Eased 0..1 toward whether we're airborne, used only to soften the
        // camera below — a plain on/off would snap the camera's aim the
        // instant state.airborne flips.
        state.airborneBlend = THREE.MathUtils.lerp(
          state.airborneBlend,
          state.airborne ? 1 : 0,
          1 - Math.pow(0.001, dt),
        );

        if (state.distance - roadStart > 190) {
          scene.remove(roadGroup);
          disposeObject(roadGroup);
          scene.remove(terrainMesh);
          disposeObject(terrainMesh);
          roadStart = state.distance - 90;
          roadGroup = buildRoadSection(roadStart, state.distance + 1500);
          terrainMesh = buildTerrainSection(roadStart, state.distance + 1500);
          scene.add(roadGroup);
          scene.add(terrainMesh);
        }
      }

      const { tangent, right } = roadFrame(state.distance);

      // Airborne, the road's own tangent can be pitched steeply down a jump's
      // drop — a camera that slavishly followed it would dive to match the
      // hill and swamp the bike's actual upward launch. Flattening the
      // tangent's vertical component (blended in only while airborne, eased
      // rather than snapped) keeps the camera comparatively level so the
      // rise-then-fall arc reads clearly against the background.
      const cameraTangent = tangent.clone();
      if (state.airborneBlend > 0.001) {
        const flattened = tangent
          .clone()
          .setY(tangent.y * 0.12)
          .normalize();
        cameraTangent.lerp(flattened, state.airborneBlend);
      }

      bikePosition.set(state.worldX, state.bikeY, state.worldZ);
      bike.position.copy(bikePosition);
      bike.up.set(0, 1, 0);

      // Face the bike along its own travel heading rather than the road's
      // tangent, so a drift visibly slides the body sideways off the line
      // the camera (which stays glued to the road) is tracking.
      const bikeForward = new THREE.Vector3(
        Math.sin(state.heading),
        0,
        -Math.cos(state.heading),
      );
      bike.lookAt(bikePosition.clone().add(bikeForward));

      bike.rotateZ(-steer * (state.drifting ? 0.5 : 0.3));
      if (state.drifting) bike.rotateY(-steer * 0.6);
      if (state.airborne) bike.rotateX(state.flipAngle);

      wheels.forEach((wheel) => {
        wheel.rotation.x -= state.speed * dt * 2.2;
      });

      updateSparks(state.drifting, right, tangent);

      cameraTarget
        .copy(bikePosition)
        .addScaledVector(cameraTangent, -10.5)
        .addScaledVector(right, 1.15)
        .add(new THREE.Vector3(0, state.airborne ? 5.8 : 4.8, 0));
      camera.position.lerp(cameraTarget, 1 - Math.pow(0.001, dt));
      cameraLook
        .copy(bikePosition)
        .addScaledVector(cameraTangent, 14)
        .add(new THREE.Vector3(0, 1.1, 0));
      camera.lookAt(cameraLook);

      sun.position.x = bikePosition.x - 35;
      sun.position.z = bikePosition.z + 30;
      sun.target.position.copy(bikePosition);
      scene.add(sun.target);

      renderer.render(scene, camera);
    };

    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      disposeObject(scene);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return (
    <main className="game-shell">
      <div className="game-canvas" ref={mountRef} aria-label="3D motorcycle game" />

      {graphicsUnavailable && (
        <section className="graphics-fallback" role="alert">
          <div>
            <p className="eyebrow">3D ENGINE CHECK</p>
            <h2>WEBGL IS OFF.</h2>
            <p>
              Open this game in current Chrome or Safari with hardware
              acceleration enabled. The game itself is ready; this browser has
              disabled its 3D graphics context.
            </p>
          </div>
        </section>
      )}

      <div className="scanlines" aria-hidden="true" />
    </main>
  );
}
