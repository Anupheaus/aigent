import { describe, expect, it } from 'vitest';
import { classifyAddress, parseIPv4, parseIPv6 } from './ip-classify.js';

describe('parseIPv4', () => {
  it.each([
    ['127.0.0.1', [127, 0, 0, 1]],
    ['2130706433', [127, 0, 0, 1]],
    ['0177.0.0.1', [127, 0, 0, 1]],
    ['0x7f.1', [127, 0, 0, 1]],
    ['0x7f.0.1', [127, 0, 0, 1]],
    ['0x7F000001', [127, 0, 0, 1]],
    ['10.1', [10, 0, 0, 1]],
    ['192.168.257', [192, 168, 1, 1]],
    ['127.0.0.1.', [127, 0, 0, 1]],
  ])('reads %s in every inet_aton form', (text, bytes) => {
    expect(parseIPv4(text)).toEqual(bytes);
  });

  it.each(['256.0.0.1', '1.2.3.4.5', '08.0.0.1', '0x', '', 'a.b.c.d', '4294967296', '1..2'])('rejects %s', text => {
    expect(parseIPv4(text)).toBeUndefined();
  });
});

describe('parseIPv6', () => {
  it('reads compressed, bracketed, zoned and IPv4-tailed forms', () => {
    expect(parseIPv6('::1')).toEqual([...new Array<number>(15).fill(0), 1]);
    expect(parseIPv6('[::1]')).toEqual(parseIPv6('0:0:0:0:0:0:0:1'));
    expect(parseIPv6('fe80::1%eth0')).toEqual(parseIPv6('fe80::1'));
    expect(parseIPv6('::ffff:127.0.0.1')?.slice(10)).toEqual([0xff, 0xff, 127, 0, 0, 1]);
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeUndefined();
    expect(parseIPv6('1::2::3')).toBeUndefined();
    expect(parseIPv6('12345::')).toBeUndefined();
  });
});

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'], ['93.184.216.34', 'public'], ['2606:4700::1111', 'public'],
    ['127.0.0.1', 'loopback'], ['127.255.255.254', 'loopback'], ['2130706433', 'loopback'], ['0177.0.0.1', 'loopback'], ['0x7f.1', 'loopback'], ['::1', 'loopback'], ['[::1]', 'loopback'],
    ['10.0.0.1', 'private'], ['172.16.0.1', 'private'], ['172.31.255.255', 'private'], ['192.168.1.1', 'private'], ['100.64.0.1', 'private'], ['100.127.255.255', 'private'],
    ['fc00::1', 'private'], ['fd12:3456::1', 'private'], ['fec0::1', 'private'],
    ['169.254.1.1', 'link-local'], ['fe80::1', 'link-local'], ['fe80::1%eth0', 'link-local'],
    ['169.254.169.254', 'metadata'], ['168.63.129.16', 'metadata'], ['fd00:ec2::254', 'metadata'], ['100.100.100.200', 'metadata'],
    ['0.0.0.0', 'reserved'], ['0.1.2.3', 'reserved'], ['::', 'reserved'], ['224.0.0.1', 'reserved'], ['255.255.255.255', 'reserved'], ['240.0.0.1', 'reserved'], ['192.0.2.1', 'reserved'], ['2001:db8::1', 'reserved'], ['ff02::1', 'reserved'],
    ['::ffff:127.0.0.1', 'loopback'], ['::ffff:7f00:1', 'loopback'], ['::ffff:169.254.169.254', 'metadata'], ['::ffff:10.0.0.1', 'private'], ['::ffff:8.8.8.8', 'public'],
    ['64:ff9b::7f00:1', 'loopback'], ['2002:7f00:0001::', 'loopback'], ['::127.0.0.1', 'reserved'],
    ['not an ip', 'invalid'], ['', 'invalid'], ['1.2.3.256', 'invalid'],
  ])('%s is %s', (ip, kind) => {
    expect(classifyAddress(ip)).toEqual({ kind });
  });
});
