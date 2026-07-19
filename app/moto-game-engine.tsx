"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";

const ROAD_WIDTH = 14;
const BIKE_CLEARANCE = 1.18;
const MAX_SPEED = 200 / 3.6;
const BOOST_SPEED = MAX_SPEED;
const NORMAL_GRIP = 12.5;
const DRIFT_GRIP = 58;
const SHARP_CURVE = 0.0065;

const STEERING_LEVELS: Record<string, number> = {
  a: -1,
  s: -0.8,
  d: -0.6,
  f: -0.4,
  g: -0.2,
  h: 0.2,
  j: 0.4,
  k: 0.6,
  l: 0.8,
  ";": 1,
};

type Hud = {
  speed: number;
  distance: number;
  score: number;
  drift: number;
  airborne: boolean;
  offroad: boolean;
  paused: boolean;
  turnDirection: "LEFT" | "RIGHT" | null;
  driftReady: boolean;
  cornerLoad: number;
};

type GameCommand = {
  start: () => void;
  reset: () => void;
};

const initialHud: Hud = {
  speed: 0,
  distance: 0,
  score: 0,
  drift: 0,
  airborne: false,
  offroad: false,
  paused: false,
  turnDirection: null,
  driftReady: false,
  cornerLoad: 0,
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

function positiveMod(value: number, modulus: number) {
  return ((value % modulus) + modulus) % modulus;
}

function steeringInput(keys: Set<string>) {
  let strongestLeft = 0;
  let strongestRight = 0;

  Object.entries(STEERING_LEVELS).forEach(([key, value]) => {
    if (!keys.has(key)) return;
    if (value < strongestLeft) strongestLeft = value;
    if (value > strongestRight) strongestRight = value;
  });

  return clamp(strongestLeft + strongestRight, -1, 1);
}

function roadHeight(distance: number) {
  const rolling =
    Math.sin(distance * 0.017) * 0.75 +
    Math.sin(distance * 0.0065) * 1.15;
  const phase = ((distance + 80) % 520 + 520) % 520;
  let stuntHill = 0;

  if (phase >= 200 && phase < 280) {
    stuntHill = smoothstep((phase - 200) / 80) * 15;
  } else if (phase >= 280 && phase < 350) {
    stuntHill = 15 - smoothstep((phase - 280) / 70) * 20;
  } else if (phase >= 350 && phase < 430) {
    stuntHill = -5 + smoothstep((phase - 350) / 80) * 5;
  }

  return rolling + stuntHill;
}

function roadX(distance: number) {
  const gentleCurve =
    Math.sin(distance * 0.004) * 9 +
    Math.sin(distance * 0.0017 + 0.8) * 6;
  const cycle = Math.floor(distance / 520);
  const phase = positiveMod(distance, 520);
  let stuntTurn = 0;

  // The stunt hill ends at 350 m in each cycle. The sharper S-bend is kept
  // inside the flatter 345–515 m corridor so steep drops and hard turns do
  // not stack on top of one another.
  if (phase >= 345 && phase <= 515) {
    const progress = (phase - 345) / 170;
    const pulse =
      progress < 0.5
        ? smootherstep(progress * 2)
        : 1 - smootherstep((progress - 0.5) * 2);
    const direction = cycle % 2 === 0 ? 1 : -1;
    stuntTurn = direction * 22 * pulse;
  }

  return gentleCurve + stuntTurn;
}

function roadHeading(distance: number) {
  const dx = (roadX(distance + 1) - roadX(distance - 1)) / 2;
  return Math.atan2(dx, 1);
}

function angleDifference(a: number, b: number) {
  let difference = a - b;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function roadCurvature(distance: number) {
  return (
    angleDifference(roadHeading(distance + 2), roadHeading(distance - 2)) / 4
  );
}

function roadCenter(distance: number, target = new THREE.Vector3()) {
  return target.set(roadX(distance), roadHeight(distance), -distance);
}

function roadFrame(distance: number) {
  const center = roadCenter(distance);
  const before = roadCenter(distance - 1.2);
  const after = roadCenter(distance + 1.2);
  const tangent = after.sub(before).normalize();
  const right = new THREE.Vector3(-tangent.z, 0, tangent.x).normalize();
  return { center, tangent, right };
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

  const turnSamples: Array<{ distance: number; curvature: number }> = [];
  const firstTurnSample = Math.ceil(from / 12) * 12;
  for (let distance = firstTurnSample; distance <= to; distance += 12) {
    const curvature = roadCurvature(distance);
    if (Math.abs(curvature) > SHARP_CURVE) {
      turnSamples.push({ distance, curvature });
    }
  }

  if (turnSamples.length > 0) {
    const postGeometry = new THREE.BoxGeometry(0.22, 1.1, 1.8);
    const postMaterial = new THREE.MeshBasicMaterial({ color: 0xb9ff45 });
    const posts = new THREE.InstancedMesh(
      postGeometry,
      postMaterial,
      turnSamples.length,
    );

    turnSamples.forEach((sample, index) => {
      const { center, tangent, right } = roadFrame(sample.distance);
      const outside = -Math.sign(sample.curvature);
      center.addScaledVector(right, outside * (ROAD_WIDTH / 2 + 1.45));
      center.y += 0.6;
      quaternion.setFromUnitVectors(forward, tangent);
      scale.set(1, 1, 1);
      matrix.compose(center, quaternion, scale);
      posts.setMatrixAt(index, matrix);
    });
    posts.instanceMatrix.needsUpdate = true;
    group.add(posts);
  }

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
    position.y -= 1.4;
    const treeScale = 0.65 + pseudoRandom(i * 11 + 2) * 1.35;
    scale.set(treeScale, treeScale, treeScale);
    quaternion.identity();
    matrix.compose(position, quaternion, scale);
    trees.setMatrixAt(i, matrix);
  }
  trees.instanceMatrix.needsUpdate = true;
  group.add(trees);

  return group;
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
  const commandRef = useRef<GameCommand>({ start: () => {}, reset: () => {} });
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [started, setStarted] = useState(false);
  const [graphicsUnavailable, setGraphicsUnavailable] = useState(false);
  const [hud, setHud] = useState<Hud>(initialHud);
  const [notice, setNotice] = useState("READY TO RIDE");

  const flashNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 1450);
  }, []);

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
      const fallbackTimer = window.setTimeout(
        () => setGraphicsUnavailable(true),
        0,
      );
      return () => window.clearTimeout(fallbackTimer);
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
    scene.add(sun.target);

    const sunDisc = new THREE.Mesh(
      new THREE.SphereGeometry(12, 20, 12),
      new THREE.MeshBasicMaterial({ color: 0xffe5a6 }),
    );
    sunDisc.position.set(-105, 92, -360);
    scene.add(sunDisc);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(2600, 2600),
      new THREE.MeshStandardMaterial({ color: 0x789a64, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -7;
    ground.receiveShadow = true;
    scene.add(ground);

    let roadStart = -80;
    let roadGroup = buildRoadSection(roadStart, 1450);
    scene.add(roadGroup);

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
        depthWrite: false,
      }),
    );
    scene.add(sparks);
    const smoke = new THREE.Points(
      sparkGeometry,
      new THREE.PointsMaterial({
        color: 0xdce6e8,
        size: 0.42,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    scene.add(smoke);

    const keys = new Set<string>();
    const state = {
      running: false,
      paused: false,
      distance: 0,
      speed: 0,
      lateral: 0,
      lateralVelocity: 0,
      bikeY: roadHeight(0) + BIKE_CLEARANCE,
      verticalSpeed: 0,
      airborne: false,
      flipAngle: 0,
      drifting: false,
      driftCharge: 0,
      driftTime: 0,
      driftCurvePeak: 0,
      driftDirection: 0,
      driftStayedOnRoad: true,
      driftWasNecessary: false,
      boostTime: 0,
      score: 0,
      lastJump: -200,
      lastHudUpdate: 0,
    };

    const reset = () => {
      state.distance = 0;
      state.speed = 0;
      state.lateral = 0;
      state.lateralVelocity = 0;
      state.bikeY = roadHeight(0) + BIKE_CLEARANCE;
      state.verticalSpeed = 0;
      state.airborne = false;
      state.flipAngle = 0;
      state.drifting = false;
      state.driftCharge = 0;
      state.driftTime = 0;
      state.driftCurvePeak = 0;
      state.driftDirection = 0;
      state.driftStayedOnRoad = true;
      state.driftWasNecessary = false;
      state.boostTime = 0;
      state.score = 0;
      state.lastJump = -200;
      state.paused = false;
      scene.remove(roadGroup);
      disposeObject(roadGroup);
      roadStart = -80;
      roadGroup = buildRoadSection(roadStart, 1450);
      scene.add(roadGroup);
      camera.position.set(7, 5.5, 12);
      setHud(initialHud);
      flashNotice("RUN RESET");
    };

    const start = () => {
      state.running = true;
      state.paused = false;
      flashNotice("GO!");
    };

    commandRef.current = { start, reset };

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (
        [
          "w",
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
          "q",
          "e",
          "r",
          "p",
          " ",
        ].includes(key)
      ) {
        event.preventDefault();
      }
      if (key === "r" && !event.repeat) reset();
      if (key === "p" && !event.repeat && state.running) {
        state.paused = !state.paused;
        flashNotice(state.paused ? "PAUSED" : "RIDE ON");
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

    const updateDriftTrail = (
      active: boolean,
      right: THREE.Vector3,
      tangent: THREE.Vector3,
      driftDirection: number,
    ) => {
      const sparkMaterial = sparks.material as THREE.PointsMaterial;
      const smokeMaterial = smoke.material as THREE.PointsMaterial;
      sparkMaterial.opacity = THREE.MathUtils.lerp(
        sparkMaterial.opacity,
        active ? 0.78 : 0,
        0.12,
      );
      smokeMaterial.opacity = THREE.MathUtils.lerp(
        smokeMaterial.opacity,
        active ? 0.42 : 0,
        0.08,
      );
      for (let i = 0; i < sparkCount; i += 1) {
        const index = i * 3;
        const trail = pseudoRandom(i * 3 + performance.now() * 0.015) * 8;
        const spread = (pseudoRandom(i * 7 + 3) - 0.5) * 3;
        const point = bikePosition
          .clone()
          .addScaledVector(tangent, -trail)
          .addScaledVector(right, spread - driftDirection * 0.9);
        point.y -= 0.45 + pseudoRandom(i * 5) * 0.8;
        sparkPositions[index] = point.x;
        sparkPositions[index + 1] = point.y;
        sparkPositions[index + 2] = point.z;
      }
      sparkGeometry.attributes.position.needsUpdate = true;
    };

    const clearDriftState = () => {
      state.drifting = false;
      state.driftCharge = 0;
      state.driftTime = 0;
      state.driftCurvePeak = 0;
      state.driftDirection = 0;
      state.driftStayedOnRoad = true;
      state.driftWasNecessary = false;
    };

    const finishDrift = () => {
      const stayedInsideRoad =
        state.driftStayedOnRoad && Math.abs(state.lateral) < ROAD_WIDTH * 0.48;
      const scored =
        state.driftTime >= 0.55 &&
        state.driftCurvePeak > SHARP_CURVE &&
        state.driftWasNecessary &&
        stayedInsideRoad;

      if (scored) {
        const driftScore = Math.round(
          state.driftCharge * 10 + state.driftTime * 300,
        );
        state.score += driftScore;
        state.boostTime = clamp(0.55 + state.driftCharge / 65, 0.55, 2.1);
        state.speed = Math.min(
          BOOST_SPEED,
          state.speed + state.driftCharge * 0.055,
        );
        flashNotice(`CURVE DRIFT +${driftScore}`);
      } else if (!stayedInsideRoad && state.driftTime > 0.3) {
        flashNotice("DRIFT LOST — STAY ON ROAD");
      } else if (!state.driftWasNecessary && state.driftTime > 0.55) {
        flashNotice("GRIP WAS ENOUGH — NO DRIFT SCORE");
      }

      clearDriftState();
    };

    const animate = () => {
      animationFrame = requestAnimationFrame(animate);
      const dt = Math.min(clock.getDelta(), 0.034);

      if (state.running && !state.paused) {
        const steer = steeringInput(keys);
        const throttle = keys.has("w");

        if (throttle) state.speed += 18.5 * dt;
        else state.speed -= 3.1 * dt;

        if (state.boostTime > 0) {
          state.boostTime -= dt;
          state.speed += 13 * dt;
        }

        const speedLimit = state.boostTime > 0 ? BOOST_SPEED : MAX_SPEED;
        state.speed = clamp(state.speed, 0, speedLimit);

        // Corner load follows v²/r (equivalently v² × curvature). Once that
        // demand exceeds ordinary grip, the bike understeers toward the outer
        // edge. A correctly directed drift raises the grip ceiling.
        const currentCurvature = roadCurvature(state.distance);
        const lookAheadDistance =
          state.distance + Math.min(12, state.speed * 0.22);
        const upcomingCurvature = roadCurvature(lookAheadDistance);
        const activeCurvature =
          Math.abs(upcomingCurvature) > Math.abs(currentCurvature)
            ? upcomingCurvature
            : currentCurvature;
        const curveDirection = Math.sign(activeCurvature);
        const sharpCurve = Math.abs(activeCurvature) > SHARP_CURVE;
        const cornerDemand =
          state.speed * state.speed * Math.abs(currentCurvature);
        const driftNecessary =
          state.speed * state.speed * Math.abs(activeCurvature) >
          NORMAL_GRIP * 0.95;
        const correctSteer =
          steer !== 0 && Math.sign(steer) === curveDirection;
        const onRoadBefore = Math.abs(state.lateral) < ROAD_WIDTH * 0.48;
        const wantsDrift =
          keys.has(" ") &&
          correctSteer &&
          sharpCurve &&
          state.speed > 18 &&
          !state.airborne &&
          onRoadBefore &&
          (!state.drifting || state.driftDirection === curveDirection);

        if (wantsDrift) {
          if (!state.drifting) {
            state.drifting = true;
            state.driftCharge = 0;
            state.driftTime = 0;
            state.driftCurvePeak = 0;
            state.driftDirection = curveDirection;
            state.driftStayedOnRoad = true;
            state.driftWasNecessary = driftNecessary;
            flashNotice(`DRIFT ${curveDirection < 0 ? "LEFT" : "RIGHT"}`);
          }
          state.driftTime += dt;
          state.driftCurvePeak = Math.max(
            state.driftCurvePeak,
            Math.abs(activeCurvature),
          );
          state.driftCharge = clamp(
            state.driftCharge + state.speed * dt * 1.2,
            0,
            100,
          );
          state.driftWasNecessary ||= driftNecessary;
        }

        const followsCurrentCurve =
          Math.abs(currentCurvature) > 0.0005 &&
          steer !== 0 &&
          Math.sign(steer) === Math.sign(currentCurvature);
        const steeringGripScale = 0.35 + Math.abs(steer) * 0.65;
        const availableGrip = state.drifting
          ? DRIFT_GRIP * steeringGripScale
          : followsCurrentCurve
            ? NORMAL_GRIP * steeringGripScale
            : NORMAL_GRIP * 0.28;
        const excessDemand = Math.max(0, cornerDemand - availableGrip);
        if (Math.abs(currentCurvature) > 0.0005) {
          state.lateralVelocity +=
            -Math.sign(currentCurvature) * excessDemand * 1.3 * dt;
        }

        const steeringAcceleration =
          (5.6 + state.speed * 0.07) * (state.drifting ? 0.82 : 1);
        const laneChangeScale = followsCurrentCurve ? 0.18 : 1;
        state.lateralVelocity +=
          steer * steeringAcceleration * laneChangeScale * dt;
        state.lateralVelocity +=
          -state.lateral * (state.drifting ? 0.32 : 0.62) * dt;
        state.lateralVelocity *= Math.pow(
          state.drifting ? 0.991 : 0.982,
          dt * 60,
        );
        state.lateral += state.lateralVelocity * dt;

        const offroad = Math.abs(state.lateral) > ROAD_WIDTH * 0.48;
        if (offroad) {
          state.speed = Math.max(0, state.speed - 18 * dt);
          state.lateral = clamp(
            state.lateral,
            -ROAD_WIDTH * 0.78,
            ROAD_WIDTH * 0.78,
          );
          state.lateralVelocity *= Math.pow(0.72, dt * 60);
          if (state.drifting) state.driftStayedOnRoad = false;
        }

        if (state.drifting && (!wantsDrift || offroad)) finishDrift();

        state.distance += state.speed * dt;
        const roadY = roadHeight(state.distance);
        const slope = (roadHeight(state.distance + 2) - roadHeight(state.distance - 2)) / 4;
        const upcomingSlope =
          (roadHeight(state.distance + 12) - roadHeight(state.distance + 7)) / 5;

        if (
          !state.airborne &&
          state.speed > 23 &&
          slope > 0.065 &&
          upcomingSlope < -0.045 &&
          state.distance - state.lastJump > 110
        ) {
          state.airborne = true;
          state.lastJump = state.distance;
          state.verticalSpeed = slope * state.speed + 3.4;
          state.flipAngle = 0;
          flashNotice("AIRBORNE — Q / E TO FLIP");
        }

        if (state.airborne) {
          state.bikeY += state.verticalSpeed * dt;
          state.verticalSpeed -= 15.5 * dt;
          if (keys.has("q")) state.flipAngle += 5.5 * dt;
          if (keys.has("e")) state.flipAngle -= 5.5 * dt;

          const landingY = roadY + BIKE_CLEARANCE;
          if (state.bikeY <= landingY && state.verticalSpeed < slope * state.speed) {
            state.bikeY = landingY;
            state.airborne = false;
            const alignment = Math.abs(
              Math.atan2(Math.sin(state.flipAngle), Math.cos(state.flipAngle)),
            );
            const rotations = Math.floor(
              (Math.abs(state.flipAngle) + Math.PI * 0.32) / (Math.PI * 2),
            );

            if (rotations >= 1 && alignment < 0.9) {
              const flipScore = rotations * 2500;
              state.score += flipScore;
              state.boostTime = Math.max(state.boostTime, 1.25);
              flashNotice(`${rotations}× FLIP LANDED +${flipScore}`);
            } else if (Math.abs(state.flipAngle) > 0.65) {
              state.speed *= 0.56;
              flashNotice("ROUGH LANDING");
            } else {
              state.score += 400;
              flashNotice("CLEAN AIR +400");
            }
            state.flipAngle = 0;
          }
        } else {
          state.bikeY = roadY + BIKE_CLEARANCE;
        }

        state.score += state.speed * dt * 0.24;

        if (state.distance - roadStart > 190) {
          scene.remove(roadGroup);
          disposeObject(roadGroup);
          roadStart = state.distance - 90;
          roadGroup = buildRoadSection(roadStart, state.distance + 1500);
          scene.add(roadGroup);
        }
      }

      const { center, tangent, right } = roadFrame(state.distance);
      bikePosition
        .copy(center)
        .addScaledVector(right, state.lateral);
      bikePosition.y = state.bikeY;
      bike.position.copy(bikePosition);
      bike.up.set(0, 1, 0);
      bike.lookAt(bikePosition.clone().add(tangent));

      const steerVisual = steeringInput(keys);
      const driftVisualDirection = state.drifting ? state.driftDirection : 0;
      bike.rotateZ(-steerVisual * (state.drifting ? 0.62 : 0.34));
      if (state.drifting) {
        bike.rotateY(-driftVisualDirection * 0.48);
        bike.translateX(-driftVisualDirection * 0.18);
      }
      if (state.airborne) bike.rotateX(state.flipAngle);

      wheels.forEach((wheel) => {
        wheel.rotation.x -= state.speed * dt * 2.2;
      });

      updateDriftTrail(
        state.drifting,
        right,
        tangent,
        state.driftDirection,
      );

      const driftCameraSide = state.drifting
        ? -state.driftDirection * 2.1
        : 1.15;
      cameraTarget
        .copy(bikePosition)
        .addScaledVector(tangent, -10.5)
        .addScaledVector(right, driftCameraSide)
        .add(
          new THREE.Vector3(
            0,
            state.airborne ? 5.8 : state.drifting ? 4.2 : 4.8,
            0,
          ),
        );
      camera.position.lerp(cameraTarget, 1 - Math.pow(0.001, dt));
      cameraLook
        .copy(bikePosition)
        .addScaledVector(tangent, 14)
        .add(new THREE.Vector3(0, 1.1, 0));
      camera.lookAt(cameraLook);
      const targetFov = state.drifting ? 69 : state.boostTime > 0 ? 66 : 62;
      camera.fov = THREE.MathUtils.lerp(camera.fov, targetFov, 0.08);
      camera.updateProjectionMatrix();

      ground.position.x = bikePosition.x;
      ground.position.z = bikePosition.z - 250;
      sun.position.x = bikePosition.x - 35;
      sun.position.z = bikePosition.z + 30;
      sun.target.position.copy(bikePosition);

      const now = performance.now();
      if (now - state.lastHudUpdate > 90) {
        state.lastHudUpdate = now;
        const hudLookAhead =
          state.distance + Math.min(12, state.speed * 0.22);
        const hudCurvature = roadCurvature(hudLookAhead);
        const hudCornerDemand =
          state.speed * state.speed * Math.abs(hudCurvature);
        const hudDirection =
          Math.abs(hudCurvature) > 0.002
            ? hudCurvature < 0
              ? "LEFT"
              : "RIGHT"
            : null;
        setHud({
          speed: Math.round(state.speed * 3.6),
          distance: Math.floor(state.distance),
          score: Math.floor(state.score),
          drift: Math.round(state.driftCharge),
          airborne: state.airborne,
          offroad: Math.abs(state.lateral) > ROAD_WIDTH * 0.48,
          paused: state.paused,
          turnDirection: hudDirection,
          driftReady:
            Math.abs(hudCurvature) > SHARP_CURVE &&
            hudCornerDemand > NORMAL_GRIP * 0.95,
          cornerLoad: Math.round(
            clamp((hudCornerDemand / NORMAL_GRIP) * 100, 0, 199),
          ),
        });
      }

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
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [flashNotice]);

  const begin = () => {
    setStarted(true);
    commandRef.current.start();
  };

  return (
    <main className="game-shell">
      <div className="game-canvas" ref={mountRef} aria-label="3D motorcycle game" />

      <header className="game-header">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">IM</span>
          <div>
            <p className="eyebrow">HACK THE 6IX PROTOTYPE</p>
            <h1>INFINITE MOTO</h1>
          </div>
        </div>
        <div className="status-pill">
          <span className="status-dot" />
          10-LEVEL STEERING
        </div>
      </header>

      <section className="speed-cluster" aria-label="Ride statistics">
        <div className="speed-value">
          <strong>{hud.speed}</strong>
          <span>KM/H</span>
        </div>
        <div className="mini-stat">
          <span>DISTANCE</span>
          <strong>{hud.distance.toLocaleString()} m</strong>
        </div>
        <div className="mini-stat">
          <span>SCORE</span>
          <strong>{hud.score.toLocaleString()}</strong>
        </div>
        <div className="mini-stat">
          <span>CORNER LOAD</span>
          <strong>{hud.cornerLoad}%</strong>
        </div>
      </section>

      <section
        className={`drift-meter ${hud.driftReady ? "ready" : ""}`}
        aria-label="Drift charge"
      >
        <div className="meter-heading">
          <span>
            {hud.driftReady && hud.turnDirection
              ? `${hud.turnDirection} DRIFT ZONE`
              : "DRIFT CHARGE"}
          </span>
          <strong>{hud.drift}%</strong>
        </div>
        <div className="meter-track">
          <div className="meter-fill" style={{ width: `${hud.drift}%` }} />
        </div>
      </section>

      <div className={`ride-notice ${notice ? "show" : ""}`}>{notice}</div>

      <aside className="controls-panel" aria-label="Keyboard controls">
        <p>RIDE CONTROLS</p>
        <div className="control-row"><kbd>W</kbd><span>Accelerate</span></div>
        <div className="steering-scale-row">
          <span>LEFT</span>
          <div>
            <div className="key-scale">
              {['A', 'S', 'D', 'F', 'G'].map((key) => <kbd key={key}>{key}</kbd>)}
            </div>
            <small>MAX → MIN</small>
          </div>
        </div>
        <div className="steering-scale-row">
          <span>RIGHT</span>
          <div>
            <div className="key-scale">
              {['H', 'J', 'K', 'L', ';'].map((key) => <kbd key={key}>{key}</kbd>)}
            </div>
            <small>MIN → MAX</small>
          </div>
        </div>
        <div className="control-row"><kbd className="wide-key">SPACE</kbd><span>Hold in sharp turns</span></div>
        <div className="control-row"><div className="key-pair"><kbd>Q</kbd><kbd>E</kbd></div><span>Back / front flip</span></div>
        <div className="control-row compact"><kbd>R</kbd><span>Reset</span><kbd>P</kbd><span>Pause</span></div>
      </aside>

      <div className="terrain-state" aria-live="polite">
        {hud.paused
          ? "PAUSED"
          : hud.airborne
            ? "AIRBORNE"
            : hud.offroad
              ? "OFF ROAD"
              : hud.driftReady && hud.turnDirection
                ? `DRIFT ${hud.turnDirection}`
                : hud.turnDirection
                  ? `TURN ${hud.turnDirection} · ${hud.cornerLoad}% LOAD`
                  : "ROAD GRIP"}
      </div>

      {!started && (
        <section className="start-screen">
          <div className="start-card">
            <p className="eyebrow">PHYSICAL CONTROLLER READY</p>
            <h2>CHASE THE<br /><em>ENDLESS ROAD.</em></h2>
            <p className="start-copy">
              Push toward 200 km/h with five-level steering, charge drifts
              through sharp turns, and throw flips when the road drops away.
            </p>
            <button type="button" onClick={begin}>START RIDE <span>→</span></button>
            <p className="start-hint">Use a physical keyboard. No brake. No reverse.</p>
          </div>
        </section>
      )}

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
