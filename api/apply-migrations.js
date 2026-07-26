// api/apply-migrations.js — RETIRED. This management surface previously ran DDL against the
// database using a POSTGRES_URL connection string. That runner + credential usage are removed;
// the route is closed. Migrations are applied via the versioned files in supabase/migrations/.
export default async function handler(req, res) {
  return res.status(410).json({ error: 'endpoint_retired', message: 'Migrations are applied via supabase/migrations/.' });
}
