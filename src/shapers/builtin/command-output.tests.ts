import { describe, expect, it } from 'vitest';
import { createAliasTable } from '../alias-table.js';
import type { ShaperContext } from '../shaper-types.js';
import { foldRepeatsShaper } from './fold-repeats.js';
import { stripNoiseShaper } from './strip-noise.js';

const context: ShaperContext = { callId: 'c1', tool: 'shell_run', aliases: createAliasTable({ minLength: 24 }), originalHandle: () => 'H1' };
const noisy = '\u001b[32mok\u001b[0m\nprogress 10%\rprogress 100%\n';

describe('command-output shapers on structured results', () => {
  it('clean stdout and stderr of each batch entry, and leave entries marked raw: true exactly as they were', () => {
    const value = [
      { index: 0, ok: true, result: { command: 'npm', stdout: noisy, stderr: 'same\nsame\nsame\n', exitCode: 0 } },
      { index: 1, ok: true, result: { command: 'npm', stdout: noisy, stderr: '', exitCode: 0, raw: true } },
    ];
    const stripped = stripNoiseShaper.shape({ value, kind: 'command-output', text: JSON.stringify(value), context });
    expect(stripped?.value).toEqual([
      { index: 0, ok: true, result: { command: 'npm', stdout: 'ok\nprogress 100%\n', stderr: 'same\nsame\nsame\n', exitCode: 0 } },
      value[1],
    ]);
    expect(stripped?.note).toContain('handle H1');
    const folded = foldRepeatsShaper.shape({ value, kind: 'command-output', text: JSON.stringify(value), context });
    expect((folded?.value as typeof value)[0]?.result.stderr).toBe('same (x3)\n');
  });

  it('change nothing (and say nothing) when there is no noise', () => {
    const value = [{ index: 0, ok: true, result: { stdout: 'clean\n', stderr: '' } }];
    expect(stripNoiseShaper.shape({ value, kind: 'command-output', text: JSON.stringify(value), context })).toBeUndefined();
  });
});
