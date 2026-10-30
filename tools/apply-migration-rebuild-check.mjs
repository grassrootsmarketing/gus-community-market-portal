// tools/apply-migration-rebuild-check.mjs (2026-10-30): applies ONE committed migration file to the TEST project
// demohub-rebuild-check and nothing else, in one transaction with its ledger row. Refuses any other project, refuses a
// version already in the ledger, refuses a file that carries its own BEGIN/COMMIT (those are pasted as written).
// Usage (SB_DB_URL = the test project's pooler URL): node tools/apply-migration-rebuild-check.mjs 0117
import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const version = process.argv[2];
if (!/^\d{4}$/.test(version || '')) { console.error('usage: node tools/apply-migration-rebuild-check.mjs <version>'); process.exit(2); }
const url = process.env.SB_DB_URL || '';
if (!/tileejdviuvijumjeplv/.test(url) || !/\/postgres(\?|$)/.test(url)) { console.error('REFUSING: SB_DB_URL is not the public database of demohub-rebuild-check'); process.exit(2); }
const file = readdirSync('supabase/migrations').find(f => f.startsWith(version + '_'));
if (!file) { console.error('no migration file for', version); process.exit(2); }
const body = readFileSync('supabase/migrations/' + file, 'utf8').replace(/\r\n/g, '\n');
if (body.split('\n').some(l => /^\s*(begin|commit);\s*$/i.test(l))) { console.error(file + ' carries its own begin/commit; paste it as written'); process.exit(2); }
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  const id = (await c.query('select environment, project_ref from get_deployment_identity()')).rows[0];
  if (!id || id.environment === 'production' || id.project_ref !== 'tileejdviuvijumjeplv') { console.error('REFUSING: identity', id); process.exit(2); }
  const have = (await c.query('select count(*)::int n from supabase_migrations.schema_migrations where version = $1', [version])).rows[0].n;
  if (have) { console.log(version, 'is already in the ledger of demohub-rebuild-check; nothing to do'); process.exit(0); }
  const tail = (await c.query('select version from supabase_migrations.schema_migrations order by version desc limit 1')).rows[0];
  console.log('demohub-rebuild-check', id.environment, 'ledger tail', tail && tail.version, file, 'sha256', createHash('sha256').update(body).digest('hex').slice(0, 16));
  await c.query('BEGIN');
  await c.query(body);
  await c.query('insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)', [version, file.slice(5, -4)]);
  await c.query('COMMIT');
  console.log('applied; ledger now', JSON.stringify((await c.query('select version from supabase_migrations.schema_migrations order by version desc limit 3')).rows.map(r => r.version)));
} catch (e) {
  try { await c.query('ROLLBACK'); } catch (_) {}
  console.error('FAILED, rolled back:', e.message);
  process.exit(1);
} finally { await c.end(); }
