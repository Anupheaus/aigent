export interface ChatBriefParams {
  context?: string;
  constraints?: string[];
  unattended?: boolean;
}

const UNATTENDED_TEXT = 'No user is available to answer questions. Do not ask; state your assumptions in the answer.';

/** The session brief every turn starts with (after the system prompt), or undefined when there is nothing to say. */
export function buildChatBrief(params: ChatBriefParams): string | undefined {
  const { context, constraints = [], unattended = false } = params;
  const sections = [
    ...(context == null || context === '' ? [] : [`## Context\n${context}`]),
    ...(constraints.length === 0 ? [] : [`## Constraints\n${constraints.map(constraint => `- ${constraint}`).join('\n')}`]),
    ...(unattended ? [`## Ambiguity\n${UNATTENDED_TEXT}`] : []),
  ];
  return sections.length === 0 ? undefined : `# Conversation\n\n${sections.join('\n\n')}`;
}
