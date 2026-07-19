function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

/**
 * Pure mix calculation kept separate from the browser audio graph so the
 * throttle, drift, and airborne rules can be regression-tested.
 * @param {{
 *   throttle: number,
 *   speedRatio: number,
 *   steering: number,
 *   slipAngle: number,
 *   drifting: boolean,
 *   airborne: boolean,
 *   paused: boolean,
 * }} state
 */
export function calculateAudioMix(state) {
  const speedRatio = clamp(state.speedRatio, 0, 1);
  const grounded = !state.airborne && !state.paused;
  const throttle = grounded ? clamp(state.throttle, 0, 1) : 0;
  const speedGate = clamp((speedRatio - 0.32) / 0.68, 0, 1);
  const steeringScrub = clamp((Math.abs(state.steering) - 0.52) / 0.48, 0, 1);
  const slipScrub = clamp(Math.abs(state.slipAngle) / 0.42, 0, 1);
  const scrubDemand = state.drifting
    ? 1
    : Math.max(steeringScrub, slipScrub);

  return {
    engineGain: grounded ? 0.006 + throttle * 0.066 : 0,
    engineFrequency: 52 + speedRatio * 105 + throttle * 34,
    scrubGain: grounded ? speedGate * scrubDemand * 0.058 : 0,
    scrubFrequency: 260 + speedRatio * 390,
  };
}

/** @param {number} impactSpeed */
export function calculateLandingImpact(impactSpeed) {
  const strength = clamp(impactSpeed / 16, 0.62, 1);
  return {
    strength,
    thumpGain: 0.32 * strength,
    crackGain: 0.16 * strength,
    gritGain: 0.21 * strength,
  };
}

export function createGameAudio() {
  /** @type {AudioContext | null} */
  let context = null;
  /** @type {GainNode | null} */
  let master = null;
  /** @type {GainNode | null} */
  let engineGain = null;
  /** @type {GainNode | null} */
  let scrubGain = null;
  /** @type {BiquadFilterNode | null} */
  let engineFilter = null;
  /** @type {BiquadFilterNode | null} */
  let scrubFilter = null;
  /** @type {OscillatorNode | null} */
  let engineLow = null;
  /** @type {OscillatorNode | null} */
  let engineHigh = null;
  /** @type {AudioBufferSourceNode | null} */
  let scrubSource = null;

  const makeNoiseBuffer = (duration) => {
    if (!context) return null;
    const frameCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, frameCount, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let previous = 0;
    for (let index = 0; index < frameCount; index += 1) {
      const white = Math.random() * 2 - 1;
      previous = previous * 0.42 + white * 0.58;
      channel[index] = previous;
    }
    return buffer;
  };

  const buildGraph = () => {
    if (context) return;
    context = new AudioContext();
    const now = context.currentTime;

    master = context.createGain();
    master.gain.setValueAtTime(0.72, now);
    master.connect(context.destination);

    engineGain = context.createGain();
    engineGain.gain.setValueAtTime(0, now);
    engineFilter = context.createBiquadFilter();
    engineFilter.type = "lowpass";
    engineFilter.frequency.setValueAtTime(680, now);
    engineFilter.Q.setValueAtTime(0.7, now);
    engineFilter.connect(engineGain);
    engineGain.connect(master);

    const lowBlend = context.createGain();
    lowBlend.gain.setValueAtTime(0.72, now);
    const highBlend = context.createGain();
    highBlend.gain.setValueAtTime(0.2, now);
    engineLow = context.createOscillator();
    engineLow.type = "sawtooth";
    engineLow.frequency.setValueAtTime(52, now);
    engineHigh = context.createOscillator();
    engineHigh.type = "square";
    engineHigh.frequency.setValueAtTime(104, now);
    engineLow.connect(lowBlend);
    engineHigh.connect(highBlend);
    lowBlend.connect(engineFilter);
    highBlend.connect(engineFilter);
    engineLow.start();
    engineHigh.start();

    scrubGain = context.createGain();
    scrubGain.gain.setValueAtTime(0, now);
    scrubFilter = context.createBiquadFilter();
    scrubFilter.type = "bandpass";
    scrubFilter.frequency.setValueAtTime(360, now);
    scrubFilter.Q.setValueAtTime(0.85, now);
    scrubFilter.connect(scrubGain);
    scrubGain.connect(master);
    const scrubBuffer = makeNoiseBuffer(1.5);
    if (scrubBuffer) {
      scrubSource = context.createBufferSource();
      scrubSource.buffer = scrubBuffer;
      scrubSource.loop = true;
      scrubSource.connect(scrubFilter);
      scrubSource.start();
    }
  };

  const ensureStarted = () => {
    if (typeof AudioContext === "undefined") return;
    buildGraph();
    if (context?.state === "suspended") {
      void context.resume().catch(() => {});
    }
  };

  const update = (state) => {
    if (!context || !engineGain || !scrubGain || !engineLow || !engineHigh) {
      return;
    }
    const mix = calculateAudioMix(state);
    const now = context.currentTime;
    const engineFade = state.airborne ? 0.035 : 0.075;
    engineGain.gain.setTargetAtTime(mix.engineGain, now, engineFade);
    engineLow.frequency.setTargetAtTime(mix.engineFrequency, now, 0.055);
    engineHigh.frequency.setTargetAtTime(mix.engineFrequency * 2.03, now, 0.055);
    scrubGain.gain.setTargetAtTime(mix.scrubGain, now, 0.045);
    scrubFilter?.frequency.setTargetAtTime(mix.scrubFrequency, now, 0.05);
  };

  const playAirWhoosh = () => {
    ensureStarted();
    if (!context || !master) return;
    const buffer = makeNoiseBuffer(0.62);
    if (!buffer) return;
    const source = context.createBufferSource();
    source.buffer = buffer;
    const filter = context.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(520, context.currentTime);
    filter.frequency.exponentialRampToValueAtTime(
      1500,
      context.currentTime + 0.48,
    );
    filter.Q.setValueAtTime(0.65, context.currentTime);
    const gain = context.createGain();
    const now = context.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.12, now + 0.045);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.58);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(master);
    source.start(now);
    source.stop(now + 0.62);
  };

  const playLanding = (impactSpeed) => {
    ensureStarted();
    if (!context || !master) return;
    const now = context.currentTime;
    const impact = calculateLandingImpact(impactSpeed);
    const thump = context.createOscillator();
    thump.type = "sine";
    thump.frequency.setValueAtTime(94, now);
    thump.frequency.exponentialRampToValueAtTime(30, now + 0.42);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0.0001, now);
    thumpGain.gain.linearRampToValueAtTime(impact.thumpGain, now + 0.012);
    thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.46);
    thump.connect(thumpGain);
    thumpGain.connect(master);
    thump.start(now);
    thump.stop(now + 0.48);

    // A short mid-frequency chassis crack makes the landing readable even on
    // laptop speakers that cannot reproduce the low thump strongly.
    const crack = context.createOscillator();
    crack.type = "square";
    crack.frequency.setValueAtTime(210, now);
    crack.frequency.exponentialRampToValueAtTime(76, now + 0.16);
    const crackGain = context.createGain();
    crackGain.gain.setValueAtTime(0.0001, now);
    crackGain.gain.linearRampToValueAtTime(impact.crackGain, now + 0.006);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.19);
    crack.connect(crackGain);
    crackGain.connect(master);
    crack.start(now);
    crack.stop(now + 0.21);

    const buffer = makeNoiseBuffer(0.4);
    if (!buffer) return;
    const grit = context.createBufferSource();
    grit.buffer = buffer;
    const gritFilter = context.createBiquadFilter();
    gritFilter.type = "lowpass";
    gritFilter.frequency.setValueAtTime(920, now);
    gritFilter.Q.setValueAtTime(0.55, now);
    const gritGain = context.createGain();
    gritGain.gain.setValueAtTime(0.0001, now);
    gritGain.gain.linearRampToValueAtTime(impact.gritGain, now + 0.008);
    gritGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.36);
    grit.connect(gritFilter);
    gritFilter.connect(gritGain);
    gritGain.connect(master);
    grit.start(now);
    grit.stop(now + 0.4);
  };

  const dispose = () => {
    try {
      engineLow?.stop();
      engineHigh?.stop();
      scrubSource?.stop();
    } catch {
      // Nodes may already be stopped during hot reload cleanup.
    }
    if (context) void context.close().catch(() => {});
    context = null;
  };

  return { ensureStarted, update, playAirWhoosh, playLanding, dispose };
}
