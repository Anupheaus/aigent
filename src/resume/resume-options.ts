import { createAigentError } from '../core/aigent-error.js';
import type { ResumeOptions } from './instance-runtime.js';

export interface ValidateResumeOptionsParams {
  resume?: ResumeOptions;
  captureContent: boolean;
  hasRedact: boolean;
}

/**
 * Throws `invalid_input` for a resume setup that cannot both keep the store owner's content rules and restore a run:
 * `captureContent: false` (a resume needs the task text, messages and tool arguments), and `redact` without an
 * explicit `checkpointRedaction` (a redacted checkpoint restores a redacted prompt; a raw one stores the content).
 */
export function validateResumeOptions(params: ValidateResumeOptionsParams): void {
  const { resume, captureContent, hasRedact } = params;
  if (resume == null) return;
  if (!captureContent) {
    throw createAigentError({ code: 'invalid_input', message: 'resume needs the content of each run (task text, messages, tool arguments) in its checkpoints, which captureContent: false forbids; turn one of them off', details: { option: 'resume' } });
  }
  const { checkpointRedaction } = resume;
  if (checkpointRedaction !== undefined && checkpointRedaction !== 'raw' && checkpointRedaction !== 'redacted') {
    throw createAigentError({ code: 'invalid_input', message: `resume.checkpointRedaction must be 'raw' or 'redacted', got ${String(checkpointRedaction)}`, details: { option: 'resume.checkpointRedaction' } });
  }
  if (hasRedact && checkpointRedaction == null) {
    throw createAigentError({
      code: 'invalid_input',
      message: "resume with redact needs resume.checkpointRedaction: 'redacted' (checkpoints pass through redact, so a resumed run continues from the redacted prompt) or 'raw' (checkpoints, the call ledger and instance records are stored unredacted)",
      details: { option: 'resume.checkpointRedaction' },
    });
  }
}
