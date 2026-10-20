import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { findSecrets, openSecretStart } from './builtin/secret-patterns.js';
import { redactSecrets } from './builtin/secrets.js';
import { BENIGN_CORPUS, SECRET_SAMPLES } from './fixtures.test-support.js';
import { createStreamHoldback } from './stream-holdback.js';

const HOLD = 64;

function holdback() {
  return createStreamHoldback({ holdBackChars: HOLD, openStart: openSecretStart, spans: findSecrets, release: segment => redactSecrets(segment).text });
}

/** Splits `text` at the given cut positions (sorted, deduplicated). */
function chunk(text: string, cuts: number[]): string[] {
  const points = [...new Set(cuts.map(cut => cut % (text.length + 1)))].sort((left, right) => left - right);
  const chunks: string[] = [];
  let previous = 0;
  for (const point of [...points, text.length]) { chunks.push(text.slice(previous, point)); previous = point; }
  return chunks;
}

function streamed(chunks: string[]): { emitted: string[]; text: string } {
  const guard = holdback();
  const emitted = chunks.map(piece => guard.push(piece));
  emitted.push(guard.end());
  return { emitted, text: emitted.join('') };
}

describe('stream hold-back', () => {
  it('never emits any part of a secret, however the stream is chunked, and otherwise emits exactly the redacted text', () => {
    const word = fc.constantFrom(...BENIGN_CORPUS.map(text => text.slice(0, 40)), 'hello', 'the result is', '\n', 'x = 1;');
    fc.assert(fc.property(
      fc.array(word, { maxLength: 4 }), fc.constantFrom(...SECRET_SAMPLES), fc.array(word, { maxLength: 4 }), fc.array(fc.nat(), { maxLength: 12 }),
      (before, { text: secret }, after, cuts) => {
        const full = `${before.join(' ')} ${secret} ${after.join(' ')}`;
        const { text } = streamed(chunk(full, cuts));
        expect(text).toBe(redactSecrets(full).text);
        expect(text).not.toContain(secret);
      },
    ), { numRuns: 400 });
  });

  it('splits a secret at every position without leaking it', () => {
    for (const { text: secret } of SECRET_SAMPLES) {
      const full = `key: ${secret} end`;
      for (let position = 0; position <= full.length; position += 1) {
        const { emitted, text } = streamed([full.slice(0, position), full.slice(position)]);
        expect(text).toBe(redactSecrets(full).text);
        for (const piece of emitted) expect(piece.includes(secret.slice(0, 12)) && !piece.includes('[REDACTED')).toBe(false);
      }
    }
  });

  it.each([16, 17, 24, 64])('never leaks a secret split at any position with holdBackChars %i', hold => {
    for (const { text: secret } of SECRET_SAMPLES) {
      const full = `the value ${secret} end`;
      for (let position = 0; position <= full.length; position += 1) {
        const guard = createStreamHoldback({ holdBackChars: hold, openStart: openSecretStart, spans: findSecrets, release: segment => redactSecrets(segment).text });
        const emitted = [guard.push(full.slice(0, position)), guard.push(full.slice(position)), guard.end()];
        expect(emitted.join('')).not.toContain(secret);
      }
    }
  });

  it('passes ordinary text through unchanged, releasing all but the window as it goes', () => {
    const guard = holdback();
    const text = 'a'.repeat(100);
    expect(guard.push(text)).toBe('a'.repeat(100 - HOLD));
    expect(guard.end()).toBe('a'.repeat(HOLD));
  });
});
