import { createPolicy } from './dispatch.js';

/** Lists to get oriented, searches without ignores or exactness, reads every candidate: correct but costly. */
export const naivePolicy = createPolicy({ style: 'naive' });
