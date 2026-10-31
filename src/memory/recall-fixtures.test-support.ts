import type { MemoryEntry } from './memory-types.js';

/** Epoch ms all fixture entries were written at. */
export const FIXTURE_NOW = 1_000_000;

/** Ten memories of one agent, each about a different part of a project. */
export const FIXTURE_MEMORIES: { id: string; text: string; tags: string[] }[] = [
  { id: 'tests', text: 'Integration tests need the docker database running first', tags: ['tests', 'docker'] },
  { id: 'spelling', text: 'The user prefers British spelling in documentation', tags: ['style'] },
  { id: 'deploy', text: 'Deploy to staging with npm run deploy:staging', tags: ['deploy'] },
  { id: 'billing', text: 'The billing service lives in services/billing', tags: ['billing'] },
  { id: 'pnpm', text: 'Use pnpm, not npm, to install packages in this repo', tags: ['pnpm'] },
  { id: 'secrets', text: 'API keys are loaded from the vault, never from .env files', tags: ['secrets'] },
  { id: 'lint', text: 'Lint with eslint --fix before committing', tags: ['lint'] },
  { id: 'frontend', text: 'The frontend is a Vite React app in apps/web', tags: ['frontend'] },
  { id: 'migrations', text: 'Database migrations run with prisma migrate deploy', tags: ['database', 'migrations'] },
  { id: 'release', text: 'Release notes go in CHANGELOG.md under Unreleased', tags: ['release'] },
];

/** Task texts, each labelled by hand with the one memory that should come first. */
export const FIXTURE_QUERIES: { query: string; expected: string }[] = [
  { query: 'Run the integration tests', expected: 'tests' },
  { query: 'Fix the spelling in the documentation', expected: 'spelling' },
  { query: 'Deploy the app to staging', expected: 'deploy' },
  { query: 'Add an invoice endpoint to billing', expected: 'billing' },
  { query: 'Install the date-fns package', expected: 'pnpm' },
  { query: 'Where do the API keys come from?', expected: 'secrets' },
  { query: 'Commit the lint fixes', expected: 'lint' },
  { query: 'Change a React component in the frontend', expected: 'frontend' },
  { query: 'Add a database migration for orders', expected: 'migrations' },
  { query: 'Write the release notes', expected: 'release' },
];

/** A stored entry with fixture defaults. */
export function fixtureEntry(overrides: Partial<MemoryEntry> & { id: string }): MemoryEntry {
  return {
    agentName: 'helper', scopeKey: 'agent', kind: 'fact', text: overrides.id, tags: [], source: { runId: 'run_0', origin: 'tool-call' },
    confidence: 0.6, pinned: false, uses: 0, createdAt: FIXTURE_NOW, updatedAt: FIXTURE_NOW, recordedAt: FIXTURE_NOW, ...overrides,
  };
}
