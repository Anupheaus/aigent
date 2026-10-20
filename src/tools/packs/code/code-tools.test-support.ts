// Test-only setup for the code pack: the fixture project in a temp root, behind a policy. Excluded from the build.
import { join } from 'node:path';
import { createNodeFsAccess } from '../../../security/fs-access-node.js';
import type { FsAccess } from '../../../security/fs-access.js';
import { createFsPolicy } from '../../../security/fs-policy.js';
import type { FsPolicyOptions } from '../../../security/fs-policy-types.js';
import { tempRoot } from '../../../security/temp-dir.test-support.js';
import type { CodeToolsOptions } from './code-shared.js';
import { writeProject } from './fixtures/fixture-project.test-support.js';

export interface CodeFixture {
  root: string;
  options: CodeToolsOptions;
  /** Every path the tools read through the access. */
  reads: string[];
  at(relative: string): string;
  cleanup(): Promise<void>;
}

export async function codeFixture(params: { files?: Record<string, string>; policy?: Partial<FsPolicyOptions>; maxFiles?: number } = {}): Promise<CodeFixture> {
  const { files, policy = {}, maxFiles } = params;
  const { root, cleanup } = await tempRoot();
  await writeProject({ root, ...(files == null ? {} : { files }) });
  const node = createNodeFsAccess();
  const reads: string[] = [];
  const access: FsAccess = { ...node, readFile: async path => { reads.push(path); return node.readFile(path); } };
  const fsPolicy = createFsPolicy({ roots: [{ path: root, permissions: ['read'], label: 'project' }], ...policy });
  return { root, reads, at: relative => join(root, relative), cleanup, options: { policy: fsPolicy, access, ...(maxFiles == null ? {} : { maxFiles }) } };
}
