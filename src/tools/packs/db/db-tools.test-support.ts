import type { DbAccess, DbCountParams, DbFindParams } from './db-access.js';
import { createMemoryDbAccess } from './memory-db-access.js';

/** A `DbAccess` that records every call it gets (without the signal) before passing it on. */
export interface CountingAccess extends DbAccess {
  calls: { method: 'find' | 'count'; params: Omit<DbFindParams | DbCountParams, 'signal'> }[];
}

export function countingAccess(inner: DbAccess): CountingAccess {
  const calls: CountingAccess['calls'] = [];
  return {
    calls,
    find: async params => {
      const { signal: _signal, ...rest } = params;
      calls.push({ method: 'find', params: rest });
      return inner.find(params);
    },
    count: async params => {
      const { signal: _signal, ...rest } = params;
      calls.push({ method: 'count', params: rest });
      return inner.count(params);
    },
  };
}

/** A small database: people (with secrets), orders and audit logs. */
export function fixtureAccess(): CountingAccess {
  return countingAccess(createMemoryDbAccess({
    collections: {
      people: [
        { _id: 1, name: 'Ann', age: 34, password: 'p1', profile: { ssn: '111', city: 'Leeds' }, joined: new Date('2020-02-01T00:00:00Z') },
        { _id: 2, name: 'Bob', age: 19, password: 'p2', profile: { ssn: '222', city: 'York' }, joined: new Date('2021-03-01T00:00:00Z') },
        { _id: 3, name: 'Cy', age: 51, password: 'p3', profile: { ssn: '333', city: 'Hull' }, joined: new Date('2019-04-01T00:00:00Z') },
      ],
      audit: [{ _id: 1, action: 'login', user: 'Ann' }],
    },
  }));
}
