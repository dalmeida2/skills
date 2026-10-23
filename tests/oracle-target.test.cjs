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
