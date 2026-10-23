'use strict';
// Frozen decision tests for step 1a, evidence bound to the graded code (dalmeida2/skills#28, M-038 to M-045).
// One test per decision or problem code; the numbers match the frozen cases in #28. Run: node --test tests/
// Changing a test here is a spec change: it goes back to the maintainer on #28, never edited to make code pass.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const TEMPLATE = path.join(REPO, 'icm-workspace-template');
const EXAMPLE = path.join(TEMPLATE, 'specs/.sdd/_config/examples/notes-service/specs');

function project({ example = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-evidence-'));
  fs.cpSync(TEMPLATE, dir, { recursive: true });
  if (example) fs.cpSync(EXAMPLE, path.join(dir, 'specs'), { recursive: true });
  return dir;
}

function sdd(dir, ...args) {
  const r = spawnSync(process.execPath, [path.join(dir, 'specs/.sdd/scripts/sdd.cjs'), ...args], { cwd: dir, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const readJson = (dir, rel) => JSON.parse(read(dir, rel));
const writeJson = (dir, rel, v) => write(dir, rel, `${JSON.stringify(v, null, 2)}\n`);
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = (dir, msg) => { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); };
/** The evidence module as shipped inside the project's copy of the template. */
const E = dir => require(path.join(dir, 'specs/.sdd/scripts/evidence.cjs'));
const L = dir => require(path.join(dir, 'specs/.sdd/scripts/sdd-lib.cjs'));

function gitInit(dir, { commit = true } = {}) {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'evidence@example.com');
  git(dir, 'config', 'user.name', 'evidence');
  if (commit) commitAll(dir, 'init');
}

function state(dir, last, stepName, projectType = 'backend-service', timestamp = '2026-01-01T00:00:00.000Z') {
  writeJson(dir, 'specs/.sdd/_config/sdd-state.json', { lastCompletedStep: last, stepName, projectType, timestamp, notes: '' });
}

/** The notes-service example, frozen and committed, ready for Stage 05. */
function frozenRepo() {
  const dir = project({ example: true });
  assert.equal(sdd(dir, 'freeze', '--reason', 'Initial freeze', '--approved-by', 'Pat', '--claim', 'two-build').code, 0);
  state(dir, 4, '04_writing_implementation_phases');
  write(dir, 'src/app.js', '// phase 1\n');
  gitInit(dir);
  return dir;
}

/** A green oracle run report as oracle.cjs writes it: stamped at the start and sealed at the end of the run. */
function stampedRun(dir, { phase, start, build } = {}) {
  const ev = E(dir);
  const s = start || ev.stamp(dir, { build });
  const lock = readJson(dir, 'specs/spec.lock.json');
  const report = {
    tool: 'sdd-oracle', mode: 'run', target: 'default', lockHash: lock.hash, lockValid: true, lockVersion: lock.lockVersion,
    filtered: phase !== undefined, filters: { phase: phase === undefined ? undefined : String(phase), bail: false },
    evidence: ev.seal(dir, s),
    startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:01:00.000Z', total: 3, passed: 3, failed: 0, errored: 0, results: [],
  };
  writeJson(dir, 'specs/logs/oracle/run-default.json', report);
  return report;
}

const checkRun = dir => E(dir).check(dir, readJson(dir, 'specs/logs/oracle/run-default.json'));

// ---------- 1–4: binding to the graded code tree (M-039, M-040) ----------

test('1: a committed report on unchanged code is fresh at the phase gate, and at Stage 07 after the stage began', () => {
  const dir = frozenRepo();
  stampedRun(dir);
  commitAll(dir, 'oracle report');
  assert.equal(checkRun(dir).ok, true);
  const r = sdd(dir, 'phase', '--completed', '1');
  assert.equal(r.code, 0, r.out);
  // Entering Stage 07 after the run does not make the same evidence stale (freshAfter is gone where check applies).
  state(dir, 6, '06_visual_acceptance_testing', 'backend-service', '2026-02-01T00:00:00.000Z');
  const t = sdd(dir, 'transition', '--completed', '07');
  assert.match(t.out, /✓ oracle run on "default": 3\/3 passed/);
  assert.doesNotMatch(t.out, /predates this stage/);
  assert.doesNotMatch(t.out, /EVIDENCE_/);
});

test('2: a rebase or amend with identical code keeps the evidence fresh', () => {
  const dir = frozenRepo();
  stampedRun(dir);
  commitAll(dir, 'oracle report');
  git(dir, 'commit', '--amend', '-qm', 'reworded');
  assert.equal(checkRun(dir).ok, true);
  assert.equal(sdd(dir, 'phase', '--completed', '1').code, 0);
});

test('3: a source change after grading is EVIDENCE_TREE_CHANGED, at the phase gate and at Stage 07', () => {
  const dir = frozenRepo();
  stampedRun(dir);
  write(dir, 'src/app.js', '// phase 1, changed after grading\n');
  commitAll(dir, 'change after grading');
  const c = checkRun(dir);
  assert.equal(c.ok, false);
  assert.equal(c.code, 'EVIDENCE_TREE_CHANGED');
  assert.match(c.message, /src\/app\.js/);
  const r = sdd(dir, 'phase', '--completed', '1');
  assert.equal(r.code, 1);
  assert.match(r.out, /EVIDENCE_TREE_CHANGED/);
  state(dir, 6, '06_visual_acceptance_testing');
  assert.match(sdd(dir, 'transition', '--completed', '07').out, /✗ EVIDENCE_TREE_CHANGED/);
});

test('4: a new untracked source file after grading is EVIDENCE_TREE_CHANGED', () => {
  const dir = frozenRepo();
  stampedRun(dir);
  write(dir, 'src/extra.js', '// not graded\n');
  const c = checkRun(dir);
  assert.equal(c.code, 'EVIDENCE_TREE_CHANGED');
  assert.match(c.message, /src\/extra\.js/);
});

// ---------- 5: what was graded must be committed and stable ----------

test('5: a run on uncommitted source is EVIDENCE_GRADED_DIRTY', () => {
  const dir = frozenRepo();
  write(dir, 'src/app.js', '// uncommitted\n');
  stampedRun(dir);
  const c = checkRun(dir);
  assert.equal(c.code, 'EVIDENCE_GRADED_DIRTY');
  assert.match(c.message, /graded tree had 1 uncommitted file/);
});

test('5b: a source file edited during the run is EVIDENCE_GRADED_DIRTY', () => {
  const dir = frozenRepo();
  const start = E(dir).stamp(dir);
  write(dir, 'src/app.js', '// edited by a parallel agent mid-run\n');
  stampedRun(dir, { start });
  git(dir, 'checkout', '-q', 'src/app.js'); // even if the edit is reverted before the gate runs
  const c = checkRun(dir);
  assert.equal(c.code, 'EVIDENCE_GRADED_DIRTY');
  assert.match(c.message, /src\/app\.js/);
});

test('5c: a repository with no commit yet is EVIDENCE_GRADED_DIRTY', () => {
  const dir = project({ example: true });
  assert.equal(sdd(dir, 'freeze', '--reason', 'Initial', '--approved-by', 'Pat', '--claim', 'two-build').code, 0);
  gitInit(dir, { commit: false });
  stampedRun(dir);
  assert.equal(checkRun(dir).code, 'EVIDENCE_GRADED_DIRTY');
});

// ---------- 6: lock changes, and the order of problem codes ----------

test('6: a re-freeze after grading is EVIDENCE_LOCK_CHANGED, before the tree change it also causes', () => {
  const dir = frozenRepo();
  stampedRun(dir);
  write(dir, 'specs/SPEC.md', `${read(dir, 'specs/SPEC.md')}\n<!-- SCR-001 -->\n`);
  assert.equal(sdd(dir, 'freeze', '--reason', 'SCR-001: x', '--approved-by', 'Pat').code, 0);
  assert.notEqual(git(dir, 'status', '--porcelain', '--', 'specs/SPEC.md'), '', 'the tree changed as well');
  const c = checkRun(dir);
  assert.equal(c.code, 'EVIDENCE_LOCK_CHANGED');
});

// ---------- 7: reports from earlier template versions ----------

test('7: a pre-sky.2 report is EVIDENCE_NO_STAMP; a clean sky.2 report is accepted by its commit\'s tree', () => {
  const dir = frozenRepo();
  const lock = readJson(dir, 'specs/spec.lock.json');
  const base = { tool: 'sdd-oracle', mode: 'run', target: 'default', lockHash: lock.hash, lockValid: true, lockVersion: lock.lockVersion, filtered: false, filters: {}, startedAt: '2026-01-02T00:00:00.000Z', finishedAt: '2026-01-02T00:01:00.000Z', total: 3, passed: 3, failed: 0, errored: 0, results: [] };
  let c = E(dir).check(dir, base);
  assert.equal(c.code, 'EVIDENCE_NO_STAMP');
  assert.match(c.message, /oracle\.cjs run/);
  const head = git(dir, 'rev-parse', 'HEAD');
  c = E(dir).check(dir, { ...base, git: { head, dirty: [], dirtyCount: 0 } });
  assert.equal(c.ok, true, c.message);
});

// ---------- 8: the app's build identity (M-041, opt-in) ----------

test('8: a declared build must name the graded commit or tree; anything else is refused; none is accepted as unverified', () => {
  const dir = frozenRepo();
  const head = git(dir, 'rev-parse', 'HEAD');
  stampedRun(dir, { build: head.slice(0, 7) });
  assert.equal(checkRun(dir).ok, true);
  stampedRun(dir, { build: 'deadbeefdeadbeef' });
  assert.equal(checkRun(dir).code, 'EVIDENCE_BUILD_MISMATCH');
  stampedRun(dir, { build: 'sha256:0123456789abcdef' });
  assert.equal(checkRun(dir).code, 'EVIDENCE_BUILD_UNCOMPARABLE');
  stampedRun(dir);
  const c = checkRun(dir);
  assert.equal(c.ok, true);
  assert.match(c.message, /build identity not verified/);
  assert.match(c.message, /ignored files/);
});

// ---------- 9–10: UI evidence (M-045) ----------

const UI_STATS = { stats: { expected: 1, unexpected: 0, flaky: 0 } };

/** A browser-only project with one UI phase, a stub lock, committed. */
function uiRepo() {
  const dir = project();
  state(dir, 4, '04_writing_implementation_phases', 'client-side-app');
  write(dir, 'specs/IMPLEMENTATION_PHASES.md', '# Phases\n\n## Phase 1: Shell\n- [x] a\n');
  write(dir, 'specs/fixtures/ui/shell.spec.ts', '// phase: 1\ntest("shell", () => {});\n');
  writeJson(dir, 'specs/spec.lock.json', { tool: 'sdd', lockVersion: 1, frozenAt: '2026-01-01T00:00:00.000Z', hash: '0'.repeat(64), files: {}, history: [] });
  write(dir, 'src/app.js', '// shell\n');
  gitInit(dir);
  return dir;
}

/** What `oracle.cjs ui` does around a Playwright run: stamp, run, then seal and write <report>.stamp.json. */
function stampedUi(dir, rel, report) {
  const ev = E(dir);
  const start = ev.stamp(dir);
  writeJson(dir, rel, report);
  ev.writeUiStamp(dir, rel, ev.seal(dir, start));
}

test('9: a UI report with no stamp (Playwright run directly, or merged from a branch) is UI_NO_STAMP', () => {
  const dir = uiRepo();
  writeJson(dir, 'specs/logs/ui-e2e.json', { suites: [{ file: 'shell.spec.ts' }], ...UI_STATS });
  const r = sdd(dir, 'phase', '--completed', '1');
  assert.equal(r.code, 1);
  assert.match(r.out, /UI_NO_STAMP/);
  assert.match(r.out, /oracle\.cjs ui/);
});

test('9b: a stamped UI report goes stale when the source changes, through transition 06', () => {
  const dir = uiRepo();
  state(dir, 5, '05_development_swarm', 'client-side-app');
  stampedUi(dir, 'specs/logs/ui-e2e.json', { suites: [{ file: 'shell.spec.ts' }], ...UI_STATS });
  commitAll(dir, 'ui report');
  let r = sdd(dir, 'transition', '--completed', '06');
  assert.doesNotMatch(r.out, /UI_NO_STAMP|EVIDENCE_/);
  write(dir, 'src/app.js', '// shell, changed\n');
  commitAll(dir, 'change after grading');
  r = sdd(dir, 'transition', '--completed', '06');
  assert.match(r.out, /✗ EVIDENCE_TREE_CHANGED/);
});

test('9c: the keyboard/focus repeat report has its own stamp, checked by its own gate', () => {
  const dir = uiRepo();
  state(dir, 5, '05_development_swarm', 'client-side-app');
  write(dir, 'specs/fixtures/ui/keys.spec.ts', "// phase: 1\ntest('arrow keys keep focus @keyboard', async () => {});\n");
  commitAll(dir, 'keyboard spec');
  stampedUi(dir, 'specs/logs/ui-e2e.json', { suites: [{ file: 'shell.spec.ts' }, { file: 'keys.spec.ts' }], ...UI_STATS });
  const repeat = { config: { projects: [{ repeatEach: 20 }] }, ...UI_STATS };
  writeJson(dir, 'specs/logs/ui-repeat.json', repeat);
  let r = sdd(dir, 'transition', '--completed', '06');
  assert.match(r.out, /UI_NO_STAMP[^\n]*ui-repeat\.json/);
  stampedUi(dir, 'specs/logs/ui-repeat.json', repeat);
  assert.notEqual(E(dir).stampPath('specs/logs/ui-repeat.json'), E(dir).stampPath('specs/logs/ui-e2e.json'));
  assert.ok(fs.existsSync(path.join(dir, E(dir).stampPath('specs/logs/ui-e2e.json'))), 'the e2e stamp survives the repeat run');
  r = sdd(dir, 'transition', '--completed', '06');
  assert.doesNotMatch(r.out, /UI_NO_STAMP|UI_REPORT_REPLACED|EVIDENCE_/);
});

test('10: a UI report replaced after stamping is UI_REPORT_REPLACED', () => {
  const dir = uiRepo();
  stampedUi(dir, 'specs/logs/ui-e2e.json', { suites: [{ file: 'shell.spec.ts' }], ...UI_STATS });
  writeJson(dir, 'specs/logs/ui-e2e.json', { suites: [{ file: 'shell.spec.ts' }], stats: { expected: 2, unexpected: 0, flaky: 0 } });
  const c = E(dir).checkUi(dir, 'specs/logs/ui-e2e.json');
  assert.equal(c.code, 'UI_REPORT_REPLACED');
  assert.match(sdd(dir, 'phase', '--completed', '1').out, /UI_REPORT_REPLACED/);
});

// ---------- 11: CSS values that cannot be compared (M-044) ----------

const DESIGN = `---
name: Test
colors:
  surface: "#FFFFFF"
components:
  draft-chip:
    backgroundColor: "{colors.surface}"
    padding: 1rem
---

## UI State Matrix
| Component | Empty | Loading | Success | Error | Edge Case |
|---|---|---|---|---|---|
| ModuleTable | none (\`module-table-empty\`) | — | rows | — | — |

## Approved Wireframes
- [module](wireframes/module.html)
`;

test('11: trivial unit differences are converted; a value that still cannot be compared is CSS_UNCOMPARABLE', () => {
  const dir = project();
  const lib = L(dir);
  assert.equal(lib.cssValuesMatch('1rem', '16px'), true);
  assert.equal(lib.cssValuesMatch('0.5em', '8px'), true);
  assert.equal(lib.cssValuesMatch('white', 'rgb(255, 255, 255)'), true);
  assert.equal(lib.cssValuesMatch('#FFFFFF', 'rgb(0, 0, 0)'), false);
  assert.equal(lib.cssValuesMatch('calc(1px + 2px)', '3px'), null);
  writeJson(dir, 'specs/.sdd/_config/sdd-state.json', { lastCompletedStep: 2, stepName: '02_adversarial_swarm_analysis', projectType: 'fullstack-app', timestamp: '2026-01-01T00:00:00.000Z', notes: '' });
  write(dir, 'specs/DESIGN.md', DESIGN);
  write(dir, 'specs/SPEC.md', '# Spec\n');
  write(dir, 'specs/wireframes/module.html', '<div data-testid="draft-chip">Draft</div><div data-testid="module-table-empty"></div>');
  const skeleton = sdd(dir, 'token-audit', '--stage', '03').out;
  write(dir, 'specs/logs/03-token-audit.md', skeleton
    .replace('| `#FFFFFF` |  |  |', '| `#FFFFFF` | var(--surface) | ✅ |')
    .replace('| `1rem` |  |  |', '| `1rem` | 16px | ✅ |'));
  const r = sdd(dir, 'transition', '--completed', '03');
  assert.match(r.out, /CSS_UNCOMPARABLE[^\n]*draft-chip\|base\|backgroundColor/);
  assert.match(r.out, /measurable units \(px, hex\)/);
  assert.doesNotMatch(r.out, /draft-chip\|base\|padding/);
});

// ---------- 12–13: no repository, and a git object that is gone ----------

test('12: outside a git repository the evidence is EVIDENCE_UNBOUND, a note that does not refuse', () => {
  const dir = project({ example: true });
  assert.equal(sdd(dir, 'freeze', '--reason', 'Initial', '--approved-by', 'Pat', '--claim', 'two-build').code, 0);
  stampedRun(dir);
  const c = checkRun(dir);
  assert.equal(c.code, 'EVIDENCE_UNBOUND');
  assert.equal(c.ok, true);
});

test('13: a stamp naming a tree object this repository does not have is EVIDENCE_UNCHECKABLE, never EVIDENCE_TREE_CHANGED', () => {
  const dir = frozenRepo();
  const report = stampedRun(dir);
  const git0 = report.evidence.materials[0];
  git0.digest.gitTree = 'f'.repeat(40);
  writeJson(dir, 'specs/logs/oracle/run-default.json', report);
  const c = checkRun(dir);
  assert.equal(c.code, 'EVIDENCE_UNCHECKABLE');
  assert.equal(c.ok, false);
});
