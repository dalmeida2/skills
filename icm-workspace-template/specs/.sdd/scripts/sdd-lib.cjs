'use strict';
/**
 * Shared helpers for the SDD tooling (sdd.cjs, oracle.cjs).
 * Zero dependencies — requires Node.js >= 18.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { parseYaml } = require('./yaml-lite.cjs');

// The template release, suffix included: reports and stamps record which tools graded them.
const TOOL_VERSION = '2026.10.01-v3+sky.3';

// ========== Paths ==========

function defaultRoot() {
  // scripts/ → .sdd/ → specs/ → project root
  return path.resolve(__dirname, '..', '..', '..');
}

function projectPaths(root) {
  const specs = path.join(root, 'specs');
  const sdd = path.join(specs, '.sdd');
  // Pipeline configuration travels with the tools (so --root can point at any project or example);
  // project state lives in the project.
  const toolConfig = path.resolve(__dirname, '..', '_config');
  return {
    root,
    specs,
    sdd,
    config: toolConfig,
    schemas: path.join(toolConfig, 'schemas'),
    matrix: path.join(toolConfig, 'contract-matrix.json'),
    entrypoint: path.join(toolConfig, 'entrypoint.md'),
    state: path.join(sdd, '_config', 'sdd-state.json'),
    contracts: path.join(specs, 'contracts'),
    manifest: path.join(specs, 'contracts', 'manifest.json'),
    fixtures: path.join(specs, 'fixtures'),
    cases: path.join(specs, 'fixtures', 'cases'),
    oracleConfig: path.join(specs, 'fixtures', 'oracle.config.json'),
    uiFixtures: path.join(specs, 'fixtures', 'ui'),
    lock: path.join(specs, 'spec.lock.json'),
    logs: path.join(specs, 'logs'),
    oracleLogs: path.join(specs, 'logs', 'oracle'),
    transitions: path.join(specs, 'logs', 'transitions.jsonl'),
    spec: path.join(specs, 'SPEC.md'),
    design: path.join(specs, 'DESIGN.md'),
    decisionLog: path.join(specs, 'DECISION_LOG.md'),
    phases: path.join(specs, 'IMPLEMENTATION_PHASES.md'),
    wireframes: path.join(specs, 'wireframes'),
  };
}

function rel(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

// ========== CLI args ==========

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { out.flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out.flags[name] = next; i++; }
    else out.flags[name] = true;
  }
  return out;
}

// ========== JSON ==========

function readJson(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { throw new Error(`cannot read ${file}: ${e.code || e.message}`); }
  try { return JSON.parse(text.replace(/^﻿/, '')); }
  catch (e) { throw new Error(`invalid JSON in ${file}: ${e.message}`); }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function jsonType(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v; // string | number | boolean | object
}

function deepEqual(a, b) {
  if (a === b) return true;
  const ta = jsonType(a);
  if (ta !== jsonType(b)) return false;
  if (ta === 'array') return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (ta === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// ========== JSON Schema (draft 2020-12 subset) ==========
// Supports: type, const, enum, pattern, minLength, maxLength, minimum, maximum,
// items, minItems, maxItems, uniqueItems, required, properties, patternProperties,
// additionalProperties, minProperties, propertyNames, allOf, anyOf, oneOf, not, $ref (#/...).

function validateSchema(schema, data) {
  const errs = [];
  checkSchema(schema, data, '$', schema, errs);
  return errs;
}

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  const target = ref.slice(2).split('/').reduce(
    (o, k) => (o == null ? undefined : o[k.replace(/~1/g, '/').replace(/~0/g, '~')]), root);
  if (target === undefined) throw new Error(`unresolvable $ref ${ref}`);
  return target;
}

function checkSchema(s, d, p, root, errs) {
  if (s === true || s === undefined) return;
  if (s === false) { errs.push(`${p}: not allowed`); return; }
  if (s.$ref) checkSchema(resolveRef(root, s.$ref), d, p, root, errs);
  if (s.type) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const t = jsonType(d);
    const ok = types.some(x => x === t || (x === 'integer' && t === 'number' && Number.isInteger(d)));
    if (!ok) { errs.push(`${p}: expected ${types.join('|')}, got ${t}`); return; }
  }
  if (Object.prototype.hasOwnProperty.call(s, 'const') && !deepEqual(s.const, d)) {
    errs.push(`${p}: must equal ${JSON.stringify(s.const)}`);
  }
  if (s.enum && !s.enum.some(e => deepEqual(e, d))) {
    errs.push(`${p}: must be one of ${s.enum.map(e => JSON.stringify(e)).join(', ')}`);
  }
  if (typeof d === 'string') {
    const len = [...d].length;
    if (s.minLength !== undefined && len < s.minLength) errs.push(`${p}: shorter than ${s.minLength}`);
    if (s.maxLength !== undefined && len > s.maxLength) errs.push(`${p}: longer than ${s.maxLength}`);
    if (s.pattern && !new RegExp(s.pattern, 'u').test(d)) errs.push(`${p}: must match /${s.pattern}/`);
  }
  if (typeof d === 'number') {
    if (s.minimum !== undefined && d < s.minimum) errs.push(`${p}: must be >= ${s.minimum}`);
    if (s.maximum !== undefined && d > s.maximum) errs.push(`${p}: must be <= ${s.maximum}`);
  }
  if (Array.isArray(d)) {
    if (s.minItems !== undefined && d.length < s.minItems) errs.push(`${p}: needs at least ${s.minItems} item(s)`);
    if (s.maxItems !== undefined && d.length > s.maxItems) errs.push(`${p}: allows at most ${s.maxItems} item(s)`);
    if (s.items) d.forEach((x, i) => checkSchema(s.items, x, `${p}[${i}]`, root, errs));
    if (s.uniqueItems && d.some((x, i) => d.findIndex(y => deepEqual(x, y)) !== i)) errs.push(`${p}: items must be unique`);
  }
  if (jsonType(d) === 'object') {
    for (const r of s.required || []) {
      if (!Object.prototype.hasOwnProperty.call(d, r)) errs.push(`${p}: missing required property "${r}"`);
    }
    const props = s.properties || {};
    const pats = Object.entries(s.patternProperties || {}).map(([k, v]) => [new RegExp(k, 'u'), v]);
    for (const [k, v] of Object.entries(d)) {
      const cp = `${p}.${k}`;
      let matched = false;
      if (Object.prototype.hasOwnProperty.call(props, k)) { matched = true; checkSchema(props[k], v, cp, root, errs); }
      for (const [re, ps] of pats) if (re.test(k)) { matched = true; checkSchema(ps, v, cp, root, errs); }
      if (!matched && s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) errs.push(`${cp}: unknown property`);
        else checkSchema(s.additionalProperties, v, cp, root, errs);
      }
    }
    if (s.minProperties !== undefined && Object.keys(d).length < s.minProperties) {
      errs.push(`${p}: needs at least ${s.minProperties} propert(ies)`);
    }
    if (s.propertyNames) for (const k of Object.keys(d)) checkSchema(s.propertyNames, k, `${p}{${k}}`, root, errs);
  }
  if (s.allOf) s.allOf.forEach(x => checkSchema(x, d, p, root, errs));
  if (s.anyOf || s.oneOf) {
    const alts = s.anyOf || s.oneOf;
    const results = alts.map(x => { const e = []; checkSchema(x, d, p, root, e); return e; });
    const passing = results.filter(e => e.length === 0).length;
    if (passing === 0) {
      const best = results.reduce((a, b) => (b.length < a.length ? b : a));
      errs.push(`${p}: does not match any allowed shape; closest mismatch:`);
      errs.push(...best.map(e => `    ${e}`));
    } else if (s.oneOf && passing > 1) {
      errs.push(`${p}: matches more than one exclusive shape`);
    }
  }
  if (s.not) {
    const e = [];
    checkSchema(s.not, d, p, root, e);
    if (e.length === 0) errs.push(`${p}: matches a forbidden shape`);
  }
}

function loadSchema(paths, name) {
  return readJson(path.join(paths.schemas, name));
}

// ========== Matchers (oracle expectations) ==========

const TYPE_PATTERNS = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  uuidv4: /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  uuidv7: /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  // Equivalence Profile SER-2: RFC 3339, UTC, millisecond precision, Z suffix.
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  rfc3339: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  base64: /^[A-Za-z0-9+/]*={0,2}$/,
  base64url: /^[A-Za-z0-9_-]*$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
  uri: /^[a-zA-Z][a-zA-Z0-9+.-]*:\S+$/,
};
const JSON_TYPES = ['string', 'number', 'integer', 'boolean', 'null', 'array', 'object'];
const MATCHER_KEYS = ['$type', '$regex', '$any', '$oneOf', '$absent', '$eq'];
// Matchers that declare a value as a permitted degree of freedom (masked in `oracle diff`).
const VARIABLE_MATCHER_KEYS = ['$type', '$regex', '$any', '$oneOf'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isMatcher(v) {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every(k => MATCHER_KEYS.includes(k));
}

function isVariableMatcher(v) {
  return isMatcher(v) && Object.keys(v).some(k => VARIABLE_MATCHER_KEYS.includes(k));
}

/** Static validation of matcher syntax inside an expectation value. */
function lintMatchers(value, at, errs) {
  if (Array.isArray(value)) { value.forEach((x, i) => lintMatchers(x, `${at}[${i}]`, errs)); return; }
  if (!isPlainObject(value)) return;
  const keys = Object.keys(value);
  const dollar = keys.filter(k => k.startsWith('$'));
  if (dollar.length && dollar.length !== keys.length) {
    errs.push(`${at}: mixes matcher keys (${dollar.join(', ')}) with literal keys; wrap literals in {"$eq": ...}`);
    return;
  }
  if (dollar.length) {
    if (dollar.includes('$unspecified')) { errs.push(`${at}: unresolved {"$unspecified": ...} — a spec gap; fix the spec, then write the derived value`); return; }
    for (const k of dollar) if (!MATCHER_KEYS.includes(k)) errs.push(`${at}: unknown matcher "${k}"`);
    if (value.$type !== undefined && !JSON_TYPES.includes(value.$type) && !TYPE_PATTERNS[value.$type]) {
      errs.push(`${at}: unknown $type "${value.$type}" (allowed: ${[...JSON_TYPES, ...Object.keys(TYPE_PATTERNS)].join(', ')})`);
    }
    if (value.$regex !== undefined) {
      try { new RegExp(value.$regex, 'u'); } catch (e) { errs.push(`${at}: invalid $regex: ${e.message}`); }
    }
    if (value.$oneOf !== undefined) {
      if (!Array.isArray(value.$oneOf) || value.$oneOf.length < 2) errs.push(`${at}: $oneOf needs an array of >= 2 alternatives`);
      else value.$oneOf.forEach((x, i) => lintMatchers(x, `${at}.$oneOf[${i}]`, errs));
    }
    if (value.$absent !== undefined && value.$absent !== true) errs.push(`${at}: $absent must be true`);
    if (value.$any !== undefined && value.$any !== true) errs.push(`${at}: $any must be true`);
    return;
  }
  for (const [k, v] of Object.entries(value)) lintMatchers(v, `${at}.${k}`, errs);
}

function typeMatches(t, v) {
  if (t === 'integer') return Number.isInteger(v);
  if (JSON_TYPES.includes(t)) return jsonType(v) === t;
  const re = TYPE_PATTERNS[t];
  return typeof v === 'string' && !!re && re.test(v);
}

function applyMatcher(m, actual, at, out, opts = { mode: 'exact' }) {
  // Object properties and headers handle $absent before reaching here, so a value exists at this point.
  if (m.$absent) out.push({ path: at, reason: 'expected to be absent', actual });
  if ('$eq' in m && !deepEqual(m.$eq, actual)) out.push({ path: at, reason: 'value mismatch', expected: m.$eq, actual });
  if (m.$type !== undefined && !typeMatches(m.$type, actual)) out.push({ path: at, reason: `expected $type ${m.$type}`, actual });
  if (m.$regex !== undefined && (typeof actual !== 'string' || !new RegExp(m.$regex, 'u').test(actual))) {
    out.push({ path: at, reason: `expected to match /${m.$regex}/`, actual });
  }
  if (m.$oneOf !== undefined && !m.$oneOf.some(alt => matchJson(alt, actual, opts).length === 0)) {
    out.push({ path: at, reason: 'matches none of $oneOf', expected: m.$oneOf, actual });
  }
}

/**
 * Compare an expectation (with matchers) against an actual JSON value.
 * mode 'exact': objects must have exactly the expected keys. mode 'subset': extra keys allowed.
 * Arrays always compare length and order.
 */
function matchJson(expected, actual, opts, at = '$', out = []) {
  if (isMatcher(expected)) { applyMatcher(expected, actual, at, out, opts); return out; }
  const et = jsonType(expected);
  const tt = jsonType(actual);
  if (et === 'array') {
    if (tt !== 'array') { out.push({ path: at, reason: `expected array, got ${tt}`, actual }); return out; }
    if (expected.length !== actual.length) {
      out.push({ path: at, reason: `expected ${expected.length} item(s), got ${actual.length}`, actual });
      return out;
    }
    expected.forEach((e, i) => matchJson(e, actual[i], opts, `${at}[${i}]`, out));
    return out;
  }
  if (et === 'object') {
    if (tt !== 'object') { out.push({ path: at, reason: `expected object, got ${tt}`, actual }); return out; }
    for (const [k, e] of Object.entries(expected)) {
      const cp = `${at}.${k}`;
      const present = Object.prototype.hasOwnProperty.call(actual, k);
      if (isMatcher(e) && e.$absent) {
        if (present) out.push({ path: cp, reason: 'expected property to be absent', actual: actual[k] });
        continue;
      }
      if (!present) { out.push({ path: cp, reason: 'missing property', expected: e }); continue; }
      matchJson(e, actual[k], opts, cp, out);
    }
    if (opts.mode !== 'subset') {
      for (const k of Object.keys(actual)) {
        if (!Object.prototype.hasOwnProperty.call(expected, k)) out.push({ path: `${at}.${k}`, reason: 'unexpected property', actual: actual[k] });
      }
    }
    return out;
  }
  if (expected !== actual) out.push({ path: at, reason: 'value mismatch', expected, actual });
  return out;
}

/** Collect concrete paths whose expectation is a variable matcher (permitted degrees of freedom). */
function variablePathsOf(expected, at = '$', out = new Set()) {
  if (isVariableMatcher(expected)) { out.add(at); return out; }
  if (Array.isArray(expected)) expected.forEach((e, i) => variablePathsOf(e, `${at}[${i}]`, out));
  else if (isPlainObject(expected) && !isMatcher(expected)) {
    for (const [k, v] of Object.entries(expected)) variablePathsOf(v, `${at}.${k}`, out);
  }
  return out;
}

/** Compile a JSONPath-like pattern: $.a.b, $..key, $.items[*].id, $.*.x */
function compilePathPattern(pat) {
  if (typeof pat !== 'string' || !pat.startsWith('$')) throw new Error(`invalid path pattern "${pat}" (must start with $)`);
  const body = pat.slice(1);
  const tokens = body.match(/\.\.[^.[\]]+|\.[^.[\]]+|\[\*\]|\[\d+\]/g) || [];
  if (tokens.join('') !== body) throw new Error(`invalid path pattern "${pat}"`);
  let re = '^\\$';
  for (const t of tokens) {
    if (t.startsWith('..')) re += '(?:\\.[^.\\[]+|\\[\\d+\\])*\\.' + escapeRegex(t.slice(2));
    else if (t === '.*') re += '\\.[^.\\[]+';
    else if (t.startsWith('.')) re += '\\.' + escapeRegex(t.slice(1));
    else if (t === '[*]') re += '\\[\\d+\\]';
    else re += escapeRegex(t);
  }
  return new RegExp(re + '$');
}

// ========== Templates ==========

function newGenerator() {
  return { named: new Map(), seq: [], idx: 0, replay: false };
}

function resolveToken(tok, vars, gen) {
  if (tok === '$uuid' || tok.startsWith('$uuid:')) {
    const name = tok.slice(6);
    if (name) {
      if (!gen.named.has(name)) gen.named.set(name, crypto.randomUUID());
      return gen.named.get(name);
    }
    if (gen.replay && gen.idx < gen.seq.length) return gen.seq[gen.idx++];
    const v = crypto.randomUUID();
    gen.seq.push(v);
    gen.idx++;
    return v;
  }
  if (tok.startsWith('$env:')) {
    const name = tok.slice(5);
    if (process.env[name] === undefined) throw new Error(`environment variable ${name} is not set`);
    return process.env[name];
  }
  if (!Object.prototype.hasOwnProperty.call(vars, tok)) throw new Error(`unknown variable {{${tok}}}`);
  return vars[tok];
}

/** Render {{var}}, {{$uuid:name}}, {{$uuid}}, {{$env:NAME}}. A whole-string token keeps the value's JSON type. */
function renderTemplate(value, vars, gen) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
    if (whole) return resolveToken(whole[1], vars, gen);
    return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, tok) => {
      const v = resolveToken(tok, vars, gen);
      return typeof v === 'string' ? v : JSON.stringify(v);
    });
  }
  if (Array.isArray(value)) return value.map(v => renderTemplate(v, vars, gen));
  if (isPlainObject(value)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = renderTemplate(v, vars, gen);
    return o;
  }
  return value;
}

/** Render an expectation: like renderTemplate, but values substituted into a $regex are regex-escaped. */
function renderExpect(value, vars, gen) {
  if (isMatcher(value) && typeof value.$regex === 'string') {
    const { $regex, ...rest } = value;
    const re = $regex.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, tok) => {
      const v = resolveToken(tok, vars, gen);
      return escapeRegex(typeof v === 'string' ? v : JSON.stringify(v));
    });
    return { ...renderExpect(rest, vars, gen), $regex: re };
  }
  if (Array.isArray(value)) return value.map(v => renderExpect(v, vars, gen));
  if (isPlainObject(value)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = renderExpect(v, vars, gen);
    return o;
  }
  return renderTemplate(value, vars, gen);
}

/** Names referenced by {{name}} tokens (excluding $-generators). */
function templateVars(value, out = new Set()) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) if (!m[1].startsWith('$')) out.add(m[1]);
  } else if (Array.isArray(value)) value.forEach(v => templateVars(v, out));
  else if (isPlainObject(value)) Object.values(value).forEach(v => templateVars(v, out));
  return out;
}

/** Expand ${VAR} and ${VAR:-default} from an env object. */
function interpolateEnv(value, env) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, dflt) => {
      if (env[name] !== undefined && env[name] !== '') return env[name];
      if (dflt !== undefined) return dflt;
      throw new Error(`environment variable ${name} is not set`);
    });
  }
  if (Array.isArray(value)) return value.map(v => interpolateEnv(v, env));
  if (isPlainObject(value)) {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = interpolateEnv(v, env);
    return o;
  }
  return value;
}

/** Every `${NAME:-fallback}` in `value` that interpolateEnv would fill from its fallback (NAME unset or empty). */
function defaultedVars(value, env, out = []) {
  if (typeof value === 'string') {
    for (const m of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}/g)) {
      if (env[m[1]] === undefined || env[m[1]] === '') out.push({ name: m[1], fallback: m[2] });
    }
  } else if (Array.isArray(value)) value.forEach(v => defaultedVars(v, env, out));
  else if (isPlainObject(value)) Object.values(value).forEach(v => defaultedVars(v, env, out));
  return out;
}

function getPath(obj, expr) {
  const tokens = [];
  expr.replace(/\[(\d+)\]|([^.[\]]+)/g, (_, idx, key) => { tokens.push(idx !== undefined ? Number(idx) : key); return ''; });
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}

// ========== Lock (frozen set) ==========

const FROZEN_FILES = ['specs/SPEC.md', 'specs/DESIGN.md', 'specs/CODING_STANDARDS.md'];
const FROZEN_DIRS = ['specs/contracts', 'specs/fixtures', 'specs/wireframes', 'specs/.sdd'];
const FROZEN_EXCLUDE = new Set(['specs/.sdd/_config/sdd-state.json']);
const IGNORED_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'node_modules', '.git']);

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (IGNORED_NAMES.has(e.name)) continue;
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, out);
    else if (e.isFile()) out.push(fp);
  }
}

function frozenFiles(root) {
  const files = [];
  for (const f of FROZEN_FILES) {
    const fp = path.join(root, f);
    if (fs.existsSync(fp)) files.push(fp);
  }
  for (const d of FROZEN_DIRS) walk(path.join(root, d), files);
  return files.map(f => rel(root, f)).filter(r => !FROZEN_EXCLUDE.has(r)).sort();
}

function normalizeEol(buf) {
  if (buf.includes(0)) return buf; // binary: hash as-is
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}

function hashFile(fp) {
  return crypto.createHash('sha256').update(normalizeEol(fs.readFileSync(fp))).digest('hex');
}

function manifestHash(files) {
  const h = crypto.createHash('sha256');
  for (const f of Object.keys(files).sort()) h.update(`${f}\0${files[f]}\n`);
  return h.digest('hex');
}

function currentLockState(root) {
  const files = {};
  for (const r of frozenFiles(root)) files[r] = hashFile(path.join(root, r));
  return { files, hash: manifestHash(files) };
}

function verifyLock(root) {
  const p = projectPaths(root);
  if (!fs.existsSync(p.lock)) return { exists: false, valid: false, added: [], removed: [], modified: [] };
  const lock = readJson(p.lock);
  const current = currentLockState(root);
  const added = [];
  const removed = [];
  const modified = [];
  for (const f of Object.keys(current.files)) {
    if (!(f in lock.files)) added.push(f);
    else if (lock.files[f] !== current.files[f]) modified.push(f);
  }
  for (const f of Object.keys(lock.files)) if (!(f in current.files)) removed.push(f);
  const intact = lock.hash === manifestHash(lock.files);
  return {
    exists: true,
    valid: intact && !added.length && !removed.length && !modified.length,
    intact,
    lock,
    current,
    added,
    removed,
    modified,
  };
}

// ========== Fixtures (oracle cases) ==========

function listFiles(dir) {
  const files = [];
  walk(dir, files);
  return files.sort();
}

function listJsonFiles(dir) {
  return listFiles(dir).filter(f => f.endsWith('.json'));
}

/** Load and schema-validate all case files. Returns { cases, errors }. */
function loadCases(paths) {
  const errors = [];
  const cases = [];
  if (!fs.existsSync(paths.cases)) return { cases, errors, files: [] };
  const schema = loadSchema(paths, 'oracle-cases.schema.json');
  // Validate the file envelope, then each case on its own, so one malformed case does not hide the others.
  const fileSchema = { ...schema, properties: { ...schema.properties, cases: { type: 'array', minItems: 1 } } };
  const caseSchema = { $ref: '#/$defs/case', $defs: schema.$defs };
  const files = listJsonFiles(paths.cases);
  for (const file of files) {
    const r = rel(paths.root, file);
    let data;
    try { data = readJson(file); } catch (e) { errors.push(e.message); continue; }
    const errs = validateSchema(fileSchema, data);
    if (errs.length) { errors.push(...errs.map(e => `${r}: ${e}`)); continue; }
    data.cases.forEach((c, i) => {
      const cerrs = validateSchema(caseSchema, c);
      if (cerrs.length) errors.push(...cerrs.map(e => `${r}: ${e.replace(/^\$/, `$.cases[${i}]`)}`));
      else cases.push({ ...c, suite: data.suite, file: r });
    });
  }
  return { cases, errors, files };
}

function loadOracleConfig(paths) {
  const cfg = readJson(paths.oracleConfig);
  const errs = validateSchema(loadSchema(paths, 'oracle-config.schema.json'), cfg);
  return { cfg, errors: errs.map(e => `${rel(paths.root, paths.oracleConfig)}: ${e}`) };
}

function stepKind(step) {
  return ['http', 'query', 'run', 'parallel'].filter(k => k in step);
}

/** Hash a file, or every file under a directory (relative names + contents). */
function hashTree(target) {
  const st = fs.statSync(target);
  if (st.isFile()) return hashFile(target);
  const h = crypto.createHash('sha256');
  for (const f of listFiles(target)) h.update(`${rel(target, f)}\0${hashFile(f)}\n`);
  return h.digest('hex');
}

// ========== OpenAPI (operations & declared responses) ==========

const HTTP_METHODS = new Set(['get', 'put', 'post', 'patch', 'delete', 'head', 'options', 'trace']);

/** Resolve local JSON references (#/components/...) one level; follows chains. */
function deref(doc, node, depth = 0) {
  let cur = node;
  while (isPlainObject(cur) && typeof cur.$ref === 'string') {
    if (depth++ > 32) throw new Error(`$ref chain too deep at ${cur.$ref}`);
    cur = resolveRef(doc, cur.$ref);
  }
  return cur;
}

function opsFromDoc(doc) {
  const ops = [];
  for (const [p, rawItem] of Object.entries(doc.paths || {})) {
    const item = deref(doc, rawItem) || {};
    for (const [m, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(m.toLowerCase()) || !isPlainObject(op)) continue;
      ops.push({
        method: m.toUpperCase(),
        path: p,
        operationId: op.operationId || null,
        statuses: Object.keys(op.responses || {}),
        op,
        pathParams: (item.parameters || []).map(x => deref(doc, x)),
      });
    }
  }
  return ops;
}

function loadOpenApi(file, root) {
  const text = fs.readFileSync(file, 'utf8');
  let doc;
  let parser;
  // Always the bundled parser: the contract must parse identically on every machine, whatever node_modules holds.
  if (file.endsWith('.json')) { doc = JSON.parse(text); parser = 'json'; }
  else { doc = parseYaml(text); parser = 'yaml-lite'; }
  if (!isPlainObject(doc) || !/^3\./.test(String(doc.openapi || ''))) throw new Error('not an OpenAPI 3.x document (missing "openapi: 3.x")');
  return { doc, ops: opsFromDoc(doc), parser };
}

function pathTemplateRegex(tpl) {
  const parts = tpl.split(/(\{[^}]+\})/);
  const params = parts.filter(x => /^\{[^}]+\}$/.test(x)).length;
  const re = parts.map(x => (/^\{[^}]+\}$/.test(x) ? '[^/]+' : escapeRegex(x))).join('');
  return { re: new RegExp(`^${re}$`), params };
}

/** Find the OpenAPI operation a request (method + concrete or templated path) targets. */
function matchOperation(ops, method, reqPath) {
  const p = String(reqPath).split('?')[0].replace(/\{\{[^{}]+\}\}/g, 'X');
  const candidates = ops
    .filter(o => o.method === String(method).toUpperCase())
    .map(o => ({ o, t: pathTemplateRegex(o.path) }))
    .filter(x => x.t.re.test(p))
    .sort((a, b) => a.t.params - b.t.params);
  return candidates.length ? candidates[0].o : null;
}

function statusCovers(declared, status) {
  if (/^[1-5]XX$/i.test(declared)) return Math.floor(status / 100) === Number(declared[0]);
  return Number(declared) === status;
}

// ========== Spec text parsing ==========

function parseInvariants(text) {
  const ids = new Set();
  for (const m of text.matchAll(/^\s*[-*]\s+(?:\*\*)?(V\d+)\b/gm)) ids.add(m[1]);
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

function parsePhases(text) {
  return [...new Set([...text.matchAll(/^##\s+Phase\s+(\d+)\b/gm)].map(m => Number(m[1])))].sort((a, b) => a - b);
}

// ========== Spec Change Requests ==========

// Draft → Approved → Applied (re-frozen) is the normal life of an SCR. Proposed is a hotfix that shipped
// ahead of the pipeline: it does not stop the build (the code is merged and graded), it stops the next
// freeze until that freeze re-grades it. Draft, Approved and a missing Status are open.
const SCR_STATUSES = ['draft', 'approved', 'applied', 'rejected', 'withdrawn', 'proposed'];
const SCR_OPEN = new Set(['draft', 'approved']);

/** Every specs/changes/SCR-NNN*.md with its Status row (`| Status | Draft |` or `Status: Draft`). */
function loadScrs(paths) {
  const dir = path.join(paths.specs, 'changes');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^SCR-\d+.*\.md$/.test(f))
    .sort()
    .map(f => {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const m = text.match(/^\|\s*\**Status\**\s*\|\s*([^|\n]+?)\s*\|/mi) || text.match(/^\s*(?:[-*]\s+)?\**Status\**:?\**\s*:?\s*(.+)$/mi);
      const raw = m ? m[1].trim() : '';
      const word = (raw.match(/[A-Za-z]+/) || [''])[0].toLowerCase();
      const status = SCR_STATUSES.includes(word) ? word : null;
      return { id: f.match(/^(SCR-\d+)/)[1], file: `specs/changes/${f}`, status, raw, open: !status || SCR_OPEN.has(status) };
    });
}

// ========== Git (optional: every check degrades to a note outside a repository) ==========

// Working files Stage 05 may change after a graded run without changing what was graded.
const WORKING_PATHS = ['specs/logs/', 'specs/changes/', 'specs/IMPLEMENTATION_PHASES.md', 'specs/dev-swarm-reconciliation.md', 'specs/.sdd/_config/sdd-state.json'];

function git(root, args) {
  try {
    // Trim the end only: `status --porcelain` lines start with a status column that may be a space.
    return require('child_process').execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd();
  } catch { return null; }
}

/** HEAD (null before the first commit) and the uncommitted files under the project root, or null outside git. */
function gitState(root) {
  if (git(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  const prefix = git(root, ['rev-parse', '--show-prefix']) || '';
  const out = git(root, ['status', '--porcelain=v1', '-uall', '--', '.']) || '';
  const changed = out.split('\n').filter(Boolean)
    .map(l => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
    .map(f => (prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f));
  const dirty = changed.filter(f => !WORKING_PATHS.some(w => (w.endsWith('/') ? f.startsWith(w) : f === w)));
  const time = head ? git(root, ['log', '-1', '--format=%cI', head]) : null;
  return { head, time: time ? new Date(time).toISOString() : null, dirty };
}

// ========== DESIGN.md tokens ==========

/** The YAML front matter of DESIGN.md (only at the very start of the file), or null. */
function parseDesign(text) {
  const m = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  return parseYaml(m[1]);
}

function resolveDesignToken(design, value) {
  const m = typeof value === 'string' && value.match(/^\{([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\}$/);
  if (!m) return value;
  const group = design[m[1]];
  return group && Object.prototype.hasOwnProperty.call(group, m[2]) ? group[m[2]] : value;
}

/** One row per component × state × property in DESIGN.md `components:` (state "base" for top-level properties).
 *  A reference to a composite token (e.g. `typography: "{typography.body}"`) expands to one row per member. */
function designTokenRows(design) {
  const rows = [];
  const push = (component, state, property, raw) => {
    const value = resolveDesignToken(design, raw);
    if (isPlainObject(value)) {
      for (const [k, v] of Object.entries(value)) if (!isPlainObject(v)) rows.push({ component, state, property: `${property}.${k}`, token: `${raw}.${k}`, expected: String(v) });
    } else rows.push({ component, state, property, token: String(raw), expected: String(value) });
  };
  for (const [component, def] of Object.entries((design && design.components) || {})) {
    if (!isPlainObject(def)) continue;
    for (const [k, v] of Object.entries(def)) {
      if (isPlainObject(v)) {
        for (const [prop, pv] of Object.entries(v)) if (!isPlainObject(pv)) push(component, k, prop, pv);
      } else push(component, 'base', k, v);
    }
  }
  return rows;
}

// The CSS basic colour keywords. Any other keyword cannot be compared and is refused with a hint to use hex.
const CSS_NAMED_COLORS = {
  black: '000000', silver: 'c0c0c0', gray: '808080', grey: '808080', white: 'ffffff', maroon: '800000', red: 'ff0000',
  purple: '800080', fuchsia: 'ff00ff', green: '008000', lime: '00ff00', olive: '808000', yellow: 'ffff00',
  navy: '000080', blue: '0000ff', teal: '008080', aqua: '00ffff', orange: 'ffa500',
};
// Browsers report computed lengths in px; rem and em are converted at the default 16px root font size.
const ROOT_FONT_PX = 16;

/** Canonical form of a measured CSS value, so "rgb(255, 255, 255)" equals "#FFFFFF" and "2.0px" equals "2px". */
function normalizeCssValue(v) {
  let s = String(v).trim().toLowerCase().replace(/["']/g, '').replace(/\s+/g, ' ');
  if (CSS_NAMED_COLORS[s]) s = `#${CSS_NAMED_COLORS[s]}`;
  const rem = s.match(/^(-?\d*\.?\d+)r?em$/);
  if (rem) return { kind: 'px', v: String(Number(rem[1]) * ROOT_FONT_PX) };
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    if (h.length === 6) h += 'ff';
    if (h.length === 8) return { kind: 'color', v: h };
  }
  const rgb = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/);
  if (rgb) {
    let a = rgb[4] === undefined ? 1 : rgb[4].endsWith('%') ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
    a = Math.round(a * 255);
    return { kind: 'color', v: [rgb[1], rgb[2], rgb[3]].map(x => Number(x).toString(16).padStart(2, '0')).join('') + a.toString(16).padStart(2, '0') };
  }
  if (s === 'transparent') return { kind: 'color', v: '00000000' };
  const px = s.match(/^(-?\d*\.?\d+)px$/);
  if (px) return { kind: 'px', v: String(Number(px[1])) };
  if (/^-?\d*\.?\d+$/.test(s)) return { kind: 'number', v: String(Number(s)) };
  return { kind: 'text', v: s.replace(/\s*,\s*/g, ',') };
}

/** false when both values are comparable and differ; null when they cannot be compared (units differ): the gate refuses those (CSS_UNCOMPARABLE). */
function cssValuesMatch(expected, measured) {
  const a = normalizeCssValue(expected);
  const b = normalizeCssValue(measured);
  if (a.kind !== b.kind) return null;
  return a.v === b.v;
}

// ========== Stages (compatible with the SDD VS Code extension's numeric state) ==========

const STAGES = {
  '00': { num: 0, name: '00_backprop' },
  '01': { num: 1, name: '01_brainstorming' },
  '01b': { num: 1, name: '01b_adoption' },
  '02': { num: 2, name: '02_adversarial_swarm_analysis' },
  '03': { num: 3, name: '03_interactive_wireframing' },
  '04': { num: 4, name: '04_writing_implementation_phases' },
  '05': { num: 5, name: '05_development_swarm' },
  '06': { num: 6, name: '06_visual_acceptance_testing' },
  '07': { num: 7, name: '07_verification_before_completion' },
};

function normalizeStage(input) {
  if (input === undefined || input === true) return null;
  const s = String(input).toLowerCase().trim();
  const m = s.match(/^0?([0-7])(b)?(?:_[a-z_]+)?$/);
  if (!m) return null;
  const key = `0${m[1]}${m[2] || ''}`;
  return STAGES[key] ? key : null;
}

module.exports = {
  TOOL_VERSION,
  defaultRoot,
  projectPaths,
  rel,
  parseArgs,
  readJson,
  writeJson,
  jsonType,
  deepEqual,
  escapeRegex,
  validateSchema,
  loadSchema,
  TYPE_PATTERNS,
  isPlainObject,
  isMatcher,
  isVariableMatcher,
  lintMatchers,
  matchJson,
  variablePathsOf,
  compilePathPattern,
  newGenerator,
  renderTemplate,
  renderExpect,
  templateVars,
  interpolateEnv,
  defaultedVars,
  getPath,
  listFiles,
  frozenFiles,
  currentLockState,
  manifestHash,
  verifyLock,
  loadCases,
  loadOracleConfig,
  stepKind,
  hashTree,
  loadOpenApi,
  deref,
  HTTP_METHODS,
  matchOperation,
  statusCovers,
  parseInvariants,
  parsePhases,
  loadScrs,
  gitState,
  WORKING_PATHS,
  parseDesign,
  designTokenRows,
  cssValuesMatch,
  STAGES,
  normalizeStage,
};
