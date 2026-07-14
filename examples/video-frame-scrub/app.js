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

let objectUrl = null;
let targetFrame = 0;
let presentedFrame = 0;
let frameRemainder = 0;

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
  targetFrame = Math.max(0, Math.min(frameCount() - 1, frame));
  video.currentTime = Math.min(video.duration || 0, targetFrame / frameRate());
  showFrames();
}

const gesture = new JogWheel(stage, {
  mode: "relative",
  axis: "x",
  // The invisible wheel has 360 movement units per virtual revolution.
  // One horizontal CSS pixel therefore maps to one requested video frame.
  radiansPerPixel: TAU / FRAMES_PER_REVOLUTION,
  maxDelta: Number.POSITIVE_INFINITY,
  keyboardStep: TAU / FRAMES_PER_REVOLUTION,
  filter: event => !event.target.closest(".controls")
});

gesture.addEventListener("start", () => {
  stage.classList.add("dragging");
  video.pause();
});

gesture.addEventListener("move", event => {
  if (!video.src) return;
  frameRemainder += (event.detail.deltaAngle || 0) / TAU * FRAMES_PER_REVOLUTION;
  const frameDelta = Math.trunc(frameRemainder);
  if (!frameDelta) return;
  frameRemainder -= frameDelta;
  seekToFrame(targetFrame + frameDelta);
});

gesture.addEventListener("end", () => {
  stage.classList.remove("dragging");
  frameRemainder = 0;
});

loadButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (!file) return;
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
  gesture.destroy();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
}, { once: true });
