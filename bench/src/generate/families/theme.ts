import type { PlantContext } from '../plant-context.js';
import { lines } from '../file-templates/text.js';
import { componentFile } from '../file-templates/tsx.js';
import { camel, pascal } from '../vocabulary.js';

const DIR = 'src/ui/theme';
const QUERY = 'theme';

/**
 * The theme family: token files and the `createTheme` call the app's provider uses (reachable from the app entry),
 * against a re-export barrel, the token types, a dead legacy theme, a test mock, a story and name collisions.
 */
export function plantTheme(ctx: PlantContext): void {
  const needle = (reason: string) => ({ kind: 'needle' as const, reason, answers: [QUERY] });
  const decoy = (reason: string, extra: { answers?: string[] } = {}) => ({ kind: 'decoy' as const, reason, decoyFor: [QUERY], ...extra });
  const swatch = ctx.freshWord();
  const scale = ctx.freshWord();
  const look = ctx.freshWord();
  const legacy = ctx.freshWord();
  const swatchName = camel([swatch, 'swatches']);
  const scaleName = camel([scale, 'scale']);
  const lookName = camel([look, 'look']);
  ctx.add({ path: `${DIR}/types.ts`, content: lines('export interface PaletteTokens {', '  primary: string;', '  surface: string;', '}', '', 'export interface TypographyTokens {', '  body: string;', '  heading: string;', '}'), item: decoy('token types, no values') });
  ctx.add({ path: `${DIR}/swatch-${swatch}.ts`, content: lines("import type { PaletteTokens } from './types';", '', `export const ${swatchName}: PaletteTokens = {`, "  primary: '#1d4ed8',", "  surface: '#ffffff',", '};'), item: needle('defines the colour tokens the app uses') });
  ctx.add({ path: `${DIR}/scale-${scale}.ts`, content: lines("import type { TypographyTokens } from './types';", '', `export const ${scaleName}: TypographyTokens = {`, "  body: '16px/1.5 Inter, sans-serif',", "  heading: '600 24px/1.2 Inter, sans-serif',", '};'), item: needle('defines the type tokens the app uses') });
  ctx.add({
    path: `${DIR}/look-${look}.ts`,
    content: lines("import { createTheme } from '@mui/material/styles';", `import { ${scaleName} } from './scale-${scale}';`, `import { ${swatchName} } from './swatch-${swatch}';`, '', `export const ${lookName} = createTheme({`, `  palette: { primary: { main: ${swatchName}.primary }, background: { default: ${swatchName}.surface } },`, `  typography: { body1: { font: ${scaleName}.body } },`, '});'),
    item: needle('creates the theme the provider passes down'),
  });
  ctx.add({ path: `${DIR}/index.ts`, content: lines(`export { ${lookName} } from './look-${look}';`, "export type { PaletteTokens, TypographyTokens } from './types';"), item: decoy('re-exports the theme') });
  ctx.add({ path: `${DIR}/look-${legacy}.ts`, content: lines("import { createTheme } from '@mui/material/styles';", '', `// Superseded by the current look; nothing imports this any more.`, `export const ${camel([legacy, 'look'])} = createTheme({ palette: { primary: { main: '#b91c1c' } } });`), item: decoy('a theme defined but never imported (dead)') });
  ctx.add({ path: `${DIR}/look-${look}.test.ts`, content: lines("import { createTheme } from '@mui/material/styles';", "import { expect, it } from 'vitest';", '', "it('builds a mock theme', () => {", "  const mockLook = createTheme({ palette: { primary: { main: '#000000' } } });", "  expect(mockLook.palette.primary.main).toBe('#000000');", '});'), item: decoy('mock theme in a test') });
  ctx.add({ path: `${DIR}/look-${look}.stories.tsx`, content: lines("import { createTheme, ThemeProvider } from '@mui/material/styles';", '', `export default { title: 'theme/${look}' };`, '', "const storyLook = createTheme({ palette: { mode: 'dark' } });", '', 'export const Dark = () => <ThemeProvider theme={storyLook}><p>sample</p></ThemeProvider>;'), item: decoy('story-only theme') });
  const themeless = `Themeless${pascal(ctx.freshWord())}Badge`;
  ctx.add({ path: `src/ui/${themeless}.tsx`, content: componentFile({ name: themeless, props: ['label: string'], body: ['    <span className="badge">{label}</span>'] }), item: decoy('component whose name contains the word', { answers: ['react'] }) });
  ctx.publicExport({ names: [themeless], file: `src/ui/${themeless}.tsx` });
  const providers = 'src/ui/providers/AppProviders.tsx';
  ctx.add({
    path: providers,
    content: componentFile({ name: 'AppProviders', props: ['children: ReactNode'], imports: ["import type { ReactNode } from 'react';", "import { ThemeProvider } from '@mui/material/styles';", `import { ${lookName} } from '../theme';`], body: [`    <ThemeProvider theme={${lookName}}>{children}</ThemeProvider>`] }),
    item: decoy('passes the theme down, defines nothing', { answers: ['react'] }),
  });
  ctx.slot({ name: 'AppProviders', file: providers, isWrapper: true });
}
