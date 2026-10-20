import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createHttpPolicy } from './http-policy.js';
import { classifyAddress } from './ip-classify.js';

/** Special IPv4 ranges as [first address, prefix bits]: none of their addresses may ever be fetched. */
const SPECIAL_RANGES: readonly [number, number][] = [
  [0x00_00_00_00, 8], [0x0a_00_00_00, 8], [0x64_40_00_00, 10], [0x7f_00_00_00, 8], [0xa9_fe_00_00, 16], [0xac_10_00_00, 12],
  [0xc0_00_00_00, 24], [0xc0_00_02_00, 24], [0xc0_a8_00_00, 16], [0xc6_12_00_00, 15], [0xc6_33_64_00, 24], [0xcb_00_71_00, 24], [0xe0_00_00_00, 4], [0xf0_00_00_00, 4],
];

const BYTE = 256;

/** An address in a special range, as a 32-bit number. */
const specialAddress = fc.constantFrom(...SPECIAL_RANGES).chain(([base, bits]) => fc.integer({ min: 0, max: 2 ** (32 - bits) - 1 }).map(offset => base + offset));

function bytesOf(value: number): number[] {
  return [24, 16, 8, 0].map(shift => Math.floor(value / 2 ** shift) % BYTE);
}

/** One numeric part in decimal, octal or hex, as inet_aton and URL parsers accept. */
function render(params: { value: number; radix: 'dec' | 'oct' | 'hex' }): string {
  const { value, radix } = params;
  if (radix === 'hex') return `0x${value.toString(16)}`;
  if (radix === 'oct') return `0${value.toString(8)}`;
  return String(value);
}

/** The address written with 1 to 4 parts (the last part filling the rest), each part in its own radix. */
const anyForm = fc.tuple(specialAddress, fc.integer({ min: 1, max: 4 }), fc.array(fc.constantFrom('dec' as const, 'oct' as const, 'hex' as const), { minLength: 4, maxLength: 4 }), fc.boolean())
  .map(([value, partCount, radices, trailingDot]) => {
    const bytes = bytesOf(value);
    const leading = bytes.slice(0, partCount - 1);
    const rest = bytes.slice(partCount - 1).reduce((total, byte) => total * BYTE + byte, 0);
    const parts = [...leading, rest].map((part, index) => render({ value: part, radix: radices[index] ?? 'dec' }));
    return { value, text: parts.join('.') + (trailingDot ? '.' : '') };
  });

describe('SSRF properties', () => {
  it('never classifies an address of a special range as public, in any IPv4 form', () => {
    fc.assert(fc.property(anyForm, ({ text }) => {
      expect(classifyAddress(text).kind).not.toBe('public');
    }), { numRuns: 2_000 });
  });

  it('never allows a URL to such an address, in any form, IPv4-mapped IPv6 included, even with any public host allowed', async () => {
    const policy = createHttpPolicy({ allowDomains: ['**'], allowAnyPublic: true, resolveHost: async () => ['93.184.216.34'] });
    await fc.assert(fc.asyncProperty(anyForm, fc.boolean(), async ({ value, text }, isMapped) => {
      const [first = 0, second = 0, third = 0, fourth = 0] = bytesOf(value);
      const host = isMapped ? `[::ffff:${((first * BYTE) + second).toString(16)}:${((third * BYTE) + fourth).toString(16)}]` : text;
      expect((await policy.checkUrl(`http://${host}/`)).allowed).toBe(false);
    }), { numRuns: 1_000 });
  });

  it('never allows a name that resolves to a special address among public ones', async () => {
    await fc.assert(fc.asyncProperty(specialAddress, fc.integer({ min: 0, max: 3 }), async (value, position) => {
      const answers = ['93.184.216.34', '93.184.216.35', '93.184.216.36'];
      answers.splice(position, 0, bytesOf(value).join('.'));
      const policy = createHttpPolicy({ allowDomains: ['*.example.com'], resolveHost: async () => answers });
      expect((await policy.checkUrl('https://www.example.com/')).allowed).toBe(false);
    }), { numRuns: 300 });
  });
});
