# SDD ICM Workspace Template

> **Release Version:** `2026.10.01-v3+sky.3` — Skymantics CLI variant of `2026.10.01-v3`. Every difference from upstream `v3` is a labeled commit on `skymantics-cli/v3`.

A portable, agent-agnostic workspace template that enforces the **Spec-Driven Development (SDD)** pipeline through filesystem structure and a small set of zero-dependency tools, so that independent coding agents built from the same spec produce **observationally equivalent** systems — and so that claim can be checked.

Based on the [Interpretable Context Methodology (ICM)](https://arxiv.org/html/2603.16021) paper's principle: _"If the context is interpretable, the agent is steerable."_

## Quick Start

1. **Copy** the template contents into your project root:
   ```bash
   cp -r /path/to/skills/icm-workspace-template/{.cursorrules,CLAUDE.md,AGENTS.md,specs} /path/to/your-project/
   ```
   `CLAUDE.md`, `AGENTS.md` and `.cursorrules` are identical copies of `specs/.sdd/_config/entrypoint.md`. If your project already has one of these files, append the entrypoint's content instead of overwriting it.

2. **Requirements:** Node.js ≥ 18 for the tools (`specs/.sdd/scripts/*.cjs`, no `npm install`). Playwright only for UI projects.

3. **Open** the project in your AI-assisted editor (Claude Code, Codex, Cursor, Gemini, …) and ask your agent to start. It reads its entry file, runs `node specs/.sdd/scripts/sdd.cjs status`, and begins at Stage 01 (or 01b for an existing codebase).

No global rules. No plugin install.

## The Core Mission: Observational Equivalence

The fundamental failure mode of AI-assisted engineering is **the ambiguity gap**: a prose specification leaves choices open — error formats, null vs absent fields, ordering, rounding, which error wins when two apply — and two independent agents (or two runs of one agent) fill them differently. Both claim success; their systems are incompatible.

SDD v3 defines equivalence operationally:

> **Two builds are observationally equivalent iff, for every case and probe in `specs/fixtures/`, they produce identical observations at the declared interfaces, after masking only the values the spec explicitly declares variable** (SPEC §9 Equivalence Boundary: server-generated ids, timestamps, cursor values, free-text error details).

Equivalence is therefore relative to the oracle and its probes — the stronger the oracle, the stronger the claim — and it is *measured*:

| Level | Evidence |
|---|---|
| **L1 Oracle-conformant** | Frozen set intact + `oracle.cjs run` 100% green against the current lock |
| **L2 Equivalence-verified** (default target) | L1 + a second build made from the frozen set alone, in a fresh agent session, and `oracle.cjs diff` (and `diff-ui` for UIs) reporting zero divergences between the two |

Every divergence `diff` finds is an unconstrained degree of freedom the spec forgot to pin. It goes back into the spec (Stage 00), not into the code.

### Diff early: measuring divergence before code exists

Most divergences start as ambiguous spec text, so v3 measures them at every stage, cheapest first:

| Stage | Diff | Catches |
|---|---|---|
| 01 | Two fresh agents predict outcomes of 3–5 scenarios per interview topic, with citations | Business-policy gaps → next interview question |
| 02 | `diff-expect` on request-only cases from the Outcome Table (gated) | Contract and plumbing ambiguity |
| 04 | Oracle written twice independently + `diff-expect` (gated); `gen-probes` widens the measured surface | Remaining ambiguity; unpinned response fields |
| 05 | Builder's decision inventory per phase; optional lockstep build B with `diff --phase N` | Gaps while little code depends on them |
| 07 | Full dual-build `diff` / `diff-ui` (gated for L2) | The evidence |

A predicting author writes `{"$unspecified": "…"}` where the spec does not decide a value; agreement without citations counts as a gap, because two identical guesses are still guesses.

### Reference example

[`specs/.sdd/_config/examples/notes-service/`](specs/.sdd/_config/examples/notes-service/) is a complete frozen spec set — SPEC, decision log, contracts, 55 derived cases plus 100 generated probes — validated against an independent reference implementation (55/55 green, zero divergences between two instances over all 155 cases, and every deliberately broken variant caught). Agents imitate examples more reliably than they follow rules.

**Contracts parse the same everywhere.** OpenAPI YAML is always read by the bundled `yaml-lite` parser, which rejects plain scalars that YAML 1.1 and 1.2 tools read differently (`yes`/`no`/`on`/`off`, `1_000`, `0755`, unquoted dates) — quote them — so the contract means the same thing to the tools and to every builder's YAML library.

### The Six Laws of SDD v3

1. **Zero unconstrained degrees of freedom — outside a declared boundary.** Every business decision is made with the user in Stages 01–02. What may legitimately vary is listed explicitly (SPEC §9); everything else is pinned.
2. **Pinned defaults for plumbing.** The [Equivalence Profile](specs/.sdd/_config/references/systems-standards.md) fixes the choices where builders typically diverge — error envelope (RFC 9457), status codes and error precedence, timestamps, ids, null handling, pagination, idempotency, concurrency, string normalization. Deviations are explicit overrides tied to a decision-log entry.
3. **Machine contracts over prose — and machine-checked.** Operations, storage, lifecycles and errors live in `specs/contracts/`; `sdd.cjs check` validates them against [JSON Schemas](specs/.sdd/_config/schemas/) and each other.
4. **One grader, never the builder.** The oracle is data (`specs/fixtures/`), written in Stage 04 before any code, and executed by the shipped, implementation-agnostic `oracle.cjs`. No stage writes its own grader. Expected values must be *derivable* from the spec (`derivedFrom`); a value the oracle author had to invent is a spec gap.
5. **The spec is the only channel.** Stage 05 builders use only the frozen set — no conversation history, no swarm logs, no other implementation. Whatever they would have to guess is raised as a spec gap instead.
6. **Change control with a lock.** `sdd.cjs freeze` hashes the frozen set into `specs/spec.lock.json` after user approval. After that, frozen files change only through a Class 1 iteration or a Stage 00 Spec Change Request, each ending in a user-approved re-freeze. `sdd.cjs verify` detects anything else, and gates refuse to advance on a broken lock.

## Tooling

All tools are zero-dependency Node.js scripts in `specs/.sdd/scripts/`.

| Command | Purpose |
|---|---|
| `sdd.cjs status` | Current stage, lock state, latest evidence, and the next stage's exit gates |
| `sdd.cjs check [--contracts]` | Validate manifest, contracts, oracle cases, cross-references, coverage (every operation × status, transition, illegal transition, invariant, error code) and phase binding |
| `sdd.cjs freeze --reason R --approved-by U --claim grader-ready\|two-build` | Lock the frozen set (refused unless `check` passes, the claim matches `equivalenceTarget`, and no hotfix SCR is still Proposed) |
| `sdd.cjs verify` | Exit 1 if any frozen file changed since the last freeze |
| `sdd.cjs phase --completed N` | Stage 05 phase gate: green cumulative oracle run on a clean, committed HEAD, earlier phases gated, no open SCR |
| `sdd.cjs transition --completed <stage>` | Record a completed stage — refused if out of order (unless `--override DECnnn`) or until that stage's exit gates pass; appends a row to `specs/logs/scoreboard.md` |
| `sdd.cjs token-audit --stage 03\|06` | Print the token-audit table (one row per DESIGN component × state × property) that Stages 03 and 06 fill with measured values |
| `sdd.cjs export <dir> [--update]` | Copy only the frozen set into `<dir>` for an independent (L2) build; `--update` resyncs it after a re-freeze, keeping B's code and progress |
| `oracle.cjs run [--phase N]` | Grade a build: HTTP, SQL and CLI steps with matchers, captures and templates |
| `oracle.cjs diff --a a --b b` | Run the same cases and probes against two builds; report every undeclared difference |
| `oracle.cjs diff-ui --a A.jsonl --b B.jsonl --b-root DIR` | Compare two builds' UI observations (ARIA snapshots + test ids from `ui-observe.cjs`) |
| `oracle.cjs gen-probes` | Derive edge-case probes from the OpenAPI contract (boundaries, nulls, Unicode, content types, idempotency, preconditions, pagination, routing) |
| `oracle.cjs diff-expect --a A --b B` | Interpretation diff: compare two independently written expectation sets; every disagreement, `$unspecified` or uncited case is a spec gap |
| `oracle.cjs strip-expect --from A --out DIR` | Request-only skeletons with neutral titles for an independent second author |
| `oracle.cjs env` | Print the frozen build environment every graded build is started with |
| `oracle.cjs record --target T --out F` | Characterize an existing system (Stage 01b) by filling expectations from observed behavior |
| `start-server.sh` / `stop-server.sh` | Visual Companion for brainstorming and live wireframes |

## Why ICM?

### The Problem with Global Skills

Traditional AI agent workflows rely on global configuration (`~/.gemini/config/skills/`, global `CLAUDE.md` rules, editor-specific rule files). This creates three problems:

1. **Not portable.** Share a project with a teammate? They need your exact skill setup.
2. **Not auditable.** The instructions controlling code generation live outside the repo — invisible to code review.
3. **Not versioned.** Skills evolve, but deployed projects don't track which version they were built with.

### The ICM Solution

ICM moves the orchestration logic **into the project's filesystem**. The agent discovers the pipeline by reading `WORKSPACE_ROUTING.md`; each stage's `CONTEXT.md` is a self-contained contract declaring Inputs, Process, Outputs and exit gates. The pipeline files are themselves part of the frozen set, so a project records — and locks — the exact pipeline version it was built with.

| Layer | What it does | Where it lives |
|-------|-------------|----------------|
| **Layer 0: Identity** | Workspace and pipeline version | HTML comments in `WORKSPACE_ROUTING.md` |
| **Layer 1: Routing** | Entry protocol, change classes, stage map | `WORKSPACE_ROUTING.md` |
| **Layer 2: Stage Contracts** | Detailed instructions per stage | `NN_stage_name/CONTEXT.md` |
| **Layer 3: Reference Material** | Profile, schemas, templates, checklists — loaded on demand | `_config/` |
| **Layer 4: Working Artifacts** | Spec, contracts, oracle, logs | `specs/` root |

**Why `CONTEXT.md`, not `AGENTS.md`.** The two names do different jobs. `AGENTS.md` / `CLAUDE.md` / `.cursorrules` are entry files that agents load automatically, and some tools also load them from any subdirectory they work in. A stage contract must load only when routing selects that stage, so it uses the ICM name `CONTEXT.md`, which no tool auto-loads. Hosts depend on that name: the Grok CLI's template manifest and its roster drift check read `NN_stage/CONTEXT.md`.

**Token efficiency.** The agent reads `WORKSPACE_ROUTING.md` (~80 lines) to route, then only the relevant stage's `CONTEXT.md`; heavy references load only when a stage asks for them. Stage contracts use a compressed notation (`!` = must, `⊥` = forbidden, `∀` = for all, …) with a decoder line in each file.

## The Pipeline

```mermaid
flowchart TD
    Start(["Feature request / brief"]) --> S01["<b>01 Brainstorming</b><br/>Lead Architect + Shadow Critic"]
    Adopt["Existing codebase"] --> S01b["<b>01b Adoption</b><br/>spec + contracts + recorded oracle"]
    S01b --> S02
    S01 --> G01{"<b>Extraction Closure</b><br/>0 open domain gaps"}
    G01 --> S02["<b>02 Adversarial Swarm</b><br/>contracts + Equivalence Profile"]
    S02 --> C{"sdd.cjs check --contracts"}
    C -- "UI" --> S03["<b>03 Wireframing</b><br/>tokens, test ids, copy"]
    C -- "non-UI" --> S04
    S03 --> S04["<b>04 Oracle + Phases</b><br/>derived cases, coverage"]
    S04 --> F{"<b>User-approved freeze</b><br/>spec.lock.json"}
    F --> S05["<b>05 Spec-only build</b><br/>oracle.cjs run per phase"]
    S05 -- "UI" --> S06["<b>06 VAT</b><br/>UI specs + visual walk"]
    S05 -- "non-UI" --> S07
    S06 --> S07["<b>07 Certification</b><br/>L1 run · L2 dual build + diff"]
    S07 --> DONE(["Certified L1 / L2"])
    S05 -. "spec gap / disputed case" .-> S00
    S07 -. "divergence / failure" .-> S00["<b>00 Backprop</b><br/>SCR → user approval → re-freeze"]
    S00 -. "--resume" .-> S05
```

| Stage | Purpose | Exit gate (`sdd.cjs transition`) |
|-------|---------|------|
| `00_backprop` | Classify defect → Spec Change Request → approval → patch spec/contracts/oracle → re-freeze | Lock intact, backprop log, `--resume` target |
| `01_brainstorming` | Socratic interview; all business policy extracted | SPEC, DECISION_LOG, (DESIGN), no placeholders, no scenario left UNSPECIFIED, docs match |
| `01b_adoption` | Reverse-engineer an existing codebase; record a characterization oracle | Same as 01 |
| `02_adversarial_swarm_analysis` | Contracts + hardening against the Equivalence Profile | `check --contracts` passes, persisted swarm log |
| `03_interactive_wireframing` | Wireframes with tokens, test ids and copy (UI only) | Wireframes carry every component/state test id and copy string, token audit all ✅ |
| `04_writing_implementation_phases` | Oracle synthesis, phases, user-approved freeze | Full `check` passes, lock intact |
| `05_development_swarm` | Spec-only build until the oracle is green | Lock intact, every phase gated, no open SCR, current unfiltered oracle run green, zero drift |
| `06_visual_acceptance_testing` | Frozen UI specs + visual walk (UI only) | Every DESIGN token row measured, VAT verdict PASS |
| `07_verification_before_completion` | Fresh evidence; L1/L2 certification | Fresh green run, equivalence report, (L2) zero-divergence diff |

## Change Classes

| Class | Definition | Route |
|---|---|---|
| **0 Non-observable** | Refactor, dependency bump, performance, internal logging | 05 → 07; oracle must stay 100% green, lock unchanged |
| **1 Observable** | Feature, behavior change, new error, UI change | 01 → 02 → (03) → 04 (re-freeze) → 05 → (06) → 07 |
| **2 Defect** | Disputed case, `diff` divergence, escaped bug | 00 → re-freeze → resume |

- **Adding a feature (Class 1):** extend SPEC and contracts through Stages 01–02, add cases and a new phase in Stage 04 (existing cases may only change where a decision-log entry declares the behavior change), re-freeze with approval, build the new phase. `--phase N` runs are cumulative, so old behavior keeps being re-graded.
- **Fixing a bug (Class 2):** Stage 00 decides whether the code broke the spec (→ Stage 05) or the spec allowed the bug (→ pin it, add a case that fails on the buggy build, re-freeze, → Stage 05).
- **Refactoring (Class 0):** no spec work at all — the frozen oracle proves the refactor changed nothing observable.

## Directory Structure

```
icm-workspace-template/
├── CLAUDE.md · AGENTS.md · .cursorrules   ← identical entry points (from _config/entrypoint.md)
├── README.md
└── specs/
    ├── .gitignore                          ← ignores Visual Companion sessions
    └── .sdd/                               ← pipeline machinery (frozen with the spec)
        ├── WORKSPACE_ROUTING.md
        ├── 00_backprop/ … 07_verification_before_completion/CONTEXT.md
        ├── scripts/                        ← sdd.cjs, oracle.cjs, sdd-lib.cjs, Visual Companion
        └── _config/
            ├── references/                 ← Equivalence Profile, oracle standard, checklists
            ├── schemas/                    ← JSON Schemas for manifest, errors, statecharts, oracle
            ├── contract-matrix.json        ← required contracts per project type
            ├── canonical-errors.json       ← profile error codes (machine-checked)
            ├── spec-template.md · design-template.md · …
            └── sdd-state.json.template
```

After running the pipeline, a project also has:

```
specs/
├── SPEC.md                    ← hardened spec (spec-template.md structure)      [frozen]
├── DESIGN.md                  ← design tokens (UI)                               [frozen]
├── contracts/                 ← manifest.json, openapi.yaml, schema.sql, statecharts.json, errors.json, …   [frozen]
├── fixtures/                  ← oracle.config.json, cases/*.json, seed/, ui/*.spec.ts   [frozen]
├── wireframes/                ← approved HTML wireframes (UI)                    [frozen]
├── spec.lock.json             ← lock manifest (hashes, approvals, history)
├── DECISION_LOG.md · IMPLEMENTATION_PHASES.md · backprop-log.md
├── changes/SCR-*.md           ← Spec Change Requests
├── logs/                      ← swarm logs, oracle/diff reports, transitions.jsonl, VAT screenshots
├── dev-swarm-reconciliation.md · VAT_REPORT.md · EQUIVALENCE_REPORT.md
└── .sdd/_config/sdd-state.json ← pipeline pointer (written by `sdd.cjs transition`)
```

`sdd-state.json` keeps the five fields the SDD VS Code extension reads (`lastCompletedStep`, `stepName`, `projectType`, `timestamp`, `notes`); everything else lives in the lock and logs. A tool that advances the state directly (like the extension's advance action) bypasses the exit gates — prefer `sdd.cjs transition`.

## What Changed in v3

v3 challenges several v2 decisions that worked against the equivalence goal:

| v2 | v3 | Why |
|---|---|---|
| Builders "forbidden" to edit `specs/`, but told to update SPEC.md on minor drift | Lock + `verify`; drift → fix code or SCR; SPEC never edited to match code | The builder rewriting the spec is self-grading |
| Fixtures as free-form JSON; harness written by whoever | Schema'd cases executed by a shipped grader | Whoever writes the harness decides how strict grading is |
| Backprop edits spec, tests and code without approval | SCR + user approval + discrimination check; no code in Stage 00 | Backprop was a way around the lock |
| "≥ 3 iterations, iteration 1 always fails" | Objective exit criteria (`check`, zero-finding round, Outcome Table) | Forced failures produce manufactured findings |
| State written, never read | `status` + gated `transition` | Gates that nothing checks are suggestions |
| Equivalence asserted ("bisimulation proof") | Measured: L2 dual build + `oracle diff` | The claim needs evidence |
| Plumbing left to "industry standard" | Equivalence Profile with rule ids | "Standard" differs between builders |
| Error envelope labelled RFC 9457 but non-compliant; three codes for OCC conflicts | RFC 9457 problem details; one canonical code table | A self-contradictory standard forks builders |
| Pinned directory layout and dependencies | Pinned *observable* environment; internals free | Layout is not observable; DB collation is |

## Upgrading a project to `+sky.3`

Evidence is bound to the code it graded (`oracle-standard.md` §Evidence binding). The tools are in the frozen set, so this is a re-freeze with the user's approval (`--reason "pipeline: 2026.10.01-v3+sky.3"`). What changes for a running project:

- **UI reports.** Run the frozen UI specs through `ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui`, which stamps the report. A `ui-e2e.json` or `ui-repeat.json` written by Playwright directly is refused (`UI_NO_STAMP`): re-run each once after upgrading.
- **Oracle runs.** A `+sky.2` run report stays valid while the code is unchanged (its tree is derived from the commit it recorded). A report from before `+sky.2` is refused (`EVIDENCE_NO_STAMP`): re-run it.
- **Freshness.** Evidence no longer has to be newer than the stage start or the lock date. It has to match the current code and lock, so committing a report, or rebasing without code changes, keeps it valid; any code change outside the Stage 05 working files makes it stale.
- **Build identity (optional).** An app may send `X-SDD-Build: <commit>` from `GET /healthz` (HTTP-6). The oracle then refuses evidence graded against a build from other code.
- **Token audits.** A measured value that cannot be compared with its token (e.g. `var(--x)` against `#FFFFFF`) is refused as `CSS_UNCOMPARABLE` instead of passing; `rem`/`em` (at 16px) and basic colour names are converted.

## Upgrading a project to `+sky.2`

The template is in the frozen set, so upgrading is a re-freeze with the user's approval. What changes for a running project:

- **SCR Status rows.** `specs/changes/SCR-*.md` need a `| Status | Draft / Approved / Applied (lock vN) / Rejected / Withdrawn / Proposed |` row. An SCR without one counts as open and blocks the Stage 05 phase gate and the 05/07 transitions: backfill the row for SCRs written before the upgrade.
- **Freeze claim.** The first freeze states `--claim grader-ready|two-build`; it must match `manifest.json#equivalenceTarget`. A lock written before this version records the claim its manifest implies on the next freeze (with a warning).
- **Phase gates.** `transition --completed 05` needs every phase gated by `sdd.cjs phase --completed N` (one green, committed run per phase; one clean unfiltered run on HEAD can gate already-built phases in order).
- **Stage 01 / 03 / 06 exit checks.** `01-interpretations.md` in the table format of Stage 01; `03-token-audit.md` / `06-token-audit.md` from `sdd.cjs token-audit`; `@keyboard`/`@focus` UI specs repeated. These apply when the project next completes those stages.

## Relationship to SDD Skills

This template implements the same pipeline as the [SDD skills](../README.md), delivered as files instead of global configuration.

| | Skills (Option A) | ICM Template (Option B) |
|---|---|---|
| **Requires** | Global agent config | Node.js ≥ 18; copy files |
| **Orchestration** | Skill orchestrator invokes sub-skills | Agent reads CONTEXT.md; `sdd.cjs` enforces gates |
| **Best for** | Consistent personal workflow | Portable projects, cross-team sharing, equivalence certification |

**Source of truth (v3):** this template is ahead of the skills — the oracle, lock, Equivalence Profile and gated transitions exist only here. Two hand-maintained copies of one pipeline would give Option A and Option B users different pipelines, which is itself a source of non-equivalence, so the skills should be ported from this template. Until then `../scripts/validate-icm-sync.sh` reports drift by design.

## Version

Check the version header in `specs/.sdd/WORKSPACE_ROUTING.md`:
```html
<!-- sdd-icm-template -->
<!-- version: 2026.10.01-v3+sky.3 -->
<!-- source: github.com/dalmeida2/skills@skymantics-cli/v3 (base: github.com/Wilberto-lopez-skymantics/skills@v3) -->
```

The lock (`specs/spec.lock.json`) records the hash of every pipeline file a project was built with; upgrading the template is a frozen-set change and requires a re-freeze.
