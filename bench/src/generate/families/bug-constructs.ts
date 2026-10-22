/** Root-cause classes of the planted bugs (answers are matched on these, not on wording). */
export const BUG_CAUSES = ['off-by-one', 'null-deref', 'race', 'wrong-operator', 'resource-leak', 'injection', 'timezone', 'swallowed-error', 'wrong-default', 'copy-paste'] as const;

export type BugCause = typeof BUG_CAUSES[number];

/** A planted function: its lines, the 0-based offset of the line that matters, and its imports and exported name. */
export interface Construct {
  lines: string[];
  /** Offset of the buggy (or bug-looking) line within `lines`. */
  at: number;
  imports?: string[];
  exported?: string;
  cause: BugCause;
  isBug: boolean;
  reason: string;
}

type Build = (name: string) => Construct;

const BOX = '{ left: number; right: number; top: number; bottom: number }';
const STORE = '{ read(id: string): Promise<number>; write(id: string, value: number): Promise<void>; withLock(id: string, work: () => Promise<void>): Promise<void> }';

/** The real bug of each class. */
export const BUGS: Record<BugCause, Build> = {
  'off-by-one': name => ({ cause: 'off-by-one', isBug: true, reason: 'loop runs one past the end', exported: name, at: 2, lines: [`export function ${name}(items: { price: number }[]): number {`, '  let total = 0;', '  for (let index = 0; index <= items.length; index += 1) {', '    total += items[index].price;', '  }', '  return total;', '}'] }),
  'null-deref': name => ({ cause: 'null-deref', isBug: true, reason: 'find may return undefined', exported: name, at: 2, lines: [`export function ${name}(users: { id: string; name: string }[], id: string): string {`, '  const user = users.find(candidate => candidate.id === id);', '  return user.name.toUpperCase();', '}'] }),
  race: name => ({ cause: 'race', isBug: true, reason: 'read-modify-write without a lock loses updates', exported: name, at: 2, lines: [`export async function ${name}(store: ${STORE}, id: string, amount: number): Promise<void> {`, '  const current = await store.read(id);', '  await store.write(id, current + amount);', '}'] }),
  'wrong-operator': name => ({ cause: 'wrong-operator', isBug: true, reason: '|| makes the check always true', exported: name, at: 1, lines: [`export function ${name}(value: string | null | undefined): boolean {`, '  return value !== null || value !== undefined;', '}'] }),
  'resource-leak': name => ({ cause: 'resource-leak', isBug: true, reason: 'file handle never closed', exported: name, imports: ["import { open } from 'node:fs/promises';"], at: 1, lines: [`export async function ${name}(path: string): Promise<unknown> {`, "  const handle = await open(path, 'r');", "  const text = await handle.readFile('utf8');", '  return JSON.parse(text);', '}'] }),
  injection: name => ({ cause: 'injection', isBug: true, reason: 'SQL built by string concatenation', exported: name, imports: ["import { db } from '../../server/db';"], at: 1, lines: [`export async function ${name}(name: string): Promise<unknown[]> {`, `  return db.query("SELECT * FROM accounts WHERE name = '" + name + "'");`, '}'] }),
  timezone: name => ({ cause: 'timezone', isBug: true, reason: 'local hours used for a UTC rule', exported: name, at: 2, lines: ['/** True during support hours, 09:00 to 17:00 UTC. */', `export function ${name}(date: Date): boolean {`, '  const hour = date.getHours();', '  return hour >= 9 && hour < 17;', '}'] }),
  'swallowed-error': name => ({ cause: 'swallowed-error', isBug: true, reason: 'error silently swallowed', exported: name, at: 3, lines: [`export async function ${name}(send: () => Promise<void>): Promise<void> {`, '  try {', '    await send();', '  } catch {', '  }', '}'] }),
  'wrong-default': name => ({ cause: 'wrong-default', isBug: true, reason: 'page size defaults to 0 (never advances)', exported: name, at: 0, lines: [`export function ${name}<T>(items: T[], pageSize = 0): T[][] {`, '  const pages: T[][] = [];', '  for (let start = 0; start < items.length; start += pageSize) pages.push(items.slice(start, start + pageSize));', '  return pages;', '}'] }),
  'copy-paste': name => ({ cause: 'copy-paste', isBug: true, reason: 'height computed from right instead of bottom', exported: name, at: 2, lines: [`export function ${name}(box: ${BOX}): { width: number; height: number } {`, '  const width = box.right - box.left;', '  const height = box.right - box.top;', '  return { width, height };', '}'] }),
};

/** Look-alikes that are correct, guarded, intentional or unreachable. */
export const LOOKALIKES: Record<BugCause, Build[]> = {
  'off-by-one': [
    name => ({ cause: 'off-by-one', isBug: false, reason: 'inclusive bound with length - 1 is correct', exported: name, at: 2, lines: [`export function ${name}(items: { price: number }[]): number {`, '  let total = 0;', '  for (let index = 0; index <= items.length - 1; index += 1) {', '    total += items[index].price;', '  }', '  return total;', '}'] }),
    name => ({ cause: 'off-by-one', isBug: false, reason: 'unreachable: never exported or called', at: 2, lines: [`function ${name}(items: number[]): number {`, '  let total = 0;', '  for (let index = 0; index <= items.length; index += 1) total += items[index];', '  return total;', '}'] }),
  ],
  'null-deref': [name => ({ cause: 'null-deref', isBug: false, reason: 'guarded before use', exported: name, at: 3, lines: [`export function ${name}(users: { id: string; name: string }[], id: string): string {`, '  const user = users.find(candidate => candidate.id === id);', "  if (user === undefined) return '';", '  return user.name.toUpperCase();', '}'] })],
  race: [name => ({ cause: 'race', isBug: false, reason: 'read-modify-write under a lock', exported: name, at: 3, lines: [`export async function ${name}(store: ${STORE}, id: string, amount: number): Promise<void> {`, '  await store.withLock(id, async () => {', '    const current = await store.read(id);', '    await store.write(id, current + amount);', '  });', '}'] })],
  'wrong-operator': [name => ({ cause: 'wrong-operator', isBug: false, reason: '&& is correct', exported: name, at: 1, lines: [`export function ${name}(value: string | null | undefined): boolean {`, '  return value !== null && value !== undefined;', '}'] })],
  'resource-leak': [name => ({ cause: 'resource-leak', isBug: false, reason: 'closed in finally', exported: name, imports: ["import { open } from 'node:fs/promises';"], at: 1, lines: [`export async function ${name}(path: string): Promise<unknown> {`, "  const handle = await open(path, 'r');", '  try {', "    return JSON.parse(await handle.readFile('utf8'));", '  } finally {', '    await handle.close();', '  }', '}'] })],
  injection: [name => ({ cause: 'injection', isBug: false, reason: 'parameterised query', exported: name, imports: ["import { db } from '../../server/db';"], at: 1, lines: [`export async function ${name}(name: string): Promise<unknown[]> {`, "  return db.query('SELECT * FROM accounts WHERE name = $1', [name]);", '}'] })],
  timezone: [
    name => ({ cause: 'timezone', isBug: false, reason: 'UTC getter for a UTC rule', exported: name, at: 2, lines: ['/** True during support hours, 09:00 to 17:00 UTC. */', `export function ${name}(date: Date): boolean {`, '  const hour = date.getUTCHours();', '  return hour >= 9 && hour < 17;', '}'] }),
    name => ({ cause: 'timezone', isBug: false, reason: 'local time intended (explained)', exported: name, at: 2, lines: [`export function ${name}(now: Date): string {`, "  // Local time is intended here: the greeting follows the viewer's own clock.", "  return now.getHours() < 12 ? 'Good morning' : 'Hello';", '}'] }),
  ],
  'swallowed-error': [name => ({ cause: 'swallowed-error', isBug: false, reason: 'deliberate, explained', exported: name, at: 3, lines: [`export async function ${name}(send: () => Promise<void>): Promise<void> {`, '  try {', '    await send();', '  } catch {', '    // Best effort: the nightly job retries receipts, so a failure here is expected and safe to drop.', '  }', '}'] })],
  'wrong-default': [name => ({ cause: 'wrong-default', isBug: false, reason: 'sensible default', exported: name, at: 0, lines: [`export function ${name}<T>(items: T[], pageSize = 20): T[][] {`, '  const pages: T[][] = [];', '  for (let start = 0; start < items.length; start += pageSize) pages.push(items.slice(start, start + pageSize));', '  return pages;', '}'] })],
  'copy-paste': [name => ({ cause: 'copy-paste', isBug: false, reason: 'correct sides', exported: name, at: 2, lines: [`export function ${name}(box: ${BOX}): { width: number; height: number } {`, '  const width = box.right - box.left;', '  const height = box.bottom - box.top;', '  return { width, height };', '}'] })],
};

/** Correct code that looks suspicious for other reasons (deprecated, a stale TODO). */
export const EXTRA_LOOKALIKES: Build[] = [
  name => ({ cause: 'wrong-operator', isBug: false, reason: 'deprecated but correct', exported: name, at: 2, lines: ['/** @deprecated Use the newer formatter; this one is still correct. */', `export function ${name}(value: number): string {`, '  return value.toFixed(2);', '}'] }),
  name => ({ cause: 'off-by-one', isBug: false, reason: 'TODO on code that is fine', exported: name, at: 2, lines: ['// TODO: fix this', `export function ${name}(value: number): number {`, '  return Math.min(100, Math.max(0, value));', '}'] }),
];
