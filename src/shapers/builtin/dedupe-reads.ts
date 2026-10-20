import type { Shaper } from '../shaper-types.js';

/** structured-data, search-hits, prose: a result identical to an earlier call's in the run becomes a stub naming it. */
export const dedupeReadsShaper: Shaper = {
  name: 'dedupe-reads',
  appliesTo: ['structured-data', 'search-hits', 'prose'],
  shape: ({ context }) => {
    const { previousIdenticalCall } = context;
    if (previousIdenticalCall == null) return undefined;
    return { value: `Same as call ${previousIdenticalCall} (unchanged)`, note: `Identical to the result of call ${previousIdenticalCall}; full result: handle ${context.originalHandle()}` };
  },
};
