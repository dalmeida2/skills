#!/usr/bin/env node
'use strict';
/**
 * oracle.cjs — the single, implementation-agnostic grader for SDD projects. Zero dependencies (Node.js >= 18).
 *
 *   node specs/.sdd/scripts/oracle.cjs run    [--target default] [--phase N] [--case ID,ID] [--suite S] [--bail]
 *   node specs/.sdd/scripts/oracle.cjs ui     [--out specs/logs/ui-e2e.json] [playwright args]
 *   node specs/.sdd/scripts/oracle.cjs diff   [--a a] [--b b] [--phase N] [--case ID,ID] [--suite S]
 *   node specs/.sdd/scripts/oracle.cjs record --target T --out FILE [--cases-dir DIR] [--case ID,ID] [--suite S]
 *   node specs/.sdd/scripts/oracle.cjs diff-ui --a OBS_A.jsonl --b OBS_B.jsonl --b-root DIR
 *   node specs/.sdd/scripts/oracle.cjs env
 *   node specs/.sdd/scripts/oracle.cjs gen-probes [--out FILE]
 *   node specs/.sdd/scripts/oracle.cjs diff-expect --a DIR|FILE --b DIR|FILE [--label NAME]
 *   node specs/.sdd/scripts/oracle.cjs strip-expect --from DIR|FILE --out DIR
 *
 * run    — grade one build against every expectation in specs/fixtures/cases/ (probe cases skipped).
 * ui     — run the frozen Playwright suite (specs/fixtures/ui/) and stamp its JSON report with the code it graded.
 * diff   — run the same cases (probes included) against two independent builds and report every
 *          observation that differs outside the declared degrees of freedom.
 * record — characterize an existing build: fill in missing expectations from what it actually does
 *          (Stage 01b adoption). Writes to --out, never into the frozen fixtures.
 * diff-ui — compare UI observations (ARIA snapshots + test ids) recorded by ui-observe.cjs for two builds.
 * env    — print the frozen build environment (oracle.config.json#buildEnv) as shell exports; every graded
 *          build must be started with it.
 * gen-probes  — derive edge-case probe cases from the OpenAPI contract (specs/fixtures/cases/generated-probes.json).
 * diff-expect — interpretation diff: compare two independently written sets of expectations for the same
 *          requests. Every disagreement, every {"$unspecified": ...} and every uncited case is a spec gap.
 * strip-expect — write request-only skeletons (no expectations, citations or revealing titles) for
 *          an independent author to predict.
 *
 * Global flag: --root <project-dir> (default: three levels above this script).
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./sdd-lib.cjs');
const E = require('./evidence.cjs');
const { generateProbes } = require('./probes.cjs');

const USAGE = `Usage:
  oracle.cjs run     [--target default] [--phase N] [--case ID,ID] [--suite S] [--bail] [--verbose]
  oracle.cjs ui      [--out specs/logs/ui-e2e.json] [playwright args]
  oracle.cjs diff    [--a a] [--b b] --b-root DIR [--phase N] [--case ID,ID] [--suite S]
  oracle.cjs record  --target T --out FILE [--cases-dir DIR] [--case ID,ID] [--suite S]
  oracle.cjs diff-ui --a OBS_A.jsonl --b OBS_B.jsonl --b-root DIR
  oracle.cjs env
  oracle.cjs gen-probes  [--out FILE]
  oracle.cjs diff-expect --a DIR|FILE --b DIR|FILE [--label NAME]
  oracle.cjs strip-expect --from DIR|FILE --out DIR`;

// Contractual response headers (Equivalence Profile HTTP-10). `diff` compares only these, plus headers a
// step's expectation names and oracle.config.json#observedHeaders; every other header is non-contractual.
const CONTRACT_HEADERS = ['content-type', 'location', 'etag', 'allow', 'retry-after', 'idempotent-replay'];
const RECORDED_HEADERS = ['content-type', 'location', 'etag', 'retry-after', 'idempotent-replay', 'allow'];

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function short(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  if (s === undefined) return 'undefined';
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}

// ========== Loading ==========

function loadProject(p, casesDir) {
  if (!fs.existsSync(p.oracleConfig)) fail('missing specs/fixtures/oracle.config.json');
  const { cfg, errors } = L.loadOracleConfig(p);
  const loaded = L.loadCases(casesDir ? { ...p, cases: path.resolve(casesDir) } : p);
  const all = [...errors, ...loaded.errors];
  if (all.length) fail(`Invalid fixtures (run \`node specs/.sdd/scripts/sdd.cjs check\` for details):\n  ${all.join('\n  ')}`);
  if (!loaded.cases.length) fail(`no cases in ${casesDir || 'specs/fixtures/cases/'} (browser-only projects are graded by specs/fixtures/ui/ and \`oracle.cjs diff-ui\`)`);
  const variablePaths = (cfg.variablePaths || []).map(L.compilePathPattern);
  return { cfg, cases: loaded.cases, variablePaths };
}

/** Phase of a probe = the earliest phase whose non-probe cases exercise every operation the probe touches. */
function probePhases(p, cases) {
  let ops = [];
  try {
    const manifest = L.readJson(p.manifest);
    if (manifest.artifacts && manifest.artifacts.openapi) ops = L.loadOpenApi(path.join(p.contracts, manifest.artifacts.openapi), p.root).ops;
  } catch { ops = []; }
  const opsOf = c => c.steps.flatMap(s => (s.http ? [s.http] : s.parallel || [])).map(h => L.matchOperation(ops, h.method, h.path)).filter(Boolean);
  const first = new Map();
  for (const c of cases) {
    if (c.probe || c.phase === undefined) continue;
    for (const o of opsOf(c)) first.set(o, Math.min(first.get(o) ?? Infinity, c.phase));
  }
  return c => {
    const touched = opsOf(c);
    return touched.length ? Math.max(...touched.map(o => first.get(o) ?? Infinity)) : Infinity;
  };
}

function selectCases(cases, flags, { includeProbes }, p) {
  let out = cases.filter(c => includeProbes || !c.probe);
  let filtered = false;
  if (flags.phase !== undefined) {
    const n = Number(flags.phase);
    if (!Number.isInteger(n)) fail('--phase must be an integer');
    const phaseOf = p ? probePhases(p, cases) : () => Infinity;
    // Cumulative: earlier phases are regressions. Probes join once every operation they touch has been built.
    out = out.filter(c => (c.probe ? phaseOf(c) <= n : c.phase !== undefined && c.phase <= n));
    filtered = true;
  }
  if (typeof flags.case === 'string') {
    const ids = new Set(flags.case.split(',').map(s => s.trim()));
    out = out.filter(c => ids.has(c.id));
    filtered = true;
  }
  if (typeof flags.suite === 'string') {
    out = out.filter(c => c.suite === flags.suite);
    filtered = true;
  }
  return { selected: out, filtered };
}

function resolveTarget(cfg, name) {
  const t = cfg.targets[name];
  if (!t) fail(`unknown target "${name}" (oracle.config.json targets: ${Object.keys(cfg.targets).join(', ')})`);
  let env;
  let baseUrl;
  try {
    env = { ...process.env, ...L.interpolateEnv(t.env || {}, process.env) };
    baseUrl = t.baseUrl !== undefined ? L.interpolateEnv(t.baseUrl, env).replace(/\/+$/, '') : null;
  } catch (e) {
    fail(`target "${name}": ${e.message}`);
  }
  return { name, env, baseUrl };
}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** What the selected cases would do that can change state, and the command definitions involved. */
function stateChanges(cfg, cases) {
  const hooks = [...new Set(cases.flatMap(c => c.setup || cfg.defaultSetup || []))];
  const defs = hooks.map(h => (cfg.hooks || {})[h]).filter(Boolean);
  const writes = (r = {}) => !READ_METHODS.has(String(r.method || 'GET').toUpperCase());
  let writeRequests = 0;
  let queries = false;
  for (const c of cases) {
    for (const st of c.steps || []) {
      if (st.http && writes(st.http)) writeRequests++;
      if (Array.isArray(st.parallel)) writeRequests += st.parallel.filter(writes).length;
      if (st.query) queries = true;
      if (st.run) defs.push({ cmd: st.run.cmd, args: st.run.args || [], env: st.run.env || {} });
    }
  }
  if (queries && cfg.adapters && cfg.adapters.sql) defs.push(cfg.adapters.sql);
  const what = [
    hooks.length && `setup hook(s) ${hooks.join(', ')}`,
    writeRequests && `${writeRequests} write request(s)`,
    queries && 'SQL query steps',
    cases.some(c => (c.steps || []).some(st => st.run)) && 'CLI run steps',
  ].filter(Boolean);
  return { what, defs };
}

/** Shell-side guesses in a command the oracle hands to a shell: `${V-x}`, `${V:=x}`, `${V=x}`, or a bare `$V` that is unset. */
function shellGuesses(value, env, out) {
  const unset = n => env[n] === undefined || env[n] === '';
  for (const v of [value].flat(Infinity)) {
    if (typeof v !== 'string') continue;
    for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:-|:?=)[^}]*\}/g)) if (unset(m[1])) out.push(m[1]);
    for (const m of v.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) if (unset(m[1])) out.push(m[1]);
  }
}

/**
 * A run that would change state (setup hooks, SQL query steps, CLI run steps, or HTTP writes) refuses before any
 * request when a value of its target, or of a command it would run, is a guess: a `${VAR:-default}` fallback used
 * because VAR is unset or empty, or a shell-side default. A guessed target is whatever app and database happen to
 * answer there (#49, M-046, M-048). Read-only case sets may use fallbacks. Only names are printed: fallbacks can hold
 * credentials.
 */
function refuseImplicitTarget(cfg, target, cases) {
  const { what, defs } = stateChanges(cfg, cases);
  if (!what.length) return;
  const t = cfg.targets[target.name] || {};
  const found = [...L.defaultedVars(t.baseUrl, process.env), ...L.defaultedVars(t.env || {}, process.env)].map(f => f.name);
  for (const d of defs) {
    let env = target.env;
    try { env = { ...target.env, ...L.interpolateEnv(d.env || {}, target.env) }; } catch { /* reported when the command runs */ }
    found.push(...L.defaultedVars(d.env || {}, target.env).map(f => f.name));
    found.push(...L.defaultedVars([d.cmd, d.args || []], env).map(f => f.name));
    shellGuesses([d.cmd, d.args || []], env, found);
  }
  if (!found.length) return;
  fail(`ORACLE_TARGET_IMPLICIT: target "${target.name}" would change state (${what.join('; ')}) using values that were not set: ${[...new Set(found)].join(', ')}. Export them for the build under test, then re-run`);
}

function lockInfo(p) {
  const v = L.verifyLock(p.root);
  if (!v.exists) return { lockHash: null, lockValid: false, lockVersion: null };
  return { lockHash: v.lock.hash, lockValid: v.valid, lockVersion: v.lock.lockVersion };
}

// ========== Execution ==========

function runCommand(p, def, env, { extraEnv, stdin, timeoutMs, sql } = {}) {
  const fullEnv = { ...env, ...L.interpolateEnv(def.env || {}, env), ...(extraEnv || {}) };
  const cmd = L.interpolateEnv(def.cmd, fullEnv);
  let args = L.interpolateEnv(def.args || [], fullEnv);
  if (sql !== undefined) args = args.map(a => a.split('{{sql}}').join(sql));
  const res = spawnSync(cmd, args, {
    cwd: p.root,
    env: fullEnv,
    input: stdin,
    timeout: timeoutMs || def.timeoutMs || 60000,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.error) throw new Error(`${cmd}: ${res.error.code === 'ETIMEDOUT' ? 'timed out' : res.error.message}`);
  return { exitCode: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function normalizeContentType(v) {
  // JSON has no charset parameter semantics (RFC 8259); treat "; charset=utf-8" as absent.
  return String(v).toLowerCase().replace(/\s*;\s*charset=utf-8\s*$/, '').trim();
}

/**
 * One HTTP exchange on a fresh connection (no keep-alive: a server closing an idle socket while the
 * client reuses it causes spurious resets) with no Accept-Encoding (no transparent compression).
 */
function httpStep(target, req, timeoutMs) {
  if (!target.baseUrl) return Promise.reject(new Error(`target "${target.name}" has no baseUrl`));
  const qs = req.query ? `?${new URLSearchParams(Object.entries(req.query).map(([k, v]) => [k, String(v)]))}` : '';
  const headers = { ...(req.headers || {}) };
  let body;
  if (req.rawBody !== undefined) body = req.rawBody;
  else if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
  }
  if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
  const url = new URL(target.baseUrl + req.path + qs);
  const lib = url.protocol === 'https:' ? require('https') : require('http');
  return new Promise((resolve, reject) => {
    const r = lib.request(url, { method: req.method, headers, agent: false, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const h = {};
        for (const [k, v] of Object.entries(res.headers)) {
          const val = Array.isArray(v) ? v.join(', ') : String(v);
          h[k] = k === 'content-type' ? normalizeContentType(val) : val;
        }
        let parsed = text === '' ? null : text;
        if (text !== '' && /json/.test(h['content-type'] || '')) {
          try { parsed = JSON.parse(text); } catch { parsed = text; }
        }
        resolve({ status: res.statusCode, headers: h, body: parsed });
      });
      res.on('error', e => reject(new Error(`${req.method} ${req.path}: ${e.code || e.message}`)));
    });
    r.on('timeout', () => r.destroy(Object.assign(new Error(`timed out after ${timeoutMs}ms`), { code: 'ETIMEDOUT' })));
    r.on('error', e => reject(new Error(`${req.method} ${req.path}: ${e.code === 'ETIMEDOUT' ? `timed out after ${timeoutMs}ms` : e.code || e.message}`)));
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/**
 * The build the app says it is, from the optional `X-SDD-Build` header on the readiness probe, else GET /healthz (HTTP-6).
 * A header, not a body field, so declaring it changes no frozen case. null when the app declares none.
 */
async function buildId(cfg, target) {
  if (!target.baseUrl) return null;
  const probe = (cfg.readiness && cfg.readiness.http) || { method: 'GET', path: '/healthz' };
  try {
    const res = await fetch(target.baseUrl + probe.path, { method: probe.method || 'GET', signal: AbortSignal.timeout(2000) });
    return res.headers.get('x-sdd-build') || null;
  } catch { return null; }
}

async function waitReady(cfg, target) {
  const r = cfg.readiness;
  if (!r || !r.http || !target.baseUrl) return;
  const deadline = Date.now() + (r.timeoutMs || 30000);
  const want = r.http.expectStatus || 200;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(target.baseUrl + r.http.path, { method: r.http.method || 'GET', signal: AbortSignal.timeout(2000) });
      if (res.status === want) return;
      last = `status ${res.status}`;
    } catch (e) {
      last = (e.cause && e.cause.code) || e.message;
    }
    await new Promise(res => setTimeout(res, 500));
  }
  fail(`target "${target.name}" not ready at ${target.baseUrl}${r.http.path} (${last})`);
}

async function executeStep(p, cfg, target, step, vars, gen) {
  const timeoutMs = cfg.timeoutMs || 10000;
  if (step.http) {
    return { kind: 'http', obs: await httpStep(target, L.renderTemplate(step.http, vars, gen), timeoutMs) };
  }
  if (step.parallel) {
    // Requests are sent concurrently; responses are kept in request order.
    const reqs = L.renderTemplate(step.parallel, vars, gen);
    return { kind: 'parallel', obs: { responses: await Promise.all(reqs.map(r => httpStep(target, r, timeoutMs))) } };
  }
  if (step.query) {
    if (!cfg.adapters || !cfg.adapters.sql) throw new Error('query step without adapters.sql');
    const sql = L.renderTemplate(step.query.sql, vars, gen);
    const res = runCommand(p, cfg.adapters.sql, target.env, { sql, timeoutMs });
    if (res.exitCode !== 0) throw new Error(`sql adapter exited ${res.exitCode}: ${res.stderr.trim().slice(0, 300)}`);
    let rows;
    try { rows = JSON.parse(res.stdout.trim() || '[]'); } catch { throw new Error(`sql adapter did not print a JSON array: ${short(res.stdout)}`); }
    if (!Array.isArray(rows)) throw new Error('sql adapter must print a JSON array of rows');
    return { kind: 'query', obs: { rows } };
  }
  const run = L.renderTemplate(step.run, vars, gen);
  const res = runCommand(p, { cmd: run.cmd, args: run.args || [] }, target.env, { extraEnv: run.env, stdin: run.stdin, timeoutMs: run.timeoutMs || timeoutMs });
  let stdoutJson;
  try { stdoutJson = JSON.parse(res.stdout); } catch { stdoutJson = undefined; }
  return { kind: 'run', obs: { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, stdoutJson } };
}

function assertHttp(exp, obs, out, prefix = '') {
  const opts = { mode: exp.bodyMatch || 'exact' };
  const one = (e, actual, at) => L.matchJson(e, actual, opts, prefix + at, out);
  if (exp.status !== undefined) one(exp.status, obs.status, 'status');
  for (const [h, e] of Object.entries(exp.headers || {})) {
    const name = h.toLowerCase();
    const present = Object.prototype.hasOwnProperty.call(obs.headers, name);
    if (L.isMatcher(e) && e.$absent) {
      if (present) out.push({ path: `${prefix}headers.${name}`, reason: 'expected header to be absent', actual: obs.headers[name] });
      continue;
    }
    if (!present) { out.push({ path: `${prefix}headers.${name}`, reason: 'missing header', expected: e }); continue; }
    one(name === 'content-type' && typeof e === 'string' ? normalizeContentType(e) : e, obs.headers[name], `headers.${name}`);
  }
  if ('body' in exp) {
    if (L.isMatcher(exp.body) && exp.body.$absent) {
      if (obs.body !== null) out.push({ path: `${prefix}body`, reason: 'expected no body', actual: obs.body });
    } else one(exp.body, obs.body, 'body');
  }
  return out;
}

/** Order-insensitive assignment of expected responses to observed ones (backtracking; n <= 8). */
function assignResponses(expList, responses) {
  const used = new Array(responses.length).fill(false);
  const tryFrom = i => {
    if (i === expList.length) return true;
    for (let j = 0; j < responses.length; j++) {
      if (used[j] || assertHttp(expList[i], responses[j], []).length) continue;
      used[j] = true;
      if (tryFrom(i + 1)) return true;
      used[j] = false;
    }
    return false;
  };
  return tryFrom(0);
}

function assertStep(kind, expect, obs, vars, gen) {
  const exp = L.renderExpect(expect, vars, gen);
  const opts = { mode: exp.bodyMatch || 'exact' };
  const out = [];
  const one = (e, actual, at) => L.matchJson(e, actual, opts, at, out);
  if (kind === 'parallel') {
    const expList = exp.responses || [];
    if (expList.length !== obs.responses.length) out.push({ path: 'responses', reason: `expected ${expList.length} responses, got ${obs.responses.length}` });
    else if (!assignResponses(expList, obs.responses)) {
      out.push({ path: 'responses', reason: 'no order-insensitive assignment of responses matches the expectations', actual: obs.responses.map(r => ({ status: r.status, body: r.body })) });
    }
    return out;
  }
  if (kind === 'http') {
    if (exp.status !== undefined) one(exp.status, obs.status, 'status');
    for (const [h, e] of Object.entries(exp.headers || {})) {
      const name = h.toLowerCase();
      const present = Object.prototype.hasOwnProperty.call(obs.headers, name);
      if (L.isMatcher(e) && e.$absent) {
        if (present) out.push({ path: `headers.${name}`, reason: 'expected header to be absent', actual: obs.headers[name] });
        continue;
      }
      if (!present) { out.push({ path: `headers.${name}`, reason: 'missing header', expected: e }); continue; }
      one(name === 'content-type' && typeof e === 'string' ? normalizeContentType(e) : e, obs.headers[name], `headers.${name}`);
    }
    if ('body' in exp) {
      if (L.isMatcher(exp.body) && exp.body.$absent) {
        if (obs.body !== null) out.push({ path: 'body', reason: 'expected no body', actual: obs.body });
      } else one(exp.body, obs.body, 'body');
    }
  } else if (kind === 'query') {
    if ('rows' in exp) one(exp.rows, obs.rows, 'rows');
  } else {
    if (exp.exitCode !== undefined) one(exp.exitCode, obs.exitCode, 'exitCode');
    if ('stdout' in exp) one(exp.stdout, obs.stdout, 'stdout');
    if ('stderr' in exp) one(exp.stderr, obs.stderr, 'stderr');
    if ('stdoutJson' in exp) {
      if (obs.stdoutJson === undefined) out.push({ path: 'stdoutJson', reason: 'stdout is not valid JSON', actual: obs.stdout });
      else one(exp.stdoutJson, obs.stdoutJson, 'stdoutJson');
    }
  }
  return out;
}

function capture(step, obs, vars) {
  for (const [name, expr] of Object.entries(step.capture || {})) {
    const v = L.getPath(obs, expr);
    if (v === undefined) throw new Error(`capture ${name}: "${expr}" not found in the observation`);
    vars[name] = v;
  }
}

/** mode: 'assert' (stop at first failing step) | 'observe' (no assertions; for diff/record). */
async function runCase(p, cfg, target, c, mode, gen) {
  const result = { id: c.id, title: c.title, suite: c.suite, phase: c.phase, status: 'pass', failures: [], steps: [] };
  const vars = {};
  try {
    for (const h of c.setup || cfg.defaultSetup || []) {
      const res = runCommand(p, cfg.hooks[h], target.env);
      if (res.exitCode !== 0) throw new Error(`setup hook "${h}" exited ${res.exitCode}: ${res.stderr.trim().slice(0, 300)}`);
    }
    for (let i = 0; i < c.steps.length; i++) {
      const step = c.steps[i];
      const before = { ...vars };
      const { kind, obs } = await executeStep(p, cfg, target, step, vars, gen);
      const entry = { kind, obs, before, after: before, step };
      result.steps.push(entry);
      if (mode === 'assert' && step.expect) {
        const failures = assertStep(kind, step.expect, obs, vars, gen);
        if (failures.length) {
          result.status = 'fail';
          result.failures = failures.map(f => ({ step: i + 1, stepId: step.id || null, ...f }));
          break;
        }
      }
      capture(step, obs, vars);
      entry.after = { ...vars };
    }
  } catch (e) {
    result.status = 'error';
    result.error = e.message;
  }
  result.vars = vars;
  return result;
}

// ========== run ==========

async function cmdRun(p, args) {
  const { cfg, cases } = loadProject(p);
  const { selected, filtered } = selectCases(cases, args.flags, { includeProbes: false });
  if (!selected.length) fail('no cases selected');
  const target = resolveTarget(cfg, typeof args.flags.target === 'string' ? args.flags.target : 'default');
  refuseImplicitTarget(cfg, target, selected);
  const lock = lockInfo(p);
  if (!lock.lockHash) console.log('⚠ no spec.lock.json yet: results cannot serve as stage evidence until the frozen set is locked');
  else if (!lock.lockValid) console.log('⚠ frozen set modified since the last freeze: results will not count as evidence (sdd.cjs verify)');
  await waitReady(cfg, target);
  const startedAt = new Date().toISOString();
  // What is being graded (evidence.cjs): stamped now, sealed after the last case, so code edited mid-run shows.
  const start = E.stamp(p.root, { build: await buildId(cfg, target) });
  const results = [];
  for (const c of selected) {
    const r = await runCase(p, cfg, target, c, 'assert', L.newGenerator());
    results.push(r);
    const mark = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '!';
    console.log(`${mark} ${r.id} ${r.title}`);
    if (r.status === 'error') console.log(`    error: ${r.error}`);
    for (const f of r.failures) {
      console.log(`    step ${f.step}${f.stepId ? ` (${f.stepId})` : ''} ${f.path}: ${f.reason}${'expected' in f ? `; expected ${short(f.expected)}` : ''}${'actual' in f ? `; got ${short(f.actual)}` : ''}`);
    }
    if (args.flags.verbose && r.status !== 'pass') {
      const last = r.steps[r.steps.length - 1];
      if (last) console.log(`    observation: ${short(last.obs)}`);
    }
    if (args.flags.bail && r.status !== 'pass') break;
  }
  const report = {
    tool: 'sdd-oracle',
    toolVersion: L.TOOL_VERSION,
    mode: 'run',
    target: target.name,
    baseUrl: target.baseUrl,
    ...lock,
    filtered: filtered || !!args.flags.bail,
    filters: { phase: args.flags.phase, case: args.flags.case, suite: args.flags.suite, bail: !!args.flags.bail },
    evidence: E.seal(p.root, start),
    startedAt,
    finishedAt: new Date().toISOString(),
    total: selected.length,
    passed: results.filter(r => r.status === 'pass').length,
    failed: results.filter(r => r.status === 'fail').length,
    errored: results.filter(r => r.status === 'error').length,
    results: results.map(({ steps, vars, ...r }) => r),
  };
  const out = path.join(p.oracleLogs, `run-${target.name}.json`);
  L.writeJson(out, report);
  console.log(`\n${report.passed}/${report.total} passed, ${report.failed} failed, ${report.errored} errored on "${target.name}"${filtered ? ' (filtered run: not stage evidence)' : ''} → ${L.rel(p.root, out)}`);
  return report.failed || report.errored ? 1 : 0;
}

// ========== diff ==========

function normalizeWithVars(s, vars) {
  let out = s;
  const entries = Object.entries(vars)
    .filter(([, v]) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length);
  for (const [k, v] of entries) out = out.split(v).join(`{{${k}}}`);
  return out;
}

// Server-generated UUIDs in headers (e.g. Location of a new resource) are declared variable by profile SER-3.
// Bodies are NOT normalized this way: there, an id is compared through captured variables or variablePaths.
const ANY_UUID_G = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const ISO_G = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g;
function normalizeHeader(v, vars) {
  return normalizeWithVars(v, vars).replace(ANY_UUID_G, '<uuid>');
}

function diffJson(a, b, at, ctx, out) {
  const masked = ctx.exact.has(at) || ctx.patterns.some(re => re.test(at));
  const ta = L.jsonType(a);
  const tb = L.jsonType(b);
  if (masked) {
    if (ta !== tb) { out.push({ path: at, reason: `type differs on a declared-variable field (${ta} vs ${tb})`, a, b }); return; }
    // A declared-variable value may differ, but if it names a captured entity both builds must name the same one
    // (otherwise masking $..id would hide e.g. a list returned in a different order).
    if (ta === 'string') {
      const na = normalizeWithVars(a, ctx.varsA);
      const nb = normalizeWithVars(b, ctx.varsB);
      if ((na !== a || nb !== b) && na !== nb) out.push({ path: at, reason: 'declared-variable field refers to different entities', a, b });
    }
    return;
  }
  if (ta !== tb) { out.push({ path: at, reason: `type differs (${ta} vs ${tb})`, a, b }); return; }
  if (ta === 'array') {
    if (a.length !== b.length) { out.push({ path: at, reason: `length differs (${a.length} vs ${b.length})`, a, b }); return; }
    a.forEach((x, i) => diffJson(x, b[i], `${at}[${i}]`, ctx, out));
    return;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ina = Object.prototype.hasOwnProperty.call(a, k);
      const inb = Object.prototype.hasOwnProperty.call(b, k);
      if (!ina || !inb) out.push({ path: `${at}.${k}`, reason: `property only in ${ina ? 'A' : 'B'}`, a: a[k], b: b[k] });
      else diffJson(a[k], b[k], `${at}.${k}`, ctx, out);
    }
    return;
  }
  if (ta === 'string') {
    if (normalizeWithVars(a, ctx.varsA) !== normalizeWithVars(b, ctx.varsB)) out.push({ path: at, reason: 'value differs', a, b });
    return;
  }
  if (a !== b) out.push({ path: at, reason: 'value differs', a, b });
}

/** Stable, key-sorted JSON with declared degrees of freedom masked, for pairing concurrent responses. */
function canonicalMasked(v, at, patterns) {
  if (patterns.some(re => re.test(at))) return '"<var>"';
  if (Array.isArray(v)) return `[${v.map((x, i) => canonicalMasked(x, `${at}[${i}]`, patterns)).join(',')}]`;
  if (L.isPlainObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalMasked(v[k], `${at}.${k}`, patterns)}`).join(',')}}`;
  if (typeof v === 'string') return JSON.stringify(v.replace(ANY_UUID_G, '<uuid>').replace(ISO_G, '<datetime>'));
  return JSON.stringify(v);
}

function canonicalResponseKey(r, patterns) {
  return `${r.status} ${canonicalMasked(r.body, '$', patterns)}`;
}

function diffStep(sa, sb, variablePaths, observedHeaders) {
  const out = [];
  if (sa.kind === 'parallel') {
    // Concurrent responses are compared as a multiset: sort each build's responses canonically, then pair them.
    const key = r => canonicalResponseKey(r, variablePaths);
    const ra = [...sa.obs.responses].sort((x, y) => key(x).localeCompare(key(y)));
    const rb = [...sb.obs.responses].sort((x, y) => key(x).localeCompare(key(y)));
    if (ra.length !== rb.length) return [{ where: 'responses', path: 'responses', reason: `response count differs (${ra.length} vs ${rb.length})` }];
    ra.forEach((r, i) => {
      const pa = { kind: 'http', obs: r, after: sa.after, step: { expect: {} } };
      const pb = { kind: 'http', obs: rb[i], after: sb.after, step: { expect: {} } };
      for (const d of diffStep(pa, pb, variablePaths, observedHeaders)) out.push({ ...d, where: `responses[${i}].${d.where}` });
    });
    return out;
  }
  const expect = sa.step.expect || {};
  // Normalize with variables captured up to and including this step (e.g. the id of the resource just created).
  const ctx = exactPaths => ({ exact: exactPaths, patterns: variablePaths, varsA: sa.after, varsB: sb.after });
  const tag = (where, list) => list.map(d => ({ where, ...d }));
  if (sa.kind === 'http') {
    if (sa.obs.status !== sb.obs.status) out.push({ where: 'status', path: 'status', reason: 'status differs', a: sa.obs.status, b: sb.obs.status });
    const expHeaders = Object.fromEntries(Object.entries(expect.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    for (const h of new Set([...observedHeaders, ...Object.keys(expHeaders)])) {
      if (L.isVariableMatcher(expHeaders[h])) continue;
      if (sa.obs.headers[h] === undefined && sb.obs.headers[h] === undefined) continue;
      const va = sa.obs.headers[h];
      const vb = sb.obs.headers[h];
      if (va === undefined || vb === undefined) out.push({ where: 'header', path: h, reason: `header only in ${va === undefined ? 'B' : 'A'}`, a: va, b: vb });
      else if (normalizeHeader(va, sa.after) !== normalizeHeader(vb, sb.after)) out.push({ where: 'header', path: h, reason: 'header differs', a: va, b: vb });
    }
    const d = [];
    diffJson(sa.obs.body, sb.obs.body, '$', ctx(L.variablePathsOf(expect.body === undefined ? null : expect.body)), d);
    out.push(...tag('body', d));
  } else if (sa.kind === 'query') {
    const d = [];
    diffJson(sa.obs.rows, sb.obs.rows, '$', ctx(L.variablePathsOf(expect.rows === undefined ? null : expect.rows)), d);
    out.push(...tag('rows', d));
  } else {
    if (sa.obs.exitCode !== sb.obs.exitCode) out.push({ where: 'exitCode', path: 'exitCode', reason: 'exit code differs', a: sa.obs.exitCode, b: sb.obs.exitCode });
    if (sa.obs.stdoutJson !== undefined && sb.obs.stdoutJson !== undefined) {
      const d = [];
      diffJson(sa.obs.stdoutJson, sb.obs.stdoutJson, '$', ctx(L.variablePathsOf(expect.stdoutJson === undefined ? null : expect.stdoutJson)), d);
      out.push(...tag('stdoutJson', d));
    } else if (!L.isVariableMatcher(expect.stdout) && normalizeWithVars(sa.obs.stdout, sa.after) !== normalizeWithVars(sb.obs.stdout, sb.after)) {
      out.push({ where: 'stdout', path: 'stdout', reason: 'stdout differs', a: sa.obs.stdout, b: sb.obs.stdout });
    }
    // stderr is diagnostic free text (Equivalence Profile CLI-3) and is not compared.
  }
  return out;
}

async function cmdDiff(p, args) {
  const { cfg, cases, variablePaths } = loadProject(p);
  const { selected, filtered } = selectCases(cases, args.flags, { includeProbes: true }, p);
  if (!selected.length) fail('no cases selected');
  const A = resolveTarget(cfg, typeof args.flags.a === 'string' ? args.flags.a : 'a');
  const B = resolveTarget(cfg, typeof args.flags.b === 'string' ? args.flags.b : 'b');
  refuseImplicitTarget(cfg, A, selected);
  refuseImplicitTarget(cfg, B, selected);
  if (A.baseUrl === B.baseUrl && JSON.stringify(A.env) === JSON.stringify(B.env)) fail(`targets "${A.name}" and "${B.name}" resolve to the same build (${A.baseUrl}); point them at two independent builds`);
  const observedHeaders = [...new Set([...CONTRACT_HEADERS, ...(cfg.observedHeaders || [])])];
  const lock = lockInfo(p);
  const bLock = bLockInfo(args);
  await waitReady(cfg, A);
  await waitReady(cfg, B);
  const startedAt = new Date().toISOString();
  const divergences = [];
  const errors = [];
  let divergentCases = 0;
  for (const c of selected) {
    const genA = L.newGenerator();
    const ra = await runCase(p, cfg, A, c, 'observe', genA);
    const genB = { named: genA.named, seq: genA.seq, idx: 0, replay: true }; // identical generated inputs
    const rb = await runCase(p, cfg, B, c, 'observe', genB);
    if (ra.status === 'error' || rb.status === 'error') {
      // A step that errors on one build but not the other is itself a divergence of observable behavior.
      errors.push({ case: c.id, a: ra.error || null, b: rb.error || null });
      console.log(`! ${c.id} ${c.title}\n    A: ${ra.error || 'ok'}\n    B: ${rb.error || 'ok'}`);
      continue;
    }
    const caseDivs = [];
    for (let i = 0; i < Math.min(ra.steps.length, rb.steps.length); i++) {
      for (const d of diffStep(ra.steps[i], rb.steps[i], variablePaths, observedHeaders)) caseDivs.push({ case: c.id, step: i + 1, ...d });
    }
    if (caseDivs.length) {
      divergentCases++;
      divergences.push(...caseDivs);
      console.log(`≠ ${c.id} ${c.title}`);
      for (const d of caseDivs) console.log(`    step ${d.step} ${d.where} ${d.path}: ${d.reason}; A=${short(d.a)} B=${short(d.b)}`);
    } else {
      console.log(`= ${c.id} ${c.title}`);
    }
  }
  const report = {
    tool: 'sdd-oracle',
    toolVersion: L.TOOL_VERSION,
    mode: 'diff',
    a: A.name,
    b: B.name,
    aBaseUrl: A.baseUrl,
    bBaseUrl: B.baseUrl,
    ...lock,
    ...bLock,
    filtered,
    filters: { phase: args.flags.phase, case: args.flags.case, suite: args.flags.suite },
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: selected.length,
    divergentCases,
    errored: errors.length,
    divergences,
    errors,
  };
  const out = path.join(p.oracleLogs, `diff-${A.name}-${B.name}.json`);
  L.writeJson(out, report);
  console.log(`\n${selected.length} case(s): ${divergentCases} divergent, ${errors.length} errored → ${L.rel(p.root, out)}`);
  if (divergentCases || errors.length) console.log('Every divergence is an unconstrained degree of freedom: route to Stage 00 (class C, spec gap).');
  return divergentCases || errors.length ? 1 : 0;
}

function bLockInfo(args) {
  if (typeof args.flags['b-root'] !== 'string') {
    console.log('⚠ no --b-root: build B\'s workspace lock is unknown, so this diff cannot serve as L2 evidence');
    return { bRoot: null, bLockHash: null, bLockValid: false };
  }
  const bRoot = path.resolve(args.flags['b-root']);
  const v = L.verifyLock(bRoot);
  return { bRoot, bLockHash: v.exists ? v.lock.hash : null, bLockValid: v.valid };
}

// ========== diff-ui ==========

function readObservations(file) {
  const byName = new Map();
  const dupes = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)) {
    const o = JSON.parse(line);
    if (byName.has(o.name)) dupes.push(o.name);
    byName.set(o.name, o);
  }
  return { byName, dupes };
}

function normalizeUiText(s) {
  return String(s).replace(ANY_UUID_G, '<uuid>').replace(ISO_G, '<datetime>');
}

async function cmdDiffUi(p, args) {
  if (typeof args.flags.a !== 'string' || typeof args.flags.b !== 'string') fail('diff-ui requires --a <observations A.jsonl> --b <observations B.jsonl>');
  const A = readObservations(path.resolve(args.flags.a));
  const B = readObservations(path.resolve(args.flags.b));
  const startedAt = new Date().toISOString();
  const divergences = [];
  for (const [file, dupes] of [['A', A.dupes], ['B', B.dupes]]) for (const n of dupes) divergences.push({ case: n, where: 'name', reason: `observation name recorded twice in ${file}; names must be unique` });
  const names = [...new Set([...A.byName.keys(), ...B.byName.keys()])].sort();
  for (const n of names) {
    const a = A.byName.get(n);
    const b = B.byName.get(n);
    if (!a || !b) { divergences.push({ case: n, where: 'presence', reason: `observed only in ${a ? 'A' : 'B'}` }); continue; }
    if (normalizeUiText(a.path) !== normalizeUiText(b.path)) divergences.push({ case: n, where: 'path', reason: 'URL path differs', a: a.path, b: b.path });
    if (JSON.stringify(a.testids) !== JSON.stringify(b.testids)) divergences.push({ case: n, where: 'testids', reason: 'data-testid sequence differs', a: a.testids, b: b.testids });
    const la = normalizeUiText(a.aria).split('\n');
    const lb = normalizeUiText(b.aria).split('\n');
    const i = la.findIndex((l, k) => l !== lb[k]);
    if (i >= 0 || la.length !== lb.length) {
      const k = i >= 0 ? i : Math.min(la.length, lb.length);
      divergences.push({ case: n, where: 'aria', reason: `ARIA snapshot differs at line ${k + 1}`, a: la[k], b: lb[k] });
    }
  }
  const divergent = new Set(divergences.map(d => d.case));
  for (const d of divergences) console.log(`≠ ${d.case} ${d.where}: ${d.reason}${'a' in d ? `; A=${short(d.a)} B=${short(d.b)}` : ''}`);
  const report = {
    tool: 'sdd-oracle',
    toolVersion: L.TOOL_VERSION,
    mode: 'diff-ui',
    a: args.flags.a,
    b: args.flags.b,
    ...lockInfo(p),
    ...bLockInfo(args),
    filtered: false,
    startedAt,
    finishedAt: new Date().toISOString(),
    totalCases: names.length,
    divergentCases: divergent.size,
    errored: 0,
    divergences,
  };
  const out = path.join(p.oracleLogs, 'uidiff-a-b.json');
  L.writeJson(out, report);
  console.log(`\n${names.length} UI observation(s): ${divergent.size} divergent → ${L.rel(p.root, out)}`);
  return divergent.size ? 1 : 0;
}

// ========== env ==========

function cmdEnv(p) {
  const { cfg } = L.loadOracleConfig(p);
  const env = L.interpolateEnv(cfg.buildEnv || {}, process.env);
  for (const [k, v] of Object.entries(env)) console.log(`export ${k}='${String(v).replace(/'/g, `'\\''`)}'`);
  if (!Object.keys(env).length) console.error('# oracle.config.json declares no buildEnv');
  return 0;
}

// ========== gen-probes ==========

function cmdGenProbes(p, args) {
  const manifest = L.readJson(p.manifest);
  if (!manifest.artifacts || !manifest.artifacts.openapi) fail('gen-probes needs an openapi artifact in specs/contracts/manifest.json');
  const { doc, ops } = L.loadOpenApi(path.join(p.contracts, manifest.artifacts.openapi), p.root);
  const cases = generateProbes(doc, ops);
  const out = typeof args.flags.out === 'string' ? path.resolve(args.flags.out) : path.join(p.cases, 'generated-probes.json');
  L.writeJson(out, {
    suite: 'generated',
    description: 'Generated by `oracle.cjs gen-probes` from the OpenAPI contract. Do not edit by hand; regenerate after contract changes. Probes run only in `oracle diff`. To assert one, copy it into a hand-written suite under a new id with derivedFrom citations.',
    cases,
  });
  console.log(`${cases.length} probe(s) for ${ops.length} operation(s) → ${L.rel(p.root, out)}`);
  if (L.verifyLock(p.root).exists) console.log('note: this changes the frozen set; re-freeze with user approval (Class 1 iteration or SCR).');
  return 0;
}

// ========== diff-expect ==========

function isUnspecified(v) {
  return L.isPlainObject(v) && Object.prototype.hasOwnProperty.call(v, '$unspecified');
}

/** Canonical form for comparing predictions: {"$eq": x} is just x; header names are case-insensitive. */
function normalizePrediction(v, key) {
  if (L.isMatcher(v) && Object.keys(v).length === 1 && '$eq' in v) return normalizePrediction(v.$eq);
  if (Array.isArray(v)) return v.map(x => normalizePrediction(x));
  if (L.isPlainObject(v) && !L.isMatcher(v) && !isUnspecified(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[key === 'headers' ? k.toLowerCase() : k] = normalizePrediction(x, k);
    return o;
  }
  return v;
}

/** One http expectation vs another: headers compare on the names both authors assert (asserting fewer is not a disagreement). */
function compareHttpExpect(a, b, at, gaps) {
  const mode = a.bodyMatch === 'subset' || b.bodyMatch === 'subset' ? 'subset' : 'exact';
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (k === 'bodyMatch') continue;
    const ina = Object.prototype.hasOwnProperty.call(a, k);
    const inb = Object.prototype.hasOwnProperty.call(b, k);
    if (k === 'headers') {
      const ha = a.headers || {};
      const hb = b.headers || {};
      for (const h of Object.keys(ha)) if (Object.prototype.hasOwnProperty.call(hb, h)) compareExpect(ha[h], hb[h], `${at}.headers.${h}`, gaps);
      continue;
    }
    if (!ina || !inb) { gaps.push({ path: `${at}.${k}`, reason: `only ${ina ? 'A' : 'B'} expects ${k}`, a: a[k], b: b[k] }); continue; }
    compareExpect(a[k], b[k], `${at}.${k}`, gaps, mode);
  }
}

/** Concurrent responses are a multiset: use the pairing with the fewest gaps. */
function compareResponses(ra, rb, at, gaps) {
  if (!Array.isArray(ra) || !Array.isArray(rb) || ra.length !== rb.length) { gaps.push({ path: at, reason: 'different numbers of concurrent responses', a: ra, b: rb }); return; }
  let best = null;
  const used = new Array(rb.length).fill(false);
  const pick = (i, acc) => {
    if (best && acc.length >= best.length) return;
    if (i === ra.length) { best = acc; return; }
    for (let j = 0; j < rb.length; j++) {
      if (used[j]) continue;
      const g = [];
      compareHttpExpect(ra[i], rb[j], `${at}[${i}]`, g);
      used[j] = true;
      pick(i + 1, acc.concat(g));
      used[j] = false;
    }
  };
  pick(0, []);
  gaps.push(...best);
}

/** Compare two independently written expectations. Any disagreement is a gap in the spec. */
function compareExpect(a, b, at, gaps, mode = 'exact') {
  if (isUnspecified(a) || isUnspecified(b)) {
    gaps.push({ path: at, reason: 'UNSPECIFIED: the spec does not determine this value', a: isUnspecified(a) ? a.$unspecified : a, b: isUnspecified(b) ? b.$unspecified : b });
    return;
  }
  if (L.isMatcher(a) || L.isMatcher(b)) {
    if (L.deepEqual(a, b)) return;
    const va = L.isVariableMatcher(a);
    const vb = L.isVariableMatcher(b);
    const reason = va !== vb
      ? `${va ? 'A' : 'B'} declares a degree of freedom that ${va ? 'B' : 'A'} pins to a value`
      : 'the two authors declare different freedoms';
    gaps.push({ path: at, reason, a, b });
    return;
  }
  const ta = L.jsonType(a);
  const tb = L.jsonType(b);
  if (ta !== tb) { gaps.push({ path: at, reason: `different types (${ta} vs ${tb})`, a, b }); return; }
  if (ta === 'array') {
    if (a.length !== b.length) { gaps.push({ path: at, reason: `different lengths (${a.length} vs ${b.length})`, a, b }); return; }
    a.forEach((x, i) => compareExpect(x, b[i], `${at}[${i}]`, gaps));
    return;
  }
  if (ta === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const ina = Object.prototype.hasOwnProperty.call(a, k);
      const inb = Object.prototype.hasOwnProperty.call(b, k);
      if (!ina || !inb) { if (mode === 'exact') gaps.push({ path: `${at}.${k}`, reason: `only ${ina ? 'A' : 'B'} expects this`, a: a[k], b: b[k] }); }
      else compareExpect(a[k], b[k], `${at}.${k}`, gaps, mode);
    }
    return;
  }
  if (a !== b) gaps.push({ path: at, reason: 'different values', a, b });
}

function loadCaseSet(p, target) {
  const abs = path.resolve(target);
  const dir = fs.statSync(abs).isDirectory() ? abs : path.dirname(abs);
  const loaded = L.loadCases({ ...p, cases: dir });
  const cases = fs.statSync(abs).isDirectory() ? loaded.cases : loaded.cases.filter(c => path.resolve(p.root, c.file) === abs);
  if (loaded.errors.length) fail(`Invalid case files in ${target}:\n  ${loaded.errors.join('\n  ')}`);
  return { cases, hash: L.hashTree(abs) };
}

function cmdDiffExpect(p, args) {
  if (typeof args.flags.a !== 'string' || typeof args.flags.b !== 'string') fail('diff-expect requires --a <dir|file> --b <dir|file>');
  const A = loadCaseSet(p, args.flags.a);
  const B = loadCaseSet(p, args.flags.b);
  const byA = new Map(A.cases.map(c => [c.id, c]));
  const byB = new Map(B.cases.map(c => [c.id, c]));
  const gaps = [];
  const ids = [...new Set([...byA.keys(), ...byB.keys()])].sort();
  let compared = 0;
  for (const id of ids) {
    const a = byA.get(id);
    const b = byB.get(id);
    if (!a || !b) {
      if ((a || b).probe && !(a || b).steps.some(s => s.expect)) continue; // probe without expectations on one side only
      gaps.push({ case: id, path: '', reason: `case only in ${a ? 'A' : 'B'}` });
      continue;
    }
    if (!a.steps.some(s => s.expect) && !b.steps.some(s => s.expect)) continue;
    compared++;
    for (const [side, c] of [['A', a], ['B', b]]) {
      if (!(c.derivedFrom || []).length) gaps.push({ case: id, path: '', reason: `${side} cites no source (derivedFrom): an uncited prediction is a guess even if both agree` });
    }
    if (a.steps.length !== b.steps.length) { gaps.push({ case: id, path: 'steps', reason: `different step counts (${a.steps.length} vs ${b.steps.length})` }); continue; }
    a.steps.forEach((sa, i) => {
      const sb = b.steps[i];
      const reqA = { http: sa.http, query: sa.query, run: sa.run, parallel: sa.parallel, capture: sa.capture };
      const reqB = { http: sb.http, query: sb.query, run: sb.run, parallel: sb.parallel, capture: sb.capture };
      if (!L.deepEqual(JSON.parse(JSON.stringify(reqA)), JSON.parse(JSON.stringify(reqB)))) {
        gaps.push({ case: id, path: `steps[${i}]`, reason: 'requests differ: both authors must predict the SAME requests' });
        return;
      }
      if (!sa.expect && !sb.expect) return;
      const g = [];
      const ea = sa.expect ? normalizePrediction(sa.expect) : null;
      const eb = sb.expect ? normalizePrediction(sb.expect) : null;
      const at = `steps[${i}].expect`;
      if (!ea || !eb) g.push({ path: at, reason: `only ${ea ? 'A' : 'B'} has expectations for this step` });
      else if (sa.parallel) compareResponses(ea.responses, eb.responses, `${at}.responses`, g);
      else if (sa.http) compareHttpExpect(ea, eb, at, g);
      else compareExpect(ea, eb, at, g, ea.bodyMatch === 'subset' || eb.bodyMatch === 'subset' ? 'subset' : 'exact');
      for (const x of g) gaps.push({ case: id, ...x });
    });
  }
  const divergent = new Set(gaps.map(g => g.case));
  for (const g of gaps) console.log(`≠ ${g.case} ${g.path}: ${g.reason}${'a' in g || 'b' in g ? `; A=${short(g.a)} B=${short(g.b)}` : ''}`);
  const fixturesHash = fs.existsSync(p.cases) ? L.hashTree(p.cases) : null;
  const label = typeof args.flags.label === 'string' ? args.flags.label : 'latest';
  const report = {
    tool: 'sdd-oracle',
    toolVersion: L.TOOL_VERSION,
    mode: 'diff-expect',
    label,
    a: args.flags.a,
    b: args.flags.b,
    aHash: A.hash,
    bHash: B.hash,
    identical: A.hash === B.hash,
    fixturesHash,
    aIsFixtures: A.hash === fixturesHash,
    finishedAt: new Date().toISOString(),
    totalCases: compared,
    divergentCases: divergent.size,
    gaps,
  };
  const out = path.join(p.oracleLogs, `expectdiff-${label}.json`);
  L.writeJson(out, report);
  console.log(`\n${compared} case(s) compared: ${divergent.size} with gaps, ${gaps.length} gap(s) → ${L.rel(p.root, out)}`);
  if (gaps.length) console.log('Resolve every gap in the SPEC (Stage 02 before freeze, Stage 00 after) — never by picking one author\'s answer.');
  if (A.hash === B.hash) console.log('⚠ A and B are byte-identical: this is not an independent prediction and will not satisfy the stage gates.');
  return gaps.length ? 1 : 0;
}

// ========== strip-expect ==========

function cmdStripExpect(p, args) {
  if (typeof args.flags.from !== 'string' || typeof args.flags.out !== 'string') fail('strip-expect requires --from <dir|file> --out <dir>');
  const src = path.resolve(args.flags.from);
  const outDir = path.resolve(args.flags.out);
  const files = fs.statSync(src).isDirectory() ? L.listFiles(src).filter(f => f.endsWith('.json')) : [src];
  let n = 0;
  for (const f of files) {
    const data = L.readJson(f);
    const cases = (data.cases || []).filter(c => !c.probe).map(c => {
      const steps = c.steps.map(({ expect, note, ...rest }) => rest);
      const reqs = steps.map(st => (st.http ? `${st.http.method} ${st.http.path}` : st.parallel ? `${st.parallel.length} concurrent requests` : st.query ? 'query' : 'run'));
      n++;
      // Neutral title: the original often states the expected outcome.
      return { id: c.id, title: `Predict: ${reqs.join(' → ')}`, ...(c.phase !== undefined ? { phase: c.phase } : {}), ...(c.setup ? { setup: c.setup } : {}), steps };
    });
    if (!cases.length) continue;
    L.writeJson(path.join(outDir, path.relative(fs.statSync(src).isDirectory() ? src : path.dirname(src), f)), { suite: data.suite, description: 'Request-only skeleton for an independent prediction: add "expect" to every step and "derivedFrom" citations to every case, using only SPEC.md, specs/contracts/ and the Equivalence Profile. Write {"$unspecified": "<what is missing>"} where those files do not determine a value.', cases });
  }
  console.log(`${n} request-only case(s) → ${L.rel(p.root, outDir)}`);
  return 0;
}

// ========== record ==========

const ANY_UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

function generalize(value, vars) {
  if (typeof value === 'string') {
    for (const [k, v] of Object.entries(vars)) if (typeof v === 'string' && v === value) return `{{${k}}}`;
    if (L.TYPE_PATTERNS.uuidv7.test(value)) return { $type: 'uuidv7' };
    if (L.TYPE_PATTERNS.uuid.test(value)) return { $type: 'uuid' };
    if (L.TYPE_PATTERNS.datetime.test(value)) return { $type: 'datetime' };
    if (L.TYPE_PATTERNS.rfc3339.test(value)) return { $type: 'rfc3339' };
    let s = value;
    for (const [k, v] of Object.entries(vars)) if (typeof v === 'string' && v.length >= 4) s = s.split(v).join(`\u0000${k}\u0000`);
    if (s !== value || ANY_UUID.test(s)) {
      const parts = s.split(/(\u0000[^\u0000]+\u0000)/).map(part => {
        if (part.startsWith('\u0000')) return `{{${part.slice(1, -1)}}}`;
        return part.split(new RegExp(ANY_UUID.source, 'g')).map(L.escapeRegex).join('[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}');
      });
      // Captured variables stay {{templates}} inside the regex; they are rendered before matching.
      return { $regex: `^${parts.join('')}$` };
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(v => generalize(v, vars));
  if (L.isPlainObject(value)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = generalize(v, vars);
    return o;
  }
  return value;
}

function synthesizeExpect(s) {
  if (s.kind === 'http') {
    const headers = {};
    for (const h of RECORDED_HEADERS) if (s.obs.headers[h] !== undefined) headers[h] = generalize(s.obs.headers[h], s.before);
    const e = { status: s.obs.status };
    if (Object.keys(headers).length) e.headers = headers;
    if (s.obs.body !== null) e.body = generalize(s.obs.body, s.before);
    return e;
  }
  if (s.kind === 'query') return { rows: generalize(s.obs.rows, s.before) };
  const e = { exitCode: s.obs.exitCode };
  if (s.obs.stdoutJson !== undefined) e.stdoutJson = generalize(s.obs.stdoutJson, s.before);
  else e.stdout = generalize(s.obs.stdout, s.before);
  return e;
}

async function cmdRecord(p, args) {
  if (typeof args.flags.target !== 'string' || typeof args.flags.out !== 'string') fail('record requires --target <name> and --out <file>');
  const outFile = path.resolve(args.flags.out);
  if (outFile.startsWith(path.resolve(p.fixtures) + path.sep)) fail('record never writes into specs/fixtures/ (frozen); write elsewhere, review, then move the cases in before freezing');
  const { cfg, cases } = loadProject(p, typeof args.flags['cases-dir'] === 'string' ? args.flags['cases-dir'] : null);
  const { selected } = selectCases(cases, args.flags, { includeProbes: true });
  const target = resolveTarget(cfg, args.flags.target);
  refuseImplicitTarget(cfg, target, selected);
  await waitReady(cfg, target);
  const stamp = new Date().toISOString();
  const recorded = [];
  for (const c of selected) {
    const r = await runCase(p, cfg, target, c, 'observe', L.newGenerator());
    if (r.status === 'error') { console.log(`! ${c.id}: ${r.error} (skipped)`); continue; }
    const { probe, file, suite, ...rest } = c;
    const steps = c.steps.map((step, i) => (step.expect ? step : { ...step, expect: synthesizeExpect(r.steps[i]) }));
    recorded.push({
      ...rest,
      phase: c.phase || 1,
      derivedFrom: [...(c.derivedFrom || []), `recorded:${target.name}@${stamp}`],
      steps,
    });
    console.log(`● ${c.id} recorded (${c.steps.filter(s => !s.expect).length} expectation(s) filled)`);
  }
  L.writeJson(outFile, { suite: 'recorded', description: `Characterization of target "${target.name}" at ${stamp}. Review every expectation: recorded behavior includes existing bugs.`, cases: recorded });
  console.log(`\nWrote ${recorded.length} case(s) → ${outFile}`);
  return 0;
}

// ========== ui ==========

const UI_CONFIG = 'specs/fixtures/ui/playwright.config.ts';
// Playwright's own output (traces, screenshots, .last-run.json) defaults to a folder beside the config, inside the
// frozen set, where it would break the lock (#29). It goes to a working path instead, unless the caller sets --output.
const UI_ARTIFACTS = 'specs/logs/ui-artifacts';

/**
 * How to start Playwright: its CLI through this Node when the project has it installed (no shell, so arguments such as
 * --grep "@keyboard|@focus" pass unchanged on every platform), otherwise npx where that needs no shell.
 */
function playwrightCommand(root) {
  for (const id of ['@playwright/test/cli', 'playwright/cli']) {
    try { return [process.execPath, [require.resolve(id, { paths: [root] })]]; } catch { /* not installed here */ }
  }
  if (process.platform === 'win32') return null;
  return ['npx', ['playwright']];
}

/**
 * Run the frozen Playwright suite and stamp its report beside it (evidence.cjs), so the UI gates can tell which
 * code it graded. Arguments other than --out and --root go to Playwright unchanged (spec files, --grep, --repeat-each).
 */
async function cmdUi(p) {
  const raw = process.argv.slice(2);
  raw.splice(raw.indexOf('ui'), 1);
  const pass = [];
  let out = 'specs/logs/ui-e2e.json';
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--out') { out = raw[++i]; continue; }
    if (a === '--root') { i++; continue; }
    if (a.startsWith('--out=')) { out = a.slice(6); continue; }
    if (a.startsWith('--root=')) continue;
    pass.push(a);
  }
  if (!/^specs\/logs\/[^/]+\.json$/.test(out || '')) fail('--out must be a .json file directly under specs/logs/');
  if (!fs.existsSync(path.join(p.root, UI_CONFIG))) fail(`no ${UI_CONFIG}: the frozen UI suite is written before the freeze`);
  const outAbs = path.join(p.root, out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  // A run that dies must not leave an older report or stamp behind to be read as this run's.
  for (const f of [outAbs, path.join(p.root, E.stampPath(out))]) fs.rmSync(f, { force: true });
  const pw = playwrightCommand(p.root);
  if (!pw) fail('Playwright is not installed in this project (npm i -D @playwright/test); on Windows oracle.cjs ui runs only the project\'s own copy');
  if (!pass.some(a => a === '--output' || a.startsWith('--output='))) pass.push(`--output=${UI_ARTIFACTS}`);
  // The UI suite's base URL (ORACLE_UI_URL) is the app being graded: ask it which build it is (HTTP-6 X-SDD-Build).
  const uiUrl = process.env.ORACLE_UI_URL;
  const start = E.stamp(p.root, { build: uiUrl ? await buildId({}, { baseUrl: uiUrl.replace(/\/+$/, '') }) : null });
  const r = spawnSync(pw[0], [...pw[1], 'test', '--config', UI_CONFIG, '--reporter=line,json', ...pass], { cwd: p.root, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_FILE: out } });
  if (r.error) fail(`could not start Playwright (${r.error.message})`);
  if (!fs.existsSync(outAbs)) fail(`Playwright wrote no ${out} (exit ${r.status}); nothing to stamp`);
  E.writeUiStamp(p.root, out, E.seal(p.root, start));
  console.log(`\n→ ${out}, stamped in ${E.stampPath(out)}`);
  return r.status === null ? 2 : r.status;
}

// ========== main ==========

async function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const root = typeof args.flags.root === 'string' ? path.resolve(args.flags.root) : L.defaultRoot();
  const p = L.projectPaths(root);
  const commands = { run: cmdRun, ui: cmdUi, diff: cmdDiff, record: cmdRecord, 'diff-ui': cmdDiffUi, env: cmdEnv, 'gen-probes': cmdGenProbes, 'diff-expect': cmdDiffExpect, 'strip-expect': cmdStripExpect };
  const cmd = commands[args._[0]];
  if (!cmd) { console.log(USAGE); return args._[0] ? 2 : 0; }
  return cmd(p, args);
}

// Exit quietly when stdout is closed early (e.g. piped into `head`).
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(process.exitCode || 0); throw e; });

main().then(code => { process.exitCode = code; }, e => { console.error(e.stack || e.message); process.exitCode = 2; });
