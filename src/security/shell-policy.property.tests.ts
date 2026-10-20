import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFsPolicy } from './fs-policy.js';
import { createShellPolicy } from './shell-policy.js';
import type { ShellPolicy } from './shell-policy-types.js';
import { tempRoot } from './temp-dir.test-support.js';

let policy: ShellPolicy;
let cleanup: () => Promise<void> = async () => undefined;

beforeAll(async () => {
  const temp = await tempRoot();
  cleanup = temp.cleanup;
  policy = createShellPolicy({ commands: [{ name: 'node', resolvedPath: process.execPath }], cwdPolicy: createFsPolicy({ roots: [{ path: temp.root, permissions: ['read'] }] }) });
});
afterAll(() => cleanup());

describe('ShellPolicy properties', () => {
  it('refuses every command name that is not exactly an allowed one', async () => {
    const name = fc.oneof(fc.string({ maxLength: 12 }), fc.constantFrom('node ', 'NODE', 'node.exe', './node', 'node\0', '/node', 'node;', 'no de'));
    await fc.assert(fc.asyncProperty(name.filter(value => value !== 'node'), async command => {
      expect(await policy.checkCommand({ command, args: [] })).toMatchObject({ allowed: false, code: 'command_not_allowed' });
    }), { numRuns: 200 });
  });

  it('passes any NUL-free argv within the limits through unchanged, and refuses any argv with a NUL', async () => {
    const arg = fc.string({ unit: 'grapheme', maxLength: 30 });
    await fc.assert(fc.asyncProperty(fc.array(arg, { maxLength: 20 }), async args => {
      const decision = await policy.checkCommand({ command: 'node', args });
      if (args.some(value => value.includes('\0'))) expect(decision).toMatchObject({ allowed: false, code: 'invalid_args' });
      else expect(decision).toMatchObject({ allowed: true, args });
    }), { numRuns: 200 });
  });
});
