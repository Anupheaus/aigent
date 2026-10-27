import { describe, expect, it } from 'vitest';
import { connectMongoStore } from './connect-mongo-store.js';

describe('connectMongoStore', () => {
  it('says how to install the driver when it is missing', async () => {
    // The driver is an optional peer and is not installed in this repository, so this is the path every default run takes.
    const failure = await connectMongoStore({ uri: 'mongodb://localhost:27017', dbName: 'test' }).then(() => undefined, (error: unknown) => error as Error);
    expect(failure?.message).toContain("npm install mongodb");
  });
});
