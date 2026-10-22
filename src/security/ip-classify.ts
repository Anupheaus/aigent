/** What an address is, for SSRF checks: only `public` addresses may be fetched. */
export type AddressKind = 'public' | 'private' | 'loopback' | 'link-local' | 'metadata' | 'reserved' | 'invalid';

export interface AddressClass {
  kind: AddressKind;
}

const IPV4_BYTES = 4;
const IPV6_BYTES = 16;
const IPV6_GROUPS = 8;
const BYTE_MAX = 255;
const BYTE = 256;
const HEXTET_MAX = 0xffff;
const MAX_HEXTET_DIGITS = 4;

/** One numeric part of an IPv4 address in any form `inet_aton` accepts: decimal, octal (`0177`) or hex (`0x7f`). */
function partValue(part: string): number | undefined {
  if (/^0x[0-9a-f]+$/i.test(part)) return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
  if (/^(?:0|[1-9]\d*)$/.test(part)) return Number(part);
  return undefined;
}

/**
 * The four bytes of an IPv4 address written in any form a URL parser or `inet_aton` accepts: `127.0.0.1`,
 * `2130706433`, `0177.0.0.1`, `0x7f.1` (the last part fills the remaining bytes), with an optional trailing dot.
 */
export function parseIPv4(text: string): number[] | undefined {
  const trimmed = text.endsWith('.') ? text.slice(0, -1) : text;
  const parts = trimmed.split('.');
  if (parts.length === 0 || parts.length > IPV4_BYTES || parts.some(part => part === '')) return undefined;
  const values = parts.map(partValue);
  if (values.some(value => value == null)) return undefined;
  const numbers = values as number[];
  const leading = numbers.slice(0, -1);
  const last = numbers.at(-1) as number;
  if (leading.some(value => value > BYTE_MAX)) return undefined;
  const remaining = IPV4_BYTES - leading.length;
  if (last >= BYTE ** remaining) return undefined;
  const tail: number[] = [];
  for (let position = remaining - 1; position >= 0; position -= 1) tail.push(Math.floor(last / BYTE ** position) % BYTE);
  return [...leading, ...tail];
}

function hextets(groups: string[]): number[] | undefined {
  const values = groups.map(group => (/^[0-9a-f]{1,4}$/i.test(group) && group.length <= MAX_HEXTET_DIGITS ? Number.parseInt(group, 16) : Number.NaN));
  return values.some(value => Number.isNaN(value) || value > HEXTET_MAX) ? undefined : values;
}

/** The sixteen bytes of an IPv6 address: brackets and a zone (`%eth0`) are dropped, `::` and a dotted IPv4 tail are expanded. */
export function parseIPv6(text: string): number[] | undefined {
  let address = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const zone = address.indexOf('%');
  if (zone !== -1) address = address.slice(0, zone);
  if (!address.includes(':')) return undefined;
  const lastColon = address.lastIndexOf(':');
  const embedded = address.slice(lastColon + 1);
  if (embedded.includes('.')) {
    // A dotted IPv4 tail (`::ffff:127.0.0.1`) is the last two groups.
    const bytes = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(embedded) ? parseIPv4(embedded) : undefined;
    if (bytes == null) return undefined;
    const [first = 0, second = 0, third = 0, fourth = 0] = bytes;
    address = `${address.slice(0, lastColon + 1)}${(first * BYTE + second).toString(16)}:${(third * BYTE + fourth).toString(16)}`;
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const split = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const head = hextets(split(halves[0] ?? ''));
  const rest = halves.length === 2 ? hextets(split(halves[1] ?? '')) : [];
  if (head == null || rest == null) return undefined;
  const given = head.length + rest.length;
  if (halves.length === 1 ? given !== IPV6_GROUPS : given >= IPV6_GROUPS) return undefined;
  const groups = [...head, ...new Array<number>(IPV6_GROUPS - given).fill(0), ...rest];
  return groups.flatMap(group => [Math.floor(group / BYTE), group % BYTE]);
}

/** Cloud metadata endpoints (AWS, GCP, Azure, Alibaba, ECS task metadata): never fetched, whatever else is allowed. */
const METADATA_IPV4 = new Set(['169.254.169.254', '168.63.129.16', '100.100.100.200', '169.254.170.2']);
const METADATA_IPV6 = new Set(['fd00:ec2:0:0:0:0:0:254']);

/** IPv4 ranges by first bytes: [prefix bytes, prefix bits, kind]. */
const IPV4_RANGES: readonly [number[], number, AddressKind][] = [
  [[0], 8, 'reserved'], [[10], 8, 'private'], [[100, 64], 10, 'private'], [[127], 8, 'loopback'], [[169, 254], 16, 'link-local'],
  [[172, 16], 12, 'private'], [[192, 0, 0], 24, 'reserved'], [[192, 0, 2], 24, 'reserved'], [[192, 88, 99], 24, 'reserved'], [[192, 168], 16, 'private'],
  [[198, 18], 15, 'reserved'], [[198, 51, 100], 24, 'reserved'], [[203, 0, 113], 24, 'reserved'], [[224], 4, 'reserved'], [[240], 4, 'reserved'],
];

/** IPv6 ranges: [prefix bytes, prefix bits, kind]. */
const IPV6_RANGES: readonly [number[], number, AddressKind][] = [
  [[0xfc], 7, 'private'], [[0xfe, 0x80], 10, 'link-local'], [[0xfe, 0xc0], 10, 'private'], [[0xff], 8, 'reserved'],
  [[0x20, 0x01, 0x0d, 0xb8], 32, 'reserved'], [[0x20, 0x01, 0x00, 0x00], 32, 'reserved'], [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64, 'reserved'], [[0, 0x64, 0xff, 0x9b, 0, 0x01], 48, 'reserved'],
];

function inRange(params: { bytes: number[]; prefix: number[]; bits: number }): boolean {
  const { bytes, prefix, bits } = params;
  for (let bit = 0; bit < bits; bit += 1) {
    const byte = Math.floor(bit / 8);
    const mask = 0x80 >> (bit % 8);
    if (((bytes[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function kindOfRanges(params: { bytes: number[]; ranges: readonly [number[], number, AddressKind][] }): AddressKind {
  const { bytes, ranges } = params;
  return ranges.find(([prefix, bits]) => inRange({ bytes, prefix, bits }))?.[2] ?? 'public';
}

function classifyIPv4(bytes: number[]): AddressKind {
  if (METADATA_IPV4.has(bytes.join('.'))) return 'metadata';
  if (bytes.every(byte => byte === BYTE_MAX)) return 'reserved';
  return kindOfRanges({ bytes, ranges: IPV4_RANGES });
}

function classifyIPv6(bytes: number[]): AddressKind {
  const groups = Array.from({ length: IPV6_GROUPS }, (_unused, index) => (((bytes[index * 2] ?? 0) * BYTE) + (bytes[index * 2 + 1] ?? 0)).toString(16));
  if (METADATA_IPV6.has(groups.join(':'))) return 'metadata';
  const leadingZeros = bytes.slice(0, 12).every(byte => byte === 0);
  const last = bytes.slice(12);
  if (leadingZeros && last.every(byte => byte === 0)) return 'reserved';
  if (leadingZeros && last.slice(0, 3).every(byte => byte === 0) && last[3] === 1) return 'loopback';
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-translated (::ffff:0:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4
  // (2002:aabb:ccdd::) reach an IPv4 address: judged by it.
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff) return classifyIPv4(last);
  if (bytes.slice(0, 8).every(byte => byte === 0) && bytes[8] === 0xff && bytes[9] === 0xff && bytes[10] === 0 && bytes[11] === 0) return classifyIPv4(last);
  if (inRange({ bytes, prefix: [0, 0x64, 0xff, 0x9b], bits: 96 })) return classifyIPv4(last);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return classifyIPv4(bytes.slice(2, 6));
  // IPv4-compatible (::a.b.c.d) is deprecated and never a destination.
  if (leadingZeros) return 'reserved';
  return kindOfRanges({ bytes, ranges: IPV6_RANGES });
}

/** Classifies an IP address in any textual form (IPv4 in every `inet_aton` form, IPv6 with brackets, zones or IPv4 tails). */
export function classifyAddress(ip: string): AddressClass {
  const v4 = ip.includes(':') ? undefined : parseIPv4(ip);
  if (v4 != null) return { kind: classifyIPv4(v4) };
  const v6 = parseIPv6(ip);
  if (v6 != null && v6.length === IPV6_BYTES) return { kind: classifyIPv6(v6) };
  return { kind: 'invalid' };
}
