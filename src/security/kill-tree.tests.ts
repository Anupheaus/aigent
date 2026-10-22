import { describe, expect, it } from 'vitest';
import { descendantsInTable } from './kill-tree.js';

const STARTED_AT = 1_700_000_000_000;

/** `ProcessId,ParentProcessId,CreationUnixMs` lines, as the Windows process-table query prints them. */
const table = (rows: [number, number, number][]): string => rows.map(row => row.join(',')).join('\r\n');

describe('descendantsInTable', () => {
  it('finds children and grandchildren started after the child', () => {
    const rows = table([[10, 1, STARTED_AT], [20, 10, STARTED_AT + 50], [30, 20, STARTED_AT + 90], [40, 1, STARTED_AT + 5]]);
    expect(descendantsInTable({ table: rows, pid: 10, startedAt: STARTED_AT }).sort()).toEqual([20, 30]);
  });

  it('skips a process that only looks like a child because its parent id was reused (it is older than the child)', () => {
    const tenMinutes = 600_000;
    const rows = table([[10, 1, STARTED_AT], [50, 10, STARTED_AT - tenMinutes], [60, 50, STARTED_AT + 100], [20, 10, STARTED_AT + 10]]);
    expect(descendantsInTable({ table: rows, pid: 10, startedAt: STARTED_AT })).toEqual([20]);
  });

  it('skips a direct child created after the child exited (its id has a new owner), keeping later grandchildren', () => {
    const exitedAt = STARTED_AT + 1_000;
    const rows = table([[20, 10, STARTED_AT + 500], [30, 20, exitedAt + 60_000], [70, 10, exitedAt + 60_000]]);
    expect(descendantsInTable({ table: rows, pid: 10, startedAt: STARTED_AT, exitedAt }).sort()).toEqual([20, 30]);
  });

  it('ignores malformed lines and a process listed as its own parent', () => {
    const rows = `garbage\r\n10,10,${STARTED_AT}\r\n20,10,\r\n30,10,${STARTED_AT + 1}\r\n`;
    expect(descendantsInTable({ table: rows, pid: 10, startedAt: STARTED_AT })).toEqual([30]);
  });
});
