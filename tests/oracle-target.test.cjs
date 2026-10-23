'use strict';
// Frozen decision tests for dalmeida2/skills#49 (M-046, M-047): setup hooks never run against a guessed target.
// Numbers match the frozen cases in #49. Changing a test here is a spec change: it goes back to the maintainer.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const TEMPLATE = path.join(REPO, 'icm-workspace-template');
const EXAMPLE = path.join(TEMPLATE, 'specs/.sdd/_config/examples/notes-service/specs');
const POSIX = process.platform !== 'win32';

function project() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-target-'));
  fs.cpSync(TEMPLATE, dir, { recursive: true });
  fs.cpSync(EXAMPLE, path.join(dir, 'specs'), { recursive: true });
  return dir;
}

const read = f => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A stand-in build in its own process: answers every request like GET /healthz and logs each request line. */
function startServer(dir) {
  const log = path.join(dir, 'requests.log');
  const portFile = path.join(dir, 'port');
  const src = `const fs=require('fs');require('http').createServer((q,r)=>{fs.appendFileSync(${JSON.stringify(log)},q.method+' '+q.url+'\\n');r.setHeader('content-type','application/json');r.end('{"status":"ok"}')}).listen(0,'127.0.0.1',function(){fs.writeFileSync(${JSON.stringify(portFile)},String(this.address().port))});`;
  const child = spawn(process.execPath, ['-e', src], { stdio: 'ignore' });
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) sleep(50);
  return { url: `http://127.0.0.1:${read(portFile)}`, requests: () => read(log).split('\n').filter(Boolean), stop: () => child.kill() };
}

const HOOKS = { reset: { cmd: 'sh', args: ['-c', 'echo ran >> hook.log'] } };

function config(dir, targets, { hooks = true } = {}) {
  const file = path.join(dir, 'specs/fixtures/oracle.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  cfg.targets = targets;
  if (hooks) { cfg.hooks = HOOKS; cfg.defaultSetup = ['reset']; } else { delete cfg.hooks; delete cfg.defaultSetup; }
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

function oracle(dir, args, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('T_')));
  const r = spawnSync(process.execPath, [path.join(dir, 'specs/.sdd/scripts/oracle.cjs'), ...args], { cwd: dir, encoding: 'utf8', env: { ...clean, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const hookRan = dir => read(path.join(dir, 'hook.log')).includes('ran');

test('1: a defaulted DATABASE_URL with a reset hook is ORACLE_TARGET_IMPLICIT, before any request or hook', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    config(dir, { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB:-postgres://localhost:5432/notes_oracle}' } } });
    const r = oracle(dir, ['run', '--case', 'NOTE-001'], { T_URL: s.url });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT/);
    assert.match(r.out, /T_DB/);
    assert.match(r.out, /reset/);
    assert.equal(hookRan(dir), false);
    assert.deepEqual(s.requests(), []);
  } finally { s.stop(); }
});

test('2: a defaulted base URL with a hook is ORACLE_TARGET_IMPLICIT, naming the variable', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    config(dir, { default: { baseUrl: `\${T_URL:-${s.url}}`, env: { DATABASE_URL: '${T_DB}' } } });
    const r = oracle(dir, ['run', '--case', 'NOTE-001'], { T_DB: 'postgres://explicit.invalid/db' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_URL/);
    assert.equal(hookRan(dir), false);
    assert.deepEqual(s.requests(), []);
  } finally { s.stop(); }
});

test('3: with every variable set, the hook runs and the case is graded', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    config(dir, { default: { baseUrl: '${T_URL:-http://127.0.0.1:9}', env: { DATABASE_URL: '${T_DB:-postgres://localhost/x}' } } });
    const r = oracle(dir, ['run', '--case', 'NOTE-001'], { T_URL: s.url, T_DB: 'postgres://explicit.invalid/db' });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /ORACLE_TARGET_IMPLICIT/);
    assert.equal(hookRan(dir), true);
    assert.ok(s.requests().some(l => l === 'GET /healthz'));
  } finally { s.stop(); }
});

test('4: defaults with no setup hooks are allowed: a read-only run proceeds', () => {
  const dir = project();
  const s = startServer(dir);
  try {
    config(dir, { default: { baseUrl: `\${T_URL:-${s.url}}`, env: { DATABASE_URL: '${T_DB:-postgres://localhost/x}' } } }, { hooks: false });
    const r = oracle(dir, ['run', '--case', 'NOTE-001'], {});
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /ORACLE_TARGET_IMPLICIT/);
    assert.ok(s.requests().length > 0);
  } finally { s.stop(); }
});

test('5: a variable set to the empty string counts as unset', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    config(dir, { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB:-postgres://localhost/x}' } } });
    const r = oracle(dir, ['run', '--case', 'NOTE-001'], { T_URL: s.url, T_DB: '' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_DB/);
    assert.equal(hookRan(dir), false);
  } finally { s.stop(); }
});

test('6: diff refuses a defaulted target B before contacting either target', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    config(dir, {
      default: { baseUrl: '${T_A_URL}', env: { DATABASE_URL: '${T_A_DB}' } }, // amendment: the schema requires a default target
      a: { baseUrl: '${T_A_URL}', env: { DATABASE_URL: '${T_A_DB}' } },
      b: { baseUrl: '${T_B_URL}', env: { DATABASE_URL: '${T_B_DB:-postgres://localhost/b}' } },
    });
    const bRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sdd-target-b-'));
    const r = oracle(dir, ['diff', '--a', 'a', '--b', 'b', '--b-root', bRoot, '--case', 'NOTE-001'], { T_A_URL: s.url, T_A_DB: 'postgres://explicit.invalid/a', T_B_URL: s.url.replace('127.0.0.1', 'localhost') });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*"b"[^\n]*T_B_DB/);
    assert.equal(hookRan(dir), false);
    assert.deepEqual(s.requests(), []);
  } finally { s.stop(); }
});

test('7: the template example names its targets explicitly, with no :- fallback', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(EXAMPLE, 'fixtures/oracle.config.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(cfg.targets), /:-/);
});

// ---------- Amendment A1 (approved on #49, 2026-10-23): Red Team gaps, and M-048's wider scope ----------
// M-048: a guessed target is refused whenever the selected cases would change state: setup hooks, SQL query steps,
// CLI run steps, or HTTP methods other than GET/HEAD/OPTIONS. A purely read-only case set may use fallbacks.

const RT_CASES = [
  { id: 'RT-001', title: 'Read only, no setup', setup: [], steps: [{ http: { method: 'GET', path: '/healthz' }, expect: { status: 200 } }] },
  { id: 'RT-002', title: 'A write request', setup: [], steps: [{ http: { method: 'POST', path: '/notes', body: { title: 'x' } }, expect: { status: 200 } }] },
  { id: 'RT-003', title: 'A query step', setup: [], steps: [{ query: { sql: 'DELETE FROM notes' }, expect: { rows: [] } }] },
  { id: 'RT-004', title: 'A per-case reset', setup: ['reset'], steps: [{ http: { method: 'GET', path: '/healthz' }, expect: { status: 200 } }] },
];

/** Config with the given targets, hooks and defaultSetup, an SQL adapter that only logs, and the RT cases. */
function setup(dir, targets, { hooks = HOOKS, defaultSetup = [] } = {}) {
  const file = path.join(dir, 'specs/fixtures/oracle.config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  Object.assign(cfg, { targets, hooks, defaultSetup, adapters: { sql: { cmd: 'sh', args: ['-c', 'echo "$DATABASE_URL" >> sql.log; echo "[]"'] } } });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'specs/fixtures/cases/rt.json'), `${JSON.stringify({ suite: 'rt', cases: RT_CASES }, null, 2)}\n`);
}

const GUESSED_DB = { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB:-postgres://localhost:5432/guessed}' } } };

test('8: a fallback inside a hook\'s env, with an explicit target, is ORACLE_TARGET_IMPLICIT', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB}' } } }, { hooks: { reset: { ...HOOKS.reset, env: { PGHOST: '${T_PGHOST:-localhost}' } } } });
    const r = oracle(dir, ['run', '--case', 'RT-004'], { T_URL: s.url, T_DB: 'postgres://explicit.invalid/db' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_PGHOST/);
    assert.equal(hookRan(dir), false);
  } finally { s.stop(); }
});

test('9: hooks defined but not selected (setup: []) leave a read-only case free to use fallbacks', () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, { default: { baseUrl: `\${T_URL:-${s.url}}`, env: { DATABASE_URL: '${T_DB:-postgres://localhost/guessed}' } } }, { defaultSetup: ['reset'] });
    const r = oracle(dir, ['run', '--case', 'RT-001'], {});
    assert.equal(r.code, 0, r.out);
    assert.equal(hookRan(dir), false);
  } finally { s.stop(); }
});

test('10: a per-case setup hook with no defaultSetup still refuses a guessed target', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, GUESSED_DB);
    const r = oracle(dir, ['run', '--case', 'RT-004'], { T_URL: s.url });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_DB/);
    assert.equal(hookRan(dir), false);
  } finally { s.stop(); }
});

test('11: record refuses a guessed target', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, GUESSED_DB);
    const out = path.join(os.tmpdir(), `sdd-target-record-${process.pid}.json`);
    const r = oracle(dir, ['record', '--target', 'default', '--out', out, '--case', 'RT-004'], { T_URL: s.url });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT/);
    assert.deepEqual(s.requests(), []);
  } finally { s.stop(); }
});

test('12: diff refuses a guessed target A', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, {
      default: { baseUrl: '${T_B_URL}', env: { DATABASE_URL: '${T_B_DB}' } },
      a: { baseUrl: '${T_A_URL}', env: { DATABASE_URL: '${T_A_DB:-postgres://localhost/a}' } },
      b: { baseUrl: '${T_B_URL}', env: { DATABASE_URL: '${T_B_DB}' } },
    });
    const r = oracle(dir, ['diff', '--a', 'a', '--b', 'b', '--case', 'RT-004'], { T_A_URL: s.url, T_B_URL: s.url.replace('127.0.0.1', 'localhost'), T_B_DB: 'postgres://explicit.invalid/b' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*"a"[^\n]*T_A_DB/);
    assert.deepEqual(s.requests(), []);
  } finally { s.stop(); }
});

test('13: a shell-side default or an unset $VAR inside a hook command is a guess too', { skip: !POSIX && 'POSIX hook' }, () => {
  for (const arg of ['echo "${T_PG-postgres://localhost/guessed}" >> hook.log', 'echo "$T_PG2" >> hook.log']) {
    const dir = project();
    const s = startServer(dir);
    try {
      setup(dir, { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB}' } } }, { hooks: { reset: { cmd: 'sh', args: ['-c', arg] } } });
      const r = oracle(dir, ['run', '--case', 'RT-004'], { T_URL: s.url, T_DB: 'postgres://explicit.invalid/db' });
      assert.equal(r.code, 2, `${arg}\n${r.out}`);
      assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_PG/);
      assert.equal(read(path.join(dir, 'hook.log')), '');
    } finally { s.stop(); }
  }
});

test('14: with no hooks, a SQL query step against a guessed database is refused', { skip: !POSIX && 'POSIX adapter' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, GUESSED_DB, { hooks: {} });
    const r = oracle(dir, ['run', '--case', 'RT-003'], { T_URL: s.url });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_DB/);
    assert.equal(read(path.join(dir, 'sql.log')), '');
  } finally { s.stop(); }
});

test('15: with no hooks, a write request to a guessed target is refused; reads stay allowed (case 9)', () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, { default: { baseUrl: `\${T_URL:-${s.url}}`, env: { DATABASE_URL: '${T_DB}' } } }, { hooks: {} });
    const r = oracle(dir, ['run', '--case', 'RT-002'], { T_DB: 'postgres://explicit.invalid/db' });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /ORACLE_TARGET_IMPLICIT[^\n]*T_URL/);
    assert.deepEqual(s.requests(), []);
  } finally { s.stop(); }
});

test('16: the refusal names variables but never prints a fallback\'s credentials', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB:-postgres://admin:s3cr3t@db.internal/prod}', PGPASSWORD: '${T_PW:-hunter2}' } } });
    const r = oracle(dir, ['run', '--case', 'RT-004'], { T_URL: s.url });
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /T_DB/);
    assert.match(r.out, /T_PW/);
    assert.doesNotMatch(r.out, /s3cr3t|hunter2|admin/);
  } finally { s.stop(); }
});

test('17: a variable the hook\'s own env supplies is not a guess', { skip: !POSIX && 'POSIX hook' }, () => {
  const dir = project();
  const s = startServer(dir);
  try {
    setup(dir, { default: { baseUrl: '${T_URL}', env: { DATABASE_URL: '${T_DB}' } } }, { hooks: { reset: { cmd: 'sh', args: ['-c', 'echo "ran ${X:-bar} $X" >> hook.log'], env: { X: 'fromHookEnv' } } } });
    const r = oracle(dir, ['run', '--case', 'RT-004'], { T_URL: s.url, T_DB: 'postgres://explicit.invalid/db' });
    assert.equal(r.code, 0, r.out);
    assert.equal(hookRan(dir), true);
  } finally { s.stop(); }
});
