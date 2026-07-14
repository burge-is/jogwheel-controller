import test from "node:test";
import assert from "node:assert/strict";
import { TAU, clamp, fitVelocity, wrapAngle } from "../src/math.js";

test("clamp bounds values", () => {
  assert.equal(clamp(-2, 0, 1), 0);
  assert.equal(clamp(0.4, 0, 1), 0.4);
  assert.equal(clamp(2, 0, 1), 1);
});

test("wrapAngle follows the shortest path", () => {
  assert.ok(Math.abs(wrapAngle(TAU - 0.2) + 0.2) < 1e-10);
  assert.ok(Math.abs(wrapAngle(-TAU + 0.2) - 0.2) < 1e-10);
});

test("fitVelocity estimates angular velocity", () => {
  const samples = [
    { time: 1, value: 0 },
    { time: 1.05, value: 0.1 },
    { time: 1.1, value: 0.2 }
  ];
  assert.ok(Math.abs(fitVelocity(samples) - 2) < 1e-10);
  assert.equal(fitVelocity(samples, 1), 1);
});
