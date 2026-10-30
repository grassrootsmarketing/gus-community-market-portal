// tools/apply-0116-rebuild-check.mjs (2026-10-30): applies migration 0116 (connected checkout at the ledger) to the
// TEST project demohub-rebuild-check and nothing else. One transaction: identity guard (never production), the
// migration body verbatim with its executed post-condition, the ledger row. A second run is refused by the guard.
// Usage (SB_DB_URL = the test project's pooler URL): node tools/apply-0116-rebuild-check.mjs
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url)) { console.error('REFUSING: SB_DB_URL is not demohub-rebuild-check'); process.exit(2); }
const file = new URL('../supabase/migrations/0116_connected_checkout_ledger.sql', import.meta.url);
const body = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) throw new Error('0116 must not carry its own begin/commit');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const id = (await c.query('select environment, project_ref from get_deployment_identity()')).rows[0];
  if (!id || id.environment === 'production' || id.project_ref !== 'tileejdviuvijumjeplv') { console.error('REFUSING: identity', id); process.exit(2); }
  const tail = (await c.query("select version from supabase_migrations.schema_migrations order by version desc limit 1")).rows[0];
  const have = (await c.query("select count(*)::int n from supabase_migrations.schema_migrations where version = '0116'")).rows[0].n;
  if (have) { console.log('0116 is already in the ledger of demohub-rebuild-check; nothing to do'); process.exit(0); }
  console.log('demohub-rebuild-check identity', id.environment, 'ledger tail', tail && tail.version, 'body sha256', createHash('sha256').update(body).digest('hex').slice(0, 16));
  await c.query('BEGIN');
  await c.query(body);
  await c.query("insert into supabase_migrations.schema_migrations (version, name) values ('0116', 'connected_checkout_ledger')");
  await c.query('COMMIT');
  const after = (await c.query("select version, name from supabase_migrations.schema_migrations order by version desc limit 2")).rows;
  console.log('applied; ledger now', JSON.stringify(after));
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) {}
  console.error('FAILED, rolled back:', e.message);
  process.exit(1);
} finally { await c.end(); }
