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

let objectUrl = null;
let targetFrame = 0;
let presentedFrame = 0;
let frameRemainder = 0;
let coastRequest = 0;
let coastVelocity = 0;
let coastTime = 0;

const frameRate = () => Math.max(1, Number(fpsInput.value) || 30);
const frameCount = () => Number.isFinite(video.duration)
  ? Math.max(1, Math.floor(video.duration * frameRate()))
  : 1;

function showFrames() {
  if (!video.src) {
    readout.value = "frame — / —";
    return;
  }
  readout.value = `wanted ${targetFrame} · shown ${presentedFrame} / ${frameCount() - 1}`;
}

function seekToFrame(frame) {
  const previous = targetFrame;
  targetFrame = Math.max(0, Math.min(frameCount() - 1, frame));
  video.currentTime = Math.min(video.duration || 0, targetFrame / frameRate());
  showFrames();
  return targetFrame !== previous;
}

function applyRotation(deltaAngle) {
  frameRemainder += deltaAngle / TAU * FRAMES_PER_REVOLUTION;
  const frameDelta = Math.trunc(frameRemainder);
  if (!frameDelta) return true;
  frameRemainder -= frameDelta;
  return seekToFrame(targetFrame + frameDelta);
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
  mode: "circular",
  deadZone: 0.1,
  authorityWidth: 0.14,
  maxDelta: 1.1,
  maxVelocity: TAU * 3,
  keyboardStep: TAU / FRAMES_PER_REVOLUTION,
  filter: event => !event.target.closest(".controls")
});

gesture.addEventListener("start", () => {
  stopCoast();
  stage.classList.add("dragging");
  video.pause();
});

gesture.addEventListener("move", event => {
  if (!video.src) return;
  applyRotation(event.detail.deltaAngle || 0);
});

gesture.addEventListener("end", event => {
  stage.classList.remove("dragging");
  frameRemainder = 0;
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
  frameRemainder = 0;
  gesture.setAngle(0);
  stage.classList.add("loaded");
  seekToFrame(0);
});

fpsInput.addEventListener("change", () => {
  targetFrame = Math.round(video.currentTime * frameRate());
  seekToFrame(targetFrame);
});

if (typeof video.requestVideoFrameCallback === "function") {
  const watchPresentedFrame = (_now, metadata) => {
    presentedFrame = Math.round(metadata.mediaTime * frameRate());
    showFrames();
    video.requestVideoFrameCallback(watchPresentedFrame);
  };
  video.requestVideoFrameCallback(watchPresentedFrame);
} else {
  video.addEventListener("seeked", () => {
    presentedFrame = Math.round(video.currentTime * frameRate());
    showFrames();
  });
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
