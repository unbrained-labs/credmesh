export const AXIS_TICK = { fill: '#666', fontSize: 9, fontFamily: 'JetBrains Mono' } as const;

export const TOOLTIP_STYLE = {
  background: '#0a0a0a',
  border: '1px solid #333',
  borderRadius: 0,
  fontSize: 11,
  fontFamily: 'JetBrains Mono',
  color: '#e0e0e0',
} as const;

export const CURSOR_STYLE = { fill: 'rgba(255,255,255,0.03)' } as const;

export const COLORS = {
  green: '#00ff41',
  red: '#ff1744',
  amber: '#ff9100',
  indigo: '#536dfe',
  cyan: '#00e5ff',
  white: '#ffffff',
} as const;

export function scoreColor(score: number): string {
  if (score >= 70) return 'text-green';
  if (score >= 40) return 'text-amber';
  return 'text-red';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dollarFmt(v: any): [string, string] {
  const n = Number(Array.isArray(v) ? v[0] : v) || 0;
  return [`$${n.toFixed(2)}`, ''];
}
