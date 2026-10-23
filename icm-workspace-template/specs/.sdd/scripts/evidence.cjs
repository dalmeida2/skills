'use strict';
/**
 * Evidence binding: ties a stage report to the code it graded (dalmeida2/skills#28). Zero dependencies.
 *
 * stamp(root)            what a run is about to grade: commit, tree, uncommitted files, lock, tool
 * seal(root, start)      the stamp at the end of the run; code that changed during the run counts as uncommitted
 * check(root, report)    ok, or exactly one problem code, evaluated in a fixed order
 * writeUiStamp / checkUi the same for Playwright reports, which Playwright writes and the oracle stamps beside them
 *
 * Scope: honest mistakes (stale, cross-branch or merged evidence; an old build still answering). The report is
 * still written on the builder's machine, so a stamp proves nothing against a forged report: every stamp says
 * enforcement "local", and a CI runner becomes the point of record at T2+ (#35).
 *
 * Field shapes follow in-toto (materials and subject with DigestSets, builder.id), so an attestation can wrap a
 * stamp unchanged.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const L = require('./sdd-lib.cjs');

const STAMP_TYPE = 'https://github.com/dalmeida2/skills/evidence-stamp/v1';
const LOCK_FILE = 'specs/spec.lock.json';
const NOT_SEEN = 'ignored files (e.g. dist/, .env) are not seen by git';

/** git with its exit status kept: 0 and 1 are answers, anything else means git could not answer. */
function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.error) return { status: -1, out: '', err: r.error.message };
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const lines = s => s.split('\n').filter(Boolean);
const excludes = () => L.WORKING_PATHS.map(w => `:(exclude)${w}`);
const inRepo = root => git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
const list = a => `${a.slice(0, 5).join(', ')}${a.length > 5 ? `, … (${a.length})` : ''}`;
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function currentLockHash(root) {
  try {
    const v = L.verifyLock(root);
    return v.exists ? v.lock.hash : null;
  } catch { return null; }
}

/** A remote URL without credentials: a stamp travels with the report. */
function remoteUri(root) {
  const url = git(root, ['config', '--get', 'remote.origin.url']).out;
  return url ? `git+${url.replace(/\/\/[^@/]+@/, '//')}` : 'git+local';
}

/** Tracked files that differ from `tree`, plus untracked files, outside WORKING_PATHS, relative to the project root. */
function changedSince(root, tree) {
  const d = git(root, ['diff', '--name-only', '--relative', '--no-renames', tree, '--', '.', ...excludes()]);
  if (d.status !== 0) return { error: d.err || `git diff exited ${d.status}` };
  const u = git(root, ['ls-files', '--others', '--exclude-standard', '--', '.', ...excludes()]);
  if (u.status !== 0) return { error: u.err || `git ls-files exited ${u.status}` };
  return { paths: [...new Set([...lines(d.out), ...lines(u.out)])].sort() };
}

function stamp(root, { build } = {}) {
  const lockHash = currentLockHash(root);
  const base = {
    _type: STAMP_TYPE,
    builder: { id: 'sdd:local' },
    enforcement: 'local',
    tool: L.TOOL_VERSION,
    build: build ? String(build) : null,
    stampedAt: new Date().toISOString(),
  };
  const lockMaterial = { name: LOCK_FILE, digest: lockHash ? { sha256: lockHash } : {} };
  if (!inRepo(root)) return { ...base, unbound: true, materials: [{ uri: 'git+none', digest: {} }, lockMaterial], dirty: [] };
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const commit = head.status === 0 ? head.out : null;
  const tree = commit ? git(root, ['rev-parse', `${commit}^{tree}`]).out : null;
  const state = L.gitState(root);
  return {
    ...base,
    materials: [{ uri: remoteUri(root), digest: commit ? { gitCommit: commit, gitTree: tree } : {} }, lockMaterial],
    dirty: state ? state.dirty : [],
  };
}

/** The stamp to record: the start stamp, plus every file that was uncommitted at either end or changed in between. */
function seal(root, start) {
  const end = stamp(root, { build: start.build });
  const dirty = new Set([...(start.dirty || []), ...(end.dirty || [])]);
  const t0 = start.materials[0].digest.gitTree;
  if (t0 && end.materials[0].digest.gitTree !== t0) {
    const ch = changedSince(root, t0);
    for (const f of ch.paths || []) dirty.add(f);
  }
  return { ...start, dirty: [...dirty].sort(), sealedAt: end.stampedAt };
}

/** The stamp a report carries; sky.2 reports carry only `git: {head, dirty}`, from which the tree is derived. */
function stampOf(report) {
  if (report.evidence) return report.evidence;
  if (!('git' in report)) return null;
  const lockMaterial = { name: LOCK_FILE, digest: report.lockHash ? { sha256: report.lockHash } : {} };
  if (!report.git) return { unbound: true, materials: [{ digest: {} }, lockMaterial], dirty: [], legacy: true };
  const dirty = report.git.dirty || [];
  const extra = Math.max(0, (report.git.dirtyCount || 0) - dirty.length);
  return {
    materials: [{ digest: report.git.head ? { gitCommit: report.git.head } : {} }, lockMaterial],
    dirty: extra ? [...dirty, `${extra} more`] : dirty,
    build: null,
    legacy: true,
  };
}

const ok = message => ({ ok: true, code: null, message });
const note = (code, message) => ({ ok: true, code, message });
const no = (code, message) => ({ ok: false, code, message });

/**
 * ok, or one problem code. Order (first match wins): NO_STAMP, UNBOUND, UNCHECKABLE, GRADED_DIRTY, LOCK_CHANGED,
 * TREE_CHANGED, BUILD_UNCOMPARABLE, BUILD_MISMATCH. `rerun` is the command that produces fresh evidence.
 */
function check(root, report, { rerun = 'node specs/.sdd/scripts/oracle.cjs run' } = {}) {
  const s = stampOf(report);
  if (!s) return no('EVIDENCE_NO_STAMP', `the report carries no evidence stamp (made before template +sky.2): re-run ${rerun}`);
  if (!inRepo(root)) return note('EVIDENCE_UNBOUND', 'not a git repository: this evidence is not bound to the code it graded');
  if (s.unbound) return no('EVIDENCE_NO_STAMP', `the run was graded outside git, and this is a repository now: re-run ${rerun}`);
  const g = s.materials[0].digest;
  if (!g.gitCommit) return no('EVIDENCE_GRADED_DIRTY', `there was no commit yet when this was graded: commit the work, then re-run ${rerun}`);
  let tree = g.gitTree;
  if (!tree) {
    const t = git(root, ['rev-parse', '--verify', '-q', `${g.gitCommit}^{tree}`]);
    if (t.status !== 0) return no('EVIDENCE_UNCHECKABLE', `the graded commit ${g.gitCommit.slice(0, 12)} is not in this repository: re-run ${rerun}`);
    tree = t.out;
  }
  const has = git(root, ['cat-file', '-e', `${tree}^{tree}`]);
  if (has.status !== 0) return no('EVIDENCE_UNCHECKABLE', `the graded tree ${tree.slice(0, 12)} is not in this repository (${has.err || 'missing object'}): re-run ${rerun}`);
  if (s.dirty && s.dirty.length) return no('EVIDENCE_GRADED_DIRTY', `the graded tree had ${s.dirty.length} uncommitted file(s) (${list(s.dirty)}), or they changed during the run: commit them, then re-run ${rerun}`);
  const want = s.materials[1] && s.materials[1].digest.sha256;
  const lockNow = currentLockHash(root);
  if (lockNow && want !== lockNow) return no('EVIDENCE_LOCK_CHANGED', `graded against lock ${want ? want.slice(0, 12) : '(none)'}, but the lock is now ${lockNow.slice(0, 12)}: re-run ${rerun}`);
  const ch = changedSince(root, tree);
  if (ch.error) return no('EVIDENCE_UNCHECKABLE', `git could not compare the code with the graded tree (${ch.error})`);
  if (ch.paths.length) return no('EVIDENCE_TREE_CHANGED', `the code changed since it was graded at ${g.gitCommit.slice(0, 7)} (${list(ch.paths)}): re-run ${rerun}`);
  let buildNote = 'build identity not verified (the app declares no build id)';
  if (s.build) {
    const b = String(s.build).toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(b)) return no('EVIDENCE_BUILD_UNCOMPARABLE', `the app declared build "${s.build}", which is not a commit or tree id: declare the commit it was built from`);
    if (!g.gitCommit.startsWith(b) && !tree.startsWith(b)) return no('EVIDENCE_BUILD_MISMATCH', `the app that answered was built from ${b.slice(0, 12)}, not the graded commit ${g.gitCommit.slice(0, 7)}: rebuild and restart it, then re-run ${rerun}`);
    buildNote = `build ${b.slice(0, 7)} matches`;
  }
  return ok(`graded code unchanged since ${g.gitCommit.slice(0, 7)}${s.legacy ? ' (sky.2 report)' : ''}; ${buildNote}; ${NOT_SEEN}`);
}

// ========== UI reports ==========

/** specs/logs/ui-e2e.json → specs/logs/ui-e2e.stamp.json: one stamp per report, so a repeat run keeps its own. */
function stampPath(rel) {
  return `${rel.replace(/\.json$/, '')}.stamp.json`;
}

function uiRerun(rel) {
  return `node specs/.sdd/scripts/oracle.cjs ui${rel === 'specs/logs/ui-e2e.json' ? '' : ` --out ${rel}`} [playwright args]`;
}

function writeUiStamp(root, rel, sealed) {
  const subject = [{ name: rel, digest: { sha256: sha256(path.join(root, rel)) } }];
  L.writeJson(path.join(root, stampPath(rel)), { ...sealed, subject });
}

function checkUi(root, rel) {
  const sp = path.join(root, stampPath(rel));
  if (!fs.existsSync(sp)) return no('UI_NO_STAMP', `${rel} has no stamp (${stampPath(rel)}): Playwright was run directly, or the report came from another tree; run ${uiRerun(rel)}`);
  let s;
  try { s = L.readJson(sp); } catch (e) { return no('UI_NO_STAMP', `${stampPath(rel)}: ${e.message}`); }
  const subj = (s.subject || [])[0];
  if (!subj || !fs.existsSync(path.join(root, rel)) || subj.digest.sha256 !== sha256(path.join(root, rel))) {
    return no('UI_REPORT_REPLACED', `${rel} is not the report its stamp was written for: run ${uiRerun(rel)}`);
  }
  return check(root, { evidence: s }, { rerun: uiRerun(rel) });
}

/** A gate line for sdd.cjs: [passed, label]. A refusal or note leads with its problem code. */
function gate(result) {
  return [result.ok, result.code ? `${result.code}: ${result.message}` : result.message];
}

module.exports = { STAMP_TYPE, stamp, seal, check, stampPath, writeUiStamp, checkUi, gate, changedSince };
