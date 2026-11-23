// Figures for the report. A figure is printed with as many digits as a handful of runs can carry, and with the
// number of runs behind it.

export const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** A count, or the median of counts (which may fall on a half). */
export const count = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
export const oneDecimal = (x: number) => x.toFixed(1);

export function tokens(x: number): string {
  if (x < 1000) return String(Math.round(x));
  if (x < 10_000) return `${(x / 1000).toFixed(1)}k`;
  if (x < 1_000_000) return `${Math.round(x / 1000)}k`;
  return `${(x / 1_000_000).toFixed(1)}M`;
}

export const seconds = (x: number) => (x < 10 ? `${x.toFixed(1)} s` : `${Math.round(x)} s`);

export function usd(x: number): string {
  if (x >= 0.1) return `$${x.toFixed(2)}`;
  if (x === 0) return "$0";
  return `$${x.toPrecision(2)}`;
}

/** A fraction as a whole percentage: 0.934 is 93%. */
export const share = (x: number) => `${Math.round(x * 100)}%`;

/** `value [n]`, or a dash when no run carries the figure. */
export function figure(xs: number[], summarise: (xs: number[]) => number | null, format: (x: number) => string): string {
  const v = summarise(xs);
  return v === null ? "–" : `${format(v)} [${xs.length}]`;
}
