/** Validate that a value is a positive finite number. */
export function positiveNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return n;
}

/** Validate that a value is a non-negative finite number. */
export function nonNegativeNumber(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number.`);
  }
  return n;
}

/** Validate that a string looks like an Ethereum address (0x + 40 hex chars). */
export function ethAddress(value: unknown, name: string): string {
  const s = String(value).trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(s)) {
    throw new Error(`${name} must be a valid Ethereum address.`);
  }
  return s;
}

/** Validate non-empty string with max length. */
export function boundedString(value: unknown, name: string, maxLen = 500): string {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${name} is required.`);
  if (s.length > maxLen) throw new Error(`${name} exceeds maximum length of ${maxLen}.`);
  return s;
}
