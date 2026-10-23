# Oracle Standard — Writing the Immutable Test Oracle

<!-- CAVEMAN-ENCODED. DECODER: ! = must/required | ⊥ = forbidden/never | → = leads to/becomes | ∀ = for all | ∃ = exists | ∈ = in | § = section ref | & = and | | = or -->

Stage 04 writes the oracle. `specs/.sdd/scripts/oracle.cjs` executes it. Nothing else grades an implementation. A complete, validated reference oracle: `../examples/notes-service/specs/fixtures/`.
Formats are machine-checked: `../schemas/oracle-cases.schema.json`, `../schemas/oracle-config.schema.json`. `sdd.cjs check` validates structure, cross-references and coverage.

## Law: the oracle derives, never decides

∀ expected value ! be derivable from the frozen SPEC, contracts or Equivalence Profile. `derivedFrom` cites the source: `"SPEC.md §5.2"`, `"openapi createOrder 201"`, `"profile PAGE-1"`, `"SPEC.md V3"`.

Cannot cite a source → the behavior is unconstrained → STOP. Log it in `specs/logs/04-spec-gaps.md` and fix the spec first (Stage 02 before freeze, Stage 00 after). ⊥ invent the value inside the fixture: a value invented here is a decision the spec never made, and a second builder reading only the spec could not reproduce it.

Inputs (request payloads, seed rows, CLI arguments) are the author's free choice. Expected outputs never are.

## Files

```
specs/fixtures/
├── oracle.config.json   targets, hooks (reset/seed), sql adapter, readiness, variablePaths
├── cases/<suite>.json   oracle cases
├── seed/                data used by hooks (e.g. db_seed.sql)
├── adapters/            library projects only: JSON-in/JSON-out adapter invoked by run steps
└── ui/*.spec.ts         browser projects only: black-box Playwright specs (profile UI-3)
```

## Configuration (`oracle.config.json`)

```json
{
  "targets": {
    "default": { "baseUrl": "${ORACLE_DEFAULT_URL}", "env": { "DATABASE_URL": "${ORACLE_DEFAULT_DATABASE_URL}" } },
    "a":       { "baseUrl": "${ORACLE_A_URL}", "env": { "DATABASE_URL": "${ORACLE_A_DATABASE_URL}" } },
    "b":       { "baseUrl": "${ORACLE_B_URL}", "env": { "DATABASE_URL": "${ORACLE_B_DATABASE_URL}" } }
  },
  "defaultSetup": ["reset"],
  "hooks": { "reset": { "cmd": "psql", "args": ["${DATABASE_URL}", "-q", "-v", "ON_ERROR_STOP=1", "-f", "specs/fixtures/seed/db_seed.sql"] } },
  "adapters": { "sql": { "cmd": "psql", "args": ["${DATABASE_URL}", "-X", "-A", "-t", "-c", "SELECT coalesce(json_agg(t), '[]'::json) FROM ({{sql}}) t"] } },
  "readiness": { "http": { "path": "/healthz" }, "timeoutMs": 30000 },
  "buildEnv": { "TZ": "UTC", "ORDER_HOLD_TTL_MS": "2000", "RATE_LIMIT_PER_WINDOW": "3", "RATE_LIMIT_WINDOW_MS": "60000" },
  "variablePaths": ["$..id", "$..created_at", "$..updated_at", "$.detail", "$.pagination.next_cursor"]
}
```

- Machine-specific values come only from `${VAR}` / `${VAR:-default}`, so the frozen file is identical for every build.
- **A target that a run changes names its own build and database.** A `:-` fallback is a guess about which app and database are under test, and `reset` truncates whatever it points at. When the selected cases would change state (a setup hook, an SQL `query` step, a CLI `run` step, or an HTTP method other than GET/HEAD/OPTIONS) and a value of the target, or of a command involved, is a guess, the oracle refuses before sending a request (`ORACLE_TARGET_IMPLICIT`, naming the variables to export, never their values). A guess is a `${VAR:-x}` fallback used because VAR is unset or empty, a shell-side default (`${VAR-x}`, `${VAR:=x}`) in a hook, adapter or run command, or a bare `$VAR` there that is unset. Read-only case sets may use fallbacks. Prefer no fallback in `targets` at all.
- `reset` ! restore the same starting state before every case (truncate + seed). Cases ⊥ depend on each other's order.
- `adapters.sql` ! print the result rows as one JSON array. SQL in cases ! have `ORDER BY` whenever it can return more than one row.
- `variablePaths` ! mirror SPEC §Equivalence Boundary — at minimum `$.detail` (ERR-2, http; enforced by `sdd.cjs check`), `$.error.detail` (CLI-2, cli; enforced), every server-generated id and timestamp (SER-2, SER-3) and `$.pagination.next_cursor` (PAGE-2).
- `buildEnv` freezes the configuration every graded build is started with — the SPEC §12 values for oracle runs, typically shortened TTLs and small rate limits (ENV-3). Start each build with `eval "$(node specs/.sdd/scripts/oracle.cjs env)"` before its start command; without it, time- and count-based cases depend on each builder's defaults.
- `observedHeaders` lists response headers SPEC declares contractual beyond the profile's HTTP-10 set. `oracle diff` compares only contractual headers.
- CLI / game simulation targets locate the build's executable through target env, e.g. `"env": { "APP_CLI": "${ORACLE_A_CLI}" }` and run steps with `"cmd": "${APP_CLI}"`. Library adapters import the build from the path in `${SDD_LIBRARY_ENTRY}` (set per target), never a hardcoded path.

## Case anatomy

```json
{
  "suite": "orders",
  "cases": [
    {
      "id": "ORD-001",
      "title": "Create order returns 201 with Location and full body",
      "phase": 2,
      "covers": ["inv:V1"],
      "derivedFrom": ["SPEC.md §5.1", "openapi createOrder 201", "profile HTTP-1", "profile OCC-1"],
      "steps": [
        {
          "id": "create",
          "http": { "method": "POST", "path": "/orders", "headers": { "Idempotency-Key": "{{$uuid:k1}}" }, "body": { "sku": "A-1", "qty": 2 } },
          "expect": {
            "status": 201,
            "headers": { "content-type": "application/json", "location": { "$regex": "^/orders/[0-9a-f-]{36}$" }, "etag": "\"v1\"" },
            "body": { "id": { "$type": "uuidv7" }, "sku": "A-1", "qty": 2, "status": "pending", "version": 1, "created_at": { "$type": "datetime" } }
          },
          "capture": { "orderId": "body.id" }
        },
        {
          "id": "replay",
          "http": { "method": "POST", "path": "/orders", "headers": { "Idempotency-Key": "{{$uuid:k1}}" }, "body": { "sku": "A-1", "qty": 2 } },
          "expect": { "status": 201, "headers": { "idempotent-replay": "true" }, "body": { "id": "{{orderId}}", "sku": "A-1", "qty": 2, "status": "pending", "version": 1, "created_at": { "$type": "datetime" } } }
        },
        { "query": { "sql": "SELECT status, version FROM orders WHERE id = '{{orderId}}'" }, "expect": { "rows": [ { "status": "pending", "version": 1 } ] } }
      ]
    }
  ]
}
```

### Steps

| Step | Request | Assertable observations | Capture paths |
|---|---|---|---|
| `http` | `method`, `path`, `query`, `headers`, `body` (JSON) or `rawBody` (verbatim, e.g. malformed JSON) | `status` (required), `headers` (only those listed; names case-insensitive), `body` | `status`, `headers.<name>`, `body.<path>` |
| `query` | `sql` (via `adapters.sql`) | `rows` (ordered) | `rows[0].<col>` |
| `run` | `cmd`, `args`, `stdin`, `env`, `timeoutMs` | `exitCode` (required), `stdout`, `stdoutJson`, `stderr` | `exitCode`, `stdout`, `stdoutJson.<path>` |
| `parallel` | 2–8 http requests sent concurrently | `responses`: one http expectation per request, matched in any order | none — which request wins a race is nondeterministic (`sdd.cjs check` rejects `capture`) |

Concurrency cases (`parallel`) are deterministic only with the profile's ENV-5 delay frozen in `buildEnv` (e.g. `"SDD_MUTATION_DELAY_MS": "150"`): the first request holds its idempotency key or resource long enough for the second to collide. `oracle diff` compares concurrent responses as a multiset.

### Matching

- Default `bodyMatch: "exact"`: objects ! have exactly the expected keys; arrays compare length and order; literals compare strictly.
- `bodyMatch: "subset"` allows extra keys. Use it only when another case pins the full shape of the same response type.
- Matchers — an object whose keys are all `$`-prefixed:

| Matcher | Meaning | Declares a degree of freedom? |
|---|---|---|
| `{"$type": "uuid" \| "uuidv4" \| "uuidv7" \| "datetime" \| "rfc3339" \| "date" \| "email" \| "uri" \| "base64" \| "base64url" \| "string" \| "number" \| "integer" \| "boolean" \| "null" \| "array" \| "object"}` | type/format check (`datetime` = profile SER-2 exactly) | yes |
| `{"$regex": "..."}` | string matches (Unicode regex) | yes |
| `{"$oneOf": [a, b]}` | equals one alternative | yes |
| `{"$any": true}` | present, any value | yes |
| `{"$absent": true}` | property or header must be absent; as `"body"`, the response must have no body (HTTP-1 `204`) | no |
| `{"$eq": {...}}` | literal (escape for objects with `$` keys) | no |

Variable matchers are the declared degrees of freedom of the case. Use them only where SPEC §Equivalence Boundary or the profile declares the value free (ids, timestamps, cursors, `detail`). Everything else ! be an exact literal. An unneeded `$any` or `subset` leaves freedom that `oracle diff` will expose later, at higher cost.

### Templates

- `{{name}}` — a value captured by an earlier step of the same case (a whole-string template keeps the value's JSON type).
- `{{$uuid:name}}` — a UUID generated once per case and reused (idempotency keys). In `diff`, both builds receive the same value. As an `Idempotency-Key`, one name belongs to one operation: the same key on a different method or path is a fingerprint mismatch (IDEM-3/IDEM-4 → 422), which dual authoring cannot catch because both authors share the request. `sdd.cjs check` rejects it unless the case carries `"tags": ["idempotency-key-reuse"]` because that mismatch is what it tests.
- A step ⊥ reads `{{name}}` that the same step captures: captures exist only after the step's response (`check` rejects it).
- `{{$uuid}}` — a fresh UUID per occurrence (replayed identically to build B in `diff`).
- `{{$env:NAME}}` — environment variable.

## Coverage (machine-enforced by `sdd.cjs check`)

| Item | Source | Covered by |
|---|---|---|
| `op:<operationId>:<status>` | every declared openapi response | inferred from `http` steps (method + path template + expected status) |
| `transition:<id>` | every statechart transition | `covers` |
| `illegal:<machine>` | every statechart machine | `covers` on a case that attempts an illegal transition and asserts `illegalTransitionError` |
| `inv:<Vn>` | every `- **Vn:**` invariant in SPEC.md | `covers` |
| `error:<CODE>` | every code in errors.json | inferred from `expect.body.code`, or `covers` |
| `cmd:<name>:<exitCode>` | every exit code of every command in cli.json | `covers` |

Frozen UI specs count too: a `// covers: transition:item.complete, inv:V2` comment inside a spec file in `specs/fixtures/ui/` covers those items (the refs are validated).

Only `specs/contracts/manifest.json#coverageExempt` (with a justification) excuses an item, e.g. `error:INTERNAL_ERROR`.

Mandatory case families. The Red Team checks these in Stage 04; they are not machine-enforced:
- IDEM: replay (IDEM-6), fingerprint mismatch (IDEM-4), missing and malformed key (IDEM-1, reported in `errors[]`) ∀ POST operation group.
- OCC: missing `If-Match` → 428, stale `If-Match` → 412 ∀ versioned resource.
- PAGE: multi-page traversal with equal primary sort values (tie-breaker), `limit` out of range.
- ERR-3: a request with ≥ 2 validation violations asserting the full, sorted `errors[]`.
- HTTP-9: ≥ 1 multi-failure request per operation group asserting which error wins.
- SER-7/SER-9: nullable field returned as `null`; string with surrounding whitespace and non-ASCII characters round-trips unchanged.

## Generated probes

`node specs/.sdd/scripts/oracle.cjs gen-probes` derives probe cases from the OpenAPI contract into `specs/fixtures/cases/generated-probes.json`: valid baselines plus missing / wrong-typed / null / extra fields, length and range boundaries (code points, before and after NFC), Unicode and NFD round-trips, empty and malformed bodies, content types, empty and malformed idempotency keys, If-Match variants, unknown query parameters, pagination parameters, malformed and nonexistent ids, trailing slashes and undeclared methods — each labelled with the profile rule it exercises. Probes on single-resource operations first create a real resource through the collection's create operation (when the contract shows one) and capture its id, so they exercise the rule they name instead of stopping at 404. In `oracle diff --phase N`, a probe joins once every operation it touches has a non-probe case in phase ≤ N. Output is deterministic; regenerate after every contract change (it is part of the frozen set). Never edit the file by hand: give a generated probe expectations by copying it into a hand-written suite under a new id.

## Probes

A case with `"probe": true` has no expectations. `oracle run` skips probes; `oracle diff` compares them across two builds. Use probes for edge inputs the spec pins but whose exact expectations are laborious to write: whitespace, Unicode, boundary lengths, large pages, unusual orderings. A divergence on a probe = spec gap. Probes need no `phase` or `derivedFrom`, but ! `capture` the ids they create so `diff` can tell "different id" from "different entity".

## Interpretation diff (`diff-expect`)

Two authors who independently derive expectations from the same spec and the same requests disagree exactly where the spec is ambiguous — the same place two builders would.

Independence starts with the input: give the second author `node specs/.sdd/scripts/oracle.cjs strip-expect --from <cases> --out <dir>` output — request-only skeletons whose titles are replaced by neutral `Predict: …` lines (original titles often state the answer) — plus SPEC, contracts and the profile. Never the first author's cases.

`node specs/.sdd/scripts/oracle.cjs diff-expect --a <dir|file> --b <dir|file> --label <name>` reports a gap for:
- any value, type, length or key-set difference;
- one side declaring a degree of freedom (variable matcher) where the other pins a value;
- `{"$unspecified": "<what is missing>"}` on either side — the author found no source; this is how a predicting author says "the spec does not decide this";
- a case with no `derivedFrom` on either side — uncited agreement can be two identical guesses;
- differing requests (both authors must predict the same requests).

Not gaps (normalized away): header-name case, `{"$eq": x}` vs `x`, the order of concurrent `responses`, headers or subset-mode keys that only one author chose to assert (asserting less is not a disagreement). Byte-identical A and B never satisfy a gate.

Rules: each author works in a fresh context with only the spec files; ⊥ resolve a gap by picking one answer — fix the spec, re-predict, re-diff. `$unspecified` never enters `specs/fixtures/` (`sdd.cjs check` rejects it). Stage 02 gates on a fresh zero-gap diff of the Outcome Table cases; Stage 04 on a fresh zero-gap diff whose A side is the final `specs/fixtures/cases`.

## Response-field coverage

`sdd.cjs check` lists declared response fields (from openapi response schemas) that no case pins to a literal value, excluding `variablePaths`. An unpinned field is either a missing assertion or an undeclared degree of freedom — both let builds diverge unnoticed. Exact empty collections (`"errors": []`) pin everything below them.

## Phases

Every non-probe case has `phase: N` from `IMPLEMENTATION_PHASES.md`. `oracle.cjs run --phase N` runs phases ≤ N (cumulative: earlier phases are regression checks). ∀ phase ! have ≥ 1 case (browser-only phases may rely on `specs/fixtures/ui/`).

## Determinism rules

- Each case is independent: `defaultSetup` resets state before every case.
- ⊥ wall-clock expectations. Time-based rules are exercised through their ENV-3 configuration variables.
- Ordering assertions create items in a known sequence and assert the full order, including the tie-breaker.
- Scoped rules ("this module | project | tenant | owner") are exercised with a sibling container that holds colliding data; a single-container case cannot tell a scoped rule from a global one.
- Test data uses reserved names: `@example.com`, `@example.org`, `*.test`, `*.invalid` (RFC 2606/6761). Fixtures travel with every export and every build, so a real person's address in them is a data leak. `check` rejects other addresses unless SPEC pins that exact value.

## UI specs (interface `browser`)

Black-box `@playwright/test` specs in `specs/fixtures/ui/`, written in Stage 04 and frozen with the rest:
- **Frozen config** `specs/fixtures/ui/playwright.config.ts` (required by `sdd.cjs check`): `testDir: '.'`, `baseURL: process.env.ORACLE_UI_URL`, a single pinned browser project (e.g. chromium), fixed `viewport`, `locale: 'en-US'`, `timezoneId: 'UTC'`, `retries: 0`, `workers: 1`. Everything that changes rendering is pinned here, not by the builder.
- Select only by `data-testid`, ARIA role + accessible name, or copy-table text (UI-3).
- ∀ UI State Matrix state ≥ 1 test (UI-4); ∀ interaction in SPEC §Input & Interaction Contract ≥ 1 test. Declare coverage with `// covers: …` comments.
- **Phase binding:** each UI spec file declares the phase it grades with a `// phase: N` comment (like `// covers:`). The Stage 05 phase gate for a phase without oracle cases requires every UI spec file with phase ≤ N in the report; without these comments it cannot tell which specs grade the phase (`sdd.cjs check` warns).
- **Timing-sensitive specs:** a test that depends on keyboard navigation or focus has `@keyboard` or `@focus` in its title. Stage 05 and 06 gates then also require `specs/logs/ui-repeat.json` from `oracle.cjs ui --out specs/logs/ui-repeat.json --grep "@keyboard|@focus" --repeat-each=20` (0 failed, 0 flaky): deferred refocus and similar races pass one run and fail one in five.
- **Observations for `diff-ui`:** at every meaningful screen or state, call `observe(page, '<unique-name>')` from `require('../../.sdd/scripts/ui-observe.cjs')`. It records the ARIA snapshot (roles, accessible names, text) and the `data-testid` sequence — the user-observable structure, independent of CSS and DOM details.
- Evidence: `ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui [spec files]`. It runs the frozen config and writes `specs/logs/ui-e2e.json` plus `ui-e2e.stamp.json`, the code and lock it graded. The Stage 05/06/07 gates require every frozen spec file in the report, ≥ 1 passing test, 0 failed, 0 flaky, and a stamp that still matches the code and lock (§Evidence binding).
- L2 (Stage 07): run the suite once per build with `SDD_UI_OBS_FILE=specs/logs/ui-obs-a.jsonl` / `ui-obs-b.jsonl`, then `node specs/.sdd/scripts/oracle.cjs diff-ui --a specs/logs/ui-obs-a.jsonl --b specs/logs/ui-obs-b.jsonl --b-root <build B workspace>`. Ids and timestamps inside snapshots are normalized; everything else must match.

## Evidence binding (`evidence.cjs`)

Every `oracle.cjs run` report, and every report `oracle.cjs ui` writes, carries a stamp: the commit and tree it graded, the code files that were uncommitted when the run started or changed before it ended, the lock hash, the tool version, and the build the app declared (HTTP-6 `X-SDD-Build`, optional). **The graded code is every file outside `specs/`.** Nothing under `specs/` is application code: its frozen part is bound by the lock hash, and the rest (logs, SCRs, stage reports such as `VAT_REPORT.md`) is written about a run, often after it, so writing or committing it never makes evidence stale. The gates accept a report only while its stamp still matches. The first code that applies is reported:

| Code | Meaning | Fix |
|---|---|---|
| `EVIDENCE_NO_STAMP` | The report predates template +sky.2, or was graded outside git in what is now a repository. | Re-run it. |
| `EVIDENCE_UNBOUND` | Not a git repository. A note, not a refusal: nothing binds evidence to code here. | — |
| `EVIDENCE_UNCHECKABLE` | git cannot find the graded commit or tree (another clone, pruned history). | Re-run it. |
| `EVIDENCE_GRADED_DIRTY` | The run graded uncommitted code, ran before the first commit, or code changed during the run. | Commit, then re-run. |
| `EVIDENCE_LOCK_CHANGED` | The frozen set was re-frozen (or the lock removed) after the run. | Re-run on the new lock. |
| `EVIDENCE_TREE_CHANGED` | Code changed since the run: a file outside `specs/` committed, edited or added (tracked or untracked). | Re-run on the current code. |
| `EVIDENCE_BUILD_UNCOMPARABLE` | The app declared a build that is not a commit or tree id. | Declare the commit. |
| `EVIDENCE_BUILD_MISMATCH` | The app that answered was built from other code. | Rebuild, restart, re-run. |
| `UI_NO_STAMP` | A UI report with no stamp beside it: Playwright was run directly, or the report came from another tree. | Run it through `oracle.cjs ui`. |
| `UI_REPORT_REPLACED` | The UI report changed after it was stamped. | Run it through `oracle.cjs ui`. |

Committing the report, or rebasing and amending without changing code, keeps evidence valid: the tree is compared, not the commit id. `oracle.cjs ui` sends Playwright's own output (traces, screenshots, `.last-run.json`) to `specs/logs/ui-artifacts/` unless `--output` is given: beside the config it would land in the frozen set and break the lock.

**What this does not do.**
- It catches honest mistakes: stale, cross-branch and merged evidence, and a stale build still answering on the port.
- It is not protection against a forged report. The stamp is written on the builder's machine, so every stamp says `enforcement: "local"`. Tamper resistance comes from a CI runner that is the point of record at T2+.
- git does not see ignored files (`dist/`, `.env`), and on a case-insensitive filesystem it does not see a rename that only changes letter case. The gate's pass message says so.

## Adoption (characterization)

Stage 01b drafts request-only cases (steps without expectations) in `specs/changes/adoption/requests/`, then runs `oracle.cjs record --target <existing build> --cases-dir specs/changes/adoption/requests --out specs/changes/adoption/recorded.json`. `record` fills expectations from observed behavior, generalizing ids and timestamps into matchers. Review every recorded expectation with the user: recorded behavior includes existing bugs. Keep them, tagged `"tags": ["tech-debt"]`, until a Class 1 change fixes them. Then move the reviewed `recorded.json` (not the drafts) into `specs/fixtures/cases/` before freezing.
