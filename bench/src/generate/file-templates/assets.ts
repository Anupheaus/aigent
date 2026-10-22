import { lines } from './text.js';

export function cssFile(params: { selector: string; gap: number }): string {
  const { selector, gap } = params;
  return lines(`.${selector} {`, '  display: grid;', `  gap: ${gap}px;`, '}', '', `.${selector}__title {`, '  font-weight: 600;', '}');
}

export function jsonFixture(params: { prefix: string; count: number }): string {
  const { prefix, count } = params;
  const rows = Array.from({ length: count }, (_unused, position) => ({ id: `${prefix}-${position + 1}`, reference: `R-${position + 1}`, amount: (position + 1) * 5 }));
  return `${JSON.stringify(rows, null, 2)}\n`;
}

export function markdownDoc(params: { title: string; paragraphs: string[] }): string {
  const { title, paragraphs } = params;
  return lines(`# ${title}`, '', paragraphs.flatMap((paragraph, position) => (position === 0 ? [paragraph] : ['', paragraph])));
}

export function htmlPage(params: { title: string; body: string[] }): string {
  const { title, body } = params;
  return lines('<!doctype html>', '<html lang="en">', '<head>', `  <title>${title}</title>`, '</head>', '<body>', body.map(line => `  ${line}`), '</body>', '</html>');
}

export function yamlConfig(params: { name: string; entries: Record<string, string | number> }): string {
  const { name, entries } = params;
  return lines(`name: ${name}`, 'settings:', Object.entries(entries).map(([key, value]) => `  ${key}: ${value}`));
}

/** Compiled build output for a module: what `dist/` holds (ignored by search defaults). */
export function compiledJs(params: { source: string }): string {
  const { source } = params;
  const body = source.split('\n').filter(line => !line.startsWith('import type') && !line.startsWith('export type') && !/^\s*(interface|export interface)/.test(line)).join('\n');
  return lines('"use strict";', '/* compiled output, do not edit */', body.trimEnd());
}

/** A minified vendored bundle: one long line holding `names`. */
export function minifiedBundle(params: { library: string; names: string[]; filler: number }): string {
  const { library, names, filler } = params;
  const parts = Array.from({ length: filler }, (_unused, position) => `function a${position}(b){return b*${position}+1}`);
  return `/*! ${library} | MIT */!function(){${[...parts, ...names.map(name => `var ${name}=function(c){return c}`)].join(';')}}();\n`;
}

/** An npm lockfile listing `packages` (huge, never an answer). */
export function lockfile(params: { name: string; packages: string[]; extra?: string[] }): string {
  const { name, packages, extra = [] } = params;
  const entries = Object.fromEntries(packages.map(pkg => [`node_modules/${pkg}`, { version: '1.0.0', resolved: `https://registry.npmjs.org/${pkg}/-/${pkg}-1.0.0.tgz`, integrity: `sha512-${pkg.replace(/[^a-z]/g, '').padEnd(24, 'x')}` }]));
  return `${JSON.stringify({ name, lockfileVersion: 3, packages: entries, ...(extra.length === 0 ? {} : { notes: extra }) }, null, 2)}\n`;
}
