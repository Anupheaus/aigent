/** Middle value (mean of the two middle values for an even count); null for no values. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] as number : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

/** Nearest-rank percentile (`fraction` 0.9 is p90); null for no values. */
export function percentile(params: { values: number[]; fraction: number }): number | null {
  const { values, fraction } = params;
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

const ONE_DECIMAL = 10;
/** Rates (0 to 1) are kept to three decimals. */
const RATE_PRECISION = 1_000;
/** Dollar amounts are kept to a millionth of a dollar, which hides float noise such as 0.1 + 0.001. */
const USD_PRECISION = 1_000_000;

/** Rounds a score or ratio to one decimal place. */
export function roundToTenth(value: number): number {
  return Math.round(value * ONE_DECIMAL) / ONE_DECIMAL;
}

/** Rounds a dollar amount to a millionth of a dollar. */
export function roundUsd(value: number): number {
  return Math.round(value * USD_PRECISION) / USD_PRECISION;
}

/** Rounds a rate (0 to 1) to three decimals. */
export function roundRate(value: number): number {
  return Math.round(value * RATE_PRECISION) / RATE_PRECISION;
}

// ─── Significance ───

/** Abramowitz and Stegun 7.1.26 coefficients for erf (absolute error below 1.5e-7). */
const ERF_P = 0.327_591_1;
const ERF_A = [0.254_829_592, -0.284_496_736, 1.421_413_741, -1.453_152_027, 1.061_405_429] as const;
/** z for a two-sided 95% interval. */
export const Z_95 = 1.959_963_985;

function erf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const absolute = Math.abs(value);
  const t = 1 / (1 + ERF_P * absolute);
  // Horner's scheme over the five coefficients.
  const polynomial = ERF_A.reduceRight((total, coefficient) => total * t + coefficient, 0) * t;
  return sign * (1 - polynomial * Math.exp(-absolute * absolute));
}

/** Standard normal cumulative distribution Φ(z). */
export function normalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Successes out of `n` trials (successes may be fractional when outcomes are weighted). */
export interface Proportion {
  successes: number;
  n: number;
}

/** Lower end of the Wilson score interval (95% by default): a success rate that small samples cannot inflate. 0 for no data. */
export function wilsonLowerBound(params: Proportion & { z?: number }): number {
  const { successes, n, z = Z_95 } = params;
  if (n <= 0) return 0;
  const rate = successes / n;
  const zSquared = z * z;
  const centre = rate + zSquared / (2 * n);
  const spread = z * Math.sqrt((rate * (1 - rate) + zSquared / (4 * n)) / n);
  return Math.max(0, (centre - spread) / (1 + zSquared / n));
}

/**
 * One-sided p-value that `treatment`'s rate is higher than `control`'s (two-proportion z-test, pooled variance, normal
 * approximation). 1 (no evidence) when either side has no data or there is no variance.
 */
export function oneSidedProportionPValue(params: { treatment: Proportion; control: Proportion }): number {
  const { treatment, control } = params;
  if (treatment.n <= 0 || control.n <= 0) return 1;
  const pooled = (treatment.successes + control.successes) / (treatment.n + control.n);
  const standardError = Math.sqrt(pooled * (1 - pooled) * (1 / treatment.n + 1 / control.n));
  if (standardError === 0) return 1;
  const z = (treatment.successes / treatment.n - control.successes / control.n) / standardError;
  return 1 - normalCdf(z);
}
