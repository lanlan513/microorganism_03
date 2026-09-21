let offsetMs = 0;
const monotonicBase = Date.now();
let monotonicCounter = 0;

export interface ServerTick {
  now: number;
  monotonic: number;
}

export function setClockOffset(nextOffsetMs: number): void {
  offsetMs = nextOffsetMs;
}

export function getClockOffset(): number {
  return offsetMs;
}

export function tick(previousServerTime?: number): ServerTick {
  const wallNow = Date.now() + offsetMs;
  monotonicCounter += 1;
  const monotonic = monotonicBase + monotonicCounter;
  const now = typeof previousServerTime === 'number'
    ? Math.max(wallNow, previousServerTime + 1, monotonic)
    : Math.max(wallNow, monotonic);
  return { now, monotonic };
}

export function wallNow(): number {
  return Date.now() + offsetMs;
}
