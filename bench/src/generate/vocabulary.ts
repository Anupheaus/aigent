/**
 * Neutral words for planted names: none of them is a word a task prompt uses, so answer paths built from them never
 * leak into task text (the hint linter checks this for every spec).
 */
export const NEUTRAL_WORDS: readonly string[] = [
  'amber', 'aspen', 'atlas', 'basil', 'birch', 'bramble', 'cairn', 'canyon', 'cedar', 'cinder', 'clover', 'cobalt',
  'comet', 'coral', 'cypress', 'dune', 'ember', 'fennel', 'fern', 'fjord', 'flint', 'garnet', 'glacier', 'granite',
  'harbor', 'hazel', 'heron', 'indigo', 'iris', 'jasper', 'juniper', 'kelp', 'kestrel', 'lagoon', 'larch', 'lichen',
  'linden', 'lotus', 'lumen', 'lynx', 'maple', 'marble', 'meadow', 'mesa', 'mica', 'moss', 'nectar', 'nimbus', 'oak',
  'obsidian', 'onyx', 'opal', 'orchid', 'osprey', 'pebble', 'pine', 'plume', 'prism', 'quartz', 'quill', 'raven',
  'reed', 'ridge', 'rowan', 'saffron', 'sage', 'sequoia', 'shale', 'sierra', 'sorrel', 'spruce', 'summit', 'tamarind',
  'thistle', 'thorn', 'tundra', 'umber', 'vale', 'velvet', 'violet', 'willow', 'wren', 'yarrow', 'zephyr', 'zinnia',
];

/** Endings that make further neutral words (`cedarwick`) once the single words are used up. */
export const WORD_ENDINGS: readonly string[] = ['wick', 'dale', 'ford', 'holm', 'mere', 'stead', 'wyn', 'bury', 'crest', 'field'];

/** Business nouns for filler modules (filler is never an answer, so these may appear anywhere). */
export const DOMAIN_WORDS: readonly string[] = [
  'order', 'invoice', 'cart', 'product', 'shipment', 'catalog', 'inventory', 'payment', 'report', 'schedule', 'notice',
  'session', 'audit', 'metric', 'ticket', 'coupon', 'review', 'supplier', 'warehouse', 'refund', 'pricing', 'tax',
  'currency', 'locale', 'upload', 'quota', 'billing', 'ledger', 'voucher', 'parcel',
];

/** Suffixes for planted component and module names. */
export const NAME_SUFFIXES: readonly string[] = ['Panel', 'Tile', 'Strip', 'Banner', 'Frame', 'Badge', 'Toolbar', 'Drawer', 'Ribbon', 'Plaque'];

export const pascal = (word: string): string => (word === '' ? word : word[0]?.toUpperCase() + word.slice(1));

/** `['cedar', 'falcon']` → `cedarFalcon`. */
export const camel = (words: readonly string[]): string => words.map((word, position) => (position === 0 ? word : pascal(word))).join('');

/** `['cedar', 'falcon']` → `CEDAR_FALCON`. */
export const upperSnake = (words: readonly string[]): string => words.map(word => word.toUpperCase()).join('_');
