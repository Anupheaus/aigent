import { describeStoreContract } from '../testing/contract/store-contract.js';
import { createInMemoryStore } from './in-memory-store.js';

describeStoreContract({ name: 'in-memory store', create: async () => ({ store: createInMemoryStore() }) });
