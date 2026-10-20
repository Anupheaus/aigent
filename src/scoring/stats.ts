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
