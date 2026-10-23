#!/usr/bin/env node
'use strict';
/**
 * sdd.cjs — SDD pipeline gatekeeper. Zero dependencies (Node.js >= 18).
 *
 *   node specs/.sdd/scripts/sdd.cjs status
 *   node specs/.sdd/scripts/sdd.cjs check [--contracts]
 *   node specs/.sdd/scripts/sdd.cjs freeze --reason "<why>" --approved-by "<who>" --claim <grader-ready|two-build>
 *   node specs/.sdd/scripts/sdd.cjs verify
 *   node specs/.sdd/scripts/sdd.cjs phase --completed <N>
 *   node specs/.sdd/scripts/sdd.cjs transition --completed <stage> [--resume <stage>] [--project-type <t>] [--note "<text>"] [--tokens orchestrator=N,subagents=M]
 *   node specs/.sdd/scripts/sdd.cjs token-audit --stage <03|06>
 *   node specs/.sdd/scripts/sdd.cjs export <dir>
 *
 * Global flag: --root <project-dir> (default: three levels above this script).
 */
const fs = require('fs');
const path = require('path');
const L = require('./sdd-lib.cjs');
const E = require('./evidence.cjs');

const USAGE = `Usage:
  sdd.cjs status                         Current stage, lock, evidence, and the next stage's exit gates
  sdd.cjs check [--contracts]            Validate contracts (+ fixtures, coverage, phases unless --contracts)
  sdd.cjs freeze --reason R --approved-by U --claim grader-ready|two-build
                                         Lock the frozen set (refused unless check passes, the claim
                                         matches manifest.equivalenceTarget, and no Proposed SCR is left)
  sdd.cjs verify                         Exit 1 if any frozen file changed since the last freeze
  sdd.cjs phase --completed N            Stage 05 phase gate: green cumulative oracle run at a clean,
                                         committed HEAD on the current lock, earlier phases gated,
                                         no open SCR. Records specs/logs/phases.jsonl
  sdd.cjs transition --completed S [--resume S] [--project-type T] [--note N] [--override DECnnn]
                     [--tokens orchestrator=N,subagents=M]
                                         Record a completed stage; refused unless it is the next stage
                                         (or --override cites a DECISION_LOG entry) and its exit gates pass.
                                         Appends a row to specs/logs/scoreboard.md (token counts in tokens)
  sdd.cjs token-audit --stage 03|06      Print the token-audit table (one row per DESIGN token) to fill in
  sdd.cjs export <dir> [--update]        Copy only the frozen set into <dir> for an independent build
                                         (--update resyncs an existing build-B workspace after a re-freeze)
Stages: 00 01 01b 02 03 04 05 06 07`;

// ========== Reporting ==========

class Report {
  constructor() { this.errors = []; this.warnings = []; this.notes = []; }
  error(m) { this.errors.push(m); }
  warn(m) { this.warnings.push(m); }
  note(m) { this.notes.push(m); }
  print(title) {
    console.log(`\n${title}`);
    for (const n of this.notes) console.log(`  · ${n}`);
    for (const w of this.warnings) console.log(`  ⚠ ${w}`);
    for (const e of this.errors) console.log(`  ✗ ${e}`);
    console.log(this.errors.length
      ? `  → FAIL: ${this.errors.length} error(s), ${this.warnings.length} warning(s)`
      : `  → PASS (${this.warnings.length} warning(s))`);
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(2);
}

function exists(f) { return fs.existsSync(f); }
function readText(f) { return exists(f) ? fs.readFileSync(f, 'utf8') : ''; }

// ========== Contracts ==========

function checkContracts(p, r) {
  const ctx = { ops: [], errorCodes: new Map(), machines: [], transitions: new Map(), commands: [], manifest: null, typeDef: null, matrix: null };
  let matrix;
  try { matrix = L.readJson(p.matrix); } catch (e) { r.error(e.message); return ctx; }
  ctx.matrix = matrix;

  if (!exists(p.spec)) r.error('missing specs/SPEC.md');
  if (!exists(p.manifest)) { r.error('missing specs/contracts/manifest.json (Stage 02 output)'); return ctx; }
  let manifest;
  try { manifest = L.readJson(p.manifest); } catch (e) { r.error(e.message); return ctx; }
  const merrs = L.validateSchema(L.loadSchema(p, 'contract-manifest.schema.json'), manifest);
  if (merrs.length) { merrs.forEach(e => r.error(`specs/contracts/manifest.json: ${e}`)); return ctx; }
  ctx.manifest = manifest;
  const typeDef = matrix.types[manifest.projectType];
  ctx.typeDef = typeDef;
  r.note(`project type: ${manifest.projectType}; interfaces: ${manifest.interfaces.join(', ')}; equivalence target: L${manifest.equivalenceTarget}`);

  for (const i of typeDef.defaultInterfaces) {
    if (!manifest.interfaces.includes(i)) r.warn(`manifest.interfaces omits "${i}" (default for ${manifest.projectType}); justify in SPEC.md §Equivalence Boundary`);
  }
  const na = manifest.notApplicable || {};
  for (const key of typeDef.required) {
    if (!manifest.artifacts[key]) r.error(`artifact "${key}" is required for ${manifest.projectType}; declare it in manifest.artifacts`);
    if (na[key]) r.error(`artifact "${key}" is required for ${manifest.projectType} and cannot be notApplicable`);
  }
  for (const key of typeDef.conditional) {
    if (!manifest.artifacts[key] && !na[key]) r.error(`conditional artifact "${key}" must be provided or justified in manifest.notApplicable`);
  }
  for (const key of Object.keys(na)) {
    if (manifest.artifacts[key]) r.error(`artifact "${key}" is both provided and marked notApplicable`);
  }
  if (manifest.interfaces.includes('http') && !manifest.artifacts.openapi) r.error('interface "http" requires the openapi artifact');
  if (manifest.interfaces.includes('cli') && !manifest.artifacts.cli) r.error('interface "cli" requires the cli artifact (cli.json)');
  if (typeDef.ui && !exists(p.design)) r.error(`${manifest.projectType} is a UI project: specs/DESIGN.md is required`);

  const order = ['openapi', 'errors', 'cli', 'statecharts', 'schema', 'storage', 'levels', 'api'];
  for (const key of order) {
    const file = manifest.artifacts[key];
    if (!file) continue;
    const fp = path.join(p.contracts, file);
    const label = `specs/contracts/${file}`;
    if (!exists(fp)) { r.error(`manifest lists ${key} → ${label}, but the file does not exist`); continue; }
    if (fs.statSync(fp).size === 0) { r.error(`${label} is empty`); continue; }
    try {
      CONTRACT_CHECKS[matrix.artifacts[key].kind](fp, label, p, ctx, r);
    } catch (e) {
      r.error(`${label}: ${e.message}`);
    }
  }

  const overrides = manifest.profileOverrides || [];
  const decisionLog = readText(p.decisionLog);
  const cites = id => !!decisionLog && new RegExp(`\\b${id}\\b`).test(decisionLog);
  for (const o of overrides) {
    if (!cites(o.decision)) r.error(`profile override ${o.rule} cites ${o.decision}, which is not in specs/DECISION_LOG.md`);
  }
  if (manifest.equivalenceTarget === 1) {
    const d = manifest.equivalenceTargetDecision;
    if (!d || !cites(d)) r.error('equivalenceTarget 1 requires manifest.equivalenceTargetDecision citing a DECnnn entry in specs/DECISION_LOG.md');
  }
  if (overrides.length) r.note(`${overrides.length} documented profile override(s)`);
  return ctx;
}

const CONTRACT_CHECKS = {
  openapi(fp, label, p, ctx, r) {
    const { doc, ops, parser } = L.loadOpenApi(fp, p.root);
    ctx.doc = doc;
    if (!ops.length) { r.error(`${label}: no operations found under paths`); return; }
    const seen = new Map();
    for (const op of ops) {
      const where = `${label}: ${op.method} ${op.path}`;
      if (!op.operationId) { r.error(`${where} has no operationId (profile HTTP-8)`); continue; }
      if (!/^[a-z][A-Za-z0-9]*$/.test(op.operationId)) r.warn(`${where}: operationId "${op.operationId}" is not lowerCamelCase (profile HTTP-8)`);
      if (seen.has(op.operationId)) r.error(`${label}: duplicate operationId "${op.operationId}"`);
      seen.set(op.operationId, op);
      if (!op.statuses.length) r.error(`${where} declares no responses`);
      if (op.statuses.includes('default')) r.warn(`${where} uses a "default" response; enumerate every status explicitly`);
    }
    ctx.ops = ops.filter(o => o.operationId);
    r.note(`openapi: ${ops.length} operation(s) (parser: ${parser})`);
  },

  errors(fp, label, p, ctx, r) {
    const data = L.readJson(fp);
    const errs = L.validateSchema(L.loadSchema(p, 'errors.schema.json'), data);
    if (errs.length) { errs.forEach(e => r.error(`${label}: ${e}`)); return; }
    const canonical = L.readJson(path.join(p.config, 'canonical-errors.json')).codes;
    const interfaces = ctx.manifest.interfaces;
    for (const e of data.errors) {
      if (ctx.errorCodes.has(e.code)) r.error(`${label}: duplicate code ${e.code}`);
      ctx.errorCodes.set(e.code, e);
      const c = canonical[e.code];
      if (c && e.status !== undefined && (c.status !== e.status || c.retryable !== e.retryable)) {
        r.error(`${label}: ${e.code} must be status ${c.status}, retryable ${c.retryable} (profile ${c.rule})`);
      }
      if (interfaces.includes('cli') && e.exitCode === undefined) r.error(`${label}: ${e.code} needs an exitCode (interface cli, profile CLI-1)`);
    }
    if (data.errors.some(e => e.status !== undefined) && !data.typeBaseUri) r.error(`${label}: typeBaseUri is required when errors carry HTTP statuses (profile ERR-1)`);
    if (interfaces.includes('http')) {
      for (const [code, c] of Object.entries(canonical)) {
        if (c.mandatory && !ctx.errorCodes.has(code)) r.error(`${label}: missing mandatory http error ${code} (${c.status}, profile ${c.rule})`);
      }
    }
    r.note(`errors: ${data.errors.length} code(s)`);
  },

  statecharts(fp, label, p, ctx, r) {
    const data = L.readJson(fp);
    const errs = L.validateSchema(L.loadSchema(p, 'statecharts.schema.json'), data);
    if (errs.length) { errs.forEach(e => r.error(`${label}: ${e}`)); return; }
    const opIds = new Set(ctx.ops.map(o => o.operationId));
    const machineIds = new Set();
    for (const m of data.machines) {
      const where = `${label}: machine ${m.id}`;
      if (machineIds.has(m.id)) r.error(`${label}: duplicate machine id ${m.id}`);
      machineIds.add(m.id);
      const states = new Map();
      for (const s of m.states) {
        if (states.has(s.id)) r.error(`${where}: duplicate state ${s.id}`);
        states.set(s.id, s);
      }
      if (!states.has(m.initial)) r.error(`${where}: initial state "${m.initial}" is not declared`);
      const outgoing = new Map([...states.keys()].map(k => [k, []]));
      const byFromEvent = new Map();
      for (const t of m.transitions) {
        const tw = `${where}: transition ${t.id}`;
        if (!t.id.startsWith(`${m.id}.`)) r.error(`${tw}: id must start with "${m.id}."`);
        if (ctx.transitions.has(t.id)) r.error(`${tw}: duplicate transition id`);
        ctx.transitions.set(t.id, { ...t, machine: m.id });
        if (!states.has(t.from)) r.error(`${tw}: from "${t.from}" is not a declared state`);
        if (!states.has(t.to)) r.error(`${tw}: to "${t.to}" is not a declared state`);
        if (states.get(t.from)?.terminal) r.error(`${tw}: leaves terminal state "${t.from}"`);
        if (outgoing.has(t.from)) outgoing.get(t.from).push(t.to);
        const fe = `${t.from}|${t.event}`;
        if (!byFromEvent.has(fe)) byFromEvent.set(fe, []);
        byFromEvent.get(fe).push(t);
        if (t.guardFailureError && ctx.errorCodes.size && !ctx.errorCodes.has(t.guardFailureError)) {
          r.error(`${tw}: guardFailureError ${t.guardFailureError} is not in errors.json`);
        }
        if (t.operationId && opIds.size && !opIds.has(t.operationId)) r.error(`${tw}: operationId ${t.operationId} is not in openapi`);
      }
      for (const [fe, ts] of byFromEvent) {
        if (ts.length > 1 && ts.some(t => !t.guard)) {
          r.error(`${where}: event ${fe.split('|')[1]} from ${fe.split('|')[0]} has ${ts.length} transitions and not all are guarded (nondeterministic)`);
        }
      }
      for (const [id, s] of states) {
        if (!s.terminal && !outgoing.get(id).length) r.error(`${where}: non-terminal state "${id}" has no outgoing transition (dangling state)`);
        if (s.terminal && !s.retention) r.warn(`${where}: terminal state "${id}" declares no retention policy (extraction-closure §1)`);
      }
      const seen = new Set([m.initial]);
      const queue = [m.initial];
      while (queue.length) for (const n of outgoing.get(queue.shift()) || []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
      for (const id of states.keys()) if (!seen.has(id)) r.error(`${where}: state "${id}" is unreachable from "${m.initial}"`);
      if (ctx.errorCodes.size && !ctx.errorCodes.has(m.illegalTransitionError)) {
        r.error(`${where}: illegalTransitionError ${m.illegalTransitionError} is not in errors.json`);
      }
      ctx.machines.push(m);
    }
    r.note(`statecharts: ${data.machines.length} machine(s), ${ctx.transitions.size} transition(s)`);
  },

  ddl(fp, label, p, ctx, r) {
    const text = fs.readFileSync(fp, 'utf8');
    if (fp.endsWith('.sql') && !/create\s+table/i.test(text)) r.error(`${label}: no CREATE TABLE statement`);
    if (fp.endsWith('.prisma') && !/\bmodel\s+\w+/.test(text)) r.error(`${label}: no model declaration`);
  },

  'json-schema'(fp, label, p, ctx, r) {
    const data = L.readJson(fp);
    if (!data.$schema && !data.type) r.warn(`${label}: declare "$schema" (JSON Schema 2020-12) and a root "type"`);
  },

  cli(fp, label, p, ctx, r) {
    const data = L.readJson(fp);
    const errs = L.validateSchema(L.loadSchema(p, 'cli.schema.json'), data);
    if (errs.length) { errs.forEach(e => r.error(`${label}: ${e}`)); return; }
    const names = new Set();
    for (const c of data.commands) {
      if (names.has(c.name)) r.error(`${label}: duplicate command "${c.name}"`);
      names.add(c.name);
      for (const x of c.exitCodes) {
        if (x.error && ctx.errorCodes.size && !ctx.errorCodes.has(x.error)) r.error(`${label}: ${c.name} exit ${x.code} cites ${x.error}, which is not in errors.json`);
      }
    }
    ctx.commands = data.commands;
    r.note(`cli: ${data.commands.length} command(s)`);
  },

  json(fp) { L.readJson(fp); },

  text() {},
};

// ========== Fixtures & coverage ==========

const { flatten: flattenSchema } = require('./probes.cjs');

const EXPECT_KEYS = {
  parallel: ['responses'],
  http: ['status', 'headers', 'body', 'bodyMatch'],
  query: ['rows', 'bodyMatch'],
  run: ['exitCode', 'stdout', 'stdoutJson', 'stderr', 'bodyMatch'],
};

const KEY_REUSE_TAG = 'idempotency-key-reuse';

/** The name of a `{{$uuid:name}}` Idempotency-Key header on a request, if any. */
function idempotencyKeyName(h) {
  const headers = L.isPlainObject(h && h.headers) ? h.headers : {};
  const k = Object.keys(headers).find(x => x.toLowerCase() === 'idempotency-key');
  const m = k && typeof headers[k] === 'string' && headers[k].match(/\{\{\s*\$uuid:([^\s{}]+)\s*\}\}/);
  return m ? m[1] : null;
}

// RFC 2606 / RFC 6761 / RFC 8375 names that can never reach a real mailbox.
const RESERVED_MAIL = /(^|\.)(example\.(com|net|org)|example|test|invalid|localhost|local|internal|home\.arpa)$/i;
// RFC 2142 role mailboxes and machine identities are not a person.
const ROLE_MAILBOX = /^(no-?reply|do-?not-?reply|postmaster|hostmaster|webmaster|abuse|security|support|info|admin|git|mailer-daemon)$/i;
const FIXTURE_TEXT = /\.(json|sql|csv|txt|ya?ml|[cm]?[jt]s)$/;

/** Frozen fixtures are copied into every build and every export: a real address in them is personal data. */
function personalDataScan(p, r) {
  const spec = readText(p.spec);
  const found = new Map();
  for (const f of L.listFiles(p.fixtures).filter(x => FIXTURE_TEXT.test(x))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(:\/\/[^\s"'@/]*)?([A-Za-z0-9._%+-]+|\}\})@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g)) {
      if (m[1]) continue; // scheme://user@host is a URL credential, not a mailbox
      const addr = `${m[2]}@${m[3]}`;
      if (RESERVED_MAIL.test(m[3]) || ROLE_MAILBOX.test(m[2]) || spec.includes(addr)) continue; // reserved, a role mailbox, or a value SPEC pins
      const rf = L.rel(p.root, f);
      if (!found.has(rf)) found.set(rf, new Set());
      found.get(rf).add(addr);
    }
  }
  for (const [f, addrs] of found) {
    r.error(`${f}: e-mail address(es) outside the reserved test domains: ${[...addrs].slice(0, 5).join(', ')} — use example.com / *.test (RFC 2606) unless SPEC.md pins the exact address`);
  }
}

function checkFixtures(p, ctx, r) {
  if (!exists(p.oracleConfig)) { r.error('missing specs/fixtures/oracle.config.json (Stage 04 output)'); return null; }
  let cfg;
  try {
    const loaded = L.loadOracleConfig(p);
    cfg = loaded.cfg;
    loaded.errors.forEach(e => r.error(e));
  } catch (e) { r.error(e.message); return null; }
  const patterns = [];
  for (const pat of cfg.variablePaths || []) {
    try { patterns.push(L.compilePathPattern(pat)); } catch (e) { r.error(`oracle.config.json variablePaths: ${e.message}`); }
  }
  const ifaces = ctx.manifest ? ctx.manifest.interfaces : [];
  const mustMask = [];
  if (ifaces.includes('http')) mustMask.push(['$.detail', 'ERR-2']);
  if (ifaces.includes('cli')) mustMask.push(['$.error.detail', 'CLI-2']);
  for (const [at, rule] of mustMask) {
    if (!patterns.some(re => re.test(at))) r.error(`oracle.config.json variablePaths must cover ${at} (free text, profile ${rule})`);
  }
  const hooks = cfg.hooks || {};
  for (const h of cfg.defaultSetup || []) if (!hooks[h]) r.error(`oracle.config.json defaultSetup references unknown hook "${h}"`);

  const { cases, errors } = L.loadCases(p);
  errors.forEach(e => r.error(e));
  const interfaces = ctx.manifest ? ctx.manifest.interfaces : [];
  const needsCases = interfaces.some(i => i !== 'browser');
  if (!cases.length && needsCases) r.error('no oracle cases found in specs/fixtures/cases/');

  const invariants = L.parseInvariants(readText(p.spec));
  const items = new Map();
  for (const op of ctx.ops) for (const st of op.statuses) if (st !== 'default') items.set(`op:${op.operationId}:${st}`, false);
  for (const id of ctx.transitions.keys()) items.set(`transition:${id}`, false);
  for (const m of ctx.machines) items.set(`illegal:${m.id}`, false);
  for (const v of invariants) items.set(`inv:${v}`, false);
  for (const code of ctx.errorCodes.keys()) items.set(`error:${code}`, false);
  for (const c of ctx.commands) for (const x of c.exitCodes) items.set(`cmd:${c.name}:${x.code}`, false);
  const cover = item => { if (items.has(item)) items.set(item, true); };

  const ids = new Set();
  const asserted = [];
  let httpSteps = 0;
  let runSteps = 0;
  for (const c of cases) {
    const where = `${c.file} ${c.id}`;
    if (ids.has(c.id)) r.error(`${where}: duplicate case id`);
    ids.add(c.id);
    const probe = !!c.probe;
    if (!probe && c.phase === undefined) r.error(`${where}: missing "phase"`);
    if (!probe && !(c.derivedFrom || []).length) r.error(`${where}: missing "derivedFrom" (oracle derives, never decides)`);
    for (const h of c.setup || []) if (!hooks[h]) r.error(`${where}: setup references unknown hook "${h}"`);

    const captured = new Set();
    const keyUses = new Map(); // named $uuid used as Idempotency-Key → operations it is sent to
    const noteKey = (h, op, sw) => {
      const name = idempotencyKeyName(h);
      if (!name) return;
      if (!keyUses.has(name)) keyUses.set(name, new Map());
      const opKey = op ? op.operationId : `${String(h.method).toUpperCase()} ${h.path}`;
      if (!keyUses.get(name).has(opKey)) keyUses.get(name).set(opKey, sw);
    };
    c.steps.forEach((s, i) => {
      const sw = `${where} step ${i + 1}${s.id ? ` (${s.id})` : ''}`;
      const kinds = L.stepKind(s);
      if (kinds.length !== 1) { r.error(`${sw}: needs exactly one of http | query | run`); return; }
      const kind = kinds[0];
      if (kind === 'http') httpSteps++;
      if (kind === 'run') runSteps++;
      if (!probe && !s.expect) r.error(`${sw}: no "expect" (only probe cases may omit expectations)`);
      if (s.expect) {
        for (const k of Object.keys(s.expect)) if (!EXPECT_KEYS[kind].includes(k)) r.error(`${sw}: expect.${k} is not valid for a ${kind} step`);
        const lint = [];
        for (const [k, v] of Object.entries(s.expect)) if (k !== 'bodyMatch') L.lintMatchers(v, `expect.${k}`, lint);
        lint.forEach(e => r.error(`${sw}: ${e}`));
        if (kind === 'http' && s.expect.status === undefined) r.error(`${sw}: http expectations must assert status`);
        if (kind === 'run' && s.expect.exitCode === undefined) r.error(`${sw}: run expectations must assert exitCode`);
      }
      const used = L.templateVars([s[kind], s.expect]);
      for (const v of used) if (!captured.has(v)) r.error(`${sw}: uses {{${v}}} before any step captures it`);
      if (kind === 'query' && !(cfg.adapters && cfg.adapters.sql)) r.error(`${sw}: query steps need adapters.sql in oracle.config.json`);
      if (kind === 'http') {
        if (s.http.body !== undefined && s.http.rawBody !== undefined) r.error(`${sw}: use body or rawBody, not both`);
        const status = s.expect && typeof s.expect.status === 'number' ? s.expect.status : null;
        const op = ctx.ops.length ? L.matchOperation(ctx.ops, s.http.method, s.http.path) : null;
        noteKey(s.http, op, sw);
        if (ctx.ops.length && !op && !probe && ![404, 405].includes(status)) r.warn(`${sw}: ${s.http.method} ${s.http.path} matches no openapi operation`);
        if (op && !probe && s.expect && L.isPlainObject(s.expect) && status !== null) asserted.push({ op, status, body: s.expect.body });
        if (op && status !== null) {
          const declared = op.statuses.filter(st => st !== 'default' && L.statusCovers(st, status));
          if (!declared.length) r.error(`${sw}: expects ${status}, which ${op.operationId} does not declare in openapi responses`);
          if (!probe) declared.forEach(st => cover(`op:${op.operationId}:${st}`));
        }
        const code = s.expect && L.isPlainObject(s.expect.body) && typeof s.expect.body.code === 'string' ? s.expect.body.code : null;
        if (code) {
          const def = ctx.errorCodes.get(code);
          if (ctx.errorCodes.size && !def) r.error(`${sw}: error code ${code} is not in errors.json`);
          else if (def && status !== null && def.status !== status) r.error(`${sw}: ${code} is ${def.status} in errors.json but the case expects ${status}`);
          if (!probe) cover(`error:${code}`);
        }
      }
      if (kind === 'parallel') {
        const exps = s.expect && Array.isArray(s.expect.responses) ? s.expect.responses : null;
        if (s.expect && (!exps || exps.length !== s.parallel.length)) r.error(`${sw}: expect.responses must list one expectation per parallel request (${s.parallel.length})`);
        (exps || []).forEach((e, j) => {
          if (!L.isPlainObject(e) || e.status === undefined) { r.error(`${sw}: expect.responses[${j}] must assert status`); return; }
          for (const k of Object.keys(e)) if (!EXPECT_KEYS.http.includes(k)) r.error(`${sw}: expect.responses[${j}].${k} is not valid`);
        });
        if (s.capture) r.error(`${sw}: parallel steps cannot capture — which request wins a race is nondeterministic`);
        const hit = s.parallel.map(h => (ctx.ops.length ? L.matchOperation(ctx.ops, h.method, h.path) : null));
        s.parallel.forEach((h, j) => noteKey(h, hit[j], `${sw} request ${j + 1}`));
        for (const e of exps || []) {
          if (!L.isPlainObject(e) || typeof e.status !== 'number' || !hit.every(Boolean)) continue;
          if (!hit.some(o => o.statuses.some(st => st !== 'default' && L.statusCovers(st, e.status)))) {
            r.error(`${sw}: expects ${e.status}, which none of ${[...new Set(hit.map(o => o.operationId))].join(', ')} declares in openapi responses`);
          }
        }
        if (!probe && exps && hit[0] && hit.every(o => o === hit[0])) {
          for (const e of exps) {
            if (!L.isPlainObject(e) || typeof e.status !== 'number') continue;
            hit[0].statuses.filter(st => st !== 'default' && L.statusCovers(st, e.status)).forEach(st => cover(`op:${hit[0].operationId}:${st}`));
            asserted.push({ op: hit[0], status: e.status, body: e.body });
          }
        }
        for (const e of exps || []) {
          const code = L.isPlainObject(e) && L.isPlainObject(e.body) && typeof e.body.code === 'string' ? e.body.code : null;
          if (!code) continue;
          const def = ctx.errorCodes.get(code);
          if (ctx.errorCodes.size && !def) r.error(`${sw}: error code ${code} is not in errors.json`);
          else if (def && typeof e.status === 'number' && def.status !== e.status) r.error(`${sw}: ${code} is ${def.status} in errors.json but the case expects ${e.status}`);
          if (!probe) cover(`error:${code}`);
        }
      }
      for (const name of Object.keys(s.capture || {})) captured.add(name);
    });
    // Profile IDEM-3/IDEM-4: one key on two different operations is a fingerprint mismatch (422), however
    // well two authors agree on the expectations. Dual authoring cannot see it: both share the request.
    if (!(c.tags || []).includes(KEY_REUSE_TAG)) {
      for (const [name, ops] of keyUses) {
        if (ops.size < 2) continue;
        r.error(`${where}: Idempotency-Key {{$uuid:${name}}} is sent to ${ops.size} different operations (${[...ops.keys()].join(', ')}) — the server answers 422 IDEMPOTENCY_KEY_MISMATCH (profile IDEM-4). Use one key name per operation, or tag the case "${KEY_REUSE_TAG}" if the mismatch is what it tests`);
      }
    }

    for (const ref of c.covers || []) {
      const [kind, ...restParts] = ref.split(':');
      const rest = restParts.join(':');
      let ok = true;
      if (kind === 'op') {
        const [opId, st] = rest.split(':');
        const op = ctx.ops.find(o => o.operationId === opId);
        ok = !!op && (st === undefined || op.statuses.includes(st));
      } else if (kind === 'transition') ok = ctx.transitions.has(rest);
      else if (kind === 'illegal') ok = ctx.machines.some(m => m.id === rest);
      else if (kind === 'inv') ok = invariants.includes(rest);
      else if (kind === 'error') ok = ctx.errorCodes.has(rest);
      else if (kind === 'cmd') ok = items.has(ref);
      if (!ok) r.error(`${where}: covers "${ref}", which does not exist in the spec/contracts`);
      else if (!probe) cover(ref);
    }
  }
  const resolves = ref => items.has(ref) || (ref.startsWith('op:') && ctx.ops.some(o => o.operationId === ref.slice(3)));
  personalDataScan(p, r);

  if (interfaces.includes('http') && !httpSteps) r.error('interface "http" declared but no case has an http step');
  if ((interfaces.includes('cli') || interfaces.includes('library')) && !runSteps) r.error('interface "cli"/"library" declared but no case has a run step');
  if (interfaces.includes('browser')) {
    const ui = [];
    for (const f of L.listFiles(p.uiFixtures)) if (/\.(spec|test)\.[cm]?[jt]s$/.test(f)) ui.push(f);
    if (!ui.length) r.error('interface "browser" declared but specs/fixtures/ui/ contains no *.spec.ts|js UI specs');
    else r.note(`ui specs: ${ui.length} file(s) in specs/fixtures/ui/`);
    // UI specs declare coverage with comments: `// covers: transition:item.complete, inv:V2`
    for (const f of ui) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/covers:\s*([^\n]*)/g)) {
        for (const ref of m[1].split(/[\s,]+/).filter(x => /^(op|transition|illegal|inv|error|cmd):/.test(x))) {
          if (!resolves(ref)) r.error(`${L.rel(p.root, f)}: covers "${ref}", which does not exist in the spec/contracts`);
          else cover(ref);
        }
      }
    }
    if (ui.length && L.parsePhases(readText(p.phases)).length > 1 && !ui.some(f => /\/\/\s*phase:\s*\d+/.test(fs.readFileSync(f, 'utf8')))) {
      r.warn('no UI spec declares `// phase: N`: the Stage 05 phase gate cannot tell which UI specs grade a UI-only phase (oracle-standard.md §UI specs)');
    }
    if (!exists(path.join(p.uiFixtures, 'playwright.config.ts')) && !exists(path.join(p.uiFixtures, 'playwright.config.js'))) {
      r.error('specs/fixtures/ui/ needs a frozen playwright.config.ts (browser, viewport, locale, timezone, retries: 0) — oracle-standard.md §UI specs');
    }
  }

  const exempt = (ctx.manifest && ctx.manifest.coverageExempt) || {};
  for (const k of Object.keys(exempt)) {
    if (!items.has(k)) r.warn(`manifest.coverageExempt lists "${k}", which is not a coverage item`);
    else items.set(k, 'exempt');
  }
  const kinds = ['op', 'transition', 'illegal', 'inv', 'error', 'cmd'];
  const summary = kinds.map(k => {
    const all = [...items.entries()].filter(([i]) => i.startsWith(`${k}:`));
    const done = all.filter(([, v]) => v).length;
    return `${k} ${done}/${all.length}`;
  });
  r.note(`cases: ${cases.length} (${cases.filter(c => c.probe).length} probe); invariants in SPEC.md: ${invariants.length}`);
  r.note(`coverage: ${summary.join(' · ')}`);
  const uncovered = [...items.entries()].filter(([, v]) => !v).map(([i]) => i);
  if (uncovered.length) r.error(`uncovered (add cases, or justify in manifest.coverageExempt): ${uncovered.join(', ')}`);
  if (!invariants.length) r.warn('SPEC.md declares no invariants (expected "- **V1:** ..." bullets in §Invariants)');
  if (ctx.doc) fieldAssertionReport(ctx, asserted, patterns, r);

  if (exists(p.phases)) {
    const phases = L.parsePhases(readText(p.phases));
    if (!phases.length) r.error('IMPLEMENTATION_PHASES.md has no "## Phase N" headings');
    const byPhase = new Map(phases.map(n => [n, 0]));
    for (const c of cases.filter(x => !x.probe)) {
      if (!byPhase.has(c.phase)) r.error(`${c.file} ${c.id}: phase ${c.phase} is not in IMPLEMENTATION_PHASES.md`);
      else byPhase.set(c.phase, byPhase.get(c.phase) + 1);
    }
    for (const [n, count] of byPhase) {
      if (count) continue;
      if (interfaces.includes('browser')) r.warn(`Phase ${n} has no oracle cases (allowed only if graded by specs/fixtures/ui/ specs)`);
      else r.error(`Phase ${n} has no oracle cases (phase without fixture = gate fail)`);
    }
  }
  return { cfg, cases, uncovered };
}

// ========== Response-field assertion coverage ==========

function schemaFields(doc, schema, at, out, depth) {
  const s = flattenSchema(doc, schema);
  if (!s || depth > 5) return out;
  const t = Array.isArray(s.type) ? s.type.find(x => x !== 'null') : s.type || (s.properties ? 'object' : s.items ? 'array' : undefined);
  if (t === 'object' && s.properties) {
    for (const [k, v] of Object.entries(s.properties)) { out.add(`${at}.${k}`); schemaFields(doc, v, `${at}.${k}`, out, depth + 1); }
  } else if (t === 'array' && s.items) schemaFields(doc, s.items, `${at}[*]`, out, depth + 1);
  return out;
}

function literalLeaves(expected, at, out) {
  if (L.isMatcher(expected)) { if (!L.isVariableMatcher(expected) && !expected.$absent) out.add(at); return out; }
  if (Array.isArray(expected)) {
    if (!expected.length) out.add(at); // an exact [] pins the field and everything below it
    expected.forEach(e => literalLeaves(e, `${at}[*]`, out));
  } else if (L.isPlainObject(expected)) {
    if (!Object.keys(expected).length) out.add(at);
    for (const [k, v] of Object.entries(expected)) literalLeaves(v, `${at}.${k}`, out);
  } else out.add(at);
  return out;
}

/** Which declared response fields are never pinned to a literal value by any case (declared freedoms excluded)? */
function fieldAssertionReport(ctx, asserted, variablePatterns, r) {
  const fields = [];
  for (const o of ctx.ops) {
    for (const st of o.statuses) {
      if (st === 'default') continue;
      const resp = L.deref(ctx.doc, (o.op.responses || {})[st]) || {};
      const content = resp.content || {};
      const media = content['application/json'] || content['application/problem+json'];
      if (!media || !media.schema) continue;
      for (const f of schemaFields(ctx.doc, media.schema, '$', new Set(), 0)) {
        if (variablePatterns.some(re => re.test(f.replace(/\[\*\]/g, '[0]')))) continue;
        fields.push({ key: `op:${o.operationId}:${st}`, op: o, st, path: f });
      }
    }
  }
  if (!fields.length) return;
  const pinned = new Map();
  for (const a of asserted) {
    if (a.body === undefined) continue;
    for (const st of a.op.statuses.filter(x => x !== 'default' && L.statusCovers(x, a.status))) {
      const k = `op:${a.op.operationId}:${st}`;
      if (!pinned.has(k)) pinned.set(k, new Set());
      literalLeaves(a.body, '$', pinned.get(k));
    }
  }
  const isPinned = f => [...(pinned.get(f.key) || [])].some(x => x === f.path
    || x.startsWith(`${f.path}.`) || x.startsWith(`${f.path}[`) // a descendant is pinned
    || f.path.startsWith(`${x}.`) || f.path.startsWith(`${x}[`)); // an ancestor is pinned to an exact value
  const open = fields.filter(f => !isPinned(f));
  r.note(`response fields pinned to literal values: ${fields.length - open.length}/${fields.length} (declared variable paths excluded)`);
  if (open.length) {
    r.warn(`${open.length} declared response field(s) are never pinned by any case — builders may diverge there unnoticed: ${open.slice(0, 12).map(f => `${f.key} ${f.path}`).join(', ')}${open.length > 12 ? ', …' : ''}`);
  }
}

// ========== Markdown tables ==========

function parseTables(text) {
  const lines = text.split(/\r?\n/);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim().startsWith('|') || !/^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] || '')) continue;
    const header = cells(lines[i]);
    const rows = [];
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
    tables.push({ header, rows });
  }
  return tables;
}

/** Stage 02 Outcome Table ↔ contracts: every declared operation status / command exit code is listed, nothing extra. */
function outcomeTableGate(p, ctx) {
  const f = 'specs/logs/02-swarm.md';
  const tables = parseTables(readText(path.join(p.root, f)));
  const t = [...tables].reverse().find(x => x.header.some(h => /operation|command/i.test(h)) && x.header.some(h => /status|exit/i.test(h)));
  if (!t) return [false, `${f}: no Outcome Table (columns "Operation / command" and "Status / exit")`];
  const nameCol = t.header.findIndex(h => /operation|command/i.test(h));
  const statusCol = t.header.findIndex(h => /status|exit/i.test(h));
  const expected = new Map();
  for (const o of ctx.ops) for (const st of o.statuses) if (st !== 'default') expected.set(`${o.operationId}:${st}`, false);
  for (const c of ctx.commands) for (const x of c.exitCodes) expected.set(`${c.name}:${x.code}`, false);
  const known = new Set([...ctx.ops.map(o => o.operationId), ...ctx.commands.map(c => c.name)]);
  const extra = [];
  for (const row of t.rows) {
    const name = (row[nameCol] || '').replace(/`/g, '').trim();
    const code = Number(((row[statusCol] || '').match(/\d{1,3}/) || [])[0]);
    if (!name || /^\.+$/.test(name)) continue;
    if (!known.has(name)) { extra.push(`${name} (not an operation/command in the contracts)`); continue; }
    if (Number.isNaN(code)) { extra.push(`${name} (no status/exit code)`); continue; }
    const key = [...expected.keys()].find(k => k.startsWith(`${name}:`) && L.statusCovers(k.slice(name.length + 1), code));
    if (key) expected.set(key, true);
    else extra.push(`${name} ${code}`);
  }
  const missing = [...expected.entries()].filter(([, v]) => !v).map(([k]) => k.replace(':', ' '));
  if (!expected.size) return [true, 'Outcome Table: no operations or commands to enumerate'];
  if (missing.length || extra.length) {
    return [false, `Outcome Table vs contracts — ${missing.length ? `missing: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}` : ''}${missing.length && extra.length ? '; ' : ''}${extra.length ? `not declared in contracts: ${extra.slice(0, 8).join(', ')}` : ''}`];
  }
  return [true, `Outcome Table lists all ${expected.size} declared outcome(s)`];
}

function runCheck(p, { contractsOnly }) {
  const r = new Report();
  const ctx = checkContracts(p, r);
  if (!contractsOnly) checkFixtures(p, ctx, r);
  return { r, ctx };
}

// ========== State & evidence ==========

function readState(p) {
  if (exists(p.state)) {
    try { return L.readJson(p.state); } catch { /* fall through to template */ }
  }
  const tpl = path.join(p.config, 'sdd-state.json.template');
  return exists(tpl) ? L.readJson(tpl) : { lastCompletedStep: 0, stepName: 'Project Initialization', projectType: '' };
}

function projectInfo(p, state) {
  const matrix = L.readJson(p.matrix);
  let manifest = null;
  try { manifest = exists(p.manifest) ? L.readJson(p.manifest) : null; } catch { manifest = null; }
  const projectType = (manifest && manifest.projectType) || state.projectType || '';
  const typeDef = matrix.types[projectType] || null;
  const interfaces = (manifest && manifest.interfaces) || (typeDef ? typeDef.defaultInterfaces : []);
  return { matrix, manifest, projectType, typeDef, ui: !!(typeDef && typeDef.ui), interfaces };
}

function latestReport(p, prefix, accept) {
  if (!exists(p.oracleLogs)) return null;
  const reports = fs.readdirSync(p.oracleLogs)
    .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
    .map(f => { try { return L.readJson(path.join(p.oracleLogs, f)); } catch { return null; } })
    .filter(Boolean)
    .filter(accept)
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  return reports[0] || null;
}

/** The full oracle run on "default", then whether it graded the code as it is now (evidence.cjs). */
function oracleRunGates(p, lock) {
  // Stage evidence is the "default" target only: a green run on another target says nothing about this build.
  const rep = latestReport(p, 'run-default', x => x.target === 'default');
  if (!rep) return [[false, 'no oracle run on target "default" (run: node specs/.sdd/scripts/oracle.cjs run)']];
  const binding = E.gate(E.check(p.root, rep));
  if (!lock || rep.lockHash !== lock.hash || !rep.lockValid) return [[false, 'latest oracle run on "default" was not made against the current, intact lock; re-run'], binding];
  if (rep.filtered) return [[false, 'latest oracle run on "default" was filtered (--phase/--case/--suite/--bail); run the full oracle'], binding];
  if (rep.failed || rep.errored || !rep.total) return [[false, `oracle run on "default": ${rep.passed}/${rep.total} passed, ${rep.failed} failed, ${rep.errored} errored`], binding];
  return [[true, `oracle run on "default": ${rep.passed}/${rep.total} passed against lock ${lock.hash.slice(0, 12)}`], binding];
}

function uiSpecFiles(p) {
  return L.listFiles(p.uiFixtures).filter(f => /\.(spec|test)\.[cm]?[jt]s$/.test(f));
}

const UI_E2E = 'specs/logs/ui-e2e.json';

/** The UI report, then whether its stamp binds it to the code as it is now (evidence.cjs). */
function uiGates(p) {
  const f = path.join(p.root, UI_E2E);
  if (!exists(f)) return [[false, `no ${UI_E2E} (ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui)`]];
  let rep;
  try { rep = L.readJson(f); } catch (e) { return [[false, e.message]]; }
  const binding = E.gate(E.checkUi(p.root, UI_E2E));
  const ran = new Set((rep.suites || []).map(s => path.basename(String(s.file || ''))));
  const missing = uiSpecFiles(p).map(x => path.basename(x)).filter(b => !ran.has(b));
  if (missing.length) return [[false, `UI report did not run every frozen spec (missing: ${missing.join(', ')}); run the whole suite`], binding];
  const st = rep.stats || {};
  // A flaky UI spec is observable nondeterminism, so it fails the gate like a hard failure.
  if (!(st.expected > 0) || st.unexpected || st.flaky) return [[false, `UI specs: ${st.expected || 0} passed, ${st.unexpected || 0} failed, ${st.flaky || 0} flaky`], binding];
  return [[true, `UI specs: ${st.expected} passed, 0 failed, 0 flaky`], binding];
}

/** UI evidence for one phase: the frozen UI specs that declare `// phase: M` with M ≤ N, graded on the committed code. */
function uiPhaseGates(p, n) {
  const f = path.join(p.root, UI_E2E);
  if (!exists(f)) return [[false, `phase ${n} is graded by the frozen UI specs: run them (ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui <phase ≤ ${n} spec files>)`]];
  let rep;
  try { rep = L.readJson(f); } catch (e) { return [[false, e.message]]; }
  return [uiPhaseGate(p, n, rep), E.gate(E.checkUi(p.root, UI_E2E))];
}

function uiPhaseGate(p, n, rep) {
  const declared = uiSpecFiles(p).map(x => ({ x, m: fs.readFileSync(x, 'utf8').match(/\/\/\s*phase:\s*(\d+)/) })).filter(y => y.m);
  const required = declared.filter(y => Number(y.m[1]) <= n).map(y => path.basename(y.x));
  const ran = new Set((rep.suites || []).map(s => path.basename(String(s.file || ''))));
  const missing = required.filter(b => !ran.has(b));
  if (missing.length) return [false, `UI report for phase ${n} did not run ${missing.join(', ')} (\`// phase:\` ≤ ${n})`];
  const st = rep.stats || {};
  if (!(st.expected > 0) || st.unexpected || st.flaky) return [false, `UI specs for phase ${n}: ${st.expected || 0} passed, ${st.unexpected || 0} failed, ${st.flaky || 0} flaky`];
  return [true, `UI specs for phase ${n}: ${st.expected} passed, 0 failed, 0 flaky${declared.length ? ` (${required.length} spec file(s) with phase ≤ ${n})` : ' — no UI spec declares `// phase:`, so the gate cannot tell which specs grade this phase'}`];
}

function diffGate(p, lock, freshAfter, prefix, label) {
  const rep = latestReport(p, prefix, () => true);
  if (!rep) return [false, `no ${label} report between two independent builds (Stage 07 §L2)`];
  if (!lock || rep.lockHash !== lock.hash || !rep.lockValid) return [false, `${label}: build A was not on the current, intact lock; re-run`];
  if (rep.bLockHash !== lock.hash || !rep.bLockValid) return [false, `${label}: build B's workspace (--b-root) is not on the same intact lock (B ${rep.bLockHash ? rep.bLockHash.slice(0, 12) : 'unknown'}); re-export and rebuild B`];
  if (rep.filtered) return [false, `${label} was filtered; run it unfiltered`];
  if (freshAfter && !(rep.finishedAt > freshAfter)) return [false, `latest ${label} (${rep.finishedAt}) predates this stage; re-run`];
  if (rep.errored) return [false, `${label} ${rep.a} vs ${rep.b}: ${rep.errored} case(s) errored`];
  if (rep.divergentCases) return [false, `${label} ${rep.a} vs ${rep.b}: ${rep.divergentCases} divergent, ${rep.divergences.length} divergence(s) → Stage 00`];
  return [true, `${label} ${rep.a} vs ${rep.b}: ${rep.totalCases} observation(s), zero divergences`];
}

/** Interpretation diff: two independent authors predicted the same requests from the spec with zero gaps. */
function expectDiffGate(p, freshAfter, mustBindFixtures, minCases = 1) {
  const fixturesHash = exists(p.cases) ? L.hashTree(p.cases) : null;
  const rep = latestReport(p, 'expectdiff-', x => !mustBindFixtures || (fixturesHash && (x.aHash === fixturesHash || x.bHash === fixturesHash)));
  const what = mustBindFixtures ? 'interpretation diff of the final oracle (A = specs/fixtures/cases)' : 'interpretation diff of the Outcome Table';
  if (!rep) return [false, `no ${what}: oracle.cjs diff-expect --a … --b … (two independent authors)`];
  if (freshAfter && !(rep.finishedAt > freshAfter)) return [false, `${what} predates this stage; re-run it`];
  if (rep.identical || rep.aHash === rep.bHash) return [false, `${what}: A and B are byte-identical — B must be predicted independently from a strip-expect skeleton`];
  if ((rep.totalCases || 0) < minCases) return [false, `${what} compared ${rep.totalCases || 0} case(s); at least ${minCases} needed (one per declared outcome)`];
  if (rep.divergentCases) return [false, `${what}: ${rep.gaps.length} gap(s) in ${rep.divergentCases} case(s) — resolve them in the spec`];
  return [true, `${what}: ${rep.totalCases} case(s), zero gaps`];
}

function lockGate(p) {
  const v = L.verifyLock(p.root);
  if (!v.exists) return [[false, 'no specs/spec.lock.json (freeze at end of Stage 04)'], v];
  if (!v.valid) return [[false, `frozen set modified since lock v${v.lock.lockVersion}: ${[...v.modified, ...v.added.map(f => `+${f}`), ...v.removed.map(f => `-${f}`)].join(', ') || 'lock file tampered'}`], v];
  return [[true, `lock v${v.lock.lockVersion} intact (${v.lock.hash.slice(0, 12)})`], v];
}

/** A required working file; with freshAfter it must also have been written during this stage. */
function fileGate(p, f, why, freshAfter) {
  const fp = path.join(p.root, f);
  if (!exists(fp)) return [false, `missing ${f}${why ? ` (${why})` : ''}`];
  if (freshAfter && !(fs.statSync(fp).mtime.toISOString() > freshAfter)) return [false, `${f} was not updated during this stage (older than ${freshAfter})`];
  return [true, `${f} ${freshAfter ? 'updated this stage' : 'exists'}`];
}

const VERDICT_PASS = /^\**Verdict:?\**:?\s*PASS\b/m;

/** Parse the reconciliation table(s): every row's Drift cell must be ✅ or ❌; any ❌ fails. */
function reconGate(p, freshAfter) {
  const f = 'specs/dev-swarm-reconciliation.md';
  const fg = fileGate(p, f, 'Stage 05 reconciliation', freshAfter);
  if (!fg[0]) return fg;
  const lines = readText(path.join(p.root, f)).split(/\r?\n/);
  const cells = l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  let rows = 0;
  let drift = 0;
  const odd = [];
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].trim().startsWith('|') ? cells(lines[i]) : null;
    const col = head ? head.findIndex(c => /^drift\??$/i.test(c)) : -1;
    if (col < 0 || !/^\s*\|?\s*:?-+:?\s*\|/.test(lines[i + 1] || '')) continue; // GFM delimiter row
    for (i += 2; i < lines.length && lines[i].trim().startsWith('|'); i++) {
      const v = cells(lines[i])[col] || '';
      rows++;
      if (v === '❌') drift++;
      else if (v !== '✅') odd.push(v || '(empty)');
    }
  }
  if (!rows) return [false, `${f} has no table with a "Drift" column`];
  if (odd.length) return [false, `${f}: Drift cells must be ✅ or ❌ (found ${odd.slice(0, 3).join(', ')})`];
  if (drift) return [false, `${f}: ${drift} ❌ drift entr${drift === 1 ? 'y' : 'ies'}`];
  return [true, `reconciliation: ${rows} row(s), zero ❌ drift`];
}


// ========== Stage 01: interpretations & docs ==========

/**
 * Dual Interpretation log: a scenario whose latest row still answers UNSPECIFIED is an open domain gap.
 * The only way to leave one open is a decision-log row (cited in that row) that puts the behavior out of scope.
 */
function interpretationGate(p) {
  const f = 'specs/logs/01-interpretations.md';
  const text = readText(path.join(p.root, f));
  if (!text) return [false, `missing ${f} (Dual Interpretation rounds, Stage 01 step 3)`];
  const decisionLog = readText(p.decisionLog);
  const latest = new Map();
  for (const t of parseTables(text)) {
    const col = t.header.findIndex(h => /scenario/i.test(h));
    if (col < 0) continue;
    const verdictCol = t.header.findIndex(h => /verdict|agree/i.test(h));
    const unspecCol = t.header.findIndex(h => /unspecified/i.test(h));
    for (const row of t.rows) {
      const cell = (row[col] || '').replace(/[`*]/g, '').trim();
      if (!cell || /^\.+$/.test(cell)) continue;
      // Key on the stable id (S1.1) so a reworded scenario in a later round still supersedes the old row.
      const id = (cell.match(/^S\d+(?:\.\d+)*\b/) || [cell])[0];
      latest.set(id, { cell, row, verdict: verdictCol >= 0 ? (row[verdictCol] || '').replace(/[*_`]/g, '').trim() : null, unspec: unspecCol >= 0 ? (row[unspecCol] || '').trim() : '' });
    }
  }
  if (!latest.size) return [false, `${f}: no table with a "Scenario" column`];
  // Out of scope only when the Verdict says so and names a decision that exists; predictors cite DECs all the time.
  const scopedOut = x => {
    const m = x.verdict && x.verdict.match(/^out of scope\b.*\b(DEC\d+)\b/i);
    return !!m && new RegExp(`\\b${m[1]}\\b`).test(decisionLog);
  };
  const isEmpty = v => !v || /^(—|-|–|none|n\/a)$/i.test(v);
  const open = [];
  const split = [];
  for (const [id, x] of latest) {
    if (scopedOut(x)) continue;
    if (x.row.some(c => /\bunspecified\b/i.test(c)) || !isEmpty(x.unspec)) open.push(id);
    else if (x.verdict !== null && !/^agree\b/i.test(x.verdict)) split.push(`${id} (${x.verdict || 'no verdict'})`);
  }
  const list = a => `${a.slice(0, 8).join(', ')}${a.length > 8 ? ', …' : ''}`;
  if (open.length) return [false, `${f}: ${open.length} scenario(s) still UNSPECIFIED in their latest round: ${list(open)} — ask the user and re-predict, or set the Verdict to "out of scope (DECnnn)" citing the decision`];
  if (split.length) return [false, `${f}: ${split.length} scenario(s) not agreed in their latest round: ${list(split)}`];
  return [true, `${f}: ${latest.size} scenario(s), all agreed or scoped out`];
}

const OPEN_STAGE01 = /\bTBD\b|\bopen\b[^.\n|]{0,40}\bStage 0?1\b|\bStage 0?1\b[^.\n|]{0,40}\bopen\b/i;

/** README and architecture docs describe the stack SPEC describes; leftover Stage 01 language means they do not. */
function docsGate(p) {
  const docs = ['README.md'].filter(f => exists(path.join(p.root, f)));
  const docDir = path.join(p.root, 'docs');
  if (exists(docDir)) for (const f of L.listFiles(docDir)) if (/architecture/i.test(path.basename(f)) && /\.(md|mmd|puml)$/.test(f)) docs.push(L.rel(p.root, f));
  const bad = docs.filter(f => OPEN_STAGE01.test(readText(path.join(p.root, f))));
  if (bad.length) return [false, `${bad.join(', ')}: TBD or "open Stage 01" language — reconcile README and architecture docs with SPEC.md before leaving Stage 01`];
  return [true, docs.length ? `${docs.length} project doc(s) carry no TBD / open-Stage-01 language` : 'no README or architecture docs yet'];
}

// ========== Stage 03 / 06: wireframes and design tokens ==========

function wireframeHtml(p) {
  return L.listFiles(p.wireframes).filter(f => f.endsWith('.html')).map(f => ({ f, text: fs.readFileSync(f, 'utf8') }));
}

function decodeHtml(t) {
  return t.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&rsquo;/g, '’').replace(/&hellip;/g, '…').replace(/\s+/g, ' ');
}

/** Every DESIGN component, every UI State Matrix state id and every static copy string appears in a wireframe. */
function wireframeContractGates(p) {
  const html = wireframeHtml(p);
  const ids = new Set();
  const styled = new Set(); // DESIGN components may be style variants (button-primary): a class or data-component names them
  for (const { text } of html) {
    for (const m of text.matchAll(/data-testid\s*=\s*["']([^"']+)["']/g)) ids.add(m[1]);
    for (const m of text.matchAll(/data-component\s*=\s*["']([^"']+)["']/g)) styled.add(m[1]);
    for (const m of text.matchAll(/class\s*=\s*["']([^"']+)["']/g)) m[1].split(/\s+/).forEach(c => styled.add(c));
  }
  const designText = readText(p.design);
  let design = null;
  try { design = L.parseDesign(designText); } catch (e) { return [[false, `DESIGN.md front matter: ${e.message}`]]; }
  const components = Object.keys((design && design.components) || {});
  const states = [...new Set([...designText.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*-(?:empty|loading|error))`/g)].map(m => m[1]))];
  const missing = [...components.filter(id => !ids.has(id) && !styled.has(id)), ...states.filter(id => !ids.has(id))];
  const gates = [[!missing.length, missing.length
    ? `wireframes lack ${missing.length} DESIGN component(s) / state id(s): ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''} (components: data-testid, data-component or class; states: data-testid — profile UI-1, UI-4)`
    : `wireframes carry all ${components.length} DESIGN component(s) and ${states.length} state test id(s)`]];
  const copy = [];
  for (const t of parseTables(readText(p.spec))) {
    if (t.header.length < 2 || !/^key$/i.test(t.header[0]) || !/^text$/i.test(t.header[1])) continue;
    for (const row of t.rows) {
      const text = (row[1] || '').replace(/^`|`$/g, '').trim();
      if (text && !/[{}]/.test(text)) copy.push({ key: row[0].replace(/`/g, ''), text });
    }
  }
  if (copy.length) {
    const body = html.map(h => decodeHtml(h.text)).join(' ');
    const absent = copy.filter(c => !body.includes(c.text.replace(/\s+/g, ' ')));
    gates.push([!absent.length, absent.length
      ? `${absent.length} SPEC copy string(s) appear in no wireframe: ${absent.slice(0, 8).map(c => c.key).join(', ')}${absent.length > 8 ? ', …' : ''} (profile UI-2)`
      : `all ${copy.length} static copy string(s) appear in the wireframes`]);
  }
  return gates;
}

const AUDIT_COLS = ['component', 'state', 'property', 'token', 'expected', 'measured', 'match'];

/** Markdown skeleton for a token audit: one row per DESIGN component × state × property. */
function tokenAuditSkeleton(p, stage) {
  const rows = L.designTokenRows(L.parseDesign(readText(p.design)));
  const subject = stage === '03' ? 'the approved wireframe CSS' : 'the computed style of the running build';
  return [
    `# Stage ${stage} token audit`,
    '',
    `Measured = the value read from ${subject}. Match = ✅ or ❌. Every row needs a measured value: a sample is not an audit.`,
    '',
    '| Component | State | Property | Token | Expected | Measured | Match |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(x => `| ${x.component} | ${x.state} | ${x.property} | \`${x.token}\` | \`${x.expected}\` |  |  |`),
    '',
  ].join('\n');
}

/** Every DESIGN token row was measured this stage and matches. */
function tokenAuditGate(p, stage, freshAfter) {
  const f = `specs/logs/${stage}-token-audit.md`;
  const fg = fileGate(p, f, `sdd.cjs token-audit --stage ${stage} > ${f}, then measure every row`, freshAfter);
  if (!fg[0]) return fg;
  let design;
  try { design = L.parseDesign(readText(p.design)); } catch (e) { return [false, `DESIGN.md front matter: ${e.message}`]; }
  const want = L.designTokenRows(design);
  if (!want.length) return [true, 'DESIGN.md declares no component tokens'];
  const got = new Map();
  for (const t of parseTables(readText(path.join(p.root, f)))) {
    const cols = AUDIT_COLS.map(c => t.header.findIndex(h => h.toLowerCase() === c));
    if (cols.some(c => c < 0)) continue;
    for (const row of t.rows) {
      const v = cols.map(c => (row[c] || '').replace(/`/g, '').trim());
      got.set(`${v[0]}|${v[1]}|${v[2]}`.toLowerCase(), { measured: v[5], match: v[6] });
    }
  }
  const missing = [];
  const unmeasured = [];
  const mismatch = [];
  const uncomparable = [];
  for (const w of want) {
    const k = `${w.component}|${w.state}|${w.property}`;
    const g = got.get(k.toLowerCase());
    if (!g) missing.push(k);
    else if (!g.measured) unmeasured.push(k);
    else if (g.match !== '✅') mismatch.push(`${k}${g.match === '❌' ? '' : ` (Match "${g.match || ''}")`}`);
    else {
      const m = L.cssValuesMatch(w.expected, g.measured);
      if (m === false) mismatch.push(`${k} (marked ✅, but measured ${g.measured} ≠ ${w.expected})`);
      else if (m === null) uncomparable.push(`${k} (${w.expected} vs ${g.measured})`);
    }
  }
  const list = a => `${a.slice(0, 6).join(', ')}${a.length > 6 ? ', …' : ''}`;
  if (missing.length) return [false, `${f}: ${missing.length} of ${want.length} DESIGN token row(s) missing: ${list(missing)}`];
  if (unmeasured.length) return [false, `${f}: ${unmeasured.length} row(s) without a measured value: ${list(unmeasured)}`];
  if (mismatch.length) return [false, `${f}: ${mismatch.length} row(s) not ✅: ${list(mismatch)}`];
  if (uncomparable.length) return [false, `CSS_UNCOMPARABLE: ${f}: ${uncomparable.length} row(s) whose measured value cannot be compared with the token: ${list(uncomparable)} — write the measured value as the browser computes it, and the token in measurable units (px, hex)`];
  return [true, `${f}: all ${want.length} DESIGN token row(s) measured and matching`];
}

/** Stage 02 deferred visible-copy / layout findings to Stage 03; each one is closed before wireframes are approved. */
function deferredUiGate(p) {
  const f = 'specs/logs/02-deferred-ui.md';
  const text = readText(path.join(p.root, f));
  if (!text) return [true, 'no UI findings deferred from Stage 02'];
  const open = (text.match(/^\s*- \[ \]/gm) || []).length;
  return [!open, open ? `${f}: ${open} deferred Stage 02 UI finding(s) still open` : `${f}: every deferred Stage 02 UI finding is closed`];
}

// ========== UI repeat runs (keyboard / focus) ==========

const UI_REPEAT_TAG = /@(keyboard|focus)\b/;
const UI_REPEAT_MIN = 20;

/** Keyboard and focus specs race the browser's frame timing: one clean pass is not evidence for them. */
const UI_REPEAT = 'specs/logs/ui-repeat.json';

/** Keyboard and focus specs race the browser's frame timing: one clean pass is not evidence for them. [] when none are tagged. */
function uiRepeatGates(p) {
  const tagged = uiSpecFiles(p).filter(f => UI_REPEAT_TAG.test(fs.readFileSync(f, 'utf8')));
  if (!tagged.length) return [];
  const f = path.join(p.root, UI_REPEAT);
  const cmd = `ORACLE_UI_URL=<build url> node specs/.sdd/scripts/oracle.cjs ui --out ${UI_REPEAT} --grep "@keyboard|@focus" --repeat-each=${UI_REPEAT_MIN}`;
  if (!exists(f)) return [[false, `${tagged.length} UI spec file(s) tag @keyboard/@focus: repeat them (${cmd})`]];
  let rep;
  try { rep = L.readJson(f); } catch (e) { return [[false, e.message]]; }
  const binding = E.gate(E.checkUi(p.root, UI_REPEAT));
  const repeat = Math.max(0, ...((rep.config && rep.config.projects) || []).map(x => Number(x.repeatEach) || 0));
  const st = rep.stats || {};
  if (repeat < UI_REPEAT_MIN) return [[false, `${UI_REPEAT} ran --repeat-each=${repeat || 1}; @keyboard/@focus specs need at least ${UI_REPEAT_MIN}`], binding];
  if (!(st.expected > 0) || st.unexpected || st.flaky) return [[false, `@keyboard/@focus specs ×${repeat}: ${st.expected || 0} passed, ${st.unexpected || 0} failed, ${st.flaky || 0} flaky`], binding];
  return [[true, `@keyboard/@focus specs ×${repeat}: ${st.expected} passed, 0 failed, 0 flaky`], binding];
}

// ========== Spec Change Requests & phase gates ==========

function scrLabel(x) { return `${x.id} (${x.status ? x.status[0].toUpperCase() + x.status.slice(1) : 'no Status row'})`; }

/** An open SCR stops the build: its item waits for the user, and nothing after it starts on a red tree. */
function openScrGate(p) {
  const open = L.loadScrs(p).filter(x => x.open);
  if (open.length) return [false, `open Spec Change Request(s): ${open.map(scrLabel).join(', ')} — Stage 00 must apply, reject or withdraw them first`];
  return [true, 'no open Spec Change Requests'];
}

function readJsonl(f) {
  if (!exists(f)) return [];
  return readText(f).split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function phaseLog(p) { return readJsonl(path.join(p.logs, 'phases.jsonl')); }

/** "## Phase N: Title" → Map(N → title). A gate record counts only for the phase it graded. */
function phaseTitles(p) {
  return new Map([...readText(p.phases).matchAll(/^##\s+Phase\s+(\d+)\b[:.\s-]*(.*)$/gm)].map(m => [Number(m[1]), m[2].trim()]));
}

/** Phases with a gate record whose title still matches IMPLEMENTATION_PHASES.md (renumbered phases re-gate). */
function gatedPhases(p) {
  const titles = phaseTitles(p);
  return new Set(phaseLog(p).filter(x => titles.has(x.phase) && (x.title === undefined || x.title === titles.get(x.phase))).map(x => x.phase));
}

/** Every phase in IMPLEMENTATION_PHASES.md passed `sdd.cjs phase --completed N`. */
function phasesGatedGate(p) {
  const phases = L.parsePhases(readText(p.phases));
  if (!phases.length) return [false, 'IMPLEMENTATION_PHASES.md has no "## Phase N" headings'];
  const done = gatedPhases(p);
  const missing = phases.filter(n => !done.has(n));
  if (missing.length) return [false, `phase gate not passed for phase(s) ${missing.join(', ')} (node specs/.sdd/scripts/sdd.cjs phase --completed N, in order)`];
  return [true, `all ${phases.length} phase(s) passed their phase gate`];
}

function exitGates(stage, p, state, info, opts = {}) {
  const gates = [];
  const freshAfter = state.timestamp || null;
  const add = g => gates.push(g);
  const nonBrowser = info.interfaces.some(i => i !== 'browser');
  const browser = info.interfaces.includes('browser');
  const typeGate = () => [!!info.typeDef, info.typeDef ? `project type ${info.projectType}` : `project type unset or unknown ("${info.projectType}"); pass --project-type <${Object.keys(info.matrix.types).join('|')}>`];
  switch (stage) {
    case '00': {
      add([!!opts.resume && opts.resume !== '00', opts.resume && opts.resume !== '00' ? `resume at ${L.STAGES[opts.resume].name}` : 'missing or invalid --resume <01|01b|02|04|05> (where the pipeline continues)']);
      add(fileGate(p, 'specs/backprop-log.md', 'append the backprop entry', freshAfter));
      if (exists(p.lock)) add(lockGate(p)[0]);
      break;
    }
    case '01':
    case '01b': {
      add(typeGate());
      add(fileGate(p, 'specs/SPEC.md'));
      add(fileGate(p, 'specs/DECISION_LOG.md'));
      if (info.ui) add(fileGate(p, 'specs/DESIGN.md', 'UI project'));
      const spec = readText(p.spec);
      const placeholders = (spec.match(/\b(TBD|TODO|FIXME)\b/g) || []).length;
      add([!placeholders, placeholders ? `SPEC.md contains ${placeholders} TBD/TODO/FIXME placeholder(s)` : 'SPEC.md has no placeholders']);
      // Adoption reverse-engineers an existing system, so its README predates the spec; Stage 01 writes both.
      if (stage === '01') { add(interpretationGate(p)); add(docsGate(p)); }
      break;
    }
    case '02': {
      const { r, ctx } = runCheck(p, { contractsOnly: true });
      add([!r.errors.length, r.errors.length ? `sdd.cjs check --contracts: ${r.errors.length} error(s)` : 'sdd.cjs check --contracts passes']);
      const lg = fileGate(p, 'specs/logs/02-swarm.md', 'persisted iteration logs + Outcome Table', freshAfter);
      add(lg);
      if (lg[0]) add(outcomeTableGate(p, ctx));
      const outcomes = ctx.ops.reduce((n, o) => n + o.statuses.filter(x => x !== 'default').length, 0) + ctx.commands.reduce((n, c) => n + c.exitCodes.length, 0);
      add(expectDiffGate(p, freshAfter, false, Math.max(1, outcomes)));
      break;
    }
    case '03': {
      add([info.ui, info.ui ? 'UI project' : 'Stage 03 applies only to UI projects']);
      const html = exists(p.wireframes) ? fs.readdirSync(p.wireframes).filter(f => f.endsWith('.html')) : [];
      add([html.length > 0, `${html.length} wireframe(s) in specs/wireframes/`]);
      const design = readText(p.design);
      add([/^##\s+Approved Wireframes/m.test(design) && /\]\((\.\/)?wireframes\/[^)]+\.html\)/.test(design), 'DESIGN.md §Approved Wireframes links wireframes with relative paths']);
      if (html.length) wireframeContractGates(p).forEach(add);
      add(tokenAuditGate(p, '03', freshAfter));
      add(deferredUiGate(p));
      break;
    }
    case '04': {
      const { r } = runCheck(p, { contractsOnly: false });
      add([!r.errors.length, r.errors.length ? `sdd.cjs check: ${r.errors.length} error(s)` : 'sdd.cjs check passes (contracts, fixtures, coverage, phases)']);
      add(fileGate(p, 'specs/IMPLEMENTATION_PHASES.md'));
      add(fileGate(p, 'specs/phase-integrity-check.md', 'Stage 04 Part C', freshAfter));
      add(expectDiffGate(p, freshAfter, true));
      add(lockGate(p)[0]);
      break;
    }
    case '05': {
      const [lg, v] = lockGate(p);
      add(lg);
      if (nonBrowser) oracleRunGates(p, v.lock).forEach(add);
      if (browser) uiGates(p).forEach(add);
      if (browser) uiRepeatGates(p).forEach(add);
      add(phasesGatedGate(p));
      add(openScrGate(p));
      add(reconGate(p, freshAfter));
      break;
    }
    case '06': {
      const [lg, v] = lockGate(p);
      add([info.ui, info.ui ? 'UI project' : 'Stage 06 applies only to UI projects']);
      add(lg);
      uiGates(p).forEach(add);
      uiRepeatGates(p).forEach(add);
      if (exists(p.design)) add(tokenAuditGate(p, '06', freshAfter));
      add(fileGate(p, 'specs/vat-checklist.md', 'Stage 06 tracker', freshAfter));
      const vf = fileGate(p, 'specs/VAT_REPORT.md', 'Stage 06 report', freshAfter);
      add(vf[0] ? [VERDICT_PASS.test(readText(path.join(p.specs, 'VAT_REPORT.md'))), 'VAT_REPORT.md verdict PASS'] : vf);
      break;
    }
    case '07': {
      const [lg, v] = lockGate(p);
      add(lg);
      if (nonBrowser) oracleRunGates(p, v.lock).forEach(add);
      if (browser) uiGates(p).forEach(add);
      add(reconGate(p, null));
      const open = (readText(p.phases).match(/^\s*- \[ \]/gm) || []).length;
      add([exists(p.phases) && !open, exists(p.phases) ? (open ? `IMPLEMENTATION_PHASES.md has ${open} unchecked task(s)` : 'all implementation tasks checked') : 'missing specs/IMPLEMENTATION_PHASES.md']);
      if (info.ui) add([VERDICT_PASS.test(readText(path.join(p.specs, 'VAT_REPORT.md'))), 'VAT_REPORT.md verdict PASS (Stage 06)']);
      add(openScrGate(p));
      add(fileGate(p, 'specs/EQUIVALENCE_REPORT.md', 'Stage 07 report', freshAfter));
      const target = info.manifest ? info.manifest.equivalenceTarget : 2;
      if (target === 2) {
        if (nonBrowser) add(diffGate(p, v.lock, freshAfter, 'diff-', 'oracle diff'));
        if (browser) add(diffGate(p, v.lock, freshAfter, 'uidiff-', 'oracle diff-ui'));
      } else add([true, `equivalence target L1 (${info.manifest.equivalenceTargetDecision}; dual-build diff not required)`]);
      break;
    }
    default:
      add([false, `unknown stage ${stage}`]);
  }
  return gates;
}

/** The value of lastCompletedStep after completing `stage` (non-UI projects skip 03 and 06). */
function completedValue(stage, ui) {
  if (!ui && stage === '02') return 3;
  if (!ui && stage === '05') return 6;
  return L.STAGES[stage].num;
}

/** Is completing `stage` the next step of the pipeline from the current state? */
function orderCheck(stage, state, info) {
  const last = typeof state.lastCompletedStep === 'number' ? state.lastCompletedStep : 0;
  const n = L.STAGES[stage].num;
  if (stage === '00') return [true, 'Stage 00 may run at any time'];
  if ((stage === '03' || stage === '06') && !info.ui) return [false, `${L.STAGES[stage].name} applies only to UI projects`];
  if (completedValue(stage, info.ui) === last) return [true, `re-running ${L.STAGES[stage].name}`];
  if (stage === '01b' && last <= 0) return [true, 'adoption of an existing codebase'];
  if (stage === '01' && (last <= 0 || last === 7)) return [true, last === 7 ? 'new Class 1 iteration' : 'pipeline start'];
  if (stage === '04' && last === 1 && state.stepName === STAGES_01B) return [true, 'adoption option C (freeze as-is)'];
  if (stage === '05' && last === 7) return [true, 'Class 0 change on a certified build'];
  if (n === last + 1 && stage !== '01b') return [true, `next stage after lastCompletedStep=${last}`];
  return [false, `${L.STAGES[stage].name} is out of order: lastCompletedStep=${last} (${state.stepName || '—'}); run \`sdd.cjs status\` for the next stage, or pass --override DECnnn citing the user's decision to skip`];
}
const STAGES_01B = '01b_adoption';

function printGates(title, gates) {
  console.log(title);
  for (const [ok, label] of gates) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

function nextStage(state, info) {
  const last = state.lastCompletedStep;
  if (last === -1) return '01b';
  if (last === 0) return '01';
  if (last === 1) return '02';
  if (last === 2) return info.ui ? '03' : '04';
  if (last === 3) return '04';
  if (last === 4) return '05';
  if (last === 5) return info.ui ? '06' : '07';
  if (last === 6) return '07';
  return null;
}

// ========== Commands ==========

function cmdStatus(p) {
  const state = readState(p);
  const info = projectInfo(p, state);
  console.log('SDD status');
  console.log(`  state:  lastCompletedStep=${state.lastCompletedStep} (${state.stepName || '—'}) projectType=${info.projectType || 'unset'}${info.ui ? ' [UI]' : ''}`);
  if (state.notes) console.log(`          ${state.notes}`);
  const v = exists(p.lock) ? L.verifyLock(p.root) : null;
  if (!v) console.log('  lock:   none (frozen set is not locked yet)');
  else console.log(`  lock:   v${v.lock.lockVersion} ${v.lock.hash.slice(0, 12)} — ${v.valid ? 'INTACT' : `MODIFIED (${v.modified.length} changed, ${v.added.length} added, ${v.removed.length} removed)`}${v.lock.claim ? ` · claim ${v.lock.claim}` : ''}`);
  if (exists(p.phases) && v) console.log(`  build:  ${buildStatus(p, v)}`);
  else { const scrs = L.loadScrs(p).filter(x => x.open); if (scrs.length) console.log(`  SCRs:   open ${scrs.map(scrLabel).join(', ')}`); }
  const run = latestReport(p, 'run-', () => true);
  if (run) console.log(`  oracle: ${run.passed}/${run.total} passed on "${run.target}" at ${run.finishedAt}${v && run.lockHash === v.lock.hash ? '' : ' (STALE: different lock)'}${run.filtered ? ' (filtered)' : ''}`);
  const diff = latestReport(p, 'diff-', () => true);
  if (diff) console.log(`  diff:   ${diff.a} vs ${diff.b}: ${diff.divergentCases} divergent case(s) at ${diff.finishedAt}`);
  const next = nextStage(state, info);
  if (!next) {
    console.log('\nPipeline complete. Next change: Class 0 (non-observable) → 05; Class 1 (observable) → 01; Class 2 (defect) → 00.');
    return 0;
  }
  console.log(`\nNext stage: ${L.STAGES[next].name} → read specs/.sdd/${L.STAGES[next].name}/CONTEXT.md`);
  printGates(`Exit gates for ${next} (all must pass before \`sdd.cjs transition --completed ${next}\`):`, exitGates(next, p, state, info));
  return 0;
}

function cmdCheck(p, args) {
  const contractsOnly = !!args.flags.contracts;
  const { r } = runCheck(p, { contractsOnly });
  r.print(contractsOnly ? 'sdd check --contracts' : 'sdd check');
  return r.errors.length ? 1 : 0;
}

function cmdFreeze(p, args) {
  const reason = args.flags.reason;
  const by = args.flags['approved-by'];
  const prevLock = exists(p.lock) ? (() => { try { return L.readJson(p.lock); } catch { return null; } })() : null;
  // A re-freeze keeps the claim the user approved at the first freeze unless --claim restates it.
  let claim = typeof args.flags.claim === 'string' ? args.flags.claim : prevLock && prevLock.claim;
  if (typeof reason !== 'string' || typeof by !== 'string') fail('freeze requires --reason "<why>" and --approved-by "<who approved>"');
  if (typeof claim !== 'string' && !prevLock) fail('freeze requires --claim <grader-ready|two-build> (the certification claim the user approves; later freezes inherit it)');
  const { r, ctx } = runCheck(p, { contractsOnly: false });
  if (r.errors.length) { r.print('sdd check'); fail('\nfreeze refused: sdd.cjs check must pass first'); }
  // The certification claim is stated at the freeze, so no later summary can upgrade it.
  const target = ctx.manifest ? ctx.manifest.equivalenceTarget : 2;
  const claimFor = { 1: 'grader-ready', 2: 'two-build' };
  if (typeof claim !== 'string') {
    // A lock written before claims existed: record what its manifest already promised, and say so.
    claim = claimFor[target];
    console.log(`⚠ lock v${prevLock.lockVersion} records no claim; recording ${claim} from manifest.equivalenceTarget ${target}. Pass --claim to state it explicitly.`);
  }
  if (!Object.values(claimFor).includes(claim)) fail(`--claim must be grader-ready (one build graded by the oracle, L1) or two-build (Stage 07 dual build, L2), not "${claim}"`);
  if (claimFor[target] !== claim) {
    fail(`freeze refused: --claim ${claim} contradicts manifest.equivalenceTarget ${target} (${claimFor[target]}). `
      + (claim === 'grader-ready' ? 'A one-build freeze needs equivalenceTarget 1 with a DECnnn (Stage 07 §L1), or schedule build B and claim two-build.' : 'A two-build claim needs equivalenceTarget 2.'));
  }
  const proposed = L.loadScrs(p).filter(x => x.status === 'proposed' && !new RegExp(`\\b${x.id}\\b`).test(reason));
  if (proposed.length) {
    fail(`freeze refused: hotfix SCR(s) ${proposed.map(x => x.id).join(', ')} are still Proposed. Re-grade each one first (Stage 00 hotfix lane): apply it in this freeze (name it in --reason) or mark it Withdrawn.`);
  }
  const prev = exists(p.lock) ? L.verifyLock(p.root) : null;
  if (prev && prev.valid) { console.log(`Lock v${prev.lock.lockVersion} already matches the frozen set; nothing to freeze.`); return 0; }
  const cur = L.currentLockState(p.root);
  const now = new Date().toISOString();
  const history = prev
    ? [...(prev.lock.history || []), { lockVersion: prev.lock.lockVersion, frozenAt: prev.lock.frozenAt, reason: prev.lock.reason, approvedBy: prev.lock.approvedBy, claim: prev.lock.claim, hash: prev.lock.hash }]
    : [];
  const lock = {
    tool: 'sdd',
    toolVersion: L.TOOL_VERSION,
    lockVersion: prev ? prev.lock.lockVersion + 1 : 1,
    frozenAt: now,
    reason,
    approvedBy: by,
    claim,
    hash: cur.hash,
    files: cur.files,
    history,
  };
  if (prev) {
    console.log(`Re-freezing (v${prev.lock.lockVersion} → v${lock.lockVersion}). Changes:`);
    prev.modified.forEach(f => console.log(`  ~ ${f}`));
    prev.added.forEach(f => console.log(`  + ${f}`));
    prev.removed.forEach(f => console.log(`  - ${f}`));
  }
  L.writeJson(p.lock, lock);
  console.log(`Frozen ${Object.keys(cur.files).length} file(s) as lock v${lock.lockVersion} (${cur.hash.slice(0, 12)}), claim ${claim} → specs/spec.lock.json`);
  return 0;
}

function cmdVerify(p) {
  const v = L.verifyLock(p.root);
  if (!v.exists) { console.log('✗ no specs/spec.lock.json — nothing is frozen yet'); return 1; }
  if (v.valid) { console.log(`✓ frozen set intact: lock v${v.lock.lockVersion} (${v.lock.hash.slice(0, 12)}), ${Object.keys(v.lock.files).length} file(s)`); return 0; }
  console.log(`✗ frozen set differs from lock v${v.lock.lockVersion}:`);
  if (!v.intact) console.log('  ! spec.lock.json hash does not match its own file list (lock edited by hand)');
  v.modified.forEach(f => console.log(`  ~ ${f}`));
  v.added.forEach(f => console.log(`  + ${f}`));
  v.removed.forEach(f => console.log(`  - ${f}`));
  console.log('Frozen files change only via a Stage 00 Spec Change Request approved by the user, then `sdd.cjs freeze`.');
  return 1;
}

function cmdTransition(p, args) {
  const stage = L.normalizeStage(args.flags.completed);
  if (!stage) fail(`transition requires --completed <stage>\n\n${USAGE}`);
  const resume = args.flags.resume !== undefined ? L.normalizeStage(args.flags.resume) : null;
  if (args.flags.resume !== undefined && !resume) fail(`invalid --resume ${args.flags.resume}`);
  const state = readState(p);
  const matrix = L.readJson(p.matrix);
  if (args.flags['project-type'] !== undefined) {
    if (!matrix.types[args.flags['project-type']]) fail(`unknown project type "${args.flags['project-type']}" (${Object.keys(matrix.types).join(', ')})`);
    state.projectType = args.flags['project-type'];
  }
  const info = projectInfo(p, state);
  if (resume === '00') fail('--resume cannot be 00; resume at the stage where the pipeline continues');
  let order = orderCheck(stage, state, info);
  const override = args.flags.override;
  if (!order[0] && typeof override === 'string') {
    if (!/^DEC\d+$/.test(override) || !new RegExp(`\\b${override}\\b`).test(readText(p.decisionLog))) fail(`--override ${override} must cite a DECnnn entry in specs/DECISION_LOG.md recording the user's decision`);
    order = [true, `order overridden by ${override}`];
  }
  let tokens = null;
  if (args.flags.tokens !== undefined) {
    tokens = parseTokens(args.flags.tokens);
    if (!tokens) fail('--tokens takes whole token counts: --tokens orchestrator=184000,subagents=2310000 (unit: tokens; no k/mil suffixes)');
  }
  const gates = [order, ...exitGates(stage, p, state, info, { resume })];
  printGates(`Exit gates for ${L.STAGES[stage].name}:`, gates);
  if (gates.some(([ok]) => !ok)) {
    // Refusals are part of the record: the scoreboard counts gate reruns per stage.
    fs.mkdirSync(p.logs, { recursive: true });
    fs.appendFileSync(p.transitions, JSON.stringify({ ts: new Date().toISOString(), refused: L.STAGES[stage].name, failed: gates.filter(([ok]) => !ok).map(([, l]) => l) }) + '\n');
    console.log('\n✗ transition refused: fix the failing gates first. Nothing that depends on this stage (a commit, a handoff) may run.');
    return 1;
  }

  let last = L.STAGES[stage].num;
  let note = typeof args.flags.note === 'string' ? args.flags.note : `Completed ${L.STAGES[stage].name}`;
  if (stage === '00') {
    // Resume means "that stage is next": 01b is reached from -1 (the extension's "Pending Adoption").
    last = resume === '01b' ? -1 : L.STAGES[resume].num - 1;
    note = `${note}; resume at ${L.STAGES[resume].name}`;
  } else if (!info.ui && stage === '02') {
    last = 3;
    note = `${note}; 03 skipped (non-UI project)`;
  } else if (!info.ui && stage === '05') {
    last = 6;
    note = `${note}; 06 skipped (non-UI project)`;
  }
  const v = exists(p.lock) ? L.verifyLock(p.root) : null;
  const now = new Date().toISOString();
  // Preserve unknown fields: other tools (e.g. the SDD VS Code extension) share this file.
  const next = { ...state, lastCompletedStep: last, stepName: L.STAGES[stage].name, projectType: info.projectType, timestamp: now, notes: note };
  L.writeJson(p.state, next);
  fs.mkdirSync(p.logs, { recursive: true });
  const metrics = stageMetrics(p, stage, v, tokens);
  appendScoreboard(p, now, stage, metrics);
  fs.appendFileSync(p.transitions, JSON.stringify({ ts: now, completed: L.STAGES[stage].name, resume: resume ? L.STAGES[resume].name : null, lastCompletedStep: last, lockHash: v && v.valid ? v.lock.hash : null, note, metrics }) + '\n');
  console.log(`\n✓ ${L.STAGES[stage].name} complete → lastCompletedStep=${last}. ${note}`);
  console.log('  scoreboard row → specs/logs/scoreboard.md');
  return 0;
}

function parseTokens(v) {
  if (typeof v !== 'string') return null;
  const out = {};
  for (const part of v.split(',')) {
    const m = part.trim().match(/^(orchestrator|subagents)=(\d+)$/);
    if (!m) return null;
    out[m[1]] = Number(m[2]);
  }
  return Object.keys(out).length ? out : null;
}

/** Red Team rounds from `Findings: API n · UI m` lines in the Stage 02 log (iteration-log-format.md). */
function redTeamRounds(p) {
  return [...readText(path.join(p.logs, '02-swarm.md')).matchAll(/^\**Findings:?\**:?\s*API\s+(\d+)\s*[·|,/]\s*UI\s+(\d+)/gim)].map(m => [Number(m[1]), Number(m[2])]);
}

function stageMetrics(p, stage, v, tokens) {
  const scrs = L.loadScrs(p);
  const decs = new Set(readText(p.decisionLog).match(/\bDEC\d+\b/g) || []).size;
  const history = readJsonl(p.transitions);
  let since = -1;
  history.forEach((x, i) => { if (x.completed) since = i; });
  const name = L.STAGES[stage].name;
  const refusals = history.slice(since + 1).filter(x => x.refused === name).length;
  const prevDecs = (([...history].reverse().find(x => x.metrics) || {}).metrics || {}).decisionRows;
  const exp = latestReport(p, 'expectdiff-', () => true);
  const gated = phaseLog(p);
  const last = gated[gated.length - 1];
  return {
    lock: v && v.lock ? `v${v.lock.lockVersion} ${v.lock.hash.slice(0, 12)}${v.valid ? '' : ' (broken)'}` : 'none',
    openScrs: scrs.filter(x => x.open).map(x => x.id),
    scrTotal: scrs.length,
    lastGatedPhase: last ? { phase: last.phase, head: last.head ? last.head.slice(0, 7) : null } : null,
    decisionRows: decs,
    decisionRowsAdded: typeof prevDecs === 'number' ? decs - prevDecs : null,
    interpretationGaps: exp ? exp.divergentCases || 0 : null,
    redTeamRounds: stage === '02' ? redTeamRounds(p) : null,
    gateRefusals: refusals,
    tokens,
  };
}

const SCOREBOARD_HEAD = '| When (UTC) | Stage | Lock | Open SCRs | SCRs | Last green phase | DEC rows (+new) | Open interp. gaps | Red Team findings per round (API/UI) | Gate refusals | Tokens: orchestrator / subagents |\n|---|---|---|---|---|---|---|---|---|---|---|\n';

/** One row per completed stage, written by the gate so no summary can describe a different curve. */
function appendScoreboard(p, now, stage, m) {
  const f = path.join(p.logs, 'scoreboard.md');
  fs.mkdirSync(p.logs, { recursive: true });
  if (!exists(f)) fs.writeFileSync(f, `# SDD scoreboard\n\nWritten by \`sdd.cjs transition\`. Token counts are whole tokens (not thousands).\n\n${SCOREBOARD_HEAD}`);
  const cell = x => (x === null || x === undefined || x === '' ? '—' : String(x));
  const rounds = m.redTeamRounds && m.redTeamRounds.length ? m.redTeamRounds.map(([a, u], i) => `r${i + 1} ${a}/${u}`).join(', ') : null;
  const tok = m.tokens ? `${cell(m.tokens.orchestrator)} / ${cell(m.tokens.subagents)}` : 'not reported';
  const row = [now.slice(0, 16).replace('T', ' '), L.STAGES[stage].name, m.lock, m.openScrs.join(', ') || 'none', m.scrTotal,
    m.lastGatedPhase ? `${m.lastGatedPhase.phase}${m.lastGatedPhase.head ? ` @ ${m.lastGatedPhase.head}` : ''}` : null,
    `${m.decisionRows}${m.decisionRowsAdded !== null ? ` (+${m.decisionRowsAdded})` : ''}`, m.interpretationGaps, rounds, m.gateRefusals, tok];
  fs.appendFileSync(f, `| ${row.map(cell).join(' | ')} |\n`);
}

/** Stage 05 phase gate. A phase is done only here: graded green, committed alone, nothing open behind it. */
function cmdPhase(p, args) {
  const n = Number(args.flags.completed);
  if (!Number.isInteger(n) || n < 1) fail('phase requires --completed <N> (a phase number from specs/IMPLEMENTATION_PHASES.md)');
  const phases = L.parsePhases(readText(p.phases));
  const state = readState(p);
  const info = projectInfo(p, state);
  const gates = [];
  const add = g => gates.push(g);
  add([phases.includes(n), phases.includes(n) ? `Phase ${n} is in IMPLEMENTATION_PHASES.md` : `Phase ${n} is not a "## Phase ${n}" heading in IMPLEMENTATION_PHASES.md`]);
  const done = gatedPhases(p);
  const earlier = phases.filter(x => x < n && !done.has(x));
  add([!earlier.length, earlier.length ? `earlier phase(s) ${earlier.join(', ')} not gated yet — gate them first, in order` : 'every earlier phase is gated']);
  const [lg, v] = lockGate(p);
  add(lg);
  add(openScrGate(p));
  let cases = [];
  try { cases = L.loadCases(p).cases; } catch { cases = []; }
  const browser = info.interfaces.includes('browser');
  const needOracle = cases.some(c => !c.probe && c.phase !== undefined && c.phase <= n); // cumulative regression
  const uiPhase = browser && !cases.some(c => !c.probe && c.phase === n); // graded by the frozen UI specs
  const git = L.gitState(p.root);
  if (git && !git.head) add([false, `no commit yet: commit phase ${n} alone, then grade that commit`]);
  let rep = null;
  if (needOracle) {
    rep = latestReport(p, 'run-default', x => x.target === 'default');
    const f = rep && rep.filters ? rep.filters : {};
    const covers = rep && !f.case && !f.suite && !f.bail && (f.phase === undefined || Number(f.phase) >= n);
    if (!rep) add([false, `no oracle run on "default" (node specs/.sdd/scripts/oracle.cjs run --phase ${n})`]);
    else if (!v.lock || rep.lockHash !== v.lock.hash || !rep.lockValid) add([false, 'latest oracle run was not made against the current, intact lock; re-run']);
    else if (!covers) add([false, `latest oracle run does not grade phase ${n} cumulatively (it used ${JSON.stringify(f)}); run oracle.cjs run --phase ${n}`]);
    else if (rep.failed || rep.errored || !rep.total) add([false, `oracle --phase ${f.phase || 'all'}: ${rep.passed}/${rep.total} passed, ${rep.failed} failed, ${rep.errored} errored — the phase stays open`]);
    else add([true, `oracle --phase ${f.phase || 'all'}: ${rep.passed}/${rep.total} passed against lock v${v.lock.lockVersion}`]);
    if (rep && !(git && !git.head)) add(E.gate(E.check(p.root, rep, { rerun: `node specs/.sdd/scripts/oracle.cjs run --phase ${n}` })));
  } else if (!uiPhase) add([false, `phase ${n} has no oracle cases at or below it (sdd.cjs check should have refused the freeze)`]);
  if (uiPhase) uiPhaseGates(p, n).forEach(add);
  if (git) {
    add([!git.dirty.length, git.dirty.length ? `working tree has ${git.dirty.length} uncommitted file(s) outside the Stage 05 working files (${git.dirty.slice(0, 5).join(', ')}): they are not phase ${n} as graded` : 'working tree clean outside the Stage 05 working files']);
  } else add([true, 'not a git repository: the one-phase-per-commit boundary is not checked']);
  printGates(`Phase gate for Phase ${n}:`, gates);
  if (gates.some(([ok]) => !ok)) {
    console.log(`\n✗ Phase ${n} is not done. ⊥ start Phase ${n + 1} files in this tree until this gate passes.`);
    return 1;
  }
  const entry = { ts: new Date().toISOString(), phase: n, title: phaseTitles(p).get(n), lockVersion: v.lock.lockVersion, lockHash: v.lock.hash, head: git ? git.head : null, run: rep ? { finishedAt: rep.finishedAt, passed: rep.passed, total: rep.total, phaseFilter: rep.filters ? rep.filters.phase : undefined } : null, ui: uiPhase };
  fs.mkdirSync(p.logs, { recursive: true });
  fs.appendFileSync(path.join(p.logs, 'phases.jsonl'), JSON.stringify(entry) + '\n');
  const next = phases.find(x => x > n);
  console.log(`\n✓ Phase ${n} done${git ? ` at ${git.head.slice(0, 7)}` : ''} (lock v${v.lock.lockVersion}). Tick its boxes in IMPLEMENTATION_PHASES.md.${next ? ` Phase ${next} may start now.` : ' All phases gated: run the unfiltered oracle and reconciliation.'}`);
  return 0;
}

function cmdTokenAudit(p, args) {
  const stage = L.normalizeStage(args.flags.stage);
  if (stage !== '03' && stage !== '06') fail('token-audit requires --stage 03 (wireframe CSS) or --stage 06 (computed styles of the build)');
  if (!exists(p.design)) fail('no specs/DESIGN.md');
  let out;
  try { out = tokenAuditSkeleton(p, stage); } catch (e) { fail(`DESIGN.md front matter: ${e.message}`); }
  process.stdout.write(out);
  return 0;
}

/** The build's position, for every user-facing Stage 05–07 update. */
function buildStatus(p, v) {
  const phases = L.parsePhases(readText(p.phases));
  const gated = phaseLog(p);
  const last = gated[gated.length - 1];
  const done = new Set(gated.map(x => x.phase));
  const open = phases.find(x => !done.has(x));
  const all = L.loadScrs(p);
  const scrs = all.filter(x => x.open);
  const proposed = all.filter(x => x.status === 'proposed');
  const git = L.gitState(p.root);
  const parts = [];
  parts.push(last ? `last green phase ${last.phase}${last.head ? ` @ ${last.head.slice(0, 7)}` : ''}${v && v.lock && last.lockHash !== v.lock.hash ? ` (lock v${last.lockVersion}, not current)` : ''}` : 'no phase gated yet');
  parts.push(open !== undefined ? `open phase ${open}` : phases.length ? 'all phases gated' : 'no phases');
  parts.push(`open SCRs: ${scrs.length ? scrs.map(scrLabel).join(', ') : 'none'}`);
  if (proposed.length) parts.push(`hotfix SCRs to re-grade at the next freeze: ${proposed.map(x => x.id).join(', ')}`);
  if (git) parts.push(git.dirty.length ? `working tree: ${git.dirty.length} uncommitted file(s) — later-phase work is not graded` : 'working tree clean');
  return parts.join(' · ');
}

function cmdExport(p, args) {
  const dir = args._[1];
  if (!dir) fail('export requires a target directory');
  const out = path.resolve(dir);
  const update = !!args.flags.update;
  const bLock = path.join(out, 'specs', 'spec.lock.json');
  if (!update && exists(out) && fs.readdirSync(out).length) fail(`${out} exists and is not empty (use --update to resync an existing build-B workspace)`);
  if (update && !exists(bLock)) fail(`--update needs an existing exported workspace (no ${bLock})`);
  const v = L.verifyLock(p.root);
  if (!v.valid) fail('export refused: the frozen set must be locked and intact (sdd.cjs verify)');
  const bPhases = update && exists(path.join(out, 'specs', 'IMPLEMENTATION_PHASES.md')) ? fs.readFileSync(path.join(out, 'specs', 'IMPLEMENTATION_PHASES.md'), 'utf8') : '';
  const bState = update && exists(path.join(out, 'specs/.sdd/_config/sdd-state.json')) ? L.readJson(path.join(out, 'specs/.sdd/_config/sdd-state.json')) : null;
  if (update) {
    // Remove frozen files that no longer exist in the new lock; B's own code is never touched.
    for (const f of Object.keys(L.readJson(bLock).files)) if (!(f in v.lock.files)) fs.rmSync(path.join(out, f), { force: true });
  }
  const copy = (relPath, transform) => {
    const src = path.join(p.root, relPath);
    const dst = path.join(out, relPath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (transform) fs.writeFileSync(dst, transform(fs.readFileSync(src, 'utf8')));
    else fs.copyFileSync(src, dst);
  };
  for (const f of Object.keys(v.lock.files)) copy(f);
  copy('specs/spec.lock.json');
  if (exists(p.phases)) {
    // Fresh export: every task unchecked. Update: keep B's progress on tasks whose text is unchanged.
    const doneInB = new Set(bPhases.split(/\r?\n/).filter(l => /^\s*- \[x\]/i.test(l)).map(l => l.replace(/^\s*- \[x\]/i, '').trim()));
    copy('specs/IMPLEMENTATION_PHASES.md', t => t.split(/\r?\n/).map(l => {
      const m = l.match(/^(\s*)- \[[ x]\](.*)$/i);
      if (!m) return l;
      return `${m[1]}- [${doneInB.has(m[2].trim()) ? 'x' : ' '}]${m[2]}`;
    }).join('\n'));
  }
  // Entry files are regenerated from the frozen entrypoint, never copied: a project's own
  // CLAUDE.md/AGENTS.md can carry information outside the spec (a side channel).
  if (exists(p.entrypoint)) {
    const entry = fs.readFileSync(p.entrypoint, 'utf8');
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.cursorrules']) fs.writeFileSync(path.join(out, f), entry);
  }
  const state = readState(p);
  L.writeJson(path.join(out, 'specs/.sdd/_config/sdd-state.json'), {
    ...(bState || {}),
    lastCompletedStep: bState ? Math.min(bState.lastCompletedStep, 4) : 4,
    stepName: L.STAGES['04'].name,
    projectType: projectInfo(p, state).projectType,
    timestamp: new Date().toISOString(),
    notes: `Independent equivalence build ${update ? 'resynced to' : 'exported from'} lock v${v.lock.lockVersion} (${v.lock.hash.slice(0, 12)}). Build with Stage 05 using ONLY these files.`,
  });
  console.log(`${update ? 'Resynced' : 'Exported'} ${Object.keys(v.lock.files).length} frozen file(s) ${update ? 'into' : 'to'} ${out}`);
  console.log('Next: open that directory in a FRESH agent session (no access to the first implementation) and run Stage 05.');
  return 0;
}

function main() {
  const args = L.parseArgs(process.argv.slice(2));
  const root = typeof args.flags.root === 'string' ? path.resolve(args.flags.root) : L.defaultRoot();
  const p = L.projectPaths(root);
  const commands = { status: cmdStatus, check: cmdCheck, freeze: cmdFreeze, verify: cmdVerify, phase: cmdPhase, transition: cmdTransition, 'token-audit': cmdTokenAudit, export: cmdExport };
  const cmd = commands[args._[0]];
  if (!cmd) { console.log(USAGE); return args._[0] ? 2 : 0; }
  return cmd(p, args);
}

// Exit quietly when stdout is closed early (e.g. piped into `head`).
process.stdout.on('error', e => { if (e.code === 'EPIPE') process.exit(process.exitCode || 0); throw e; });

process.exitCode = main();
