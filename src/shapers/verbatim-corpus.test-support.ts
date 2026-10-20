/** Bytes in the `huge-1mb` fixture. */
const HUGE_BYTES = 1_024 * 1_024;

function hugeText(): string {
  const lines: string[] = [];
  let length = 0;
  for (let lineNumber = 0; length < HUGE_BYTES; lineNumber += 1) {
    const line = `line ${lineNumber}: ${'abcdefghij'.repeat(lineNumber % 7)}\t  \u001b[3${lineNumber % 8}m`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n').slice(0, HUGE_BYTES);
}

/**
 * Tricky file contents that must reach the model byte for byte when a result is verbatim: markup that looks like
 * boilerplate, tabular text, ANSI escapes, repeated lines, line-ending and whitespace quirks, empty and huge files.
 */
export const VERBATIM_CORPUS: Record<string, string> = {
  'html-page': '<!doctype html>\n<html><head><style>body{margin:0}</style><script>var a = 1;</script></head>\n<body><nav>Home | About</nav><main><h1>Title</h1>\n\n\n\n<p>Main   text</p></main><!-- note --><aside>ad</aside><footer>(c)</footer></body></html>\n',
  'html-fragment': '<div class="card">\n  <nav>menu</nav>\n  <p>Fragment</p>\n</div>',
  'html-template': '<template>\n  <script setup>const x = 1;</script>\n  <footer>{{ year }}</footer>\n</template>\n',
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><style>.a{fill:red}</style><!-- c --><rect class="a" width="10" height="10"/></svg>',
  xml: '<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <item id="1">a</item>\n  <item id="1">a</item>\n  <item id="1">a</item>\n</root>\n',
  csv: 'id,name,score\n1,Ann,3\n2,Bob,\n3,"Cy, Jr",7\n',
  tsv: 'id\tname\n1\tAnn\n2\tBob\n',
  json: '{\n  "b": 1,\n  "a": [1, 2, 3],\n  "nested": { "z": null, "y": "" }\n}\n',
  ndjson: '{"a":1}\n{"a":1}\n{"a":1}\n{"a":2}\n',
  'minified-js': 'function a(b){return b?b.c:void 0}var d=[1,2,3].map(function(e){return e*2});/*! keep */console.log(d);',
  'markdown-decorated': '# Title\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n\n\n> quote   \n\n```js\nconst x = 1;  \n```\n',
  'ansi-file': '\u001b[31mred\u001b[0m text\r\nprogress 10%\rprogress 100%\n\u001b]0;title\u0007done\n',
  'repeated-lines': 'same\nsame\nsame\nsame\nother\n',
  'base64-blob': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'crlf-bom': '﻿first line\r\nsecond line\r\n\r\n\r\n\r\nlast\r\n',
  'trailing-whitespace': 'a   \nb\t\t\n   \n\n\n\nc ',
  tabs: '\tindented\n\t\tmore\n',
  empty: '',
  'huge-1mb': hugeText(),
};
