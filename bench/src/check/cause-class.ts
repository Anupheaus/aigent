import type { BugCause } from '../generate/families/bug-constructs.js';

/** Keywords per root-cause class, tried in order: a reported cause is matched by meaning, not by exact wording. */
const CAUSE_KEYWORDS: readonly [BugCause, RegExp][] = [
  ['off-by-one', /off[\s-]by[\s-]one|one past|out of bounds|past the end|<=\s*\w*\.?length|fencepost|boundary/i],
  ['injection', /inject|sql|xss|concatenat|unsanitis|unsanitiz/i],
  ['race', /race|concurren|lost update|without (a )?lock|atomic/i],
  ['resource-leak', /leak|never closed|not closed|close the (file )?handle|unclosed/i],
  ['swallowed-error', /swallow|empty catch|silently|ignored error|error is ignored|catch block is empty/i],
  ['timezone', /time\s?zone|utc|local (time|hours)|gethours|daylight/i],
  ['wrong-default', /default/i],
  ['copy-paste', /copy|paste|duplicat|wrong (field|side|property)|right instead of bottom/i],
  ['wrong-operator', /operator|always true|\|\||logical (or|and)|should be &&/i],
  ['null-deref', /null|undefined|deref|missing (check|guard)|may not exist|not found case/i],
];

/** The root-cause class a free-text cause describes, or undefined when none matches. */
export function classifyCause(text: string): BugCause | undefined {
  return CAUSE_KEYWORDS.find(([, pattern]) => pattern.test(text))?.[0];
}
