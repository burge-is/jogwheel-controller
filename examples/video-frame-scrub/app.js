import { JogWheel } from "../../src/JogWheel.js";

const stage = document.querySelector("#stage");
const video = document.querySelector("#video");
const fileInput = document.querySelector("#file");
const loadButton = document.querySelector("#load");
const fpsInput = document.querySelector("#fps");
const readout = document.querySelector("#readout");
const fullscreenButton = document.querySelector("#fullscreen");

const TAU = Math.PI * 2;
const FRAMES_PER_REVOLUTION = 360;
const COAST_DRAG = 4.8;
const TAP_ROTATION_LIMIT = TAU / 180; // two degrees

let objectUrl = null;
let targetFrame = 0;
let presentedFrame = 0;
let queuedFrames = 0;
let frameInFlight = false;
let frameRemainder = 0;
let coastRequest = 0;
let coastVelocity = 0;
let coastTime = 0;
let gestureRotation = 0;
let gestureWasPlaying = false;
let tapStoppedSpin = false;

const frameRate = () => Math.max(1, Number(fpsInput.value) || 30);
const frameCount = () => Number.isFinite(video.duration)
  ? Math.max(1, Math.floor(video.duration * frameRate()))
  : 1;
const boundFrame = frame => Math.max(0, Math.min(frameCount() - 1, frame));

function showFrames() {
  if (!video.src) {
    readout.value = "frame — / —";
    return;
  }
  readout.value = `wanted ${targetFrame} · shown ${presentedFrame} / ${frameCount() - 1}`;
}

// Issue only one adjacent frame at a time. Further gesture movement remains in
// queuedFrames until requestVideoFrameCallback confirms what was presented.
function pumpFrameQueue() {
  if (frameInFlight || !video.src || !queuedFrames) return;
  const direction = Math.sign(queuedFrames);
  const nextFrame = boundFrame(presentedFrame + direction);
  if (nextFrame === presentedFrame) {
    queuedFrames = 0;
    return;
  }

  queuedFrames -= direction;
  targetFrame = nextFrame;
  frameInFlight = true;
  const exactTime = targetFrame / frameRate();
  video.currentTime = Math.min(video.duration || 0, exactTime + 1e-7);
  showFrames();
}

function queueFrameDelta(delta) {
  if (!delta || !video.src) return false;
  const inFlightDelta = frameInFlight ? targetFrame - presentedFrame : 0;
  const queuedDestination = presentedFrame + inFlightDelta + queuedFrames;
  const boundedDestination = boundFrame(queuedDestination + delta);
  const accepted = boundedDestination - queuedDestination;
  queuedFrames += accepted;
  pumpFrameQueue();
  return accepted !== 0;
}

function applyRotation(deltaAngle) {
  frameRemainder += deltaAngle / TAU * FRAMES_PER_REVOLUTION;
  const frameDelta = Math.trunc(frameRemainder);
  if (!frameDelta) return true;
  frameRemainder -= frameDelta;
  return queueFrameDelta(frameDelta);
}

function stopCoast() {
  cancelAnimationFrame(coastRequest);
  coastRequest = 0;
  coastVelocity = 0;
}

function coast(now) {
  const dt = Math.min(0.05, Math.max(0, (now - coastTime) / 1000));
  coastTime = now;
  const moved = applyRotation(coastVelocity * dt);
  coastVelocity *= Math.exp(-COAST_DRAG * dt);
  if (moved && Math.abs(coastVelocity) > 0.04) coastRequest = requestAnimationFrame(coast);
  else stopCoast();
}

const gesture = new JogWheel(stage, {
  mode: "platter",
  platterRadius: 72,
  maxDelta: 1.1,
  maxVelocity: TAU * 3,
  keyboardStep: TAU / FRAMES_PER_REVOLUTION,
  filter: event => !event.target.closest(".controls")
});

gesture.addEventListener("start", () => {
  gestureRotation = 0;
  gestureWasPlaying = !video.paused;
  tapStoppedSpin = Boolean(coastRequest || queuedFrames);
  stopCoast();
  queuedFrames = 0;
  stage.classList.add("dragging");
  video.pause();
});

gesture.addEventListener("move", event => {
  if (!video.src) return;
  const deltaAngle = event.detail.deltaAngle || 0;
  gestureRotation += Math.abs(deltaAngle);
  applyRotation(deltaAngle);
});

gesture.addEventListener("end", event => {
  stage.classList.remove("dragging");
  frameRemainder = 0;

  if (gestureRotation <= TAP_ROTATION_LIMIT) {
    // A tap arrests an already coasting platter. Otherwise it acts as the
    // transport button, toggling the state captured before pointerdown.
    if (!tapStoppedSpin && video.src && !gestureWasPlaying) video.play().catch(() => {});
    return;
  }

  coastVelocity = Number(event.detail.velocity) || 0;
  if (video.src && Math.abs(coastVelocity) > 0.12) {
    coastTime = performance.now();
    coastRequest = requestAnimationFrame(coast);
  }
});

loadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  stopCoast();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  video.load();
  fileInput.value = "";
});

video.addEventListener("loadedmetadata", () => {
  targetFrame = 0;
  presentedFrame = 0;
  queuedFrames = 0;
  frameInFlight = false;
  frameRemainder = 0;
  gesture.setAngle(0);
  stage.classList.add("loaded");
  video.currentTime = 0;
  showFrames();
});

fpsInput.addEventListener("change", () => {
  stopCoast();
  queuedFrames = 0;
  frameInFlight = false;
  presentedFrame = boundFrame(Math.round(video.currentTime * frameRate()));
  targetFrame = presentedFrame;
  showFrames();
});

function confirmPresentedFrame(mediaTime) {
  presentedFrame = boundFrame(Math.round(mediaTime * frameRate()));
  targetFrame = presentedFrame;
  frameInFlight = false;
  showFrames();
  pumpFrameQueue();
}

if (typeof video.requestVideoFrameCallback === "function") {
  const watchPresentedFrame = (_now, metadata) => {
    confirmPresentedFrame(metadata.mediaTime);
    video.requestVideoFrameCallback(watchPresentedFrame);
  };
  video.requestVideoFrameCallback(watchPresentedFrame);
} else {
  video.addEventListener("seeked", () => confirmPresentedFrame(video.currentTime));
}

fullscreenButton.addEventListener("click", async () => {
  if (document.fullscreenElement) await document.exitFullscreen();
  else await stage.requestFullscreen();
});

document.addEventListener("fullscreenchange", () => {
  fullscreenButton.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
});

window.addEventListener("pagehide", () => {
  stopCoast();
  gesture.destroy();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}, { once: true });
