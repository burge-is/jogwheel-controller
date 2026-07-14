import { JogWheel } from "../../src/JogWheel.js";

(() => {
  "use strict";

  const TAU = Math.PI * 2;
  const TRAJECTORY_CAPACITY = 2048;
  const TRAJECTORY_HEADER_BYTES = 16;
  const TRAJECTORY_FIELDS = 4;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
  const master = audioContext.createGain();
  master.gain.value = 0.82;
  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -7;
  compressor.knee.value = 8;
  compressor.ratio.value = 5;
  compressor.attack.value = 0.0025;
  compressor.release.value = 0.11;
  master.connect(compressor).connect(audioContext.destination);

  let workletFailure = null;
  const workletReady = (async () => {
    if (!window.isSecureContext) {
      throw new Error("Open this through the included Node server at http://127.0.0.1:8787");
    }
    if (!audioContext.audioWorklet || !window.AudioWorkletNode) {
      throw new Error("This browser does not expose AudioWorklet.");
    }
    await audioContext.audioWorklet.addModule(new URL("./scratch-worklet.js", location.href));
    return true;
  })().catch(error => {
    workletFailure = error;
    console.error(error);
    queueMicrotask(() => showToast(error.message || "AudioWorklet failed"));
    throw error;
  });

  async function resumeAudio() {
    if (audioContext.state !== "running") await audioContext.resume();
    await workletReady;
  }
  document.addEventListener("pointerdown", () => { resumeAudio().catch(() => {}); }, { passive: true });

  class TrajectoryWriter {
    constructor(capacity = TRAJECTORY_CAPACITY) {
      this.capacity = capacity;
      this.shared = Boolean(window.crossOriginIsolated && typeof SharedArrayBuffer === "function");
      this.buffer = null;
      this.header = null;
      this.data = null;
      if (this.shared) {
        this.buffer = new SharedArrayBuffer(TRAJECTORY_HEADER_BYTES + capacity * TRAJECTORY_FIELDS * Float64Array.BYTES_PER_ELEMENT);
        this.header = new Int32Array(this.buffer, 0, 4);
        this.data = new Float64Array(this.buffer, TRAJECTORY_HEADER_BYTES);
      }
    }

    sequence() {
      return this.shared ? Atomics.load(this.header, 0) : 0;
    }

    write(point) {
      if (!this.shared) return;
      const sequence = Atomics.load(this.header, 0);
      const index = sequence % this.capacity;
      const base = index * TRAJECTORY_FIELDS;
      this.data[base] = Number(point.time) || audioContext.currentTime;
      this.data[base + 1] = Number(point.position) || 0;
      this.data[base + 2] = Number(point.speed) || 0;
      this.data[base + 3] = Number(point.flags) || 0;
      Atomics.store(this.header, 0, sequence + 1);
    }

    writeMany(points) {
      if (!this.shared) return;
      for (const point of points) this.write(point);
    }
  }

  class ScratchEngine extends EventTarget {
    constructor(output) {
      super();
      this.output = output;
      this.node = null;
      this.trajectory = new TrajectoryWriter();
      this.gain = audioContext.createGain();
      this.gain.gain.value = Math.SQRT1_2;
      this.position = 0;
      this.positionSamples = 0;
      this.duration = 0;
      this.sourceSampleRate = 48000;
      this.speed = 0;
      this.mode = "stop";
      this.playing = false;
      this.loaded = false;
      this.sharedTrajectory = this.trajectory.shared;
      this.stateAudioTime = audioContext.currentTime;
      this.ready = this.initialize();
    }

    async initialize() {
      await workletReady;
      const processorOptions = this.trajectory.shared ? {
        trajectoryBuffer: this.trajectory.buffer,
        trajectoryCapacity: this.trajectory.capacity
      } : {};
      this.node = new AudioWorkletNode(audioContext, "vinyl-scratch-processor", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions
      });
      this.node.port.onmessage = event => this.onMessage(event.data || {});
      this.node.connect(this.gain).connect(this.output);
      this.dispatchEvent(new CustomEvent("ready"));
      return this;
    }

    onMessage(message) {
      if (message.type === "state") {
        this.position = Number(message.position) || 0;
        this.positionSamples = this.position * this.sourceSampleRate;
        this.duration = Number(message.duration) || this.duration;
        this.speed = Number(message.speed) || 0;
        this.mode = message.mode || this.mode;
        this.playing = this.mode === "motor";
        this.sharedTrajectory = Boolean(message.sharedTrajectory);
        this.stateAudioTime = audioContext.currentTime;
        this.dispatchEvent(new CustomEvent("state", { detail: { ...message } }));
      } else if (message.type === "edge") {
        this.position = Number(message.position) || this.position;
        this.speed = 0;
        this.mode = "stop";
        this.playing = false;
        this.dispatchEvent(new CustomEvent("edge", { detail: { position: this.position } }));
      }
    }

    send(message, transfer = []) {
      if (this.node) {
        this.node.port.postMessage(message, transfer);
      } else {
        this.ready.then(() => this.node.port.postMessage(message, transfer)).catch(() => {});
      }
    }

    async setBuffer(buffer) {
      await this.ready;
      const channelCount = Math.min(2, Math.max(1, buffer.numberOfChannels));
      const channelBuffers = [];
      const transfer = [];
      for (let channel = 0; channel < channelCount; channel++) {
        const copy = new Float32Array(buffer.length);
        copy.set(buffer.getChannelData(channel));
        channelBuffers.push(copy.buffer);
        transfer.push(copy.buffer);
      }
      this.sourceSampleRate = buffer.sampleRate;
      this.duration = buffer.duration;
      this.position = 0;
      this.positionSamples = 0;
      this.speed = 0;
      this.mode = "stop";
      this.playing = false;
      this.loaded = true;
      this.node.port.postMessage({
        type: "load",
        channels: channelBuffers,
        sourceSampleRate: buffer.sampleRate,
        length: buffer.length
      }, transfer);
    }

    setGain(value, immediate = false) {
      const now = audioContext.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      if (immediate) this.gain.gain.setValueAtTime(value, now);
      else this.gain.gain.setTargetAtTime(value, now, 0.012);
    }

    estimatedPosition(atTime = audioContext.currentTime) {
      if (!this.loaded) return 0;
      if (this.mode === "touch") return this.position;
      const age = clamp(atTime - this.stateAudioTime, 0, 0.05);
      return clamp(this.position + this.speed * age, 0, this.duration);
    }

    seek(seconds) {
      if (!this.loaded) return;
      this.position = clamp(seconds, 0, this.duration);
      this.positionSamples = this.position * this.sourceSampleRate;
      this.send({ type: "seek", position: this.position });
    }

    setPlaying(playing) {
      if (!this.loaded) return false;
      this.playing = Boolean(playing);
      this.mode = this.playing ? "motor" : "stop";
      this.send({ type: "play", playing: this.playing });
      return this.playing;
    }

    togglePlay() {
      return this.setPlaying(!this.playing);
    }

    beginTouch(position, { audioTime = audioContext.currentTime, wasMotor = this.playing } = {}) {
      if (!this.loaded) return;
      const startSeq = this.trajectory.sequence();
      this.playing = false;
      this.mode = "touch";
      this.position = clamp(position, 0, this.duration);
      this.positionSamples = this.position * this.sourceSampleRate;
      this.send({
        type: "touchStart",
        position: this.position,
        time: audioTime,
        startSeq,
        wasMotor: Boolean(wasMotor),
        speed: this.speed
      });
    }

    touchPoints(points) {
      if (!this.loaded || !points.length) return;
      const cleaned = points.map(point => ({
        time: Number(point.time) || audioContext.currentTime,
        position: clamp(Number(point.position) || 0, 0, this.duration),
        speed: clamp(Number(point.speed) || 0, -12, 12),
        flags: Number(point.flags) || 0
      }));
      const last = cleaned[cleaned.length - 1];
      this.position = last.position;
      this.positionSamples = this.position * this.sourceSampleRate;
      this.speed = last.speed;
      this.mode = "touch";
      if (this.trajectory.shared) this.trajectory.writeMany(cleaned);
      else this.send({ type: "trajectory", points: cleaned });
    }

    endTouch({ releaseSpeed = 0, resumeMotor = false } = {}) {
      if (!this.loaded) return;
      const speed = clamp(releaseSpeed, -12, 12);
      this.playing = Boolean(resumeMotor);
      this.mode = resumeMotor ? "motor" : Math.abs(speed) > 0.10 ? "inertia" : "stop";
      this.speed = resumeMotor || Math.abs(speed) > 0.10 ? speed : 0;
      this.send({
        type: "touchEnd",
        resumeMotor: Boolean(resumeMotor),
        speed,
        endSeq: this.trajectory.sequence()
      });
    }

    configure(config = {}) {
      this.send({ type: "config", ...config });
    }
  }

  class DeckController extends EventTarget {
    constructor(root, index) {
      super();
      this.root = root;
      this.index = index;
      this.side = root.dataset.side;
      this.engine = new ScratchEngine(master);
      this.instrument = root.querySelector(".thumb-instrument");
      this.wheelHit = root.querySelector(".wheel-hit");
      this.jogWheel = new JogWheel(this.wheelHit, { keyboard: false });
      this.centerButton = root.querySelector(".center-button");
      this.gear = root.querySelector(".gear");
      this.gearValue = root.querySelector(".gear-value");
      this.fileInput = root.querySelector(".file-input");
      this.loadButton = root.querySelector(".load-button");
      this.fileName = root.querySelector(".file-name");
      this.timeReadout = root.querySelector(".time-readout");
      this.status = root.querySelector(".deck-status");
      this.overviewWrap = root.querySelector(".overview-wrap");
      this.overview = root.querySelector(".overview");
      this.scope = root.querySelector(".scope");
      this.overviewCtx = this.overview.getContext("2d");
      this.scopeCtx = this.scope.getContext("2d");
      this.overviewCache = document.createElement("canvas");
      this.cacheCtx = this.overviewCache.getContext("2d");
      this.teethRoot = root.querySelector(".teeth");
      this.angle = 0;
      this.drag = null;
      this.linkedDrag = null;
      this.gearDrag = null;
      this.replaying = null;
      this.replayTimer = 0;
      this.recordingEnabled = true;
      this.capture = null;
      this.lastGesture = null;
      this.name = "";
      this.peaks = null;
      this.scopeMin = null;
      this.scopeMax = null;
      this.transients = [];
      this.scopeHz = 512;
      this.lastHapticAt = 0;
      this.lastTickIndex = 0;
      this.idleTimer = 0;
      this.ghostTimer = 0;
      this.lastFrame = performance.now();
      this.slipEnabled = false;
      this.levels = [
        { teeth: 128, secondsPerRev: 0.45, label: ".45s" },
        { teeth: 64, secondsPerRev: 0.90, label: ".90s" },
        { teeth: 32, secondsPerRev: 1.80, label: "1.8s" },
        { teeth: 16, secondsPerRev: 3.60, label: "3.6s" },
        { teeth: 8, secondsPerRev: 7.20, label: "7.2s" }
      ];
      this.levelIndex = 2;
      this.resizeObserver = new ResizeObserver(() => this.resizeCanvases());
      this.resizeObserver.observe(root);
      this.bind();
      this.applyLevel(2, false);
      this.armFade();
    }

    bind() {
      this.loadButton.addEventListener("click", () => this.fileInput.click());
      this.fileInput.addEventListener("change", event => {
        const file = event.target.files && event.target.files[0];
        if (file) this.loadFile(file);
        event.target.value = "";
      });

      this.centerButton.addEventListener("pointerdown", event => {
        event.stopPropagation();
        this.wake();
        this.centerButton.classList.add("down");
      });
      this.centerButton.addEventListener("pointerup", async event => {
        event.stopPropagation();
        this.centerButton.classList.remove("down");
        try {
          await resumeAudio();
        } catch (error) {
          this.toast(error.message || "Audio engine unavailable");
          return;
        }
        if (!this.engine.loaded) {
          this.fileInput.click();
          return;
        }
        const playing = this.engine.togglePlay();
        this.updatePlayUI(playing);
        this.haptic(playing ? [12] : [7]);
        this.emit("play", { playing });
        this.armFade();
      });
      this.centerButton.addEventListener("pointercancel", () => this.centerButton.classList.remove("down"));

      this.jogWheel.addEventListener("start", event => this.onWheelDown(event.detail));
      this.jogWheel.addEventListener("move", event => this.onWheelMove(event.detail));
      this.jogWheel.addEventListener("end", event => this.onWheelUp(event.detail));

      this.gear.addEventListener("pointerdown", event => this.onGearDown(event));
      window.addEventListener("pointermove", event => this.onGearMove(event), { passive: false });
      window.addEventListener("pointerup", event => this.onGearUp(event));
      window.addEventListener("pointercancel", event => this.onGearUp(event));

      this.overviewWrap.addEventListener("pointerdown", event => {
        if (!this.engine.loaded) return;
        event.preventDefault();
        this.wake();
        const rect = this.overviewWrap.getBoundingClientRect();
        const position = clamp((event.clientX - rect.left) / rect.width, 0, 1) * this.engine.duration;
        this.engine.seek(position);
        this.angle = position / this.level.secondsPerRev * TAU;
        this.applyAngle();
        this.haptic([5]);
        this.emit("seek", { position, source: "waveform" });
      });

      this.engine.addEventListener("state", event => {
        const state = event.detail;
        if (!this.drag && !this.linkedDrag && !this.replaying) this.updatePlayUI(state.mode === "motor");
      });
      this.engine.addEventListener("edge", () => {
        this.updatePlayUI(false);
        this.haptic([10, 25, 10]);
      });
    }

    updatePlayUI(playing) {
      this.root.classList.toggle("playing", Boolean(playing));
      this.centerButton.textContent = playing ? "Ⅱ" : (this.index === 0 ? "A" : "B");
    }

    async loadFile(file) {
      this.toast(`Decoding ${file.name}…`);
      try {
        await resumeAudio();
        const bytes = await file.arrayBuffer();
        const decoded = await audioContext.decodeAudioData(bytes.slice(0));
        this.buildVisualData(decoded);
        await this.engine.setBuffer(decoded);
        this.name = file.name;
        this.fileName.textContent = file.name;
        this.root.classList.add("loaded");
        this.updatePlayUI(false);
        this.renderOverviewCache();
        this.toast(`${this.side === "left" ? "A" : "B"}: ${file.name}`);
        this.emit("file", { name: file.name, duration: decoded.duration });
        this.wake();
      } catch (error) {
        console.error(error);
        this.toast(error.message || "Could not decode that file");
      }
    }

    buildVisualData(buffer) {
      const data = buffer.getChannelData(0);
      const overviewCount = 1600;
      const overviewBlock = Math.max(1, Math.floor(data.length / overviewCount));
      this.peaks = new Float32Array(overviewCount);
      for (let i = 0; i < overviewCount; i++) {
        const start = i * overviewBlock;
        const end = Math.min(data.length, start + overviewBlock);
        const stride = Math.max(1, Math.floor((end - start) / 36));
        let max = 0;
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j += stride) {
          const value = Math.abs(data[j]);
          if (value > max) max = value;
          sum += value * value;
          count++;
        }
        this.peaks[i] = Math.min(1, max * 0.72 + Math.sqrt(sum / Math.max(1, count)) * 0.42);
      }

      const visualBins = Math.max(1, Math.ceil(buffer.duration * this.scopeHz));
      this.scopeMin = new Float32Array(visualBins);
      this.scopeMax = new Float32Array(visualBins);
      const samplesPerBin = buffer.sampleRate / this.scopeHz;
      for (let bin = 0; bin < visualBins; bin++) {
        const start = Math.floor(bin * samplesPerBin);
        const end = Math.min(data.length, Math.ceil((bin + 1) * samplesPerBin));
        const stride = Math.max(1, Math.floor((end - start) / 28));
        let min = 0;
        let max = 0;
        for (let sample = start; sample < end; sample += stride) {
          const value = data[sample];
          if (value < min) min = value;
          if (value > max) max = value;
        }
        this.scopeMin[bin] = min;
        this.scopeMax[bin] = max;
      }

      this.transients = [];
      let baseline = 0.025;
      let lastTransient = -1;
      for (let bin = 0; bin < visualBins; bin++) {
        const amplitude = Math.max(Math.abs(this.scopeMin[bin]), Math.abs(this.scopeMax[bin]));
        const time = bin / this.scopeHz;
        if (amplitude > 0.11 && amplitude > baseline * 1.72 && time - lastTransient > 0.075) {
          this.transients.push(time);
          lastTransient = time;
        }
        baseline = baseline * 0.965 + amplitude * 0.035;
      }
    }

    eventAudioTime(sampleTimeStamp, hostTimeStamp) {
      const now = audioContext.currentTime;
      const hostStamp = Number(hostTimeStamp);
      const sampleStamp = Number(sampleTimeStamp);
      if (!Number.isFinite(hostStamp) || !Number.isFinite(sampleStamp)) return now;
      const age = clamp((hostStamp - sampleStamp) / 1000, 0, 0.08);
      return now - age;
    }

    async onWheelDown(detail) {
      try {
        await resumeAudio();
      } catch (error) {
        this.toast(error.message || "Audio engine unavailable");
        return;
      }
      if (!this.jogWheel.active || this.jogWheel.active.pointerId !== detail.pointerId) return;
      this.wake();
      this.cancelReplay();
      if (this.linkedDrag) this.endLinkedGesture({ releaseSpeed: 0 });
      const audioTime = this.eventAudioTime(detail.timeStamp, detail.timeStamp);
      this.drag = {
        id: detail.pointerId,
        audioTime,
        wasPlaying: this.engine.playing,
        speed: 0,
        targetPosition: this.engine.estimatedPosition(audioTime),
        samples: []
      };
      this.drag.samples.push({ t: audioTime, p: this.drag.targetPosition });
      this.instrument.classList.add("dragging");
      this.engine.beginTouch(this.drag.targetPosition, { audioTime, wasMotor: this.drag.wasPlaying });
      this.beginCapture(this.drag.targetPosition, audioTime, "finger", this.drag.wasPlaying);
      this.emit("start", { position: this.drag.targetPosition, audioTime, wasPlaying: this.drag.wasPlaying });
    }

    onWheelMove(detail) {
      if (!this.drag || detail.pointerId !== this.drag.id) return;
      const trajectory = [];
      let appliedDeltaSeconds = 0;

      for (const point of detail.points) {
        const audioTime = this.eventAudioTime(point.timeStamp, detail.timeStamp);
        const deltaSeconds = point.deltaAngle / TAU * this.level.secondsPerRev;
        const before = this.drag.targetPosition;
        const after = this.engine.loaded ? clamp(before + deltaSeconds, 0, this.engine.duration) : before;
        const applied = after - before;
        const dt = Math.max(1 / 1000, audioTime - this.drag.audioTime);
        const localSpeed = clamp(applied / dt, -12, 12);

        this.drag.audioTime = audioTime;
        this.drag.targetPosition = after;
        this.drag.samples.push({ t: audioTime, p: after });
        trajectory.push({
          time: audioTime,
          position: after,
          speed: localSpeed,
          deltaSeconds: applied,
          deltaAngle: point.deltaAngle
        });
        appliedDeltaSeconds += applied;
      }

      if (!trajectory.length) return;
      const newestTime = trajectory[trajectory.length - 1].time;
      this.drag.samples = this.drag.samples.filter(sample => newestTime - sample.t <= 0.062);
      const fittedSpeed = this.fitVelocity(this.drag.samples);
      this.drag.speed = this.drag.speed * 0.18 + fittedSpeed * 0.82;
      trajectory[trajectory.length - 1].speed = this.drag.speed;
      this.angle += detail.deltaAngle;

      if (this.engine.loaded) this.engine.touchPoints(trajectory);
      this.recordCapturePoints(trajectory);
      this.applyAngle();
      this.checkTicks();
      this.emit("motion", {
        points: trajectory,
        deltaAngle: detail.deltaAngle,
        angle: this.angle,
        deltaSeconds: appliedDeltaSeconds,
        position: this.drag.targetPosition,
        speed: this.drag.speed,
        secondsPerRev: this.level.secondsPerRev,
        teeth: this.level.teeth
      });
    }

    fitVelocity(samples) {
      if (!samples || samples.length < 2) return 0;
      const latest = samples[samples.length - 1].t;
      let meanT = 0;
      let meanP = 0;
      for (const sample of samples) {
        meanT += sample.t - latest;
        meanP += sample.p;
      }
      meanT /= samples.length;
      meanP /= samples.length;
      let numerator = 0;
      let denominator = 0;
      for (const sample of samples) {
        const t = sample.t - latest - meanT;
        const p = sample.p - meanP;
        numerator += t * p;
        denominator += t * t;
      }
      return denominator > 1e-10 ? clamp(numerator / denominator, -12, 12) : 0;
    }

    onWheelUp(detail) {
      if (!this.drag || detail.pointerId !== this.drag.id) return;
      const releaseSpeed = this.fitVelocity(this.drag.samples);
      const wasPlaying = this.drag.wasPlaying;
      const endPosition = this.drag.targetPosition;
      this.drag = null;
      this.instrument.classList.remove("dragging");
      this.engine.endTouch({ releaseSpeed, resumeMotor: wasPlaying });
      this.finishCapture(releaseSpeed, wasPlaying);
      this.updatePlayUI(wasPlaying);
      this.emit("end", { position: endPosition, releaseSpeed, resumed: wasPlaying });
      this.armFade();
    }

    beginLinkedGesture(detail) {
      if (!this.engine.loaded || this.drag || this.linkedDrag || this.replaying) return false;
      const audioTime = Number(detail.audioTime) || audioContext.currentTime;
      this.wake();
      this.linkedDrag = {
        source: detail.deck,
        targetPosition: this.engine.estimatedPosition(audioTime),
        wasPlaying: this.engine.playing,
        samples: []
      };
      this.linkedDrag.samples.push({ t: audioTime, p: this.linkedDrag.targetPosition });
      this.instrument.classList.add("linked");
      this.engine.beginTouch(this.linkedDrag.targetPosition, { audioTime, wasMotor: this.linkedDrag.wasPlaying });
      this.beginCapture(this.linkedDrag.targetPosition, audioTime, "link", this.linkedDrag.wasPlaying);
      return true;
    }

    applyLinkedPoints(sourcePoints) {
      if (!this.linkedDrag || !sourcePoints?.length) return;
      const points = [];
      let angleDelta = 0;
      for (const source of sourcePoints) {
        const before = this.linkedDrag.targetPosition;
        const after = clamp(before + Number(source.deltaSeconds || 0), 0, this.engine.duration);
        const applied = after - before;
        this.linkedDrag.targetPosition = after;
        this.linkedDrag.samples.push({ t: source.time, p: after });
        points.push({ time: source.time, position: after, speed: source.speed, deltaSeconds: applied });
        angleDelta += applied / this.level.secondsPerRev * TAU;
      }
      const newest = points[points.length - 1].time;
      this.linkedDrag.samples = this.linkedDrag.samples.filter(sample => newest - sample.t <= 0.062);
      this.angle += angleDelta;
      this.engine.touchPoints(points);
      this.recordCapturePoints(points);
      this.applyAngle();
      this.checkTicks();
    }

    endLinkedGesture(detail) {
      if (!this.linkedDrag) return;
      const releaseSpeed = Number.isFinite(detail.releaseSpeed)
        ? Number(detail.releaseSpeed)
        : this.fitVelocity(this.linkedDrag.samples);
      const resumeMotor = this.linkedDrag.wasPlaying;
      this.linkedDrag = null;
      this.instrument.classList.remove("linked");
      this.engine.endTouch({ releaseSpeed, resumeMotor });
      this.finishCapture(releaseSpeed, resumeMotor);
      this.updatePlayUI(resumeMotor);
      this.armFade();
    }

    beginCapture(basePosition, startAudioTime, source, wasPlaying) {
      if (!this.recordingEnabled) {
        this.capture = null;
        return;
      }
      this.capture = {
        basePosition,
        startAudioTime,
        source,
        wasPlaying,
        points: [{ t: 0, offset: 0, speed: 0 }]
      };
    }

    recordCapturePoints(points) {
      if (!this.capture) return;
      for (const point of points) {
        const t = Math.max(0, point.time - this.capture.startAudioTime);
        if (t > 20) break;
        const last = this.capture.points[this.capture.points.length - 1];
        if (last && t - last.t < 0.0025 && this.capture.points.length > 2) {
          last.t = t;
          last.offset = point.position - this.capture.basePosition;
          last.speed = point.speed;
        } else {
          this.capture.points.push({
            t,
            offset: point.position - this.capture.basePosition,
            speed: point.speed
          });
        }
        if (this.capture.points.length >= 1800) break;
      }
    }

    finishCapture(releaseSpeed, resumeMotor) {
      if (!this.capture) return;
      const capture = this.capture;
      this.capture = null;
      if (capture.points.length < 2) return;
      capture.duration = capture.points[capture.points.length - 1].t;
      capture.releaseSpeed = clamp(releaseSpeed, -12, 12);
      capture.resumeMotor = Boolean(resumeMotor);
      this.lastGesture = capture;
      this.emit("recorded", {
        duration: capture.duration,
        points: capture.points.length,
        source: capture.source
      });
    }

    async replayGesture() {
      if (!this.lastGesture || !this.engine.loaded || this.drag || this.linkedDrag) return false;
      await resumeAudio();
      this.cancelReplay();
      const gesture = this.lastGesture;
      const basePosition = this.engine.estimatedPosition();
      const baseAngle = this.angle;
      const lead = 0.045;
      const baseAudioTime = audioContext.currentTime + lead;
      const points = gesture.points.map(point => ({
        time: baseAudioTime + point.t,
        position: clamp(basePosition + point.offset, 0, this.engine.duration),
        speed: point.speed
      }));
      const wasPlaying = this.engine.playing;
      this.engine.beginTouch(basePosition, { audioTime: baseAudioTime, wasMotor: wasPlaying });
      if (points.length > 1) this.engine.touchPoints(points.slice(1));
      this.replaying = {
        gesture,
        basePosition,
        baseAngle,
        baseAudioTime,
        wasPlaying
      };
      this.instrument.classList.add("replaying");
      this.wake();
      this.replayTimer = window.setTimeout(() => {
        if (!this.replaying) return;
        this.engine.endTouch({ releaseSpeed: gesture.releaseSpeed, resumeMotor: wasPlaying });
        this.replaying = null;
        this.instrument.classList.remove("replaying");
        this.updatePlayUI(wasPlaying);
        this.armFade();
      }, Math.max(0, (lead + gesture.duration) * 1000 + 8));
      this.emit("replay", { duration: gesture.duration, points: gesture.points.length });
      return true;
    }

    cancelReplay() {
      if (!this.replaying) return;
      clearTimeout(this.replayTimer);
      const wasPlaying = this.replaying.wasPlaying;
      this.replaying = null;
      this.instrument.classList.remove("replaying");
      this.engine.endTouch({ releaseSpeed: 0, resumeMotor: wasPlaying });
    }

    replayOffsetAt(elapsed) {
      const points = this.replaying?.gesture.points;
      if (!points?.length) return 0;
      if (elapsed <= 0) return points[0].offset;
      if (elapsed >= points[points.length - 1].t) return points[points.length - 1].offset;
      let low = 0;
      let high = points.length - 1;
      while (low + 1 < high) {
        const mid = (low + high) >> 1;
        if (points[mid].t <= elapsed) low = mid;
        else high = mid;
      }
      const a = points[low];
      const b = points[high];
      const amount = clamp((elapsed - a.t) / Math.max(1e-6, b.t - a.t), 0, 1);
      return a.offset + (b.offset - a.offset) * amount;
    }

    setRecording(enabled) {
      this.recordingEnabled = Boolean(enabled);
      if (!enabled) this.capture = null;
    }

    setSlip(enabled) {
      this.slipEnabled = Boolean(enabled);
      this.engine.configure({ slipEnabled: this.slipEnabled });
    }

    onGearDown(event) {
      event.preventDefault();
      event.stopPropagation();
      this.wake();
      this.gear.setPointerCapture?.(event.pointerId);
      this.gearDrag = { id: event.pointerId };
      this.instrument.classList.add("gear-dragging");
      this.updateGearFromPointer(event);
    }

    onGearMove(event) {
      if (!this.gearDrag || event.pointerId !== this.gearDrag.id) return;
      event.preventDefault();
      this.updateGearFromPointer(event);
    }

    onGearUp(event) {
      if (!this.gearDrag || event.pointerId !== this.gearDrag.id) return;
      this.gear.releasePointerCapture?.(event.pointerId);
      this.gearDrag = null;
      this.instrument.classList.remove("gear-dragging");
      this.haptic([9, 24, 5]);
      this.armFade();
    }

    updateGearFromPointer(event) {
      const rect = this.gear.getBoundingClientRect();
      const t = clamp((event.clientY - rect.top - 10) / Math.max(1, rect.height - 20), 0, 1);
      const index = Math.round(t * (this.levels.length - 1));
      this.applyLevel(index, true);
    }

    applyLevel(index, notify = true) {
      index = clamp(index, 0, this.levels.length - 1);
      if (index === this.levelIndex && notify) return;
      this.levelIndex = index;
      this.level = this.levels[index];
      this.instrument.style.setProperty("--gear-y", `${10 + index / (this.levels.length - 1) * 80}%`);
      this.gearValue.textContent = this.level.label;
      this.buildTeeth();
      this.lastTickIndex = Math.floor(this.angle / TAU * this.level.teeth);
      if (notify) {
        this.haptic([7]);
        this.emit("gear", { index, ...this.level });
      }
    }

    buildTeeth() {
      this.teethRoot.textContent = "";
      const teeth = this.level.teeth;
      const visibleTeeth = Math.min(teeth, 128);
      const majorEvery = Math.max(1, Math.round(visibleTeeth / 4));
      for (let i = 0; i < visibleTeeth; i++) {
        const tooth = document.createElement("i");
        tooth.className = "tooth" + (i % majorEvery === 0 ? " major" : "");
        tooth.style.transform = `rotate(${i / visibleTeeth * 360}deg)`;
        this.teethRoot.appendChild(tooth);
      }
    }

    applyAngle() {
      this.instrument.style.setProperty("--wheel-angle", `${this.angle * 180 / Math.PI}deg`);
    }

    checkTicks() {
      const tickIndex = Math.floor(this.angle / TAU * this.level.teeth);
      if (tickIndex === this.lastTickIndex) return;
      const diff = tickIndex - this.lastTickIndex;
      this.lastTickIndex = tickIndex;
      const quarter = Math.max(1, this.level.teeth / 4);
      const major = Math.abs(tickIndex) % quarter === 0;
      const full = Math.abs(tickIndex) % this.level.teeth === 0;
      const now = performance.now();
      if (now - this.lastHapticAt > 17) {
        this.haptic(full ? [9, 18, 5] : major ? [6] : [2]);
        this.lastHapticAt = now;
      }
      const children = this.teethRoot.children;
      if (children.length) {
        const hot = ((tickIndex % children.length) + children.length) % children.length;
        for (let i = 0; i < children.length; i++) children[i].classList.toggle("hot", i === hot);
      }
      this.emit("tick", { direction: Math.sign(diff), tickIndex, major, full, teeth: this.level.teeth });
    }

    step(now) {
      const dt = Math.min(0.04, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      if (this.replaying) {
        const elapsed = audioContext.currentTime - this.replaying.baseAudioTime;
        const offset = this.replayOffsetAt(elapsed);
        this.angle = this.replaying.baseAngle + offset / this.level.secondsPerRev * TAU;
        this.applyAngle();
        this.checkTicks();
      } else if (!this.drag && !this.linkedDrag && Math.abs(this.engine.speed) > 0.0005) {
        this.angle += (this.engine.speed * dt / this.level.secondsPerRev) * TAU;
        this.applyAngle();
        this.checkTicks();
      }
      const velocity = this.drag ? this.drag.speed : this.engine.speed;
      const velocityLight = clamp(Math.abs(velocity) / 4, 0, 1);
      this.instrument.style.setProperty("--velocity-light", velocityLight.toFixed(3));
      this.updateReadout();
      this.updateStatus();
      this.drawOverview();
      this.drawScope();
    }

    updateStatus() {
      const mode = this.drag ? "GRAB" : this.linkedDrag ? "LINK" : this.replaying ? "REPLAY" : this.engine.mode.toUpperCase();
      this.status.textContent = `${mode} · ${this.level.label}/REV${this.slipEnabled ? " · SLIP" : ""}`;
    }

    resizeCanvases() {
      this.sizeCanvas(this.overview, this.overviewWrap.clientWidth, this.overviewWrap.clientHeight);
      const scopeWrap = this.scope.parentElement;
      this.sizeCanvas(this.scope, scopeWrap.clientWidth, scopeWrap.clientHeight);
      this.renderOverviewCache();
    }

    sizeCanvas(canvas, width, height) {
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const w = Math.max(1, Math.round(width * dpr));
      const h = Math.max(1, Math.round(height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
    }

    renderOverviewCache() {
      const width = this.overview.width;
      const height = this.overview.height;
      if (!width || !height) return;
      this.overviewCache.width = width;
      this.overviewCache.height = height;
      const ctx = this.cacheCtx;
      ctx.clearRect(0, 0, width, height);
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const mid = height / 2;
      ctx.strokeStyle = this.side === "left" ? "rgba(139,180,234,.62)" : "rgba(237,143,161,.62)";
      ctx.fillStyle = this.side === "left" ? "rgba(139,180,234,.11)" : "rgba(237,143,161,.11)";
      ctx.lineWidth = Math.max(1, dpr * 0.72);
      if (!this.peaks) {
        ctx.beginPath();
        ctx.moveTo(0, mid);
        ctx.lineTo(width, mid);
        ctx.strokeStyle = "rgba(255,255,255,.05)";
        ctx.stroke();
        return;
      }
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const index = Math.min(this.peaks.length - 1, Math.floor(x / width * this.peaks.length));
        const amp = this.peaks[index] * height * 0.43;
        if (x === 0) ctx.moveTo(x, mid - amp);
        else ctx.lineTo(x, mid - amp);
      }
      for (let x = width - 1; x >= 0; x--) {
        const index = Math.min(this.peaks.length - 1, Math.floor(x / width * this.peaks.length));
        const amp = this.peaks[index] * height * 0.43;
        ctx.lineTo(x, mid + amp);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      if (this.transients.length && this.engine.duration) {
        ctx.strokeStyle = this.side === "left" ? "rgba(185,215,255,.16)" : "rgba(255,190,205,.16)";
        ctx.lineWidth = Math.max(1, dpr * 0.45);
        for (const time of this.transients) {
          const x = time / this.engine.duration * width;
          ctx.beginPath();
          ctx.moveTo(x, height * 0.14);
          ctx.lineTo(x, height * 0.86);
          ctx.stroke();
        }
      }
    }

    drawOverview() {
      const ctx = this.overviewCtx;
      const width = this.overview.width;
      const height = this.overview.height;
      if (!width || !height) return;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(this.overviewCache, 0, 0);
      if (!this.engine.loaded) return;
      const ratio = this.engine.position / Math.max(0.0001, this.engine.duration);
      const x = ratio * width;
      ctx.fillStyle = this.side === "left" ? "rgba(139,180,234,.09)" : "rgba(237,143,161,.09)";
      ctx.fillRect(0, 0, x, height);
      ctx.strokeStyle = this.side === "left" ? "rgba(201,225,255,.96)" : "rgba(255,207,218,.96)";
      ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 1.1);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    drawScope() {
      const ctx = this.scopeCtx;
      const width = this.scope.width;
      const height = this.scope.height;
      ctx.clearRect(0, 0, width, height);
      if (!this.engine.loaded || !this.scopeMin || !this.scopeMax) return;

      const centerTime = this.engine.position;
      const windowSeconds = Math.max(0.18, this.level.secondsPerRev * 1.35);
      const startTime = centerTime - windowSeconds / 2;
      const revWidth = clamp(this.level.secondsPerRev / windowSeconds * width, 1, width);
      const revLeft = width / 2 - revWidth / 2;
      ctx.fillStyle = this.side === "left" ? "rgba(139,180,234,.045)" : "rgba(237,143,161,.045)";
      ctx.fillRect(revLeft, 0, revWidth, height);
      ctx.strokeStyle = this.side === "left" ? "rgba(139,180,234,.16)" : "rgba(237,143,161,.16)";
      ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 0.45);
      ctx.strokeRect(revLeft, 0, revWidth, height);

      if (this.transients.length) {
        ctx.strokeStyle = this.side === "left" ? "rgba(201,225,255,.24)" : "rgba(255,207,218,.24)";
        for (const time of this.transients) {
          if (time < startTime || time > startTime + windowSeconds) continue;
          const x = (time - startTime) / windowSeconds * width;
          ctx.beginPath();
          ctx.moveTo(x, height * 0.15);
          ctx.lineTo(x, height * 0.85);
          ctx.stroke();
        }
      }

      const binsPerPixel = Math.max(1, Math.ceil(windowSeconds * this.scopeHz / Math.max(1, width)));
      const mid = height / 2;
      ctx.beginPath();
      for (let x = 0; x < width; x++) {
        const time = startTime + x / Math.max(1, width - 1) * windowSeconds;
        const startBin = clamp(Math.floor(time * this.scopeHz), 0, this.scopeMax.length - 1);
        const endBin = clamp(startBin + binsPerPixel, startBin + 1, this.scopeMax.length);
        let max = 0;
        for (let bin = startBin; bin < endBin; bin++) max = Math.max(max, this.scopeMax[bin]);
        const y = mid - max * height * 0.43;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let x = width - 1; x >= 0; x--) {
        const time = startTime + x / Math.max(1, width - 1) * windowSeconds;
        const startBin = clamp(Math.floor(time * this.scopeHz), 0, this.scopeMin.length - 1);
        const endBin = clamp(startBin + binsPerPixel, startBin + 1, this.scopeMin.length);
        let min = 0;
        for (let bin = startBin; bin < endBin; bin++) min = Math.min(min, this.scopeMin[bin]);
        ctx.lineTo(x, mid - min * height * 0.43);
      }
      ctx.closePath();
      ctx.fillStyle = this.side === "left" ? "rgba(139,180,234,.19)" : "rgba(237,143,161,.19)";
      ctx.strokeStyle = this.side === "left" ? "rgba(157,197,247,.62)" : "rgba(247,163,181,.62)";
      ctx.lineWidth = Math.max(1, (window.devicePixelRatio || 1) * 0.65);
      ctx.fill();
      ctx.stroke();
    }

    updateReadout() {
      this.timeReadout.textContent = `${this.formatTime(this.engine.position)} / ${this.formatTime(this.engine.duration)}`;
    }

    formatTime(seconds) {
      if (!Number.isFinite(seconds)) seconds = 0;
      const minutes = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      const ms = Math.floor((seconds % 1) * 1000);
      return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
    }

    wake() {
      clearTimeout(this.idleTimer);
      clearTimeout(this.ghostTimer);
      this.instrument.classList.remove("idle", "ghost");
    }

    armFade() {
      clearTimeout(this.idleTimer);
      clearTimeout(this.ghostTimer);
      if (this.drag || this.gearDrag || this.linkedDrag || this.replaying) return;
      this.idleTimer = setTimeout(() => this.instrument.classList.add("idle"), 1050);
      this.ghostTimer = setTimeout(() => {
        this.instrument.classList.add("ghost");
        this.instrument.classList.remove("idle");
      }, 3600);
    }

    haptic(pattern) {
      try { navigator.vibrate?.(pattern); } catch (_) {}
    }

    emit(type, detail = {}) {
      const payload = { deck: this.side, ...detail };
      this.dispatchEvent(new CustomEvent(type, { detail: payload }));
      window.dispatchEvent(new CustomEvent(`dualscratch:${type}`, { detail: payload }));
    }

    toast(message) { showToast(message); }
  }

  const decks = [...document.querySelectorAll(".deck")].map((root, index) => new DeckController(root, index));

  class BridgeController {
    constructor(decks) {
      this.decks = decks;
      this.root = document.getElementById("bridge");
      this.linkButton = document.getElementById("linkButton");
      this.slipButton = document.getElementById("slipButton");
      this.recordButton = document.getElementById("recordButton");
      this.replayButton = document.getElementById("replayButton");
      this.crossfader = document.getElementById("crossfader");
      this.linked = false;
      this.slip = false;
      this.recording = true;
      this.idleTimer = 0;
      this.centerHapticArmed = true;
      this.bind();
      this.setCrossfader(50, true);
      this.setRecording(true);
      this.armFade();
    }

    bind() {
      this.root.addEventListener("pointerdown", () => this.wake(), { passive: true });
      this.linkButton.addEventListener("click", () => this.setLinked(!this.linked));
      this.slipButton.addEventListener("click", () => this.setSlip(!this.slip));
      this.recordButton.addEventListener("click", () => this.setRecording(!this.recording));
      this.replayButton.addEventListener("click", async () => {
        this.wake();
        const results = await Promise.all(this.decks.map(deck => deck.replayGesture()));
        if (!results.some(Boolean)) showToast("Record a scratch first");
        else this.haptic([8, 18, 4]);
      });
      this.crossfader.addEventListener("input", () => this.setCrossfader(Number(this.crossfader.value)));
      this.crossfader.addEventListener("dblclick", () => this.setCrossfader(50));

      for (const deck of this.decks) {
        deck.addEventListener("start", event => this.onDeckStart(deck, event.detail));
        deck.addEventListener("motion", event => this.onDeckMotion(deck, event.detail));
        deck.addEventListener("end", event => this.onDeckEnd(deck, event.detail));
        deck.addEventListener("recorded", () => this.updateReplayReady());
      }
    }

    other(deck) {
      return this.decks[deck.index === 0 ? 1 : 0];
    }

    onDeckStart(deck, detail) {
      this.wake();
      if (!this.linked) return;
      const other = this.other(deck);
      other.beginLinkedGesture(detail);
    }

    onDeckMotion(deck, detail) {
      if (!this.linked) return;
      this.other(deck).applyLinkedPoints(detail.points);
    }

    onDeckEnd(deck, detail) {
      if (!this.linked) return;
      this.other(deck).endLinkedGesture(detail);
    }

    setLinked(enabled) {
      const next = Boolean(enabled);
      if (!next) {
        for (const deck of this.decks) {
          if (deck.linkedDrag) deck.endLinkedGesture({ releaseSpeed: 0 });
        }
      }
      this.linked = next;
      this.linkButton.classList.toggle("on", this.linked);
      this.linkButton.setAttribute("aria-pressed", String(this.linked));
      this.haptic(this.linked ? [6, 18, 6] : [5]);
      this.wake();
      window.dispatchEvent(new CustomEvent("dualscratch:link", { detail: { linked: this.linked } }));
    }

    setSlip(enabled) {
      this.slip = Boolean(enabled);
      this.slipButton.classList.toggle("on", this.slip);
      this.slipButton.setAttribute("aria-pressed", String(this.slip));
      for (const deck of this.decks) deck.setSlip(this.slip);
      this.haptic(this.slip ? [5, 14, 5] : [4]);
      this.wake();
      window.dispatchEvent(new CustomEvent("dualscratch:slip", { detail: { slip: this.slip } }));
    }

    setRecording(enabled) {
      this.recording = Boolean(enabled);
      this.recordButton.classList.toggle("recording", this.recording);
      this.recordButton.textContent = this.recording ? "REC" : "SAFE";
      this.recordButton.setAttribute("aria-pressed", String(this.recording));
      for (const deck of this.decks) deck.setRecording(this.recording);
      this.wake();
    }

    updateReplayReady() {
      const ready = this.decks.some(deck => deck.lastGesture);
      this.replayButton.disabled = !ready;
      this.replayButton.classList.toggle("ready", ready);
    }

    setCrossfader(value, immediate = false) {
      const clamped = clamp(Number(value) || 0, 0, 100);
      this.crossfader.value = String(clamped);
      const amount = clamped / 100;
      this.decks[0].engine.setGain(Math.cos(amount * Math.PI / 2), immediate);
      this.decks[1].engine.setGain(Math.sin(amount * Math.PI / 2), immediate);
      if (Math.abs(clamped - 50) <= 1 && this.centerHapticArmed) {
        this.haptic([4]);
        this.centerHapticArmed = false;
      } else if (Math.abs(clamped - 50) > 4) {
        this.centerHapticArmed = true;
      }
      this.wake();
      window.dispatchEvent(new CustomEvent("dualscratch:crossfader", { detail: { value: clamped } }));
    }

    wake() {
      clearTimeout(this.idleTimer);
      this.root.classList.add("active");
      this.root.classList.remove("idle");
      this.armFade();
    }

    armFade() {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        this.root.classList.remove("active");
        this.root.classList.add("idle");
      }, 1800);
    }

    haptic(pattern) {
      try { navigator.vibrate?.(pattern); } catch (_) {}
    }
  }

  const bridge = new BridgeController(decks);

  let raf = 0;
  function frame(now) {
    for (const deck of decks) deck.step(now);
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const settingsButton = document.getElementById("settingsButton");
  const settingsPanel = document.getElementById("settingsPanel");
  const thumbY = document.getElementById("thumbY");
  const thumbYOut = document.getElementById("thumbYOut");
  const wheelSize = document.getElementById("wheelSize");
  const wheelSizeOut = document.getElementById("wheelSizeOut");
  const idleOpacity = document.getElementById("idleOpacity");
  const idleOpacityOut = document.getElementById("idleOpacityOut");
  const feelPreset = document.getElementById("feelPreset");
  const feelOut = document.getElementById("feelOut");
  const controlDelay = document.getElementById("controlDelay");
  const controlDelayOut = document.getElementById("controlDelayOut");
  const motorPull = document.getElementById("motorPull");
  const motorPullOut = document.getElementById("motorPullOut");
  const coast = document.getElementById("coast");
  const coastOut = document.getElementById("coastOut");
  const qualityToggle = document.getElementById("qualityToggle");
  const trajectoryOut = document.getElementById("trajectoryOut");

  const presets = {
    light: { controlDelay: 8, motorPull: 28, coast: 7, brakeResponse: 36 },
    vinyl: { controlDelay: 12, motorPull: 15, coast: 4.8, brakeResponse: 24 },
    heavy: { controlDelay: 16, motorPull: 8, coast: 2.4, brakeResponse: 12 },
    precision: { controlDelay: 6, motorPull: 38, coast: 11, brakeResponse: 60 }
  };

  let saved = (() => {
    try { return JSON.parse(localStorage.getItem("dualScratchLabV3") || "{}"); }
    catch (_) { return {}; }
  })();
  let cleanMode = saved.cleanMode !== false;

  function persistState() {
    saved = {
      thumbY: Number(thumbY.value),
      wheelSize: Number(wheelSize.value),
      idleOpacity: Number(idleOpacity.value),
      feelPreset: feelPreset.value,
      controlDelay: Number(controlDelay.value),
      motorPull: Number(motorPull.value),
      coast: Number(coast.value),
      cleanMode,
      crossfader: Number(bridge.crossfader.value),
      linked: bridge.linked,
      slip: bridge.slip
    };
    try { localStorage.setItem("dualScratchLabV3", JSON.stringify(saved)); } catch (_) {}
  }

  function applyLayout(layout, persist = true) {
    const y = clamp(Number(layout.thumbY ?? thumbY.value), 42, 78);
    const size = clamp(Number(layout.wheelSize ?? wheelSize.value), 112, 190);
    const opacity = clamp(Number(layout.idleOpacity ?? idleOpacity.value), 5, 45);
    document.documentElement.style.setProperty("--thumb-y", `${y}dvh`);
    document.documentElement.style.setProperty("--wheel-size", `${size}px`);
    document.documentElement.style.setProperty("--idle-opacity", String(opacity / 100));
    document.documentElement.style.setProperty("--ghost-opacity", String(Math.max(0.035, opacity / 100 * 0.34)));
    thumbY.value = String(y);
    wheelSize.value = String(size);
    idleOpacity.value = String(opacity);
    thumbYOut.textContent = `${y}%`;
    wheelSizeOut.textContent = `${size}px`;
    idleOpacityOut.textContent = `${opacity}%`;
    if (persist) persistState();
  }

  function applyPhysics(config = {}, persist = true) {
    const delayMs = clamp(Number(config.controlDelay ?? controlDelay.value), 4, 28);
    const motor = clamp(Number(config.motorPull ?? motorPull.value), 4, 40);
    const coastDrag = clamp(Number(config.coast ?? coast.value), 1, 14);
    const brakeResponse = Number(config.brakeResponse) || (feelPreset.value === "precision" ? 60 : 24);
    controlDelay.value = String(delayMs);
    motorPull.value = String(motor);
    coast.value = String(coastDrag);
    controlDelayOut.textContent = `${delayMs}ms`;
    motorPullOut.textContent = String(motor);
    coastOut.textContent = String(coastDrag);
    feelOut.textContent = feelPreset.value.toUpperCase();
    qualityToggle.textContent = cleanMode ? "CLEAN" : "RAW";
    qualityToggle.classList.toggle("on", cleanMode);
    qualityToggle.setAttribute("aria-pressed", String(cleanMode));
    trajectoryOut.textContent = decks.every(deck => deck.engine.trajectory.shared) ? "SAB" : "PORT";
    for (const deck of decks) {
      deck.engine.configure({
        controlDelay: delayMs / 1000,
        motorResponse: motor,
        inertiaDecay: coastDrag,
        brakeResponse,
        rawMode: !cleanMode,
        slipEnabled: bridge.slip
      });
    }
    if (persist) persistState();
  }

  const initialPreset = saved.feelPreset === "custom"
    ? "custom"
    : presets[saved.feelPreset] ? saved.feelPreset : "vinyl";
  const initialDefaults = presets[initialPreset] || presets.vinyl;
  feelPreset.value = initialPreset;
  applyLayout({
    thumbY: saved.thumbY ?? 58,
    wheelSize: saved.wheelSize ?? Math.min(160, Math.round(innerWidth * 0.37)),
    idleOpacity: saved.idleOpacity ?? 20
  }, false);
  applyPhysics({
    ...initialDefaults,
    controlDelay: saved.controlDelay ?? initialDefaults.controlDelay,
    motorPull: saved.motorPull ?? initialDefaults.motorPull,
    coast: saved.coast ?? initialDefaults.coast
  }, false);
  bridge.setCrossfader(saved.crossfader ?? 50, true);
  bridge.setLinked(Boolean(saved.linked));
  bridge.setSlip(Boolean(saved.slip));
  document.getElementById("linkButton").addEventListener("click", persistState);
  document.getElementById("slipButton").addEventListener("click", persistState);
  bridge.crossfader.addEventListener("change", persistState);

  thumbY.addEventListener("input", () => applyLayout({ thumbY: thumbY.value }));
  wheelSize.addEventListener("input", () => applyLayout({ wheelSize: wheelSize.value }));
  idleOpacity.addEventListener("input", () => applyLayout({ idleOpacity: idleOpacity.value }));

  feelPreset.addEventListener("change", () => {
    const preset = presets[feelPreset.value] || presets.vinyl;
    applyPhysics(preset);
    try { navigator.vibrate?.([8, 20, 5]); } catch (_) {}
  });
  for (const input of [controlDelay, motorPull, coast]) {
    input.addEventListener("input", () => {
      feelPreset.value = "custom";
      feelOut.textContent = "CUSTOM";
      applyPhysics();
    });
  }
  qualityToggle.addEventListener("click", () => {
    cleanMode = !cleanMode;
    applyPhysics();
    showToast(cleanMode ? "Clean resampling" : "Raw linear resampling");
  });

  settingsButton.addEventListener("click", event => {
    event.stopPropagation();
    settingsPanel.classList.toggle("open");
    decks.forEach(deck => deck.wake());
    bridge.wake();
  });
  document.addEventListener("pointerdown", event => {
    if (!settingsPanel.contains(event.target) && event.target !== settingsButton) settingsPanel.classList.remove("open");
  });

  document.getElementById("resetLayout").addEventListener("click", () => {
    feelPreset.value = "vinyl";
    cleanMode = true;
    applyLayout({
      thumbY: 58,
      wheelSize: Math.min(160, Math.round(innerWidth * 0.37)),
      idleOpacity: 20
    }, false);
    applyPhysics(presets.vinyl, false);
    bridge.setCrossfader(50, true);
    bridge.setLinked(false);
    bridge.setSlip(false);
    persistState();
    showToast("Layout and platter feel reset");
  });

  document.getElementById("copySetup").addEventListener("click", async () => {
    const note = `Dual scratch v3: thumb ${thumbY.value}dvh, wheel ${wheelSize.value}px, idle ${idleOpacity.value}%, feel ${feelOut.textContent}, motion delay ${controlDelay.value}ms, motor ${motorPull.value}, coast drag ${coast.value}, ${cleanMode ? "clean" : "raw"}, trajectory ${trajectoryOut.textContent}.`;
    try {
      await navigator.clipboard.writeText(note);
      showToast("Setup copied");
    } catch (_) {
      showToast(note);
    }
  });

  const toast = document.getElementById("toast");
  let toastTimer = 0;
  function showToast(message) {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  Promise.all(decks.map(deck => deck.engine.ready)).then(() => {
    applyPhysics({}, false);
    showToast(decks.every(deck => deck.engine.trajectory.shared)
      ? "Shared trajectory ready · load audio"
      : "Trajectory fallback ready · load audio");
  }).catch(error => {
    showToast(error.message || "AudioWorklet unavailable");
  });

  window.dualScratch = {
    version: "0.3.0-trajectory",
    audioContext,
    workletReady,
    decks: { left: decks[0], right: decks[1] },
    bridge,
    getLayout() {
      return { thumbY: Number(thumbY.value), wheelSize: Number(wheelSize.value), idleOpacity: Number(idleOpacity.value) };
    },
    setLayout(layout) { applyLayout(layout); },
    setLinked(enabled) { bridge.setLinked(enabled); persistState(); },
    setSlip(enabled) { bridge.setSlip(enabled); persistState(); },
    setCrossfader(value) { bridge.setCrossfader(value); persistState(); },
    setRecording(enabled) { bridge.setRecording(enabled); },
    replay() { return Promise.all(decks.map(deck => deck.replayGesture())); },
    configurePhysics(config) { applyPhysics(config); },
    showSettings() { settingsPanel.classList.add("open"); },
    hideSettings() { settingsPanel.classList.remove("open"); },
    getDiagnostics() {
      return {
        secureContext: window.isSecureContext,
        crossOriginIsolated: window.crossOriginIsolated,
        sharedArrayBuffer: typeof SharedArrayBuffer === "function",
        audioContextState: audioContext.state,
        audioWorkletAvailable: Boolean(audioContext.audioWorklet && window.AudioWorkletNode),
        workletFailure: workletFailure ? String(workletFailure.message || workletFailure) : null,
        baseLatency: audioContext.baseLatency ?? null,
        outputLatency: audioContext.outputLatency ?? null,
        physics: {
          feel: feelOut.textContent,
          controlDelayMs: Number(controlDelay.value),
          motorPull: Number(motorPull.value),
          coastDrag: Number(coast.value),
          cleanMode
        },
        decks: decks.map(deck => ({
          side: deck.side,
          loaded: deck.engine.loaded,
          position: deck.engine.position,
          speed: deck.engine.speed,
          mode: deck.engine.mode,
          sharedTrajectory: deck.engine.sharedTrajectory,
          recordedGesture: deck.lastGesture ? {
            duration: deck.lastGesture.duration,
            points: deck.lastGesture.points.length
          } : null
        }))
      };
    },
    destroy() {
      cancelAnimationFrame(raf);
      decks.forEach(deck => {
        clearTimeout(deck.replayTimer);
        deck.resizeObserver.disconnect();
        deck.jogWheel.destroy();
        deck.engine.node?.disconnect();
      });
      master.disconnect();
    }
  };
})();
