import { decodeEntities } from './html-entities.js';
import { htmlTokens } from './html-tokens.js';

/** The readable parts of a page. */
export interface ExtractedPage {
  title: string;
  /** The main content (a `main` or `article` element when there is one, else the body), one block per line. */
  text: string;
  headings: { level: number; text: string }[];
  /** Absolute http(s) links, first occurrence of each URL, at most `MAX_LINKS`. */
  links: { text: string; url: string }[];
  /** The text was cut at `maxChars`. */
  truncated: boolean;
}

export interface HtmlToTextParams {
  html: string;
  /** The page's URL: relative links resolve against it (or the page's `<base href>`). */
  baseUrl: string;
  maxChars?: number;
}

export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_LINKS = 50;
/** Deepest element nesting tracked; deeper elements are read as text of their parent. */
const MAX_DEPTH = 256;
/** Elements whose content is never page text: code, page chrome and controls. */
const DROPPED: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'aside', 'form', 'head', 'iframe', 'object', 'canvas', 'button', 'select', 'textarea']);
const BLOCKS: ReadonlySet<string> = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'section', 'article', 'main', 'header', 'blockquote', 'pre', 'hr', 'dd', 'dt', 'dl', 'figure', 'figcaption', 'address', 'body']);
const VOID: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const MAIN: ReadonlySet<string> = new Set(['main', 'article']);
const HEADING = /^h([1-6])$/;

/** One line per block, spaces collapsed (non-breaking ones too), blank lines dropped. */
function tidy(text: string): string {
  return text.split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(line => line !== '').join('\n');
}

function absoluteUrl(params: { href: string; base: string }): string | undefined {
  const { href, base } = params;
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Readable text from HTML without running or fetching anything: scripts, styles, navigation, footers, asides and
 * forms are dropped, blocks become lines, entities are decoded. Linear in the input, so huge or malformed pages are safe.
 */
export function htmlToText(params: HtmlToTextParams): ExtractedPage {
  const { html, maxChars = DEFAULT_MAX_CHARS } = params;
  let base = params.baseUrl;
  const stack: string[] = [];
  let dropped = 0;
  let inMain = 0;
  let title = '';
  let body = '';
  let main = '';
  const headings: ExtractedPage['headings'] = [];
  const links: ExtractedPage['links'] = [];
  const seenLinks = new Set<string>();
  let heading: { level: number; text: string } | undefined;
  let link: { url?: string; text: string } | undefined;

  const write = (text: string): void => {
    body += text;
    if (inMain > 0) main += text;
    if (heading != null) heading.text += text;
    if (link != null) link.text += text;
  };
  const closeLink = (): void => {
    if (link?.url != null && !seenLinks.has(link.url) && links.length < MAX_LINKS) {
      seenLinks.add(link.url);
      links.push({ text: tidy(link.text) || link.url, url: link.url });
    }
    link = undefined;
  };
  const pop = (): void => {
    const name = stack.pop() as string;
    if (DROPPED.has(name)) dropped -= 1;
    if (MAIN.has(name)) inMain -= 1;
    if (name === 'a') closeLink();
    const level = HEADING.exec(name)?.[1];
    if (level != null && heading != null) {
      const text = tidy(heading.text);
      if (text !== '') headings.push({ level: heading.level, text });
      heading = undefined;
    }
    if (BLOCKS.has(name) && dropped === 0) write('\n');
  };

  for (const token of htmlTokens(html)) {
    if (token.type === 'text') {
      if (stack.at(-1) === 'title') title += token.text;
      else if (dropped === 0) write(decodeEntities(token.text));
      // A link in page chrome (navigation, footer) is still a link worth listing, with its text.
      else if (link != null) link.text += decodeEntities(token.text);
      continue;
    }
    const { name } = token;
    if (token.type === 'end') {
      const index = stack.lastIndexOf(name);
      if (index !== -1) while (stack.length > index) pop();
      continue;
    }
    if (name === 'base' && token.attributes.href != null) base = absoluteUrl({ href: token.attributes.href, base: params.baseUrl }) ?? base;
    if (BLOCKS.has(name) && dropped === 0) write('\n');
    if (VOID.has(name) || token.selfClosing || stack.length >= MAX_DEPTH) continue;
    stack.push(name);
    if (DROPPED.has(name)) dropped += 1;
    if (MAIN.has(name)) inMain += 1;
    const level = HEADING.exec(name)?.[1];
    if (level != null && dropped === 0) heading = { level: Number(level), text: '' };
    if (name === 'a') {
      closeLink();
      const href = token.attributes.href;
      const url = href == null ? undefined : absoluteUrl({ href, base });
      link = { text: '', ...(url == null ? {} : { url }) };
    }
  }
  while (stack.length > 0) pop();
  const content = tidy(main) !== '' ? tidy(main) : tidy(body);
  const truncated = content.length > maxChars;
  return { title: tidy(decodeEntities(title)), text: truncated ? content.slice(0, maxChars) : content, headings, links, truncated };
}
