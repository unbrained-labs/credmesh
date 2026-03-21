/** Round to 2 decimal places (currency). */
export function rc(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Round to N decimal places. */
export function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Clamp a number to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normalize an address (lowercase + trim). */
export function norm(address: string): string {
  return address.trim().toLowerCase();
}

/** Repayment rate for an agent. */
export function repaymentRate(repaid: number, defaulted: number): number {
  const total = repaid + defaulted;
  return total === 0 ? 1 : roundTo(repaid / total, 2);
}
