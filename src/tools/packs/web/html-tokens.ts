/** One piece of an HTML document, as the tolerant tokenizer reads it. */
export type HtmlToken =
  | { type: 'text'; text: string }
  | { type: 'start'; name: string; attributes: Record<string, string>; selfClosing: boolean }
  | { type: 'end'; name: string };

/** Elements whose content is raw text up to their own end tag (never markup). */
const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const NAME_START = /[A-Za-z]/;
const NAME_CHAR = /[A-Za-z0-9:_-]/;
const SPACE = /\s/;

/** Where the end tag of raw-text element `name` starts at or after `from` (any case), or the end of the text. */
function rawTextEnd(params: { html: string; name: string; from: number }): number {
  const { html, name, from } = params;
  const pattern = new RegExp(`</${name}`, 'gi');
  pattern.lastIndex = from;
  return pattern.exec(html)?.index ?? html.length;
}

/** Reads a tag's attributes from `from` up to its closing `>`; quotes are respected, so `>` inside them does not end it. */
function readAttributes(params: { html: string; from: number }): { attributes: Record<string, string>; selfClosing: boolean; end: number } {
  const { html, from } = params;
  const attributes: Record<string, string> = {};
  let position = from;
  let selfClosing = false;
  while (position < html.length) {
    const character = html.charAt(position);
    if (character === '>') return { attributes, selfClosing, end: position + 1 };
    if (character === '/') { selfClosing = html.charAt(position + 1) === '>'; position += 1; continue; }
    if (SPACE.test(character)) { position += 1; continue; }
    let name = '';
    while (position < html.length && !SPACE.test(html.charAt(position)) && !'=>/'.includes(html.charAt(position))) { name += html.charAt(position); position += 1; }
    while (position < html.length && SPACE.test(html.charAt(position))) position += 1;
    let value = '';
    if (html.charAt(position) === '=') {
      position += 1;
      while (position < html.length && SPACE.test(html.charAt(position))) position += 1;
      const quote = html.charAt(position);
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, position + 1);
        const stop = close === -1 ? html.length : close;
        value = html.slice(position + 1, stop);
        position = stop + 1;
      } else {
        const start = position;
        while (position < html.length && !SPACE.test(html.charAt(position)) && html.charAt(position) !== '>') position += 1;
        value = html.slice(start, position);
      }
    }
    if (name !== '') attributes[name.toLowerCase()] = value;
    if (name === '' && value === '') position += 1;
  }
  return { attributes, selfClosing, end: html.length };
}

/**
 * A forgiving, linear HTML tokenizer: comments, doctypes and processing instructions are skipped, unterminated
 * constructs end at the end of the input, raw-text elements (scripts, styles, titles) hold their content as one text
 * token, and anything that is not a tag is text. It never executes or fetches anything.
 */
export function* htmlTokens(html: string): Generator<HtmlToken> {
  let position = 0;
  while (position < html.length) {
    const open = html.indexOf('<', position);
    if (open === -1) { yield { type: 'text', text: html.slice(position) }; return; }
    if (open > position) yield { type: 'text', text: html.slice(position, open) };
    const next = html.charAt(open + 1);
    if (html.startsWith('<!--', open)) {
      const close = html.indexOf('-->', open + 4);
      position = close === -1 ? html.length : close + 3;
    } else if (next === '!' || next === '?') {
      const close = html.indexOf('>', open);
      position = close === -1 ? html.length : close + 1;
    } else if (next === '/' && NAME_START.test(html.charAt(open + 2))) {
      let end = open + 2;
      while (end < html.length && NAME_CHAR.test(html.charAt(end))) end += 1;
      const name = html.slice(open + 2, end).toLowerCase();
      const close = html.indexOf('>', end);
      position = close === -1 ? html.length : close + 1;
      yield { type: 'end', name };
    } else if (NAME_START.test(next)) {
      let end = open + 1;
      while (end < html.length && NAME_CHAR.test(html.charAt(end))) end += 1;
      const name = html.slice(open + 1, end).toLowerCase();
      const { attributes, selfClosing, end: tagEnd } = readAttributes({ html, from: end });
      yield { type: 'start', name, attributes, selfClosing };
      position = tagEnd;
      if (RAW_TEXT_ELEMENTS.has(name) && !selfClosing) {
        const close = rawTextEnd({ html, name, from: position });
        if (close > position) yield { type: 'text', text: html.slice(position, close) };
        const closeEnd = html.indexOf('>', close);
        position = closeEnd === -1 ? html.length : closeEnd + 1;
        yield { type: 'end', name };
      }
    } else {
      yield { type: 'text', text: '<' };
      position = open + 1;
    }
  }
}
