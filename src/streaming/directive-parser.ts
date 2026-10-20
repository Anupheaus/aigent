import { DIRECTIVE_SCHEMAS } from './directive-schemas.js';
import type { DirectiveType, PlanUpdate, TodoOp } from './directive-schemas.js';

export type Directive =
  | { type: 'outcome'; data: { success: boolean; answer: string } }
  | { type: 'status'; data: { text: string } }
  | { type: 'plan'; data: { updates: PlanUpdate[] } }
  | { type: 'todo'; data: { ops: TodoOp[] } };

export interface ParseOutput {
  /** Visible text with directive lines removed. */
  text: string;
  directives: Directive[];
  warnings: string[];
}

export interface DirectiveParser {
  push(chunk: string): ParseOutput;
  /** Flushes anything held back; call once when the stream ends. */
  end(): ParseOutput;
}

const MARKER = '::aigent';
const JSON_PREVIEW_LENGTH = 80;

/** True while `buffer` could still turn out to be (the start of) a directive line. */
function couldBeDirective(buffer: string): boolean {
  return MARKER.startsWith(buffer) || buffer.startsWith(MARKER);
}

function parseDirectiveLine(line: string, output: ParseOutput): void {
  const body = line.slice(MARKER.length).trim();
  const separator = body.search(/\s/);
  const typeName = separator === -1 ? body : body.slice(0, separator);
  const jsonText = separator === -1 ? '' : body.slice(separator).trim();
  if (!(typeName in DIRECTIVE_SCHEMAS)) {
    output.warnings.push(`Unknown ${MARKER} directive type '${typeName}'; expected one of ${Object.keys(DIRECTIVE_SCHEMAS).join(', ')}`);
    return;
  }
  const type = typeName as DirectiveType;
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch { // model-written text is untrusted; report instead of throwing
    output.warnings.push(`Directive '${type}' has invalid JSON: ${jsonText.slice(0, JSON_PREVIEW_LENGTH)}`);
    return;
  }
  const validated = DIRECTIVE_SCHEMAS[type].safeParse(json);
  if (!validated.success) {
    output.warnings.push(`Directive '${type}' failed validation: ${validated.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
    return;
  }
  output.directives.push({ type, data: validated.data } as Directive);
}

export function createDirectiveParser(): DirectiveParser {
  let buffer = '';
  let atLineStart = true;

  function process(output: ParseOutput, isFinal: boolean): void {
    for (;;) {
      if (buffer === '') return;
      if (!atLineStart) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) { output.text += buffer; buffer = ''; return; }
        output.text += buffer.slice(0, newline + 1);
        buffer = buffer.slice(newline + 1);
        atLineStart = true;
        continue;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (!isFinal && couldBeDirective(buffer)) return; // hold back until we can decide
        if (isFinal && buffer.startsWith(MARKER)) { parseDirectiveLine(buffer, output); buffer = ''; return; }
        output.text += buffer;
        buffer = '';
        atLineStart = false;
        return;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.startsWith(MARKER)) parseDirectiveLine(line, output);
      else output.text += `${line}\n`;
    }
  }

  return {
    push(chunk) {
      const output: ParseOutput = { text: '', directives: [], warnings: [] };
      buffer += chunk;
      process(output, false);
      return output;
    },
    end() {
      const output: ParseOutput = { text: '', directives: [], warnings: [] };
      process(output, true);
      return output;
    },
  };
}
