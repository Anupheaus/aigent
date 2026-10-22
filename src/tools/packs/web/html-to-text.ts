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
/**
 * Elements whose content is never page text: code, page chrome and form controls. A `form` itself is not dropped:
 * whole pages (ASP.NET WebForms) sit inside one.
 */
const DROPPED: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'template', 'svg', 'nav', 'footer', 'aside', 'head', 'iframe', 'object', 'canvas', 'button', 'select', 'textarea', 'label']);
/** Elements that may stay inside `head`; any other start tag ends it, as an HTML5 parser does when `</head>` is omitted. */
const HEAD_CONTENT: ReadonlySet<string> = new Set(['title', 'meta', 'link', 'style', 'script', 'base', 'noscript', 'template']);
const BLOCKS: ReadonlySet<string> = new Set(['p', 'div', 'br', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'section', 'article', 'main', 'header', 'blockquote', 'pre', 'hr', 'dd', 'dt', 'dl', 'figure', 'figcaption', 'address', 'body']);
const VOID: ReadonlySet<string> = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const MAIN: ReadonlySet<string> = new Set(['main', 'article']);
const HEADING = /^h([1-6])$/;
/** Raw-text elements whose content (one text token) is never page text, even past `MAX_DEPTH` where they are not tracked. */
const RAW_TEXT_DROPPED: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'noscript', 'iframe', 'xmp', 'noembed', 'noframes', 'title']);
/** Longest title, heading and link text kept, and most headings listed: a page cannot flood the result with them. */
const MAX_TITLE_CHARS = 300;
const MAX_HEADING_CHARS = 300;
const MAX_HEADINGS = 100;
const MAX_LINK_TEXT_CHARS = 300;
/** Raw text collected for a bounded field before it is tidied and cut (whitespace collapses, so keep some slack). */
const RAW_SLACK = 4;

/** `text` added to `collected` while it is shorter than `limit` times the slack. */
function appendBounded(params: { collected: string; text: string; limit: number }): string {
  const { collected, text, limit } = params;
  return collected.length >= limit * RAW_SLACK ? collected : collected + text;
}

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
 * form controls are dropped, blocks become lines, entities are decoded. Linear in the input, so huge or malformed pages are safe.
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
  /** SVG elements open: an SVG `<title>` names an icon, not the page. */
  let inSvg = 0;
  let hasTitle = false;
  /** A raw-text element opened past `MAX_DEPTH` (untracked): its one text token is skipped. */
  let skipRawText = false;

  const addLinkText = (text: string): void => {
    if (link != null) link.text = appendBounded({ collected: link.text, text, limit: MAX_LINK_TEXT_CHARS });
  };
  const write = (text: string): void => {
    body += text;
    if (inMain > 0) main += text;
    if (heading != null) heading.text = appendBounded({ collected: heading.text, text, limit: MAX_HEADING_CHARS });
    addLinkText(text);
  };
  const closeLink = (): void => {
    if (link?.url != null && !seenLinks.has(link.url) && links.length < MAX_LINKS) {
      seenLinks.add(link.url);
      links.push({ text: tidy(link.text).slice(0, MAX_LINK_TEXT_CHARS) || link.url, url: link.url });
    }
    link = undefined;
  };
  const pop = (): void => {
    const name = stack.pop() as string;
    if (DROPPED.has(name)) dropped -= 1;
    if (MAIN.has(name)) inMain -= 1;
    if (name === 'svg') inSvg -= 1;
    if (name === 'title' && inSvg === 0 && tidy(title) !== '') hasTitle = true;
    if (name === 'a') closeLink();
    const level = HEADING.exec(name)?.[1];
    if (level != null && heading != null) {
      const text = tidy(heading.text).slice(0, MAX_HEADING_CHARS);
      if (text !== '' && headings.length < MAX_HEADINGS) headings.push({ level: heading.level, text });
      heading = undefined;
    }
    if (BLOCKS.has(name) && dropped === 0) write('\n');
  };

  for (const token of htmlTokens(html)) {
    if (token.type === 'text') {
      if (skipRawText) skipRawText = false;
      else if (stack.at(-1) === 'title') { if (!hasTitle && inSvg === 0) title = appendBounded({ collected: title, text: token.text, limit: MAX_TITLE_CHARS }); }
      else if (dropped === 0) write(decodeEntities(token.text));
      // A link in page chrome (navigation, footer) is still a link worth listing, with its text.
      else addLinkText(decodeEntities(token.text));
      continue;
    }
    skipRawText = false;
    const { name } = token;
    if (token.type === 'end') {
      const index = stack.lastIndexOf(name);
      if (index !== -1) while (stack.length > index) pop();
      continue;
    }
    const openHead = stack.lastIndexOf('head');
    if (openHead !== -1 && !HEAD_CONTENT.has(name)) while (stack.length > openHead) pop();
    if (name === 'base' && token.attributes.href != null) base = absoluteUrl({ href: token.attributes.href, base: params.baseUrl }) ?? base;
    if (BLOCKS.has(name) && dropped === 0) write('\n');
    if (VOID.has(name) || token.selfClosing) continue;
    if (stack.length >= MAX_DEPTH) { skipRawText = RAW_TEXT_DROPPED.has(name); continue; }
    stack.push(name);
    if (DROPPED.has(name)) dropped += 1;
    if (MAIN.has(name)) inMain += 1;
    if (name === 'svg') inSvg += 1;
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
  return { title: tidy(decodeEntities(title)).slice(0, MAX_TITLE_CHARS), text: truncated ? content.slice(0, maxChars) : content, headings, links, truncated };
}
