<!-- sdd-icm-template -->
<!-- version: 2026.10.01-v3+sky.3 -->
<!-- source: github.com/dalmeida2/skills@skymantics-cli/v3 (base: github.com/Wilberto-lopez-skymantics/skills@v3) -->

# Spec-Driven Development (SDD v3) Workspace
## Observational Equivalence Engine

**Objective:** a frozen spec set — prose spec, typed machine contracts, and an executable oracle — so complete that two independent builders, each given ONLY that set, produce systems the oracle cannot tell apart.

**Equivalence is measured, not asserted:**
> Two builds are observationally equivalent iff, for every case and probe in `specs/fixtures/`, they produce identical observations at the declared interfaces, after masking only the values the spec explicitly declares variable (SPEC §9 Equivalence Boundary).

| Level | Evidence |
|---|---|
| L1 Oracle-conformant | Lock intact + `oracle.cjs run` 100% green against the current lock |
| L2 Equivalence-verified (default target) | L1 + `oracle.cjs diff` between two independently built implementations reports zero divergences |

**Tools** (Node.js ≥ 18, zero dependencies):
- `node specs/.sdd/scripts/sdd.cjs status | check | freeze | verify | phase | transition | token-audit | export [--update]`
- `node specs/.sdd/scripts/oracle.cjs run | diff | diff-ui | diff-expect | gen-probes | record | env`

**Reference example:** `specs/.sdd/_config/examples/notes-service/` — a complete, validated frozen spec set. Imitate its precision, not its domain.

**Diff early, not only at the end.** Divergence is measured at every stage, cheapest first: Stage 01 dual interpretation of scenarios → Stage 02 `diff-expect` on the Outcome Table → Stage 04 dual-authored oracle + generated probes → Stage 05 builder decision inventory and lockstep build B with per-phase `diff` → Stage 07 full dual-build `diff` (the evidence).

## Entry Protocol (∀ requests, before anything else)

1. Run `node specs/.sdd/scripts/sdd.cjs status` → current stage, lock state, latest evidence, and the next stage's exit gates.
2. Classify the request with **Change Classes** below.
3. Read the target stage's `CONTEXT.md` before doing anything else.
4. The target stage's inputs are missing → ⊥ proceed. Tell the user what is missing and which stage produces it. Skipping requires the user's explicit instruction, recorded in `specs/DECISION_LOG.md`.
5. Finish a stage only with `sdd.cjs transition --completed <stage>`. It refuses a stage that is out of order and refuses until the exit gates pass, then records the transition in `specs/logs/transitions.jsonl`. A user-approved skip uses `--override DECnnn` (the decision ! exist in `specs/DECISION_LOG.md`); the exit gates still apply. ⊥ hand-edit `specs/.sdd/_config/sdd-state.json` (the SDD VS Code extension reads it).

## Gate Commands

`sdd.cjs transition`, `sdd.cjs phase`, `sdd.cjs freeze`, `sdd.cjs verify` and `oracle.cjs run` exit non-zero when they refuse. Anything that depends on them (a commit, a push, a handoff that says "done") runs only after a zero exit:

```bash
node specs/.sdd/scripts/sdd.cjs transition --completed 06 && git commit -m "Stage 06: VAT PASS"
```

⊥ pipe a gate into `tail`, `head` or `tee` in front of `&&`: the pipeline's status is the last command's, so a refused gate is followed by the commit. Need trimmed output → `set -o pipefail` first, or run the gate on its own line and check `$?`.

## Delegation (fresh agents and subagents)

Several stages hand work to a fresh agent (Stage 01 predictors, Stage 02 critics and predictors, Stage 04 oracle authors, Stage 05 builders, Stage 06 walkers). Every brief, in every host:

1. **Names its inputs and outputs.** Only the files the stage allows; the deliverable is files written plus a short report of gaps.
2. **Has a timebox and a stop-and-report rule.** At the limit (default 45 min), stop, commit what exists and report what is done, what is not, and the evidence. A partial report is a result; silence is not.
3. **Checkpoints.** Work in progress is committed on a branch at least at every finished step, so a stall never leaves the only copy in an editor buffer.
4. **Edits large generated files by script** (fixtures, case files, copy tables): a script that changes the needed entries, never a full rewrite of the file.
5. **Has a named fallback.** Before the stage starts, record the primary model and the fallback model for its subagents (decision log or run notes). A subagent that stops without a report, or a model that becomes unavailable, → fallback model with a smaller brief (one step, its evidence). ⊥ relaunch the same brief on the same model: it stalls the same way.

The parent owns integration, the grader run and the commit. A subagent's "done" counts only with the evidence the stage requires.

## Spec Change Requests

`specs/changes/SCR-NNN.md` carries a `| Status | … |` row; `sdd.cjs` reads it:

| Status | Meaning | Blocks |
|---|---|---|
| Draft | Raised, waiting for the user | the next phase gate and Stage 05/07 transitions |
| Approved | User approved, frozen-set edits not yet re-frozen | same |
| Applied (lock vN) | Edits made and re-frozen | — |
| Rejected / Withdrawn | Closed without a change | — |
| Proposed | Hotfix shipped ahead of the pipeline (Stage 00 hotfix lane) | only the next `freeze`, until that freeze re-grades it |

An SCR without a Status row counts as open (Draft). The row may be `| Status | … |`, `| **Status** | … |` or `Status: …`.

## Change Classes

| Class | Definition | Route |
|---|---|---|
| **0 Non-observable** | Changes no observation at any declared interface: refactor, dependency bump, performance, internal logging | 05 → 07. Oracle ! stay 100% green; `sdd.cjs verify` ! pass unchanged |
| **1 Observable** | Adds or changes an observation: feature, behavior change, new error, UI change | 01 → 02 → (03) → 04 → 05 → (06) → 07 |
| **2 Defect** | Disputed oracle case, `oracle diff` divergence, escaped bug, Stage 07 failure | 00 → re-freeze → resume where `--resume` says |

Unsure between Class 0 and 1 → Class 1.

## The Frozen Set

`sdd.cjs freeze` (end of Stage 04) hashes these into `specs/spec.lock.json`:
- `specs/SPEC.md`, `specs/DESIGN.md`, `specs/CODING_STANDARDS.md` (if used), `specs/contracts/**`, `specs/fixtures/**`, `specs/wireframes/**`
- the pipeline itself: `specs/.sdd/**` except `_config/sdd-state.json`

Working files outside the lock: `DECISION_LOG.md`, `IMPLEMENTATION_PHASES.md` (only checkboxes change after freeze), `logs/**`, `changes/**`, `backprop-log.md`, `phase-integrity-check.md`, `dev-swarm-reconciliation.md`, `vat-checklist.md`, `VAT_REPORT.md`, `EQUIVALENCE_REPORT.md`.

After the freeze, a frozen file changes through exactly two doors, both ending in a user-approved `sdd.cjs freeze`:
1. **Class 1 iteration** — Stages 01 → 02 → (03) → 04 edit the spec set; the lock stays broken until Stage 04 re-freezes it with the user's approval.
2. **Stage 00 Spec Change Request** (Class 2) — SCR → explicit user approval → edit → `sdd.cjs freeze --reason "SCR-NNN: …" --approved-by "<user>"`.

`sdd.cjs verify` detects every other change. Every gate from Stage 04 on refuses while the lock is broken, so no build can be graded against an unapproved spec.

## Workspace Stages

Map the request to a stage and **read its `CONTEXT.md` before doing anything else.**

0. **`specs/.sdd/00_backprop/CONTEXT.md`**: Defect backpropagation. Classify the root cause, write a Spec Change Request, get user approval, patch spec + contracts + oracle, re-freeze. Never writes implementation code.
1. **`specs/.sdd/01_brainstorming/CONTEXT.md`**: Socratic dialogue with a real-time **Shadow Critic**. Ends when the 4 **Extraction Closure** dimensions pass with zero open domain gaps.
1b. **`specs/.sdd/01b_adoption/CONTEXT.md`**: Bring an existing codebase under SDD: reverse-engineer spec and contracts, record a characterization oracle.
2. **`specs/.sdd/02_adversarial_swarm_analysis/CONTEXT.md`**: Technical hardening and **machine contract synthesis** (`specs/contracts/`), validated by `sdd.cjs check --contracts`.
3. **`specs/.sdd/03_interactive_wireframing/CONTEXT.md`**: WYSIWYG HTML wireframes from design tokens (UI projects).
4. **`specs/.sdd/04_writing_implementation_phases/CONTEXT.md`**: **Oracle synthesis** (`specs/fixtures/`), phase breakdown, coverage check, user-approved **freeze**.
5. **`specs/.sdd/05_development_swarm/CONTEXT.md`**: Spec-only build. Builders fulfill the frozen oracle and never modify the frozen set.
6. **`specs/.sdd/06_visual_acceptance_testing/CONTEXT.md`**: Browser-based visual QA against tokens, wireframes and frozen UI specs.
7. **`specs/.sdd/07_verification_before_completion/CONTEXT.md`**: Fresh evidence + equivalence certification (L1/L2) → `specs/EQUIVALENCE_REPORT.md`.

## Core Rules

- **The spec is the only channel.** A builder ⊥ use anything outside the frozen set — conversation history, swarm logs, another implementation. Information it needs but cannot find = spec gap → Stage 00.
- **The oracle derives, never decides.** ∀ expected value in a fixture ! be citable from SPEC, contracts or the Equivalence Profile (`derivedFrom`). A value the fixture author had to choose = spec gap.
- **Pinned defaults.** `_config/references/systems-standards.md` (Equivalence Profile) applies automatically. Deviations ! be in `manifest.json#profileOverrides` + `DECISION_LOG.md`.
- **Single grader.** Only `oracle.cjs` (and frozen UI specs) grades. Builder-written tests are allowed for internal use and never count as evidence.
- **Evidence is lock-bound and fresh.** Oracle results count only if their `lockHash` equals the current lock; Stage 07 accepts only evidence produced after Stage 07 began.
- **Machine contracts over prose.** Operations, storage, lifecycles and errors live in `specs/contracts/`; SPEC points to them instead of restating them.
- **Code is a byproduct.** ⊥ write implementation code before the frozen set is locked (except Class 0 changes against an existing lock).
