export const TAU = Math.PI * 2;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function wrapAngle(value) {
  while (value > Math.PI) value -= TAU;
  while (value < -Math.PI) value += TAU;
  return value;
}

export function fitVelocity(samples, limit = Infinity) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;

  const latest = samples[samples.length - 1].time;
  let meanTime = 0;
  let meanValue = 0;
  for (const sample of samples) {
    meanTime += sample.time - latest;
    meanValue += sample.value;
  }
  meanTime /= samples.length;
  meanValue /= samples.length;

  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    const time = sample.time - latest - meanTime;
    const value = sample.value - meanValue;
    numerator += time * value;
    denominator += time * time;
  }

  if (denominator <= 1e-10) return 0;
  return clamp(numerator / denominator, -limit, limit);
}
