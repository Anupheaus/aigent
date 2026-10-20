import type { ToolErrorDetail } from './tool-error-detail.js';

export type ToolEnvelope =
  | { id: string; tool: string; ok: true; result: unknown }
  | { id: string; tool: string; ok: false; error: ToolErrorDetail };
