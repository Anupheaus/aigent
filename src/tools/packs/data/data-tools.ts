import type { Tool } from '../../tool-types.js';
import { createCalc } from './calc.js';
import { createCsvQuery } from './csv-query.js';
import { createJsonQuery } from './json-query.js';
import { createRegexExtract } from './regex-extract.js';
import { createTextDiff } from './text-diff.js';

/** The data/format pack: `json_query`, `csv_query`, `text_diff`, `regex_extract` and `calc`, all pure and cached. */
export function dataTools(): Tool[] {
  return [createJsonQuery(), createCsvQuery(), createTextDiff(), createRegexExtract(), createCalc()];
}
