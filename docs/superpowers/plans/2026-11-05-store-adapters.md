# Store Adapters and Embedding Recall Implementation Plan (Phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Durable stores beyond in-memory: a file store (single-machine, multi-process safe), a MongoDB store (optional peer dependency, versioned updates with retry), a shared `describeStoreContract` suite that every store (and consumer-written stores) must pass, a persistent vector index for knowledge/memory, and embedding-backed memory recall.

**Architecture:** Stores implement the existing `Store` interface (`get`, `compareAndSet`, `list`, optional `purge`, optional `delete`) — the contract suite is the specification. The file store keeps one JSON document per record under `<dir>/<collection>/<encoded-key>.json` with an atomic write (temp + rename) guarded by per-key lock files and version checks; the Mongo store uses one collection per logical collection with `{ _id: key, version, value }` and conditional `updateOne`/`insertOne` for CAS. Embedding recall plugs a `MemoryRetriever` backed by the knowledge `Embedder` + `VectorIndex` into memory.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check, `node:fs/promises`. `mongodb` optional peer dependency (adapter dynamically imported; tests use a faithful in-memory fake `Collection` double implementing the subset used; a gated live test exists but is NOT run here).

**Spec:** master plan "Store interface (atomic primitives)", "Concurrency-safe by design", Phase 6 in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: stores must be safe under concurrent in-process and (file store) multi-process writers; keys/collections are encoded so any string is safe on any OS filesystem (no traversal, reserved names, case collisions on Windows/macOS); partial writes never corrupt a record; no network, no real MongoDB in default tests.

## Review Focus

1. Contract coverage: CAS exclusivity under heavy contention (100 writers, one winner per version), `get` after crash-injected writes returns either the old or new full record (never torn), `list` consistency, large values, special-character keys/collections (`../x`, `CON`, `a/b`, unicode, very long, case-only differences), purge/delete semantics.
2. Multi-process file locking: two real Node child processes hammering the same key produce exactly the expected number of successful CAS increments; stale lock files from crashed processes are recovered after a timeout without allowing two writers.
3. Mongo adapter correctness against the fake: no operation other than the documented set, duplicate-key races map to CAS failure (not exceptions), indexes created idempotently, all errors mapped to `AigentError` with retryable details, connection lifecycle (`close`) and no leaked handles.
4. Embedding recall: relevance beats BM25 on a paraphrase fixture, embedder failure degrades to BM25 (never fails the run), index freshness when memory entries change/forgotten, vectors persisted and reloaded.

---

### Task 0: Store contract suite and file store

**Files:**
- Create: `src/testing/contract/store-contract.ts` (exported as `describeStoreContract` from `@anupheaus/aigent/testing/contract`), `src/store/file-store.ts`, `src/store/file-lock.ts`, `src/store/key-encoding.ts`, `src/store/file-store.worker.test-support.mjs` (child-process worker for multi-process tests)
- Modify: `src/store/store-types.ts` (`delete?(collection, key): Promise<boolean>` documented), `src/store/in-memory-store.ts` (implements `delete`), `src/index.ts` (`createFileStore`), `package.json` exports, README
- Test: beside; run `describeStoreContract` for in-memory and file store

**Interfaces (binding):** `createFileStore(options: { dir: string; lockTimeoutMs?: 10_000; staleLockMs?: 30_000; clock?; sleep? }): Store & { close(): Promise<void> }`. Record file JSON `{ schemaVersion: 1, key, version, value }`. `compareAndSet` = acquire lock file `<record>.lock` (exclusive create `wx`, content `{ pid, token, at }`), read current, compare version, write temp + `fsync` + rename, release (verify token); stale lock (age > `staleLockMs` and pid not alive when checkable) is stolen with an atomic rename-based takeover; `list` reads directory (skips temp/lock files, tolerates concurrent deletes); `get` reads without locking (atomic rename guarantees whole-file reads). `encodeKey(key)`: percent-style encoding of everything outside `[A-Za-z0-9._-]` plus Windows reserved names/trailing dots/case-collision-safe suffix (lowercase hex of the exact key hash appended when the encoded name differs only by case from another or exceeds 120 chars), reversible via stored `key` field. Contract suite scenarios (all registered as vitest tests): create-only-if-absent, version bump, mismatch fails, copy semantics, list, missing get, special keys corpus, large values (5 MB), CAS contention (100 concurrent writers ⇒ exactly one winner per round across 20 rounds), `purge` (if present) filter semantics, `delete` semantics (if present), crash-injection hook (store factory may supply `injectCrash` for torn-write tests; skipped otherwise).

- [ ] **Step 1: Failing tests**: contract suite on in-memory and file store; file-store specifics: temp-dir cleanup, torn-write injection (kill between temp write and rename ⇒ old record intact, stray temp ignored and cleaned), stale lock takeover, key-encoding property tests (injective over random strings, never produces traversal/reserved names, round trip), multi-process test with 3 child processes × 50 CAS increments on one key ⇒ final value exactly 150 via retry loop (`updateRecord`) ; works under the whole library: run the foundation e2e (task + report + feedback) against a file store in a temp dir and re-open with a fresh `createAigent`.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: store contract suite and multi-process-safe file store`.

---

### Task 1: Mongo store, vector index persistence, embedding recall

**Files:**
- Create: `src/store/mongo-store.ts`, `src/store/mongo-types.ts` (minimal `MongoCollectionLike`/`MongoDbLike` interfaces), `src/store/mongo-fake.test-support.ts` (faithful in-memory fake incl. duplicate-key errors with code 11000 and conditional updates), `src/knowledge/store-vector-index.ts` (vector index persisted in any `Store`, chunked records), `src/memory/embedding-retriever.ts`
- Modify: `package.json` (`peerDependencies.mongodb` optional, exports `./stores/mongo`), `src/index.ts` exports, README
- Test: beside + gated live test `src/store/mongo-store.live.tests.ts` (skipped unless `AIGENT_LIVE_MONGO` is set; NOT run here)

**Interfaces (binding):** `createMongoStore(options: { db: MongoDbLike | (() => Promise<MongoDbLike>); collectionPrefix?: string; ensureIndexes?: true }): Store & { close(): Promise<void> }`. Records `{ _id: key, version, value, updatedAt }`; create = `insertOne` (duplicate-key ⇒ CAS false), update = `findOneAndUpdate({ _id, version: expected }, { $set: { value, updatedAt }, $inc: { version: 1 } })` (null ⇒ false); `get` = `findOne`; `list` = `find` with paging; `purge` implemented via `deleteMany` with a filter translated from `{ agentName, runId, before }` (applied to a `meta` projection field written alongside: `recordedAt`, `agentName`, `runId` copied from the value when present); `delete` = `deleteOne`; BSON-safe: values are stored as `value` JSON-serialised with `$`/`.` key-safe encoding (documented), errors mapped to `AigentError` (`store_conflict` retryable on transient write conflicts; others `provider_failed`-style `store_failed` — add `store_failed` to `AigentErrorCode`). Runs `describeStoreContract` against the fake. `createStoreVectorIndex(store, namespace)` implements `VectorIndex` (records chunked into pages of 200 vectors, version doc updated via CAS, brute-force cosine query; size note in docs). `embeddingRetriever({ embedder, index })` implements `MemoryRetriever`: embeds entries lazily (stored vectors keyed by memory id + text hash), embeds the query, ranks by cosine fused with BM25 via RRF; embedder failure ⇒ falls back to BM25 and returns a `warning` through the retriever callback; forgotten/changed entries re-embedded/dropped.

- [ ] **Step 1: Failing tests**: contract suite on the Mongo fake; Mongo specifics (duplicate-key race ⇒ one winner, operation whitelist, index creation idempotent, error mapping, `close()`); store vector index CRUD/query/version/persistence reload; embedding retriever beats BM25 on a paraphrase fixture (hash-embedder variant for tests with synonym-aware fake embedder), fallback on failure, freshness; end-to-end: agent with Mongo-fake store + memory + embedding retriever recalls a paraphrased fact.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: mongo store, persistent vector index and embedding-backed memory recall`.

---

## Self-review

Coverage: contract + file (T0), mongo + vectors + embedding recall (T1). Live Mongo untested by design. Names: `describeStoreContract`, `createFileStore`, `createMongoStore`, `MongoDbLike`, `createStoreVectorIndex`, `embeddingRetriever`.
