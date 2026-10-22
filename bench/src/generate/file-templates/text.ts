/** Joins lines into file text with a final newline. */
export function lines(...parts: (string | readonly string[])[]): string {
  return `${parts.flat().join('\n')}\n`;
}

/** Builds a file line by line and remembers the 1-based line numbers of marked lines (planted bugs, decoys). */
export interface LineBuilder {
  push(...added: string[]): void;
  /** Adds one line and returns its 1-based number. */
  mark(line: string): number;
  text(): string;
}

export function createLineBuilder(): LineBuilder {
  const collected: string[] = [];
  return {
    push: (...added) => { collected.push(...added); },
    mark: line => { collected.push(line); return collected.length; },
    text: () => lines(collected),
  };
}
