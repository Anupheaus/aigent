import { describe, expect, it } from 'vitest';
import { isAigentError } from '../../core/aigent-error.js';
import { createMongoFake } from '../../store/mongo-fake.test-support.js';
import type { MongoDbLike } from '../../store/mongo-types.js';
import { openMongoStore } from './open-mongo-store.js';
import type { MongoDriver } from './open-mongo-store.js';

/** A driver whose client fails (or not) to connect, counting closes. */
function scriptedDriver(params: { connectError?: Error }): { driver: MongoDriver; closes: () => number } {
  const { connectError } = params;
  let closes = 0;
  const db: MongoDbLike = createMongoFake().db;
  const MongoClient = function MongoClient() {
    return {
      connect: async () => { if (connectError != null) throw connectError; },
      close: async () => { closes += 1; },
      db: () => db,
    };
  } as unknown as MongoDriver['MongoClient'];
  return { driver: { MongoClient }, closes: () => closes };
}

describe('openMongoStore', () => {
  it('closes the client and throws store_failed, without the password, when connecting fails', async () => {
    const password = ['hunter', '2-secret'].join('');
    const { driver, closes } = scriptedDriver({ connectError: new Error('connect ECONNREFUSED 127.0.0.1:27017') });
    const failure = await openMongoStore({ options: { uri: `mongodb://admin:${password}@localhost:27017`, dbName: 'test' }, driver }).catch((error: unknown) => error);
    expect(isAigentError(failure) && failure.code).toBe('store_failed');
    expect((failure as Error).message).toContain('ECONNREFUSED');
    expect((failure as Error).message).not.toContain(password);
    expect(closes()).toBe(1);
  });

  it('gives a working store whose close closes the client', async () => {
    const { driver, closes } = scriptedDriver({});
    const store = await openMongoStore({ options: { uri: 'mongodb://localhost:27017', dbName: 'test' }, driver });
    expect(await store.compareAndSet({ collection: 'c', key: 'k', expectedVersion: undefined, value: 1 })).toBe(true);
    await store.close();
    expect(closes()).toBe(1);
  });
});
