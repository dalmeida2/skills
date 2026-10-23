<!-- CAVEMAN-ENCODED. DECODER: ! = must/required | ⊥ = forbidden/never | → = leads to/becomes | ∀ = for all | ∃ = exists | ∄ = does not exist | ∈ = in | § = section ref | & = and | | = or -->

# Stage 06: Visual Acceptance Testing (VAT)

Browser-based visual acceptance testing for UI projects. Walks every screen in the spec's Component Hierarchy, screenshots each, verifies element presence and visibility, tests interactions, and flags debug artifacts.

**Why:** Unit tests verify logic. TypeScript verifies types. Neither verifies button visible, screen has content, animation plays. This stage does — and it checks that the rendered UI matches the frozen visual contract (tokens, wireframes, test ids, copy), which is what makes two UI builds look and behave alike.

## Inputs
- Layer 4 (working): Source code / Deployed application
- Layer 4 (working): `specs/SPEC.md`
- Layer 4 (working): `specs/DESIGN.md` (if UI project)
- Layer 4 (working): `specs/wireframes/*.html` (? exists)
- Layer 4 (frozen): `specs/fixtures/ui/*.spec.ts` (black-box UI specs)
- Layer 3 (reference): `../_config/vat-report-format.md`
- Layer 3 (reference): `../_config/references/systems-standards.md` §11 (UI-1…UI-4)

## Process

**MANDATORY** ∀ UI project types (`fullstack-app`, `client-side-app`, `game`). Non-UI projects skip this stage (`sdd.cjs transition --completed 05` skips it automatically).

#### Step 0: Frozen UI Specs
Run the black-box UI specs through the oracle, on committed code, and keep the report as evidence:
```bash
ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui
```
It runs the frozen Playwright config and stamps `specs/logs/ui-e2e.json` with the code it graded (`ui-e2e.stamp.json`). The gates refuse a report Playwright wrote directly (`UI_NO_STAMP`), one changed after stamping (`UI_REPORT_REPLACED`), and one whose code has changed since (`EVIDENCE_TREE_CHANGED`).
Any failed or flaky test = VAT FAIL. ⊥ edit the specs to make them pass (frozen set).

Specs tagged `@keyboard` or `@focus` also run repeated — one "0 flaky" pass does not show a focus race:
```bash
ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui --out specs/logs/ui-repeat.json --grep "@keyboard|@focus" --repeat-each=20
```
Cite the repeat count and pass count in `VAT_REPORT.md`. Any failure in the repeat = VAT FAIL.

#### Walkers (parallel screen walks)
Walkers share one disposable stack, so they share its rate limits. Before a group of walkers starts, give each walker its own accounts, or reset the sign-in rate window (and any other per-client limit the spec declares) for the group. A walker that hits a limit (e.g. HTTP 429 on sign-in) reports **BLOCKED**, not FAIL: the orchestrator resets and re-runs that walker. A rate limit the spec declares is product behavior only in a case that tests it. Each walker brief follows WORKSPACE_ROUTING §Delegation.

### VAT Protocol

**⛔ GATE:** ! create tracking artifact `specs/vat-checklist.md`. ! document evaluation ∀ screen/interaction sequentially, check boxes only when proven by browser screenshot | computed style extraction. Mass-approving without tracker = severe process violation (rubber-stamping).

#### Step 1: Identify Screen Map
Read spec's **Component Hierarchy**. Extract ∀ screens & child components → checklist:

```markdown
## VAT Checklist
- [ ] TitleScreen: Logo, PlayButton, SettingsButton
- [ ] LevelSelectScreen: BackButton, LevelGrid > LevelTile[]
```

#### Step 2: Screen Walk (Visual Presence Audit)
∀ screen ∈ checklist, use the agent's browser tool (or a Puppeteer/Playwright script if none is available):

1. **Navigate** to screen
2. **Screenshot** the screen
3. **Verify** ∀ child component:
   - Present ∈ DOM
   - Visually visible (not `display: none`, not 0-height, not transparent)
   - Non-empty
   - Carries its pinned `data-testid` (UI-1) and copy-table text (UI-2)
4. **Record** PASS/FAIL per component

#### Step 3: Interaction Contract Audit
Read spec's **Input & Interaction Contract**. ∀ interaction:

1. Navigate to correct state
2. Perform input (tap, click)
3. Verify expected result occurs & expected feedback

#### Step 3.5: Design Token Verification (∃ `DESIGN.md` only)
∃ `specs/DESIGN.md` → verify the rendered UI uses its tokens — every token row, not a sample.

1. `node specs/.sdd/scripts/sdd.cjs token-audit --stage 06 > specs/logs/06-token-audit.md` — one row per component × state × property in DESIGN.md `components:`.
2. ∀ row: find the element by its `data-testid`, put it in that state (hover, focus, disabled… via the browser's state forcing or the real interaction), read the **computed style** (`getComputedStyle`) for that property, write it in `Measured`, and `Match` ✅ | ❌ after normalizing units and color notation. A screenshot is not a measured value.
3. Any ❌ → FAIL. `transition --completed 06` refuses while a row is missing, unmeasured or ❌.

#### Step 4: Debug Artifact Scan
Search visible DOM for elements ⊥ be exposed ∈ production:
1. IDs | classes containing: `mock`, `debug`, `test`, `dev`, `tmp`, `TODO`
2. `console.log` ∈ browser console
3. Commented-out UI elements partially visible
4. Placeholder text

#### Step 5: Screenshot Evidence Archive
Save ∀ screenshots taken during Screen Walk → `specs/logs/vat/<screen>.png` (in the repo, so Stage 07 can cite them).

### Verdict Rules

- **PASS:** Frozen UI specs green (0 failed, 0 flaky), `@keyboard`/`@focus` repeat green. ∀ screen walk components present + visible + has content + correct test ids and copy. ∀ tested interactions produce expected result. Every token row measured and ✅. Zero high-severity debug artifacts.
- **FAIL:** Any of the above fails.
- **Not a FAIL:** a control or state the spec says is absent for this role / state (e.g. no Edit button for a viewer) is correct when absent — record it as PASS (absent by §x). A walker blocked by a shared limit is BLOCKED and re-run, not FAIL.

**⛔ GATE:** VAT FAIL → ⊥ transition. Return to Stage 05 with the VAT report as the defect list: fix the code, re-run Stage 05's final evidence and reconciliation, then re-run this stage from Step 0. A failure the frozen visual contract cannot explain (two acceptable renderings, missing copy, undefined state) = spec gap → Stage 00.

## Outputs
- `specs/vat-checklist.md`
- `specs/VAT_REPORT.md` (format: `vat-report-format.md`, ending in a `**Verdict:** PASS | FAIL` line)
- `specs/logs/ui-e2e.json`, `specs/logs/ui-repeat.json` (if tagged specs exist), each with its `.stamp.json`, `specs/logs/06-token-audit.md`, `specs/logs/vat/*.png`
- `specs/.sdd/_config/sdd-state.json` (via `sdd.cjs transition`)

### Handoff / Transitions
1. **Update state:** `node specs/.sdd/scripts/sdd.cjs transition --completed 06 && git commit …` (refuses unless the UI specs and the keyboard/focus repeat are green, `06-token-audit.md` covers every token row with ✅, `vat-checklist.md` exists and `VAT_REPORT.md` says `**Verdict:** PASS`). ⊥ pipe the transition into `tail`/`head` before `&&` (WORKSPACE_ROUTING §Gate Commands).
2. **Handoff:** Prompt user to proceed `07_verification_before_completion`.
