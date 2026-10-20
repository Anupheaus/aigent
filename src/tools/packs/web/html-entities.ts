/** Named character references a page's text commonly uses; unknown names are left as written. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', euro: '€', pound: '£', middot: '·', bull: '•',
};
const ENTITY = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});?/g;
const MAX_CODE_POINT = 0x10_ffff;
const REPLACEMENT = '�';

function codePoint(value: number): string {
  return value > 0 && value <= MAX_CODE_POINT ? String.fromCodePoint(value) : REPLACEMENT;
}

/** Text with character references (`&amp;`, `&#8364;`, `&#x26;`) decoded. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return codePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return codePoint(Number.parseInt(name.slice(1), 10));
    return NAMED[name.toLowerCase()] ?? whole;
  });
}
