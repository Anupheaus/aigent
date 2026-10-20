const NUMBER_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const USD_FORMAT = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });

/** A figure for evidence text: thousands separators, at most one decimal. */
export function formatNumber(value: number): string {
  return NUMBER_FORMAT.format(value);
}

/** A dollar amount for evidence text, to a millionth of a dollar. */
export function formatUsd(value: number): string {
  return `$${USD_FORMAT.format(value)}`;
}
