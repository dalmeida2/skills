# VAT Report Formats

Shared format templates for Visual Acceptance Testing reports. Used by Stage 06 (`06_visual_acceptance_testing`) to write `specs/VAT_REPORT.md`. The report ! end with a verdict line — `sdd.cjs transition --completed 06` reads it:

```markdown
**Verdict:** PASS
```

---

## Screen Walk Report

```markdown
## 🖥️ Screen Walk Report

| Screen | Component | Present? | Visible? | Has Content? | Test id / copy match? | Status |
|--------|-----------|----------|----------|--------------|-----------------------|--------|
| TitleScreen | Logo | ✅ | ✅ | ✅ "COFFEE RUSH" | ✅ `logo` | PASS |
| LevelComplete | StarAnimation | ✅ | ❌ | ❌ empty div | ✅ `star-animation` | FAIL |
| LevelComplete | Stats | ❌ | — | — | — | FAIL |
```

## Interaction Audit

```markdown
## 🎮 Interaction Audit

| Input | State | Expected Result | Actual Result | Status |
|-------|-------|-----------------|---------------|--------|
| Tap tray (match) | GAMEPLAY:IDLE | Cup flies to tray | Cup disappeared from belt, appeared in tray | PASS |
| Tap Retry | LEVEL_FAILED | Reload level | Screen froze, no transition | FAIL |
```

## Design Token Verification

```markdown
## 🎨 Design Token Verification

Every row of `specs/logs/06-token-audit.md` (from `sdd.cjs token-audit --stage 06`), measured with `getComputedStyle` — not a sample, not a screenshot:

| Component | State | Property | Token | Expected | Measured | Match |
|---|---|---|---|---|---|---|
| chat-card-user | base | borderLeft | `{colors.accent}` | `#00D4FF` | rgb(0, 212, 255) | ✅ |
| send-button | hover | backgroundColor | `{colors.accent-hover}` | `#3B82F6` | rgb(0, 212, 255) | ❌ |
```

## UI Spec Runs

```markdown
| Run | Command | Result |
|-----|---------|--------|
| Full suite | `oracle.cjs ui` → specs/logs/ui-e2e.json | 252 passed, 0 failed, 0 flaky |
| Keyboard / focus ×20 | `oracle.cjs ui --out specs/logs/ui-repeat.json --grep "@keyboard|@focus" --repeat-each=20` → specs/logs/ui-repeat.json | 600 passed, 0 failed, 0 flaky |
```

A walker stopped by a shared limit (HTTP 429 on sign-in) is **BLOCKED** and re-run with its own accounts or a reset window; it is not a FAIL. A control the spec says is absent for that role or state is a PASS when absent.

## Debug Artifact Scan

```markdown
## 🔍 Debug Artifact Scan

| Element | Location | Issue | Severity |
|---------|----------|-------|----------|
| btn-win-mock | GameplayScreen | Dev button visible in production | 🔴 High |
| console.log | StateMachine.ts | Transition logs in console | 🟡 Low |
```
