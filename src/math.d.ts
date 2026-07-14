export const TAU: number;
export function clamp(value: number, min: number, max: number): number;
export function wrapAngle(value: number): number;
export function fitVelocity(
  samples: Array<{ time: number; value: number }>,
  limit?: number
): number;
