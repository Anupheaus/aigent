import type { TaskInput } from './task-input.js';

function bulletList(entries: string[]): string {
  return entries.map(entry => `- ${entry}`).join('\n');
}

function ambiguityText(input: TaskInput): string | undefined {
  const { onAmbiguity, unattended } = input;
  if (unattended === true) return 'No user is available. Do not ask questions; state your assumptions in the answer.';
  if (onAmbiguity === 'assume') return 'If something is ambiguous, make a reasonable assumption and state it.';
  if (onAmbiguity === 'fail') return 'If something is ambiguous, stop and report what is unclear instead of guessing.';
  return undefined;
}

/** Renders the task into a fixed-order brief; only provided sections appear. */
export function buildTaskBrief(input: TaskInput): string {
  const { task, context, inputs, references, inScope, outOfScope, constraints, acceptanceCriteria } = input;
  const sections = [`# Task\n${task}`];
  if (context != null) sections.push(`## Context\n${context}`);
  if (inputs != null) sections.push(`## Inputs\n${JSON.stringify(inputs, null, 2)}`);
  if (references != null && references.length > 0) {
    const rendered = references.map(reference => {
      const { label, content, path } = reference;
      return [`### ${label}`, path != null ? `Path: ${path}` : undefined, content].filter(part => part != null).join('\n');
    });
    sections.push(`## References\n${rendered.join('\n\n')}`);
  }
  if (inScope != null && inScope.length > 0) sections.push(`## In scope\n${bulletList(inScope)}`);
  if (outOfScope != null && outOfScope.length > 0) sections.push(`## Out of scope\n${bulletList(outOfScope)}`);
  if (constraints != null && constraints.length > 0) sections.push(`## Constraints\n${bulletList(constraints)}`);
  if (acceptanceCriteria != null && acceptanceCriteria.length > 0) sections.push(`## Acceptance criteria\n${bulletList(acceptanceCriteria)}`);
  const ambiguity = ambiguityText(input);
  if (ambiguity != null) sections.push(`## Ambiguity\n${ambiguity}`);
  return sections.join('\n\n');
}
