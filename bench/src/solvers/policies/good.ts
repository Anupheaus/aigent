import { createPolicy } from './dispatch.js';

/** The reference policy: the efficient expert path with the Round-0 tools (ignores on, batched reads, targeted searches). */
export const goodPolicy = createPolicy({ style: 'good' });
