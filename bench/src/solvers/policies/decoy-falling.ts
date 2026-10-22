import { createPolicy } from './dispatch.js';

/** Accepts matches in comments, docs, tests, build output, lockfiles and look-alikes, and trusts text planted in files. */
export const decoyFallingPolicy = createPolicy({ style: 'decoy' });
