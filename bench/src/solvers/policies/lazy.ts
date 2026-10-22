import { createPolicy } from './dispatch.js';

/** Stops at the first few results (must fail recall). */
export const lazyPolicy = createPolicy({ style: 'lazy' });
