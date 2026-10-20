# HTTP/Web and Code-Intelligence Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** `@anupheaus/aigent/tools/web` (`http_fetch`, `web_search`, `page_extract`) with a strong SSRF/size/domain policy, and `@anupheaus/aigent/tools/code` (`code_outline`, `code_find_symbol`, `code_references`) that answers "where is X?" in one call using the TypeScript compiler API.

**Architecture:** Network access goes through an injected `HttpAccess` (default global `fetch`) behind `HttpPolicy`, which performs DNS resolution itself (injectable `resolveHost`) and validates every hop of a redirect chain against private/loopback/link-local/metadata ranges and the domain allowlist, connecting to the validated IP (anti-rebinding) via an injectable `connect`. Code intelligence uses `typescript` as an optional peer dependency (dynamically imported; pack unavailable with a clear error if absent) over files read through `FsPolicy`/`FsAccess`.

**Tech Stack:** TypeScript strict ESM, zod, vitest, fast-check. `typescript` (already a devDependency; becomes an optional peerDependency for the code pack). No other new dependencies; HTML-to-text extraction is implemented in-house (small tokenizer, tested).

**Spec:** master plan sections "Built-in tool library" (HTTP/web, Code intelligence), "Security (later packs): SSRF…" in `C:\Users\email\.claude\plans\i-want-to-create-hazy-church.md`; slice plans so far; pack conventions in `docs/superpowers/plans/2026-10-28-fs-data-meta-packs.md`.

## Global Constraints

Same as the foundation plan's Global Constraints (functional, no classes, named exports, max 2 params, no `any`, `.js` suffixes, named constants, co-located `*.tests.ts`, barrels only, commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`), plus: no real network in tests (a fake `HttpAccess` and fake DNS); **deny by default** (no allowlist ⇒ `http_fetch` refuses); fetched content is untrusted data; response size, redirect count and time are capped; shaping follows the verbatim rules (`web-page` results may be `lossy-ok`; raw `http_fetch` bodies of non-HTML are verbatim).

## Review Focus

1. SSRF matrix: every private/special IPv4 and IPv6 form (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16 incl. 169.254.169.254, 100.64/10, 0.0.0.0, ::1, fc00::/7, fe80::/10, IPv4-mapped IPv6 `::ffff:127.0.0.1`, decimal/octal/hex integer IPs like `2130706433`, `0177.0.0.1`, `0x7f.1`, bracketed IPv6, trailing dots, userinfo tricks `http://a@127.0.0.1`, `localhost`, `*.localhost`, DNS names resolving to private IPs, DNS rebinding where the second resolution differs) is blocked at the initial URL and at every redirect hop.
2. Size/time safety: oversized bodies are cut at the byte cap with an explicit marker without buffering the entire body, compressed bombs are bounded, slow-loris responses time out, and abort cancels the body.
3. `page_extract` yields readable text without scripts/styles and never executes anything; huge/malformed/binary HTML does not hang or blow memory.
4. Code intelligence correctness: symbol definitions/usages match the compiler's own answers on fixtures (re-exports, default exports, aliased imports, class members, overloads, declaration merging), no phantom results, results stay inside the allowed roots.
5. Domain allowlist semantics: exact vs wildcard subdomain matching (`example.com` does not match `evilexample.com` or `example.com.evil.net`), IDN/punycode handled.

---

### Task 0: HttpPolicy, address classification, HttpAccess

**Files:**
- Create: `src/security/ip-classify.ts`, `src/security/http-policy.ts`, `src/security/http-policy-types.ts`, `src/security/http-access.ts`, `src/security/http-access-fetch.ts`, `src/security/read-limited-body.ts`
- Test: beside + `src/security/ssrf.property.tests.ts`

**Interfaces (binding):** `classifyAddress(ip: string): { kind: 'public' | 'private' | 'loopback' | 'link-local' | 'metadata' | 'reserved' | 'invalid' }` including integer/octal/hex IPv4 forms and IPv4-mapped IPv6 (parse to bytes, then classify). `HttpPolicyOptions = { allowDomains: string[] ('example.com' exact, '*.example.com' subdomains only, '**' not allowed unless `allowAnyPublic: true`); allowPorts?: number[] (default 80, 443); maxRedirects (default 5); maxBodyBytes (default 1_000_000); timeoutMs (default 15_000); resolveHost?: (host) => Promise<string[]>; allowPrivateNetwork?: false }`. `createHttpPolicy(options)` ⇒ `checkUrl(url): Promise<UrlDecision>` (`{ allowed:true; url; addresses: string[]; pinnedAddress: string } | { allowed:false; code; message }`) normalising the URL (lowercase host, strip trailing dot, punycode, reject userinfo, schemes http/https only) and resolving+classifying ALL addresses (any private ⇒ deny). `HttpAccess.request({ url, pinnedAddress, method, headers, body?, signal, timeoutMs, maxBodyBytes }) ⇒ { status; headers; body: Uint8Array; truncated: boolean }`; the fetch-based implementation connects to the pinned IP using an `undici`-free approach: **ruling: since global fetch cannot pin IPs, the default `HttpAccess` re-resolves nothing and instead performs the policy check immediately before the request and again on every redirect with `redirect: 'manual'`; the pinned-IP guarantee is provided by the injectable `connect`-capable access (documented limitation + test with fake)**. `readLimitedBody(stream, max, signal)` streams and stops at the cap (cancelling the stream), tolerates `content-encoding` bombs by counting decoded bytes.

- [ ] **Step 1: Failing tests**: classification table covering every Review Focus form; allowlist table (exact/wildcard/lookalike/punycode); URL normalisation; redirect-chain validation with fake access (public ⇒ redirect to 169.254.169.254 blocked; to a hostname resolving privately blocked; redirect limit); rebinding fake DNS (second answer private ⇒ blocked at hop); body cap with fake stream asserting no more than cap+chunk read and cancel called; timeout/abort; property test: random IPv4 strings in all forms never classified `public` when their numeric value is in a special range.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: HttpPolicy with SSRF protection and limited body reads`.

---

### Task 1: Web tools

**Files:**
- Create: `src/tools/packs/web/` (`web-tools.ts`, `http-fetch.ts`, `web-search.ts`, `page-extract.ts`, `html-to-text.ts`, `search-provider.ts`), barrel `index.ts`
- Modify: `package.json` exports `./tools/web`, README
- Test: beside + integration (fake HttpAccess + FakeProvider)

**Interfaces (binding):** `webTools(options: { policy: HttpPolicy; access?: HttpAccess; search?: SearchProvider; userAgent?: string })`. `http_fetch` (batch, max 10): items `{ url, method?: 'GET'|'HEAD', headers?: record<string,string> limited to a safe allowlist (accept, accept-language, if-none-match) }` ⇒ `{ url, finalUrl, status, headers (subset), contentType, bodyText?, bodyBytes, truncated, redirected }`; text decoded by charset; binary ⇒ `binary-ref` no body; `deterministic:false, cache:true, cacheTtlMs: 300_000`; `contentKind`: `web-page` for HTML else `file-content`-like `prose`/`structured-data` by content type; `fidelity`: `lossy-ok` only for HTML. `page_extract` (batch): `{ url, selector?: never (no selectors), maxChars? }` ⇒ title, readable text (main content heuristics: drop script/style/nav/footer/aside/form, collapse whitespace), links list (≤50, absolute URLs, same `http(s)` only), headings outline; in-house tolerant tokenizer; cache TTL. `web_search` (batch queries, max 5): requires a consumer-supplied `SearchProvider = { name; search(query, options): Promise<{ title; url; snippet }[]> }` (none ships; tool not registered when absent), returns top `limit` (≤10) deduped results, `contentKind:'search-hits'` `lossy-ok` snippets; provider errors become structured failures. All tools: approvals optional (`requiresApproval` via options for non-allowlisted? no — allowlist only), `describeActivity`, `maxResultTokens`.

- [ ] **Step 1: Failing tests**: each tool vs fake access: redirects, status errors, truncation marker, charset decoding (utf-8, latin1 header), HEAD, header allowlist (disallowed header ⇒ validation error), binary handling, cache behaviour with TTL fake clock, policy denials as `denied` envelopes with suggestions, extraction fixtures (article page, nav-heavy page, malformed HTML, script injection text kept out, 5 MB page within budget), prompt-injection text in page content is data (through the agent loop with the guardrail built-ins enabled it is quarantined), `web_search` dedupe/limits, tool registration rules.
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: web tool pack`.

---

### Task 2: Code-intelligence pack

**Files:**
- Create: `src/tools/packs/code/` (`code-tools.ts`, `code-outline.ts`, `code-find-symbol.ts`, `code-references.ts`, `ts-program.ts` (cached program per project root + file versions), `ts-loader.ts` (dynamic import of `typescript`, clear error if missing)), barrel `index.ts`
- Modify: `package.json` (`peerDependencies.typescript` optional, exports `./tools/code`), README
- Test: beside + fixture project under `src/tools/packs/code/fixtures/` (small TS project written to a temp dir at test time)

**Interfaces (binding):** `codeTools(options: { policy: FsPolicy; access?: FsAccess; tsconfigPath?: string })`. All batch, `deterministic:false, cache:true` with `validity` = hash of the relevant files' mtimes; results `contentKind:'search-hits'`, `fidelity:'verbatim'`. `code_outline` items `{ path }` ⇒ symbols `{ name, kind, line, endLine, exported, signature, children[] }` (functions, classes, interfaces, types, enums, consts, methods, properties) without bodies. `code_find_symbol` items `{ name, kind?, scope?: path prefix, exportedOnly? }` ⇒ definitions `{ path, line, kind, signature, containerName, exported }` ranked (exact name, exported, shallow path) with total counts and truncation; resolves re-exports to the original declaration (reports both `reexportedFrom`). `code_references` items `{ path, line, character? | symbol name + path }` ⇒ usages grouped by file `{ path, line, text, kind: 'definition'|'import'|'call'|'type-ref'|'other' }` using the language service `findReferences`, honouring FsPolicy (files outside roots never read or reported; counted as `skipped`). Programs are created with `noEmit`, `skipLibCheck`, `allowJs`, bounded `maxFiles` (default 5000) and cached per root until file versions change. JS/TSX/JSX supported; other languages ⇒ `unsupported_language` per-item error with a suggestion to use `fs_search`.

- [ ] **Step 1: Failing tests**: outline of a fixture file (classes with members, overloads, declaration merging, default export, `export *`); find_symbol resolving through a re-export chain and aliased import to the real definition; references vs the compiler's own `findReferences` answers (compare to an independent small walk of the AST for identifier occurrences with symbol identity) on fixtures; policy: file outside roots not read; missing typescript peer ⇒ clear error; cache invalidates when a file changes; large-project bound (generated 2000-file project completes within a generous time budget and honours `maxFiles` with a `truncated` marker); unsupported language item error; integration through the agent loop answering "where is X defined?" in ONE tool call (assert tool call count).
- [ ] **Step 2–4.** [ ] **Step 5: Commit** `feat: code-intelligence tool pack`.

---

## Self-review

Coverage: SSRF/policy (T0), web tools (T1), code intelligence (T2). Pinned-IP connect is a documented limitation of global `fetch` with an injectable stronger access. Names: `HttpPolicy`, `HttpAccess`, `UrlDecision`, `webTools`, `codeTools`, `SearchProvider`.
