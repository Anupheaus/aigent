import { describeError } from '../core/describe-value.js';
import type { RedactableRecord } from './redact.js';
import type { RecordWriter } from './record-writer.js';

export interface PersistRunParams {
  /** Absent when the runtime has no store: nothing is written. */
  writer?: RecordWriter;
  /** The agent name: all of an agent's writes go through one queue. */
  queueKey: string;
  /** The run's records (run, trace, response index, agent feedback), written in order. */
  records: RedactableRecord[];
}

const WARNING_PREFIX = 'Could not save run record: ';

/** Why one record was not written, or undefined when it was. */
async function writeOne(params: { writer: RecordWriter; queueKey: string; record: RedactableRecord }): Promise<string | undefined> {
  const { writer, queueKey, record } = params;
  const label = `'${record.collection}/${record.key}'`;
  try {
    return await writer.create({ queueKey, record }) ? undefined : `${label} already exists`;
  } catch (error) {
    return `${label} failed: ${describeError(error)}`;
  }
}

/**
 * Writes a finished run's records through the writer (redact, then the agent's queue). Returns one warning naming every
 * record that was not written, instead of throwing: telemetry must never fail a finished task, and a failed write never
 * stops the others.
 */
export async function persistRun(params: PersistRunParams): Promise<string | undefined> {
  const { writer, queueKey, records } = params;
  if (writer == null) return undefined;
  const problems: string[] = [];
  for (const record of records) {
    const problem = await writeOne({ writer, queueKey, record });
    if (problem != null) problems.push(problem);
  }
  return problems.length === 0 ? undefined : `${WARNING_PREFIX}${problems.join('; ')}`;
}
