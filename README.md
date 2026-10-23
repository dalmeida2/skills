# Spec-Driven Development Skills

> **Code is a byproduct of the spec — never the other way around.**

A curated set of AI agent skills that enforce a rigorous **Spec-Driven Development (SDD)** pipeline. Every skill ensures specifications are written, hardened, and phase-planned *before* implementation code is generated. If your project has a `specs/` folder, these skills govern the entire lifecycle — from ideation through adversarial review to verified, production-ready code.

**🎯 Spec First** · **🔴 Adversarial Hardening** · **🔵 Builder–Critic Swarms** · **✅ Empirical Verification** · **🏷️ Template `2026.10.01-v3+sky.3`** · [**📖 Interactive Visual Guide**](./sdd-icm-documentation.html)

## Quick Start

1. Clone this repo somewhere on disk:
   ```bash
   git clone https://github.com/Wilberto-lopez-skymantics/skills.git ~/my-sdd-skills
   ```

2. Point your agent at the skills (see [Enforcing Skills](#enforcing-skills-via-user-rules) below).

3. **(Recommended)** Resolve reference paths for full fidelity:
   ```bash
   # macOS
   find ~/my-sdd-skills -name "*.md" -exec sed -i '' "s|{{SKILLS_DIR}}|$(cd ~/my-sdd-skills && pwd)|g" {} +

   # Linux
   find ~/my-sdd-skills -name "*.md" -exec sed -i "s|{{SKILLS_DIR}}|$(cd ~/my-sdd-skills && pwd)|g" {} +
   ```

   > **Skip this step?** Skills still work — critical references (completeness checklists, design templates, spec review checks) have inline fallbacks that activate automatically. The agent will log when using a fallback. Run this step to enable full reference loading with detailed checklists, examples, and project-type adapters.

## Two Ways to Use SDD

This repository provides two delivery mechanisms for the same SDD pipeline. They implement identical stages and must stay synchronized.

### Option A: Skill-Based (Global Agent Rules)

For agents that support global skill instructions (Gemini Code Assist, Claude Code with global rules). The `spec-driven-development` orchestrator skill invokes sub-skills by name. See [Enforcing Skills](#enforcing-skills-via-user-rules) below.

**Best for:** Teams with a single agent platform and centralized configuration.

### Option B: ICM Workspace Template (Portable)

For agents that don't support global skills, or for projects that need to be shared across teams/environments. The pipeline is encoded as a folder structure with `CONTEXT.md` files that any agent can read.

**Best for:** Cross-team sharing, multi-agent environments, portable projects.

1. Copy `icm-workspace-template/` contents (`.cursorrules`, `CLAUDE.md`, `specs/.sdd/`) to the root of your new project.
2. If your agent supports auto-loading rules (Cursor with `.cursorrules`, Claude Code with `CLAUDE.md`), it will automatically find the routing instructions in `specs/.sdd/WORKSPACE_ROUTING.md`.
3. Ask your agent to start the project — it will begin at `specs/.sdd/01_brainstorming/CONTEXT.md`.
4. All spec outputs live in `specs/` at the project root. Pipeline machinery lives in `specs/.sdd/`.

### Keeping Them in Sync

The ICM template is the source of truth for the pipeline: its stage `CONTEXT.md` files and `specs/.sdd/scripts/sdd.cjs` are what Cursor, Claude Code and the Grok CLI actually run, and `sdd.cjs` enforces the gates no prompt can waive. Each stage `SKILL.md` is a portable summary of its `CONTEXT.md`, and `shared/` is a copy of `_config/`. Change the template first, then mirror the skill. The validator fails when a rule phrase is missing from either side, a v2 rule survives in a skill, a Stage 02/05 roster differs, or `shared/` differs from `_config/`:

```bash
./scripts/validate-icm-sync.sh
node --test tests/        # gate tests for sdd.cjs (temp projects built from the template)
```

The Grok CLI vendors `icm-workspace-template/` from the `skymantics-cli/v3` branch through its pin (`overlays/skymantics/sync-sdd-template.sh`); its `verify-sdd.sh` parses the Stage 02/05 rosters and the Stage 05 iteration cap, so keep those lines stable.


## The SDD Pipeline

These skills form a sequential, gated pipeline. Each skill produces artifacts that the next consumes. Skipping a step or writing code before the spec is updated is a violation.

```mermaid
flowchart TD
    Start(["💡 Feature Request / User Brief"]) --> S01["<b>Stage 01: Socratic Brainstorming</b><br/>Lead Architect + Shadow Critic"]
    Adoption["Existing Codebase"] --> S01b["<b>Stage 01b: Codebase Adoption</b><br/>Reverse-engineer specs & contracts"]
    S01b --> S01

    S01 --> G01{"<b>Gate 1: 4 Extraction Closures</b><br/>• Entity Lifecycle • Negative Space<br/>• Fork Test • Policy vs Mechanics"}
    
    G01 -- "0 Open Gaps" --> S02["<b>Stage 02: Adversarial Swarm Analysis</b><br/>Autonomous Contract Compiler"]
    
    S02 --> C_OUT["<b>Machine Contracts in specs/contracts/</b><br/>• openapi.yaml (RFC 9457 errors)<br/>• schema.sql (OCC + Idempotency)<br/>• statecharts.json • errors.json"]
    
    C_OUT --> UI_CHECK{"UI Project?"}
    
    UI_CHECK -- "Yes" --> S03["<b>Stage 03: Interactive Wireframing</b><br/>WYSIWYG HTML wireframes from tokens"]
    UI_CHECK -- "No" --> S04["<b>Stage 04: Implementation Phases</b><br/>& Immutable Test Oracle Synthesis"]
    S03 --> S04

    S04 --> F_OUT["<b>Immutable Test Oracle in specs/fixtures/</b><br/>• api_cases.json (Exact I/O envelopes)<br/>• db_seed.sql • state_transitions.json"]
    
    F_OUT --> G_WALL{"<b>🔒 Anti-Tampering Wall</b><br/>Specs & Fixtures are strictly READ-ONLY"}
    
    G_WALL --> S05["<b>Stage 05: Development Swarm</b><br/>Test-Consumer Coders (Pass Oracle)"]
    
    S05 --> UI_TEST{"UI Project?"}
    UI_TEST -- "Yes" --> S06["<b>Stage 06: Visual Acceptance Testing</b><br/>Browser-based visual validation against tokens"]
    UI_TEST -- "No" --> S07["<b>Stage 07: Verification Before Completion</b><br/>Empirical Evidence & Bisimulation Proof"]
    S06 --> S07

    S07 --> G_FINAL{"<b>Bisimulation Gate</b><br/>100% Test Oracle Pass • Zero Drift"}
    
    G_FINAL -- "Passed" --> DONE(["🚀 Production / Shipped"])
    
    G_FINAL -. "Runtime Defect Escape" .-> S00["<b>Stage 00: Defect Backprop</b><br/>Trace Root Cause → Append §V Invariant"]
    S00 -. "Spec Patch & Regression Fixture" .-> S01
```

**Execution Gates:** Before each major step, the agent presents the user with a gate showing what's about to happen, its token budget (🟢/🟡/🔴), whether it's skippable, and adjustable parameters. The user decides to proceed, skip, or adjust.

## Spec Artifacts

All specs live in the project's `specs/` directory — the single source of truth.

| Document | Purpose | Produced By | Consumed By |
|----------|---------|-------------|-------------|
| `specs/SPEC.md` | **What** to build — contracts, hierarchy, data flow, invariants | brainstorming → adversarial | dev swarm, impl phases |
| `specs/DESIGN.md` | **How it looks** — visual tokens, interaction states, UI State Matrix | brainstorming | wireframing, dev swarm |
| `specs/DECISION_LOG.md` | **Why** we build this way — options considered, rationale | brainstorming | context for humans & swarms |
| `specs/IMPLEMENTATION_PHASES.md` | **In what order** — sequenced, testable phases | writing-impl-phases | dev swarm (execution order) |
| `specs/wireframes/` | **Visual source of truth** — approved WYSIWYG HTML screens | interactive-wireframing | dev swarm (pixel-perfect reference) |

## Skills Reference

### Core Pipeline

| Skill | Purpose |
|-------|---------|
| [`spec-driven-development`](./spec-driven-development/) | The governor — enforces "spec first, code second." Orchestrates the lifecycle, execution gates, checkpoints, drift handling, and bug escape hardening. |
| [`brainstorming`](./brainstorming/) | Ideas → design → specs. Confidence assessment, theme brainstorming, decision log, DESIGN.md, spec merge. Includes Visual Companion for live browser mockups. |
| [`adversarial-swarm-analysis`](./adversarial-swarm-analysis/) | Harden specs and compile machine contracts via Creator vs Critic loop. 6 Blue + 8 Red Team personas. Exits on objective criteria (clean round, Outcome Table, zero-gap interpretation diff), never on an iteration count. |
| [`interactive-wireframing`](./interactive-wireframing/) | Screen-by-screen WYSIWYG HTML wireframes from DESIGN.md tokens and SPEC.md hierarchy. Iterative user approval. |
| [`writing-implementation-phases`](./writing-implementation-phases/) | Spec → dependency-ordered, testable phase checklist. Phase integrity validation. |
| [`development-swarm`](./development-swarm/) | Spec-only build via Builder vs Critic loop. 5 Blue + 8 Red Team personas. The frozen oracle is the only acceptance evidence; one green, committed phase at a time; open SCRs stop the next phase. |

### Supporting Skills

| Skill | Purpose |
|-------|---------|
| [`visual-acceptance-testing`](./visual-acceptance-testing/) | Browser-based verification: screen walk, interaction audit, design token verification (computed styles vs DESIGN.md), debug artifact scan. |
| [`verification-before-completion`](./verification-before-completion/) | Empirical proof gate — run builds/tests/commands before claiming anything works. |
| [`frontend-ui-design`](./frontend-ui-design/) | CSS standards, responsive design, a11y. Used by dev swarm for non-SDD React/Next.js projects. |
| [`test-driven-development`](./test-driven-development/) | Red-green-refactor loop for backend logic. |
| [`kubernetes-deployment`](./kubernetes-deployment/) | Safe infrastructure investigation and K8s manifest generation. |
| [`ubiquitous-language`](./ubiquitous-language/) | DDD-style domain glossary — extracts canonical terms, flags ambiguities, enforces consistent terminology across specs and swarms. |

### Shared Resources

The `shared/` directory contains templates and format definitions referenced by multiple skills. It mirrors `icm-workspace-template/specs/.sdd/_config/`, which is the source of truth.

> **`shared/` vs `_config/`:** The ICM workspace template copies these files into `icm-workspace-template/specs/.sdd/_config/` for portability — ICM workspaces must be self-contained folders. When updating shared resources, edit `_config/` first (it ships with the template), then copy to `shared/`; `visual-companion.md` keeps skill-side script paths. Run `./scripts/validate-icm-sync.sh` to detect drift.

| File | Used By |
|------|---------|
| `shared/role-standards.md` | Dev swarm, adversarial swarm (default role behavioral standards) |
| `shared/spec-self-review.md` | SDD orchestrator (14-step completeness gate) |
| `shared/design-template.md` | Brainstorming, wireframing (DESIGN.md template + token checklist) |
| `shared/decision-log-template.md` | Brainstorming (DECISION_LOG.md template) |
| `shared/iteration-log-format.md` | Adversarial swarm, dev swarm (iteration log + reconciliation formats) |
| `shared/vat-report-format.md` | VAT (screen walk, interaction, design token, debug scan reports) |
| `shared/visual-companion.md` | Brainstorming, wireframing (browser companion guide) |

## Directory Structure

```
skills/
├── shared/                           # Source of truth for shared templates
│   ├── spec-self-review.md
│   ├── design-template.md
│   ├── decision-log-template.md
│   ├── iteration-log-format.md
│   ├── vat-report-format.md
│   └── visual-companion.md
├── scripts/                          # Tooling
│   └── validate-icm-sync.sh          # Skills ↔ ICM drift detector
├── tests/                            # node --test: sdd.cjs gate tests
├── icm-workspace-template/           # Portable ICM template (Option B)
│   ├── README.md                     # Setup guide + ICM theory
│   ├── CLAUDE.md                     # Agent pointer → specs/.sdd/
│   ├── .cursorrules                  # Agent pointer → specs/.sdd/
│   └── specs/.sdd/                   # Pipeline machinery
│       ├── WORKSPACE_ROUTING.md      # Layer 0+1: identity + routing
│       ├── _config/                  # Layer 3: portable copy of shared/
│       ├── 00_backprop/CONTEXT.md    # Bug → source fix loop
│       ├── 01_brainstorming/         # Ideas → specs
│       ├── 02_adversarial_swarm_analysis/
│       ├── 03_interactive_wireframing/
│       ├── 04_writing_implementation_phases/
│       ├── 05_development_swarm/
│       ├── 06_visual_acceptance_testing/
│       └── 07_verification_before_completion/
├── spec-driven-development/          # The governor / orchestrator (Option A)
│   └── SKILL.md
├── brainstorming/                    # Ideas → specs
│   ├── SKILL.md
│   ├── spec-document-reviewer-prompt.md
│   ├── references/
│   │   ├── confidence-assessment.md
│   │   ├── theme-brainstorming.md
│   │   └── ui-state-matrix.md
│   └── scripts/                      # Visual Companion server
├── adversarial-swarm-analysis/       # Spec hardening
│   ├── SKILL.md
│   └── references/
│       └── completeness-checklist.md
├── interactive-wireframing/          # WYSIWYG wireframes
│   └── SKILL.md
├── writing-implementation-phases/    # Spec → phase checklist
│   └── SKILL.md
├── development-swarm/                # Code generation + validation
│   └── SKILL.md
├── visual-acceptance-testing/        # Browser-based visual QA
│   └── SKILL.md
├── verification-before-completion/   # Empirical proof gate
│   └── SKILL.md
├── ubiquitous-language/              # Domain glossary
│   └── SKILL.md
├── frontend-ui-design/               # CSS/a11y standards
│   └── SKILL.md
├── test-driven-development/          # TDD loop
│   ├── SKILL.md
│   └── testing-anti-patterns.md
└── kubernetes-deployment/            # K8s manifests
    └── SKILL.md
```

## Token Efficiency

All skill files use **caveman encoding** — a compression technique that drops articles, filler, and hedging while preserving all technical content. This reduces token consumption by ~42% compared to prose-heavy instructions.

Each file includes a decoder key:
```
<!-- DECODER: ! = must/required | ⊥ = forbidden/never | → = leads to/becomes
     ∀ = for all | ∃ = exists | & = and | | = or -->
```

Additionally, large reference sections are extracted into `references/` subdirectories and loaded on-demand, keeping per-invocation context lean.

## Recommended: Context7 MCP Server

Several skills (`development-swarm`, `adversarial-swarm-analysis`) benefit from querying latest framework docs via [Context7](https://context7.com) before writing code.

If available, the `context7` MCP server provides verified, up-to-date framework documentation during pre-flight checks. Without it, agents will fall back to web search or training knowledge — the pipeline still works, but generated code may not reflect the latest API changes.

## Enforcing Skills via User Rules

The `spec-driven-development` skill is the **top-level governor** — it orchestrates all sub-skills in the correct sequence. You only need to enforce the governor, not each sub-skill individually.

Add these to your agent's global custom instructions (update paths after cloning):

```xml
<!-- spec-driven-development enforcement -->
You MUST use the Spec-Driven Development skill (instructions located at
/path/to/skills/spec-driven-development/SKILL.md) EVERY TIME there is a
request for a new feature, update, or bugfix in a project that contains
a specs/ folder. Never write code before updating the spec.
<!-- spec-driven-development enforcement -->

<!-- verification-before-completion enforcement -->
You MUST use the Verification Before Completion skill (instructions located at
/path/to/skills/verification-before-completion/SKILL.md) EVERY TIME you are
about to claim that a task is complete, a bug is fixed, or tests are passing.
Evidence before assertions, always.
<!-- verification-before-completion enforcement -->

<!-- anti-sycophancy -->
Do not be blindly agreeable or sycophantic. Always challenge, question,
or push back on the user's instructions if you identify a better, more
efficient, safer, or more idiomatic approach.
<!-- anti-sycophancy -->
```

> **Why not enforce sub-skills directly?** They are invoked by `spec-driven-development` at the right moment. Enforcing them separately could trigger code generation or spec hardening outside the SDD lifecycle.

## Platform Setup

### What to install

The repo contains **skills** (install these) and **infrastructure** (don't install):

| Directory | Type | Install? |
|-----------|------|----------|
| `adversarial-swarm-analysis/` | Skill | ✓ |
| `brainstorming/` | Skill | ✓ |
| `development-swarm/` | Skill | ✓ |
| `frontend-ui-design/` | Skill | ✓ |
| `interactive-wireframing/` | Skill | ✓ |
| `kubernetes-deployment/` | Skill | ✓ |
| `spec-driven-development/` | Skill | ✓ |
| `test-driven-development/` | Skill | ✓ |
| `ubiquitous-language/` | Skill | ✓ |
| `verification-before-completion/` | Skill | ✓ |
| `visual-acceptance-testing/` | Skill | ✓ |
| `writing-implementation-phases/` | Skill | ✓ |
| `shared/` | Dependency | ✓ (required by multiple skills) |
| `icm-workspace-template/` | Project template | ✗ (use via Quick Start Option B) |
| `scripts/` | Tooling | ✗ |
| `README.md` | Repo docs | ✗ |

> **Important:** Some skills have `references/` or `scripts/` subdirectories containing checklists and templates referenced by SKILL.md. These subdirectories must be copied alongside SKILL.md — not just the SKILL.md file alone.

### Gemini Code Assist / Antigravity

Skills go in `~/.gemini/config/skills/<skill-name>/SKILL.md`.

**Scriptable install** (agent or human can run this verbatim):
```bash
# 1. Clone the repo (source — don't modify this copy)
git clone https://github.com/Wilberto-lopez-skymantics/skills.git /tmp/sdd-skills-source

# 2. Define target
TARGET="$HOME/.gemini/config/skills"
mkdir -p "$TARGET"

# 3. Copy skills + shared (preserving subdirectories like references/)
for skill in adversarial-swarm-analysis brainstorming development-swarm \
             frontend-ui-design interactive-wireframing kubernetes-deployment \
             spec-driven-development test-driven-development ubiquitous-language \
             verification-before-completion visual-acceptance-testing \
             writing-implementation-phases shared; do
  cp -r "/tmp/sdd-skills-source/$skill" "$TARGET/$skill"
done

# 4. Resolve reference paths (runs on destination, not source)
find "$TARGET" -name "*.md" -exec sed -i '' "s|{{SKILLS_DIR}}|$TARGET|g" {} +
# Linux: remove the '' after -i

# 5. Verify
echo "Installed $(ls -d $TARGET/*/SKILL.md 2>/dev/null | wc -l | tr -d ' ') skills"
grep -rl '{{SKILLS_DIR}}' "$TARGET" --include='*.md' | wc -l | tr -d ' '
echo "unresolved template vars (should be 0)"

# 6. Clean up source
rm -rf /tmp/sdd-skills-source
```

Then add user rules as described in [Enforcing Skills](#enforcing-skills-via-user-rules).

### Claude Code

**Option A (Global):** Copy skills to `~/.claude/skills/` using the same script above (change `TARGET`).

**Option B (Per-project, recommended):** Use the ICM template — copy `icm-workspace-template/` contents to your project root. Claude Code reads `CLAUDE.md` automatically. No global config needed.

### Cursor

**Recommended:** Use the ICM template — copy `icm-workspace-template/` contents to your project root. Cursor reads `.cursorrules` automatically. No global config needed.

### Other Agents

Any agent that can read files from disk and follows markdown instructions can use these skills. Either:
- Point your agent's configuration at the `SKILL.md` files (Option A)
- Copy the ICM template into your project (Option B — works with any agent)
