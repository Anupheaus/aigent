import { describeValue } from '../core/describe-value.js';
import type { ToolEnvelope } from './tool-envelope.js';

/**
 * The tool message text the model receives. A result JSON cannot represent (cycles, BigInt) is sent as its plain
 * description instead of failing the run.
 */
export function envelopeText(envelope: ToolEnvelope): string {
  try {
    return JSON.stringify(envelope);
  } catch { // only a successful result can hold such a value; errors are plain data
    return JSON.stringify({ ...envelope, result: envelope.ok ? describeValue(envelope.result) : undefined });
  }
}
