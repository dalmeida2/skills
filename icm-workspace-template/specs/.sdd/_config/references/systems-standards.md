# Equivalence Profile — Systems, Protocol & Representation Defaults

<!-- CAVEMAN-ENCODED. DECODER: ! = must/required | ⊥ = forbidden/never | → = leads to/becomes | ∀ = for all | ∃ = exists | ∈ = in | § = section ref | & = and | | = or -->

Pinned defaults that apply automatically ∀ project with the matching interface. They remove the plumbing choices where independent builders diverge, so Stage 01 never interviews the user about them and Stage 05 never guesses.

- **Defaults, not suggestions.** ⊥ deviate silently. A deviation ! appear in `specs/contracts/manifest.json#profileOverrides` (`{ "rule", "override", "decision" }`) with a matching `DECnnn` entry in `specs/DECISION_LOG.md`. `sdd.cjs check` enforces the cross-reference.
- **Unlisted ≠ free.** Observable behavior pinned neither here nor in SPEC = spec gap → Stage 02 (before freeze) | Stage 00 (after freeze).
- **Machine-checked where possible.** Canonical error codes, statuses and `retryable`: `../canonical-errors.json`. Timestamp format: oracle matcher `{"$type": "datetime"}`.

---

## 1. Representation (all interfaces)

| Rule | Pinned default |
|---|---|
| SER-1 | Text = UTF-8. JSON per RFC 8259, no BOM. JSON object key order is not significant. |
| SER-2 | Timestamps: RFC 3339, UTC, millisecond precision, `Z` suffix — `2026-10-01T12:00:00.000Z`. Stored at millisecond precision too (truncate on write), so stored, compared and rendered values are identical. Calendar dates: `YYYY-MM-DD`. Durations: integer milliseconds in fields suffixed `_ms`. |
| SER-3 | Identifiers: UUIDv7, lowercase, hyphenated, generated server-side, monotonic within a process (RFC 9562 §6.2: ids created later — even in the same millisecond — compare greater). Client-supplied ids ⊥ unless SPEC says. Id *values* = declared degree of freedom; which entity an id refers to, and id order, are not. |
| SER-4 | Money: integer minor units (`amount_minor`) + ISO 4217 `currency`. Binary floats ⊥ for money. |
| SER-5 | Non-integer quantities: decimal string with the scale fixed in the schema (`"12.50"`), rounding half-even. Binary floats ⊥ in contracts unless SPEC pins a tolerance. |
| SER-6 | Field names: `snake_case` in JSON bodies, query parameters and DB columns — the same name end to end. Enum values: lowercase `snake_case` strings. |
| SER-7 | Shape stability: every property declared in a response schema is always present; no value → `null`. Empty collections → `[]`, never `null` or absent. |
| SER-8 | Unknown request properties and unknown query parameters → 422 `VALIDATION_ERROR` (`issue: additionalProperties`; `additionalProperties: false` in every request schema). This applies to every operation, so every operation declares `422` in openapi (HTTP-8). Unknown request headers are ignored. |
| SER-9 | Strings are NFC-normalized first, then validated, stored and returned exactly as normalized. ⊥ trim | case-fold unless SPEC says. Length limits count the Unicode code points of the NFC-normalized value (not bytes, not UTF-16 units). |
| SER-10 | Identifiers, enum values and codes are case-sensitive. Email addresses are lowercased on write; uniqueness applies to the lowercased value. |
| SER-11 | Every multi-item result has an explicit total order (§6). String sorting = binary code-point order (PostgreSQL `COLLATE "C"`), never locale collation. |
| SER-12 | Booleans are JSON `true`/`false` — never `0`/`1` or `"true"`. |
| SER-13 | JSON integers stay within ±(2^53−1); larger values are decimal strings. |

## 2. HTTP semantics (interface `http`)

| Rule | Pinned default |
|---|---|
| HTTP-1 | Success statuses: create (`POST` to a collection) → `201` + `Location: <path of new resource>` + full resource body. Read → `200`. Update (`PUT`/`PATCH`) → `200` + full resource. Delete → `204`, empty body. Action (`POST /<collection>/{id}/<verb>`) → `200` + full resource. `202` only where SPEC declares async processing. |
| HTTP-2 | `PATCH` = JSON Merge Patch semantics (RFC 7396) sent as `application/json`; `null` clears a nullable field. `PUT` = full replacement. |
| HTTP-3 | Operations that declare a request body: the request ! be `Content-Type: application/json`, else `415 UNSUPPORTED_MEDIA_TYPE`; an empty body → `400 MALFORMED_REQUEST`. Operations without a request body ignore `Content-Type` and any body. Success responses with a body: `Content-Type: application/json`; responses without a body (e.g. `204`) carry no `Content-Type`. Errors: `application/problem+json`. A `; charset=utf-8` parameter is optional and graded as equivalent. |
| HTTP-4 | Paths: lowercase, kebab-case segments, plural collection nouns, no trailing slash (trailing-slash variant → 404). No version segment unless SPEC says. |
| HTTP-5 | Unknown path → `404 NOT_FOUND`. Known path, unsupported method → `405 METHOD_NOT_ALLOWED` + `Allow` listing exactly the methods openapi declares for that path, uppercase, alphabetical, `", "`-separated. `HEAD` and `OPTIONS` are not part of the contract unless openapi declares them (framework auto-answers are non-contractual; fixtures ⊥ use undeclared methods). |
| HTTP-6 | `GET /healthz` → `200 {"status":"ok"}`, unauthenticated, declared in openapi as `operationId: getHealth` (with `422` for unknown query parameters, SER-8). It is the oracle readiness probe. It may also send the response header `X-SDD-Build: <commit id it was built from>` (≥ 7 hex digits); the oracle then refuses evidence from an app built from other code (`EVIDENCE_BUILD_MISMATCH`). A header, so no case changes. |
| HTTP-7 | API resources never answer with redirects. |
| HTTP-8 | Every operation has a unique lowerCamelCase `operationId` (verbNoun: `createOrder`) and enumerates every response status — no `default` response. Fixtures cover operations as `op:<operationId>:<status>`. |
| HTTP-9 | **Evaluation order.** When several failures apply, the first in this list wins: (1) route → 404 / 405 · (2) authentication → 401 `UNAUTHENTICATED` · (3) rate limit → 429 `RATE_LIMITED` · (4) content type → 415 · (5) body parse → 400 `MALFORMED_REQUEST` · (6) schema validation of query, headers (including `Idempotency-Key` presence and format) and body, all violations reported together → 422 `VALIDATION_ERROR` · (7) idempotency replay / mismatch / in-flight (§4) · (8) resource lookup → 404 `NOT_FOUND` (also when the caller may not know the resource exists, and when a path id is not a valid id format) · (9) authorization on the resource → 403 `PERMISSION_DENIED` · (10) preconditions → 428 / 412 (§5) · (11) state-machine guard → 409 `INVALID_STATE_TRANSITION` · (12) uniqueness or domain conflict → 409 `RESOURCE_CONFLICT`; a domain rule not expressible in the schema → 422 with a domain code from `errors.json` · (13) unhandled → 500 `INTERNAL_ERROR`, no internals in the body. |
| HTTP-10 | **Contractual response headers** are exactly: `Content-Type`, `Location` (HTTP-1), `ETag` (OCC-2), `Allow` (HTTP-5), `Retry-After` (IDEM-5, RATE-1, RES-4), `Idempotent-Replay` (IDEM-6), plus headers SPEC declares (mirrored in `oracle.config.json#observedHeaders`). Each appears exactly where its rule requires and nowhere else (e.g. no `ETag` on collections or errors). All other headers (caching, security, compression, `Vary`, server, request ids) are non-contractual: builders may send them, `oracle diff` ignores them. |
| HTTP-11 | Request header values are trimmed of surrounding whitespace; a header present with an empty value is treated exactly as an absent header (e.g. `Idempotency-Key:` → `issue: required`; `If-Match:` → 428). |

## 3. Error envelope (RFC 9457 problem details)

| Rule | Pinned default |
|---|---|
| ERR-1 | Every error body has exactly these 8 members, always present (SER-7):<br>`{"type": "<typeBaseUri><CODE>", "title": "<errors.json title>", "status": <int>, "detail": "<free text>", "instance": "<request path without query>", "code": "<CODE>", "retryable": <bool>, "errors": []}`<br>`type`, `title`, `status` and `retryable` come from `errors.json` and are fixed per code. |
| ERR-2 | `detail` is free text — the ONLY declared degree of freedom in an error body. Fixtures assert `{"$type": "string"}`; `oracle.config.json#variablePaths` ! include `$.detail`. |
| ERR-3 | `errors[]` is non-empty only for `VALIDATION_ERROR`. Items: `{"in": "body|query|header", "pointer": "...", "issue": "<keyword>"}` (path parameters never appear: malformed path ids are 404, HTTP-9 step 8).<br>`pointer`: for `body`, the RFC 6901 JSON Pointer of the offending member itself — for `required` the missing member (`/items/0/sku`), for `additionalProperties` the unexpected member (`/extra`), `""` for the whole body; for `query`, the parameter name; for `header`, the header name in lowercase.<br>`issue` ∈ `required`, `type`, `format`, `enum`, `const`, `minimum`, `maximum`, `minLength`, `maxLength`, `pattern`, `minItems`, `maxItems`, `additionalProperties` — for a value with a declared `format` (uuid, date-time, email, …), a malformed value is `format`, never `pattern`.<br>Report every violation once (the first failing keyword per member, in the order listed above), sorted by `in`, then `pointer`, then `issue` (code-point order). |
| ERR-4 | Codes are `SCREAMING_SNAKE_CASE` without prefixes. Canonical codes and their statuses/`retryable` values: `../canonical-errors.json` (machine-checked; mandatory codes must exist ∀ http project). Domain-specific codes use 409 or 422. |

## 4. Idempotency (`POST`)

| Rule | Pinned default |
|---|---|
| IDEM-1 | Every `POST` requires an `Idempotency-Key` header whose value is a lowercase UUID (any version), declared in openapi as a required header parameter with `format: uuid`. Missing → `issue: required`, malformed → `issue: format`, both `in: header`, `pointer: idempotency-key`, reported with the other validation errors (HTTP-9 step 6). Exemption only via openapi `x-idempotency: exempt` on the operation + justification in SPEC (e.g. login). |
| IDEM-2 | Key scope: per authenticated principal (global for unauthenticated operations). Retention: 24 h after the first request completes. |
| IDEM-3 | Fingerprint = method + path + canonical JSON body (keys sorted, no insignificant whitespace). |
| IDEM-4 | Same key, different fingerprint → 422 `IDEMPOTENCY_KEY_MISMATCH` — whether the first request is still executing or completed (checked before IDEM-5, so the answer never depends on timing). Body-less operations fingerprint an empty body. |
| IDEM-5 | Same key and same fingerprint while the first request is still executing → 409 `IDEMPOTENCY_IN_FLIGHT` + `Retry-After: 1`. |
| IDEM-6 | Same key after completion → replay the stored status, body, `Location` and `ETag`, plus `Idempotent-Replay: true` (absent on the original response). Every response with status < 500 is stored; a 5xx releases the key. Business logic ⊥ re-executes on replay. |

## 5. Optimistic concurrency (OCC)

| Rule | Pinned default |
|---|---|
| OCC-1 | Every mutable entity has `version INTEGER NOT NULL DEFAULT 1`, incremented by exactly 1 per successful mutation (even when no field changed). The representation includes `"version"`. |
| OCC-2 | Single-resource responses of versioned entities carry `ETag: "v<version>"` (strong, quoted). |
| OCC-3 | `PUT`/`PATCH`/`DELETE` on versioned resources require `If-Match`, declared in openapi as an optional header parameter (`required: false`) because its absence is a precondition failure (HTTP-9 step 10), never a validation error. Missing → 428 `PRECONDITION_REQUIRED`. Any value other than exactly the current strong tag `"v<version>"` — a stale tag, `*`, a weak `W/"…"` tag, an unquoted value, or a list — → 412 `PRECONDITION_FAILED` (RFC 9110 §13.1.1). Action `POST`s: `If-Match` optional; if present, the same rule applies. |
| OCC-4 | Storage mutation: `UPDATE … SET …, version = version + 1 WHERE id = :id AND version = :expected`; 0 rows → 412 + rollback. Last-write-wins ⊥ unless overridden. |

## 6. Pagination & ordering

| Rule | Pinned default |
|---|---|
| PAGE-1 | Every collection `GET` is paginated: `limit` (integer, default 20, min 1, max 100) and `cursor` (opaque string). Out-of-range `limit` → 422, never clamped. Invalid cursor → 422 (`in: query`, `pointer: cursor`, `issue: format`). |
| PAGE-2 | Envelope: `{"data": [...], "pagination": {"next_cursor": <string or null>, "has_more": <bool>}}`. Forward-only. `has_more` is `true` iff at least one more matching item exists after the page (look ahead: a page that ends exactly at the last item has `has_more: false`, `next_cursor: null`); `next_cursor` is non-null iff `has_more`. The `next_cursor` *value* is a declared degree of freedom (`variablePaths`: `$.pagination.next_cursor`); following it ! yield identical pages. A cursor encodes only the position (the sort-key values of the last item returned): reused with different filter parameters, it continues from that position under the new filters. |
| PAGE-3 | Default order: `created_at DESC, id DESC`. Every sort SPEC defines ! end with `id` in the same direction as its primary key (total order). |
| PAGE-4 | Keyset semantics: the next page holds the items strictly after the cursor position; rows inserted during a traversal appear only if they sort after the cursor. |
| PAGE-5 | Filters: query parameters named after fields (SER-6), exact match, AND-combined, unless SPEC says otherwise. |

## 7. Rate limiting

| Rule | Pinned default |
|---|---|
| RATE-1 | Where SPEC declares limits: exceeded → 429 `RATE_LIMITED` + `Retry-After: <integer seconds until the window ends, rounded up>`. SPEC ! pin the limit, window length and scope (principal | IP). Default algorithm = fixed window that starts at the first counted request of the scope (not aligned to the wall clock); after a window expires, the next window starts at the next counted request. A request sequence therefore gives the same results whenever it runs. The oracle `reset` hook clears counters. |
| RATE-2 | Limits and window lengths are configurable via env var (ENV-3); the oracle's values are frozen in `oracle.config.json#buildEnv`. |

## 8. Resilience (integration points)

Mostly internal; RES-4 is the observable effect.

| Rule | Pinned default |
|---|---|
| RES-1 | Connect timeout 3000 ms; read timeout 10000 ms. |
| RES-2 | Idempotent reads: ≤ 3 retries, exponential backoff with full jitter, base 200 ms, cap 2000 ms. Non-idempotent writes: ⊥ automatic retry unless the destination honors an idempotency key. |
| RES-3 | Circuit breaker opens after 5 consecutive failures within 10 s, stays open 30 s, then half-opens with a single probe. |
| RES-4 | Dependency unavailable | circuit open → 503 `SERVICE_UNAVAILABLE` + `Retry-After: 30`. |

## 9. Environment & time

| Rule | Pinned default |
|---|---|
| ENV-1 | Process timezone UTC; all formatting is locale-independent. |
| ENV-2 | SPEC §Observable Environment pins the runtime major version, database engine + major version, and collation. |
| ENV-3 | Every time- or count-based rule (TTL, expiry, rate limit, retention, batch size) reads its value from an env var listed in the SPEC configuration table. The values used for oracle runs are frozen in `oracle.config.json#buildEnv`; every graded build starts with them (`eval "$(node specs/.sdd/scripts/oracle.cjs env)"`). |
| ENV-4 | Randomness that affects observable output (shuffles, sampling, game logic) uses the PRNG algorithm pinned in SPEC (default Mulberry32) with an observable or injectable seed. |
| ENV-5 | Concurrency testability: when env `SDD_MUTATION_DELAY_MS` is set to N > 0, every state-mutating request waits N ms after it passes HTTP-9 steps 1–7 (validation, idempotency reservation), then runs steps 8–12 (lookup, authorization, preconditions, state guard, domain rules) and the write as one atomic step. Unset or 0 → no delay. This makes concurrent oracle cases (`parallel` steps: in-flight idempotency, OCC races) deterministic; the value is frozen in `oracle.config.json#buildEnv`. |
| ENV-6 | Ordering testability: when env `SDD_TIMESTAMP_GRANULARITY_MS` is set to N > 0, every server-generated timestamp (stored, compared and returned) is truncated to a multiple of N ms; durations and expiry still use the real clock. With N = 60000 in `buildEnv`, items created within one oracle case share `created_at`, so the id tie-breaker (PAGE-3, SER-3) becomes observable. Unset or 0 → millisecond precision (SER-2). |

## 10. CLI (interface `cli`)

| Rule | Pinned default |
|---|---|
| CLI-1 | Exit codes: `0` success · `1` runtime | domain error · `2` usage error (unknown flag, missing argument). Domain codes may map to other values via `errors.json#exitCode`. |
| CLI-2 | stdout carries results only; stderr carries diagnostics. Machine output: the `--json` flag prints exactly one JSON document to stdout — on failure `{"error": {"code": "<CODE>", "title": "<errors.json title>", "detail": "<free text>"}}` with the nonzero exit code. `error.detail` is a declared degree of freedom (`variablePaths`: `$.error.detail`). |
| CLI-3 | stderr text is a declared degree of freedom (`oracle diff` does not compare it). |
| CLI-4 | No ANSI color when stdout is not a TTY or `NO_COLOR` is set. Output ends with exactly one `\n`. |

## 11. UI testability (interface `browser`)

| Rule | Pinned default |
|---|---|
| UI-1 | Every component in the SPEC Component Hierarchy renders `data-testid="<kebab-case name>"` (= its DESIGN.md `components:` key). Repeated items add `data-key="<entity id>"`. |
| UI-2 | All user-visible static text comes from the SPEC §Copy table, character-exact. |
| UI-3 | Frozen UI specs (`specs/fixtures/ui/`) select only by `data-testid`, ARIA role + accessible name, or copy-table text — never CSS classes or DOM structure. |
| UI-4 | Each UI State Matrix state renders a distinct test id: `<component>-empty`, `<component>-loading`, `<component>-error`. |
