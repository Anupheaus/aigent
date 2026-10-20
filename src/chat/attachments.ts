import { createHash } from 'node:crypto';
import { createAigentError } from '../core/aigent-error.js';
import type { RecordWriter } from '../telemetry/record-writer.js';
import type { AttachmentInput, ChatAttachmentOptions, ReadAttachmentResult } from './chat-types.js';
import type { MessageAttachment, Part } from './message.js';

/** Store collection of attachment contents, keyed by content hash. */
export const ATTACHMENTS_COLLECTION = 'attachments';
/** Text attachments up to this size are inlined into the model's view of the message; larger ones go by handle. */
export const INLINE_ATTACHMENT_BYTES = 8 * 1_024;
const TEXT_MIME_PATTERN = /^(text\/|application\/(json|xml|csv|x-ndjson|yaml)\b)/;
const DEFAULT_FILE_MIME = 'application/octet-stream';
const DEFAULT_TEXT_MIME = 'text/plain';

/** One stored attachment (`attachments/<id>`). */
export interface AttachmentRecord {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  /** Base64 of the content. */
  data: string;
  createdAt: number;
}

export interface PrepareAttachmentsParams {
  attachments: AttachmentInput[];
  options: ChatAttachmentOptions;
  /** The agent's model can see images (`capabilities.vision`). */
  vision: boolean;
  /** `provider:model`, named in errors. */
  model: string;
  /** Stores a record unless one with its id exists (content-hash dedupe). */
  save(record: AttachmentRecord): Promise<void>;
  now(): number;
}

export interface PreparedAttachments {
  /** Appended to the user's text in the model's view of the message. */
  modelText: string;
  parts: Part[];
  meta: MessageAttachment[];
}

async function resolveContent(params: { attachment: AttachmentInput; options: ChatAttachmentOptions }): Promise<ReadAttachmentResult> {
  const { attachment: { kind, ref, bytes, text, name, mimeType }, options: { readAttachment } } = params;
  if (ref != null) {
    if (readAttachment == null) throw createAigentError({ code: 'invalid_input', message: `Attachment '${ref}' is given by ref, but the chat has no attachments.readAttachment to read it`, details: { ref } });
    return readAttachment(ref);
  }
  const content = bytes ?? (text == null ? undefined : new TextEncoder().encode(text));
  if (content == null) throw createAigentError({ code: 'invalid_input', message: `An ${kind} attachment needs ref, bytes or text`, details: { kind } });
  return { name: name ?? `${kind}-attachment`, mimeType: mimeType ?? (text == null ? DEFAULT_FILE_MIME : DEFAULT_TEXT_MIME), bytes: content };
}

function contentId(bytes: Uint8Array): string {
  return `att_${createHash('sha256').update(bytes).digest('hex')}`;
}

async function describeImage(params: { content: ReadAttachmentResult; options: ChatAttachmentOptions; vision: boolean; model: string }): Promise<string | undefined> {
  const { content, options: { onNoVision = 'error', describe }, vision, model } = params;
  if (vision) return undefined;
  if (onNoVision === 'describe' && describe != null) return describe(content);
  throw createAigentError({
    code: 'invalid_input',
    message: `Image '${content.name}' cannot be sent: model '${model}' has no vision capability; use a vision model, or set attachments.onNoVision to 'describe' with a describe function`,
    details: { model, name: content.name },
  });
}

/** Stores attachment records by content hash through the given writer (redact and the session's write queue apply). */
export function attachmentSaver(params: { writer: RecordWriter; queueKey: string }): (record: AttachmentRecord) => Promise<void> {
  const { writer, queueKey } = params;
  // create() writes nothing when the content is already stored: identical content is kept once.
  return async record => { await writer.create({ queueKey, record: { collection: ATTACHMENTS_COLLECTION, key: record.id, value: record } }); };
}

/** Reads, stores (by content hash) and renders each attachment for the model: small text inline, the rest by handle. */
export async function prepareAttachments(params: PrepareAttachmentsParams): Promise<PreparedAttachments> {
  const { attachments, options, vision, model, save, now } = params;
  const prepared: PreparedAttachments = { modelText: '', parts: [], meta: [] };
  for (const attachment of attachments) {
    const content = await resolveContent({ attachment, options });
    const { name, mimeType, bytes } = content;
    const id = contentId(bytes);
    const description = attachment.kind === 'image' ? await describeImage({ content, options, vision, model }) : undefined;
    await save({ id, name, mimeType, bytes: bytes.byteLength, data: Buffer.from(bytes).toString('base64'), createdAt: now() });
    const isInline = attachment.kind === 'file' && TEXT_MIME_PATTERN.test(mimeType) && bytes.byteLength <= INLINE_ATTACHMENT_BYTES;
    const summary = description != null
      ? `[Image ${name}: ${description}]`
      : `[${attachment.kind === 'image' ? 'Image' : 'Attachment'} ${name} (${mimeType}, ${bytes.byteLength} bytes) stored as handle ${id}; its content is not included here]`;
    prepared.modelText += isInline ? `\n\n[Attachment ${name} (${mimeType})]\n${new TextDecoder().decode(bytes)}` : `\n\n${summary}`;
    prepared.parts.push(attachment.kind === 'image' ? { type: 'image', attachmentId: id, alt: name } : { type: 'file', attachmentId: id, name });
    prepared.meta.push({ id, kind: attachment.kind, name, mimeType, bytes: bytes.byteLength, inline: isInline, summary });
  }
  return prepared;
}
