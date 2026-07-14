"use strict";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0, edge1, value) => {
  const t = clamp((value - edge0) / Math.max(1e-9, edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const TRAJECTORY_HEADER_BYTES = 16;
const TRAJECTORY_FIELDS = 4; // audioTime, positionSeconds, speed, flags

class PolyphaseResampler {
  constructor() {
    this.radius = 8;
    this.taps = this.radius * 2;
    this.phases = 512;
    this.cutoffs = [0.96, 0.72, 0.50, 0.34, 0.22, 0.14];
    this.tables = this.cutoffs.map(cutoff => this.buildTable(cutoff));
  }

  buildTable(cutoff) {
    const table = new Float32Array(this.phases * this.taps);
    for (let phase = 0; phase < this.phases; phase++) {
      const fraction = phase / this.phases;
      let total = 0;
      for (let tap = 0; tap < this.taps; tap++) {
        const offset = tap - (this.radius - 1);
        const distance = fraction - offset;
        const x = distance * cutoff;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const normalizedDistance = Math.abs(distance) / this.radius;
        const window = normalizedDistance >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * normalizedDistance);
        const weight = cutoff * sinc * window;
        table[phase * this.taps + tap] = weight;
        total += weight;
      }
      const inverse = Math.abs(total) > 1e-9 ? 1 / total : 1;
      for (let tap = 0; tap < this.taps; tap++) table[phase * this.taps + tap] *= inverse;
    }
    return table;
  }

  tableForSpeed(speed) {
    const value = Math.abs(speed);
    if (value <= 1.05) return this.tables[0];
    if (value <= 1.45) return this.tables[1];
    if (value <= 2.1) return this.tables[2];
    if (value <= 3.2) return this.tables[3];
    if (value <= 5.2) return this.tables[4];
    return this.tables[5];
  }
}

class VinylScratchProcessor extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();

    this.channels = null;
    this.sourceSampleRate = sampleRate;
    this.length = 0;
    this.duration = 0;

    this.position = 0; // source samples
    this.speed = 0; // source seconds per wall-clock second
    this.mode = "stop"; // stop | motor | inertia | touch
    this.loop = false;

    this.controlDelay = 0.012;
    this.motorResponse = 15;
    this.brakeResponse = 24;
    this.inertiaDecay = 4.8;
    this.rawMode = false;
    this.slipEnabled = false;

    this.touchStartPosition = 0;
    this.touchWasMotor = false;
    this.slipPosition = 0;
    this.slipActive = false;

    this.motionGain = 0;
    this.edgeSent = false;
    this.stateCountdown = 0;
    this.lastTouchPosition = 0;

    this.jumpPhase = "none";
    this.jumpCount = 0;
    this.jumpLength = Math.max(32, Math.round(sampleRate * 0.0045));
    this.pendingJumpPosition = 0;
    this.pendingTouchEnd = null;

    this.dcX = [0, 0];
    this.dcY = [0, 0];
    this.dcR = 0.9995;

    this.resampler = new PolyphaseResampler();

    this.trajectoryHeader = null;
    this.trajectoryData = null;
    this.trajectoryCapacity = 0;
    this.trajectoryReadSeq = 0;
    this.trajectoryPoints = [];
    this.trajectoryCursor = 0;

    const processorOptions = options.processorOptions || {};
    if (typeof SharedArrayBuffer === "function" && processorOptions.trajectoryBuffer instanceof SharedArrayBuffer) {
      this.attachTrajectory(processorOptions.trajectoryBuffer, Number(processorOptions.trajectoryCapacity) || 2048);
    }

    this.port.onmessage = event => this.onMessage(event.data || {});
  }

  attachTrajectory(buffer, capacity) {
    try {
      this.trajectoryHeader = new Int32Array(buffer, 0, 4);
      this.trajectoryData = new Float64Array(buffer, TRAJECTORY_HEADER_BYTES);
      this.trajectoryCapacity = Math.max(8, capacity | 0);
      this.trajectoryReadSeq = Atomics.load(this.trajectoryHeader, 0);
      this.trajectoryPoints.length = 0;
      this.trajectoryCursor = 0;
    } catch (_) {
      this.trajectoryHeader = null;
      this.trajectoryData = null;
      this.trajectoryCapacity = 0;
    }
  }

  resetTrajectory() {
    this.trajectoryPoints.length = 0;
    this.trajectoryCursor = 0;
    if (this.trajectoryHeader) this.trajectoryReadSeq = Atomics.load(this.trajectoryHeader, 0);
  }

  appendTrajectoryPoint(time, position, speed, flags = 0) {
    if (!Number.isFinite(time) || !Number.isFinite(position)) return;
    const point = {
      time,
      position: clamp(position, 0, this.duration || Number.MAX_SAFE_INTEGER),
      speed: clamp(Number(speed) || 0, -12, 12),
      flags: Number(flags) || 0
    };
    const last = this.trajectoryPoints[this.trajectoryPoints.length - 1];
    if (last && point.time < last.time) {
      // Coalesced events occasionally arrive with equal or slightly reordered
      // timestamps. Preserve monotonicity rather than making the needle jump.
      point.time = last.time;
    }
    this.trajectoryPoints.push(point);
  }

  pullTrajectory() {
    if (!this.trajectoryHeader || !this.trajectoryData || !this.trajectoryCapacity) return;
    const writeSeq = Atomics.load(this.trajectoryHeader, 0);
    if (writeSeq - this.trajectoryReadSeq > this.trajectoryCapacity) {
      this.trajectoryReadSeq = writeSeq - this.trajectoryCapacity;
    }
    while (this.trajectoryReadSeq < writeSeq) {
      const index = this.trajectoryReadSeq % this.trajectoryCapacity;
      const base = index * TRAJECTORY_FIELDS;
      this.appendTrajectoryPoint(
        this.trajectoryData[base],
        this.trajectoryData[base + 1],
        this.trajectoryData[base + 2],
        this.trajectoryData[base + 3]
      );
      this.trajectoryReadSeq++;
    }
  }

  onMessage(message) {
    switch (message.type) {
      case "load": {
        const buffers = Array.isArray(message.channels) ? message.channels : [];
        this.channels = buffers.map(buffer => new Float32Array(buffer));
        this.sourceSampleRate = Number(message.sourceSampleRate) || sampleRate;
        this.length = Number(message.length) || (this.channels[0]?.length || 0);
        this.duration = this.length / this.sourceSampleRate;
        this.position = 0;
        this.speed = 0;
        this.mode = "stop";
        this.motionGain = 0;
        this.edgeSent = false;
        this.slipActive = false;
        this.jumpPhase = "none";
        this.pendingTouchEnd = null;
        this.dcX[0] = this.dcX[1] = this.dcY[0] = this.dcY[1] = 0;
        this.resetTrajectory();
        this.postState(true);
        break;
      }
      case "seek": {
        const seconds = clamp(Number(message.position) || 0, 0, this.duration);
        this.position = seconds * this.sourceSampleRate;
        this.speed = 0;
        this.edgeSent = false;
        this.jumpPhase = "none";
        this.pendingTouchEnd = null;
        this.resetTrajectory();
        this.postState(true);
        break;
      }
      case "play": {
        const playing = Boolean(message.playing);
        this.mode = playing ? "motor" : "stop";
        this.edgeSent = false;
        break;
      }
      case "touchStart": {
        this.touchWasMotor = Boolean(message.wasMotor);
        this.mode = "touch";
        this.touchStartPosition = clamp((Number(message.position) || 0) * this.sourceSampleRate, 0, Math.max(0, this.length - 1));
        this.position = this.touchStartPosition;
        this.lastTouchPosition = this.position;
        this.speed = Number.isFinite(message.speed) ? clamp(Number(message.speed), -12, 12) : this.speed;
        this.slipActive = this.slipEnabled && this.touchWasMotor;
        this.slipPosition = this.position;
        this.edgeSent = false;
        this.jumpPhase = "none";
        this.pendingTouchEnd = null;
        this.trajectoryPoints.length = 0;
        this.trajectoryCursor = 0;
        if (this.trajectoryHeader && Number.isFinite(message.startSeq)) {
          this.trajectoryReadSeq = Math.max(0, Number(message.startSeq) | 0);
        } else if (this.trajectoryHeader) {
          this.trajectoryReadSeq = Atomics.load(this.trajectoryHeader, 0);
        }
        this.appendTrajectoryPoint(
          Number.isFinite(message.time) ? Number(message.time) : currentTime,
          this.touchStartPosition / this.sourceSampleRate,
          Number(message.speed) || 0,
          1
        );
        break;
      }
      case "trajectory": {
        const points = Array.isArray(message.points) ? message.points : [];
        for (const point of points) {
          this.appendTrajectoryPoint(Number(point.time), Number(point.position), Number(point.speed), Number(point.flags));
        }
        break;
      }
      case "touchEnd": {
        this.pendingTouchEnd = {
          resumeMotor: Boolean(message.resumeMotor),
          releaseSpeed: clamp(Number(message.speed) || 0, -12, 12),
          endSeq: Number.isFinite(message.endSeq) ? Math.max(0, Number(message.endSeq) | 0) : null
        };
        break;
      }
      case "config": {
        if (Number.isFinite(message.controlDelay)) this.controlDelay = clamp(Number(message.controlDelay), 0.002, 0.040);
        if (Number.isFinite(message.motorResponse)) this.motorResponse = clamp(Number(message.motorResponse), 2, 60);
        if (Number.isFinite(message.brakeResponse)) this.brakeResponse = clamp(Number(message.brakeResponse), 2, 90);
        if (Number.isFinite(message.inertiaDecay)) this.inertiaDecay = clamp(Number(message.inertiaDecay), 0.4, 22);
        if (typeof message.rawMode === "boolean") this.rawMode = message.rawMode;
        if (typeof message.slipEnabled === "boolean") this.slipEnabled = message.slipEnabled;
        if (typeof message.loop === "boolean") this.loop = message.loop;
        break;
      }
      default:
        break;
    }
  }

  trajectoryPositionAt(timeSeconds) {
    const points = this.trajectoryPoints;
    if (!points.length) {
      return { position: this.touchStartPosition / this.sourceSampleRate, speed: 0 };
    }

    while (this.trajectoryCursor + 1 < points.length && points[this.trajectoryCursor + 1].time <= timeSeconds) {
      this.trajectoryCursor++;
    }

    const current = points[this.trajectoryCursor];
    const next = points[this.trajectoryCursor + 1];
    if (next && next.time > current.time && timeSeconds >= current.time) {
      const amount = clamp((timeSeconds - current.time) / (next.time - current.time), 0, 1);
      return {
        position: current.position + (next.position - current.position) * amount,
        speed: (next.position - current.position) / (next.time - current.time)
      };
    }

    if (timeSeconds < current.time) {
      const previous = points[Math.max(0, this.trajectoryCursor - 1)] || current;
      return { position: previous.position, speed: 0 };
    }

    // A tiny bounded extrapolation bridges the tail of a 60 Hz pointer frame.
    // It then hard-locks beneath a stationary finger instead of drifting.
    const age = Math.max(0, timeSeconds - current.time);
    if (age <= 0.008 && Math.abs(current.speed) > 0.001) {
      return { position: current.position + current.speed * age, speed: current.speed };
    }
    return { position: current.position, speed: 0 };
  }


  finishTouch(pending) {
    if (!pending) return;
    const resumeMotor = pending.resumeMotor;
    const releaseSpeed = pending.releaseSpeed;
    if (resumeMotor) {
      if (this.slipActive) {
        this.pendingJumpPosition = this.slipPosition;
        this.jumpPhase = "out";
        this.jumpCount = 0;
      }
      this.mode = "motor";
      this.speed = releaseSpeed;
    } else if (Math.abs(releaseSpeed) > 0.10) {
      this.mode = "inertia";
      this.speed = releaseSpeed;
    } else {
      this.mode = "stop";
      this.speed = 0;
    }
    this.pendingTouchEnd = null;
    this.slipActive = false;
    this.edgeSent = false;
  }

  maybeFinishTouch(targetTime) {
    const pending = this.pendingTouchEnd;
    if (!pending || this.mode !== "touch") return;
    const sequenceReady = !this.trajectoryHeader || pending.endSeq == null || this.trajectoryReadSeq >= pending.endSeq;
    const last = this.trajectoryPoints[this.trajectoryPoints.length - 1];
    const timeReady = !last || targetTime >= last.time;
    if (sequenceReady && timeReady) this.finishTouch(pending);
  }

  rawSample(channel, position) {
    const data = this.channels[channel] || this.channels[0];
    if (!data || !this.length) return 0;
    const i0 = Math.floor(position);
    const fraction = position - i0;
    const a = data[this.resolveIndex(i0)];
    const b = data[this.resolveIndex(i0 + 1)];
    return a + (b - a) * fraction;
  }

  resolveIndex(index) {
    if (this.loop && this.length > 1) return ((index % this.length) + this.length) % this.length;
    return clamp(index, 0, this.length - 1);
  }

  cleanSample(channel, position, speed) {
    const data = this.channels[channel] || this.channels[0];
    if (!data || !this.length) return 0;
    const center = Math.floor(position);
    const fraction = position - center;
    const phase = clamp(Math.floor(fraction * this.resampler.phases), 0, this.resampler.phases - 1);
    const table = this.resampler.tableForSpeed(speed);
    const tableBase = phase * this.resampler.taps;
    let total = 0;
    for (let tap = 0; tap < this.resampler.taps; tap++) {
      const offset = tap - (this.resampler.radius - 1);
      total += data[this.resolveIndex(center + offset)] * table[tableBase + tap];
    }
    return total;
  }

  readSample(channel, position, speed) {
    return this.rawMode ? this.rawSample(channel, position) : this.cleanSample(channel, position, speed);
  }

  highPass(channel, input) {
    const output = input - this.dcX[channel] + this.dcR * this.dcY[channel];
    this.dcX[channel] = input;
    this.dcY[channel] = output;
    return output;
  }

  updateJump() {
    if (this.jumpPhase === "none") return 1;
    if (this.jumpPhase === "out") {
      const gain = 1 - this.jumpCount / this.jumpLength;
      this.jumpCount++;
      if (this.jumpCount >= this.jumpLength) {
        this.position = clamp(this.pendingJumpPosition, 0, Math.max(0, this.length - 1));
        this.speed = 1;
        this.jumpPhase = "in";
        this.jumpCount = 0;
      }
      return clamp(gain, 0, 1);
    }
    const gain = this.jumpCount / this.jumpLength;
    this.jumpCount++;
    if (this.jumpCount >= this.jumpLength) {
      this.jumpPhase = "none";
      this.jumpCount = 0;
      return 1;
    }
    return clamp(gain, 0, 1);
  }

  advancePhysicalModel() {
    if (this.mode === "motor") {
      const alpha = 1 - Math.exp(-this.motorResponse / sampleRate);
      this.speed += (1 - this.speed) * alpha;
      this.position += this.speed * this.sourceSampleRate / sampleRate;
    } else if (this.mode === "inertia") {
      this.speed *= Math.exp(-this.inertiaDecay / sampleRate);
      this.position += this.speed * this.sourceSampleRate / sampleRate;
      if (Math.abs(this.speed) < 0.004) {
        this.speed = 0;
        this.mode = "stop";
      }
    } else if (this.mode === "stop") {
      const alpha = 1 - Math.exp(-this.brakeResponse / sampleRate);
      this.speed += (0 - this.speed) * alpha;
      this.position += this.speed * this.sourceSampleRate / sampleRate;
      if (Math.abs(this.speed) < 0.0004) this.speed = 0;
    }
  }

  handleEdge() {
    if (this.loop && this.length > 1) {
      this.position = ((this.position % this.length) + this.length) % this.length;
      if (this.slipActive) this.slipPosition = ((this.slipPosition % this.length) + this.length) % this.length;
      return false;
    }

    if (this.position < 0 || this.position >= this.length - 1) {
      this.position = clamp(this.position, 0, Math.max(0, this.length - 1));
      this.speed = 0;
      this.mode = "stop";
      if (!this.edgeSent) {
        this.edgeSent = true;
        this.port.postMessage({ type: "edge", position: this.position / this.sourceSampleRate });
      }
      return true;
    }
    return false;
  }

  postState(force = false) {
    if (!force && this.stateCountdown > 0) return;
    this.stateCountdown = 512;
    this.port.postMessage({
      type: "state",
      position: this.sourceSampleRate ? this.position / this.sourceSampleRate : 0,
      duration: this.duration,
      speed: this.speed,
      mode: this.mode,
      sharedTrajectory: Boolean(this.trajectoryHeader),
      controlDelay: this.controlDelay,
      slipActive: this.slipActive
    });
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const left = output[0];
    const right = output[1] || output[0];
    left.fill(0);
    if (right !== left) right.fill(0);

    if (!this.channels || !this.length) {
      this.stateCountdown -= left.length;
      this.postState();
      return true;
    }

    this.pullTrajectory();

    for (let i = 0; i < left.length; i++) {
      if (this.mode === "touch") {
        const renderTime = currentTime + i / sampleRate;
        const targetTime = renderTime - this.controlDelay;
        const target = this.trajectoryPositionAt(targetTime);
        const nextPosition = clamp(target.position * this.sourceSampleRate, 0, Math.max(0, this.length - 1));
        this.speed = clamp((nextPosition - this.lastTouchPosition) / this.sourceSampleRate * sampleRate, -12, 12);
        this.position = nextPosition;
        this.lastTouchPosition = nextPosition;
        if (this.slipActive) this.slipPosition += this.sourceSampleRate / sampleRate;
        this.maybeFinishTouch(targetTime);
      } else {
        this.advancePhysicalModel();
      }

      const edge = this.handleEdge();
      const wantedGain = this.mode === "motor"
        ? 1
        : smoothstep(0.0012, 0.020, Math.abs(this.speed));
      const gainAlpha = 1 - Math.exp(-1 / (sampleRate * 0.0022));
      this.motionGain += (wantedGain - this.motionGain) * gainAlpha;
      const jumpGain = this.updateJump();

      if (!edge && this.motionGain > 0.00005) {
        const rawLeft = this.readSample(0, this.position, this.speed);
        const rawRight = this.readSample(this.channels.length > 1 ? 1 : 0, this.position, this.speed);
        left[i] = this.highPass(0, rawLeft) * this.motionGain * jumpGain;
        right[i] = this.highPass(1, rawRight) * this.motionGain * jumpGain;
      }
    }

    if (this.trajectoryCursor > 64) {
      this.trajectoryPoints.splice(0, this.trajectoryCursor - 1);
      this.trajectoryCursor = 1;
    }

    this.stateCountdown -= left.length;
    this.postState();
    return true;
  }
}

registerProcessor("vinyl-scratch-processor", VinylScratchProcessor);
