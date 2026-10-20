import type { Shaper } from '../shaper-types.js';

/** Elements removed with their content: page chrome and code, not the page's text. */
const BOILERPLATE_ELEMENTS = ['script', 'style', 'nav', 'footer', 'aside'];
const COMMENTS = /<!--[\s\S]*?-->/g;
const SPACES = /[ \t\f\v]+/g;
const LINE_BREAKS = /\s*\n\s*/g;

function elementPattern(element: string): RegExp {
  return new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?</${element}\\s*>`, 'gi');
}

function stripBoilerplate(html: string): string {
  const withoutElements = BOILERPLATE_ELEMENTS.reduce((text, element) => text.replace(elementPattern(element), ''), html);
  return withoutElements.replace(COMMENTS, '').replace(SPACES, ' ').replace(LINE_BREAKS, '\n').trim();
}

/** web-page only: scripts, styles, navigation, footers, asides and comments removed, whitespace collapsed. */
export const htmlBoilerplateShaper: Shaper = {
  name: 'html-boilerplate',
  appliesTo: ['web-page'],
  shape: ({ value, context }) => {
    if (typeof value !== 'string') return undefined;
    const stripped = stripBoilerplate(value);
    if (stripped === value) return undefined;
    return { value: stripped, note: `HTML boilerplate removed (scripts, styles, navigation, footers, asides, comments); full page: handle ${context.originalHandle()}` };
  },
};
