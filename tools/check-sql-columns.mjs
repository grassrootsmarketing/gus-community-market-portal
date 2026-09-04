#!/usr/bin/env node
// tools/check-sql-columns.mjs
//
// Cross-checks every column referenced by the migration chain's SQL against the columns that
// actually exist in a live database built from that chain.
//
// WHY THIS EXISTS. PL/pgSQL does not resolve identifiers in a function body at CREATE time — the
// body is parsed, not bound. A migration containing `UPDATE bookings SET refund_id = ...` applies
// cleanly and reports success even when bookings has no refund_id column. The error (42703) only
// appears when that specific BRANCH executes, which may be months later, on the refund path, in
// production.
//
// Two such defects reached this codebase:
//   settings.billing_tier   in enforce_venue_limit()  — broke ALL venue creation
//   bookings.refund_id      in apply_refund_event()   — broke refund application
// Neither was visible to: migration success, the clean-build manifest comparison (both builds were
// identically broken), the mocked route tests, or a probe that called each function once (the bad
// column sat in a branch dummy arguments never reached).
//
// Static analysis catches what execution coverage misses, and vice versa. This is the static half.
//
// DESIGN (C2 correction):
//   * Line endings are normalised (CRLF -> LF) before anything else. The comment stripper is a
//     per-line `--` cut; a stray CR left `--` comments un-stripped and produced false qualified
//     references out of commentary. Normalising first makes the checker platform-independent.
//   * A function is validated by its FINAL `CREATE OR REPLACE FUNCTION` body only. `settings.billing_tier`
//     lived in the superseded 0021/0052 definitions of enforce_venue_limit(); 0054 replaced the body to
//     read retailers.billing_tier. Superseded bodies are historical text, not the shipped schema, so they
//     must not be judged against the final schema. DO blocks are anonymous and each is validated.
//   * Unqualified single-source references are resolved. The original defect was the unqualified
//     `lower(billing_tier) ... FROM settings` shape — no `settings.` prefix — so the qualified pass alone
//     could never have caught it. When a statement has exactly one table source and no join, unqualified
//     identifiers in column position (excluding declared vars, params, keywords, type names and function
//     names) are checked against that one table.
//
// The analysis is a pure function (`analyze`) so tests/check_sql_columns.test.mjs can exercise it
// offline against fixture schemas; the CLI below feeds it the live schema and real migrations.
//
// Usage: SB_URL=... SB_KEY=... node tools/check-sql-columns.mjs
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// SQL keywords, PL/pgSQL control words, and built-in type names that appear as bare identifiers but
// are never column references. Kept deliberately broad — a missing keyword is a false positive.
export const NON_COLUMN = new Set([
  // statement / clause keywords
  'select','insert','update','delete','into','from','where','set','values','returning','join','left','right',
  'inner','outer','full','cross','lateral','on','using','and','or','not','in','is','null','as','distinct','all',
  'group','by','order','having','limit','offset','asc','desc','union','except','intersect','with','recursive',
  'case','when','then','else','end','coalesce','nullif','exists','between','like','ilike','similar','escape',
  'true','false','default','for','update','share','of','nowait','only','perform','execute','do','begin','declare',
  'no','skip','locked',   // row-lock clauses: FOR NO KEY UPDATE (0072), SKIP LOCKED — 'key' is listed with the DDL words
  'if','elsif','elseif','loop','while','foreach','return','next','query','raise','exception','notice','warning',
  'get','stacked','diagnostics','continue','exit','call','assert','constant','alias','open','fetch','close','move',
  'language','plpgsql','sql','immutable','stable','volatile','strict','security','definer','invoker','cost','rows',
  'trigger','before','after','instead','row','statement','each','new','old','tg_op','tg_name','found','sqlstate','sqlerrm',
  'create','replace','function','procedure','table','view','index','sequence','type','domain','drop','alter','add',
  'column','constraint','primary','key','foreign','references','unique','check','cascade','restrict','grant','revoke',
  'to','public','current_user','session_user','commit','rollback','savepoint','array','any','some','over','partition',
  'window','filter','within','ordinal','ordinality','tablesample','material','materialized','refresh',
  'conflict','nothing','returns','trigger','setof','out','inout','variadic',
  // PL/pgSQL exception condition names (EXCEPTION WHEN <cond> THEN …) — never columns
  'unique_violation','foreign_key_violation','check_violation','not_null_violation','exclusion_violation',
  'no_data_found','too_many_rows','division_by_zero','others','raise_exception','data_exception','no_data',
  'string_data_right_truncation','numeric_value_out_of_range','invalid_text_representation','serialization_failure',
  'deadlock_detected','lock_not_available','integrity_constraint_violation','case_not_found','object_not_in_prerequisite_state',
  // built-in / common type names
  'text','varchar','char','character','varying','int','integer','int2','int4','int8','smallint','bigint','serial',
  'bigserial','numeric','decimal','real','double','precision','float','boolean','bool','date','time','timestamp',
  'timestamptz','interval','uuid','json','jsonb','bytea','money','inet','cidr','macaddr','tsvector','void','record',
  'anyelement','anyarray','name','regclass','oid','bit','xml','point','line','box','circle','path','polygon',
  // very common built-in function names (also skipped by the followed-by-'(' rule, but belt-and-braces)
  'lower','upper','trim','btrim','ltrim','rtrim','length','coalesce','count','sum','avg','max','min','now','abs',
  'round','ceil','floor','greatest','least','concat','substring','position','replace','split_part','to_char','to_date',
  'to_timestamp','date_trunc','extract','age','gen_random_uuid','uuid_generate_v4','random','md5','encode','decode',
  'jsonb_build_object','json_build_object','jsonb_set','to_jsonb','array_agg','string_agg','unnest','format','cast',
  'make_interval','current_timestamp','current_date','current_time','localtimestamp','clock_timestamp','statement_timestamp',
]);

// Qualified table.column noise: prefixes that are schemas / aliases / trigger pseudo-rows, not real tables.
export const QUAL_NOISE = new Set(['sql','pg_catalog','information_schema','storage','auth','supabase_migrations',
  'excluded','new','old','tg','v','e','j','p','r','s','t','c','n','con','x','extensions','vault','cron','realpath']);

export function normalize(sql) { return sql.replace(/\r\n?/g, '\n'); }

// Remove block + line comments. Line ending must already be LF (call normalize first).
export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
}

// Replace single-quoted string literals with a space so their contents cannot look like columns.
function stripStrings(sql) { return sql.replace(/'(?:[^']|'')*'/g, ' '); }

// Split on a delimiter, ignoring delimiters inside parentheses.
function splitTopLevel(s, delim) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === delim && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

// Extract dollar-quoted blocks ($$ … $$ or $tag$ … $tag$). Returns the blocks (with the text that
// precedes each, which carries the CREATE FUNCTION signature) and the top-level SQL with every block
// replaced by a space.
function extractDollarBlocks(sql) {
  const blocks = [];
  let top = '';
  const tagRe = /\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/g;
  let i = 0;
  while (i < sql.length) {
    tagRe.lastIndex = i;
    const open = tagRe.exec(sql);
    if (!open) { top += sql.slice(i); break; }
    top += sql.slice(i, open.index);
    const tag = open[0];
    const bodyStart = open.index + tag.length;
    const closeIdx = sql.indexOf(tag, bodyStart);
    if (closeIdx < 0) { top += sql.slice(open.index); break; }   // unterminated — treat rest as top-level
    blocks.push({ body: sql.slice(bodyStart, closeIdx), preceding: top });
    top += ' ';                                                 // block removed from top-level scan
    i = closeIdx + tag.length;
  }
  return { blocks, top };
}

// Capture a balanced `( … )` starting at the '(' at openIdx; returns the inner text.
function balancedArgs(s, openIdx) {
  let depth = 0, out = '';
  for (let k = openIdx; k < s.length; k++) {
    const ch = s[k];
    if (ch === '(') { depth++; if (depth === 1) continue; }
    else if (ch === ')') { depth--; if (depth === 0) return out; }
    out += ch;
  }
  return out;
}

// From the text preceding a $tag$ body, recover the `name(args)` signature of the CREATE FUNCTION whose
// body this is — the LAST function header in the preceding text (a file may define several). Returns
// { signature, name, params } or null (DO block / not a function). Arg types may contain parens
// (numeric(10,2)), so the arg list is captured with balanced-paren matching, not a lazy `)`.
function functionSignature(preceding) {
  const tail = preceding.slice(-8000);
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\(/gi;
  let last = null, m;
  while ((m = re.exec(tail)) !== null) last = m;
  if (!last) return null;
  const name = last[1].toLowerCase();
  const args = balancedArgs(tail, tail.indexOf('(', last.index));
  const params = new Set();
  for (const arg of splitTopLevel(args, ',')) {
    const t = arg.trim().split(/\s+/);
    if (t[0] && /^[a-z_][a-z0-9_]*$/i.test(t[0]) && !NON_COLUMN.has(t[0].toLowerCase())) params.add(t[0].toLowerCase());
  }
  return { signature: `${name}(${args.replace(/\s+/g, ' ').toLowerCase()})`, name, params };
}

// FOR / FOREACH loop variables (`for i in 2..11`, `foreach x in array …`) are implicit locals.
function loopVars(body) {
  const v = new Set();
  for (const m of body.matchAll(/\b(?:for|foreach)\s+([a-z_][a-z0-9_]*)\s+in\b/gi)) {
    const id = m[1].toLowerCase();
    if (!NON_COLUMN.has(id)) v.add(id);
  }
  return v;
}

// Declared variable names inside a function/DO body: the DECLARE section before the first BEGIN.
// Each declaration's first token is the variable name.
function declaredVars(body) {
  const vars = new Set();
  const beginIdx = body.search(/\bbegin\b/i);
  const declIdx = body.search(/\bdeclare\b/i);
  if (declIdx < 0) return vars;
  const declSection = body.slice(declIdx + 'declare'.length, beginIdx < 0 ? body.length : beginIdx);
  for (const decl of declSection.split(';')) {
    const t = decl.trim().split(/\s+/);
    if (t[0] && /^[a-z_][a-z0-9_]*$/i.test(t[0]) && !NON_COLUMN.has(t[0].toLowerCase())) vars.add(t[0].toLowerCase());
  }
  return vars;
}

// The single table source of a statement, or null if zero / more than one / a join / a subquery.
// NOTE: `INTO` counts only in `INSERT INTO <table>`. Bare `INTO` is the PL/pgSQL `SELECT … INTO <var>`
// assignment target (a variable, not a table) and must not be read as a second source.
function singleSource(stmt, tables) {
  if (/\bjoin\b/i.test(stmt) || /\(\s*select\b/i.test(stmt)) return null;
  const srcs = new Set();
  const add = t => { t = t.toLowerCase(); if (!NON_COLUMN.has(t)) srcs.add(t); };   // known or unknown; two sources = ambiguous
  for (const m of stmt.matchAll(/\b(?:from|update)\s+(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) add(m[1]);
  for (const m of stmt.matchAll(/\binsert\s+into\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) add(m[1]);
  return srcs.size === 1 ? [...srcs][0] : null;
}

// Aliases introduced in a statement: `from t alias`, `t as alias`. So `alias` is not judged as a column.
function aliasesOf(stmt) {
  const al = new Set();
  for (const m of stmt.matchAll(/\b(?:from|update)\s+(?:only\s+)?(?:public\.)?[a-z_][a-z0-9_]*\s+(?:as\s+)?([a-z_][a-z0-9_]*)/gi)) {
    const a = m[1].toLowerCase();
    if (!NON_COLUMN.has(a)) al.add(a);
  }
  return al;
}

// Core: given the live schema and the migration files (in order), return the list of non-existent
// column references. `files` is [{ name, sql }]. `schema` is { table: Set(columns) }.
export function analyze(schema, files) {
  const tables = new Set(Object.keys(schema));
  const problems = [];

  // ---- pass 1: assemble scan units, keeping only the FINAL body per function signature ----
  const finalFn = new Map();              // signature -> { body, params, file }
  const doBlocks = [];                    // { body, file }
  const topLevel = [];                    // { sql, file }
  for (const { name, sql } of files) {
    const clean = stripComments(normalize(sql));
    const { blocks, top } = extractDollarBlocks(clean);
    topLevel.push({ sql: top, file: name });
    for (const b of blocks) {
      const sig = functionSignature(b.preceding);
      if (sig) finalFn.set(sig.signature, { body: b.body, params: sig.params, file: name });   // last wins
      else doBlocks.push({ body: b.body, file: name });
    }
  }

  const UPDATE_RE = /\bupdate\s+(?:only\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+set\s+([\s\S]*?)(?=\bwhere\b|\breturning\b|\bfrom\b|;|$)/gi;
  const INSERT_RE = /\binsert\s+into\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
  const scanWrites = (sql, file) => {
    const s = stripStrings(sql);
    for (const m of s.matchAll(UPDATE_RE)) {
      const table = m[1].toLowerCase();
      if (!tables.has(table)) continue;
      for (const assign of splitTopLevel(m[2], ',')) {
        const col = (assign.split('=')[0] || '').trim().toLowerCase().replace(/^"|"$/g, '');
        if (!/^[a-z_][a-z0-9_]*$/.test(col) || NON_COLUMN.has(col)) continue;
        if (!schema[table].has(col)) problems.push(`${file}: UPDATE ${table} SET ${col}  <- column does not exist`);
      }
    }
    for (const m of s.matchAll(INSERT_RE)) {
      const table = m[1].toLowerCase();
      if (!tables.has(table)) continue;
      for (const raw of m[2].split(',')) {
        const col = raw.trim().toLowerCase().replace(/^"|"$/g, '');
        if (!/^[a-z_][a-z0-9_]*$/.test(col) || NON_COLUMN.has(col)) continue;
        if (!schema[table].has(col)) problems.push(`${file}: INSERT INTO ${table} (${col})  <- column does not exist`);
      }
    }
  };

  const QUAL_RE = /\b(?:public\.)?([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/g;
  const scanQualified = (sql, file) => {
    const s = stripStrings(sql);
    for (const m of s.matchAll(QUAL_RE)) {
      const table = m[1].toLowerCase(), col = m[2].toLowerCase();
      if (QUAL_NOISE.has(table) || !tables.has(table)) continue;
      if (!schema[table].has(col)) problems.push(`${file}: reference ${table}.${col}  <- column does not exist`);
    }
  };

  const scanUnqualified = (sql, file, localVars) => {
    const s = stripStrings(sql);
    for (const stmt of s.split(';')) {
      const src = singleSource(stmt, tables);
      if (!src || !schema[src]) continue;                 // ambiguous, or source not a known table
      const aliases = aliasesOf(stmt);
      const seen = new Set();
      for (const m of stmt.matchAll(/(?<![.:\w])([a-z_][a-z0-9_]*)\b(?!\s*[.(])/gi)) {
        const id = m[1].toLowerCase();
        // a `name =>` token is a named function argument (make_interval(secs => …)), not a column
        if (/^\s*=>/.test(stmt.slice(m.index + m[1].length))) continue;
        if (seen.has(id)) continue; seen.add(id);
        if (NON_COLUMN.has(id) || QUAL_NOISE.has(id)) continue;
        if (id === src || aliases.has(id) || localVars.has(id)) continue;
        if (!schema[src].has(id)) problems.push(`${file}: reference ${src}.${id} (unqualified)  <- column does not exist`);
      }
    }
  };

  for (const { sql, file } of topLevel) { scanWrites(sql, file); scanQualified(sql, file); scanUnqualified(sql, file, new Set()); }
  for (const [, fn] of finalFn) {
    const localVars = new Set([...fn.params, ...declaredVars(fn.body), ...loopVars(fn.body)]);
    scanWrites(fn.body, fn.file); scanQualified(fn.body, fn.file); scanUnqualified(fn.body, fn.file, localVars);
  }
  for (const d of doBlocks) {
    const localVars = new Set([...declaredVars(d.body), ...loopVars(d.body)]);
    scanWrites(d.body, d.file); scanQualified(d.body, d.file); scanUnqualified(d.body, d.file, localVars);
  }

  return [...new Set(problems)];
}

// --------------------------------------------------------------------------- CLI
async function main() {
  const SB_URL = process.env.SB_URL, SB_KEY = process.env.SB_KEY;
  if (!SB_URL || !SB_KEY) { console.error('SB_URL and SB_KEY required (a database built from this chain)'); process.exit(2); }
  const spec = await (await fetch(`${SB_URL}/rest/v1/`, { headers: { apikey: SB_KEY, Authorization: 'Bearer ' + SB_KEY } })).json();
  const schema = {};
  for (const [t, def] of Object.entries(spec.definitions || {})) schema[t] = new Set(Object.keys(def.properties || {}));

  const dir = resolve('supabase/migrations');
  const names = readdirSync(dir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const files = names.map(name => ({ name, sql: readFileSync(resolve(dir, name), 'utf8') }));

  const problems = analyze(schema, files);
  console.log(`sql-column check: ${files.length} migrations against ${Object.keys(schema).length} live tables`);
  if (problems.length) {
    console.log(`\n${problems.length} reference(s) to columns that DO NOT EXIST:\n`);
    problems.forEach(p => console.log('  ' + p));
    process.exit(1);
  }
  console.log('  ✓ every column written by the migration chain exists in the built database');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
