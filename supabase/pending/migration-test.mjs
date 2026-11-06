// =============================================================================
// Volltest für Migration 002 und Rückfall – läuft lokal, ohne Supabase-Zugang
//
// Baut eine Supabase-ähnliche Postgres-Datenbank im Speicher (PGlite):
// auth.uid(), Rollen anon/authenticated, Storage. Dann:
//   1. Schema laden, Testdaten anlegen, Ist-Zustand festhalten
//   2. Migration 002 ausführen
//   3. Sicherheit prüfen (keine Lücke mehr)
//   4. App-Zugriffe prüfen (Lesen für alle Rollen, Schreiben nur Schreibrollen,
//      Registrierung und Upload über den Server)
//   5. Datenerhalt prüfen (jede Tabelle Zeile für Zeile identisch)
//   6. Migration ein zweites Mal ausführen (darf nichts kaputt machen,
//      Sicherung darf nicht überschrieben werden)
//   7. Rückfall ausführen → Regeln, Funktionen, RLS, Bucket exakt wie vorher
//   8. Migration erneut → wieder sicher
//
// Benötigt @electric-sql/pglite (nicht in package.json, keine neue
// Projekt-Abhängigkeit):
//   npm install --no-save @electric-sql/pglite
// Oder gegen einen echten PostgreSQL-Server (leere Wegwerf-Datenbank):
//   npm install --no-save pg
//   TEST_DATABASE_URL=postgres://… node supabase/pending/migration-test.mjs <schema.sql> …
//   node supabase/pending/migration-test.mjs <schema.sql> [weitere.sql ...]
//
// Beispiel Produktionsnachbau:
//   node supabase/pending/migration-test.mjs SETUP_DATABASE.sql supabase/pending/test/prod-like-extra.sql
// =============================================================================
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const MIGRATION = readFileSync(join(here, '002_security_policies.sql'), 'utf8')
const ROLLBACK = readFileSync(join(here, '002_rollback.sql'), 'utf8')
const schemaFiles = process.argv.slice(2)
if (schemaFiles.length === 0) { console.error('Bitte Schema-Datei(en) angeben'); process.exit(2) }

const APP_TABLES = ['companies','company_users','stores','uploads','customers','analytics',
  'street_analytics','marketing_actions','alerts','postal_codes','streets','poi_businesses','data_refresh_logs']

const results = []
const pass = (name, ok, info = '') => results.push({ ok: !!ok, name, info })

// Standard: PGlite (Postgres im Prozess). Mit TEST_DATABASE_URL läuft derselbe
// Test gegen einen echten PostgreSQL-Server (leere Wegwerf-Datenbank angeben).
let db
if (process.env.TEST_DATABASE_URL) {
  const { default: pg } = await import('pg')
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL })
  await client.connect()
  client.on('notice', () => {})
  await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pg_trgm;')
  db = {
    exec: (sql) => client.query(sql),
    query: async (sql, params) => { const r = await client.query(sql, params); return { rows: r.rows, affectedRows: r.rowCount ?? 0 } },
    close: () => client.end(),
  }
} else {
  const { PGlite } = await import('@electric-sql/pglite')
  const { uuid_ossp } = await import('@electric-sql/pglite/contrib/uuid_ossp')
  const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm')
  db = new PGlite({ extensions: { uuid_ossp, pg_trgm } })
}

// ── 1. Umgebung, Schema, Testdaten ───────────────────────────────────────────
await db.exec(`
  DO $r$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  END $r$;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
    $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
`)
for (const f of schemaFiles) {
  await db.exec(readFileSync(f, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS "postgis".*\n/, ''))
}
await db.exec(`
  INSERT INTO storage.buckets (id, name, public) VALUES ('uploads','uploads',false) ON CONFLICT (id) DO NOTHING;
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth, storage TO anon, authenticated;
`)

const U = {
  ownerA: '00000000-0000-0000-0000-00000000000a', managerA: '00000000-0000-0000-0000-0000000000a1',
  viewerA: '00000000-0000-0000-0000-0000000000a2', ownerB: '00000000-0000-0000-0000-00000000000b',
  stranger: '00000000-0000-0000-0000-0000000000ff', newUser: '00000000-0000-0000-0000-0000000000ee',
}
const A = '10000000-0000-0000-0000-00000000000a'
const B = '10000000-0000-0000-0000-00000000000b'
const cols = async (t) => (await db.query(
  `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t])).rows.map(r => r.column_name)
const has = async (t) => (await db.query(`SELECT to_regclass('public.'||$1) IS NOT NULL AS x`, [t])).rows[0].x

await db.exec(`
  INSERT INTO auth.users VALUES ${Object.values(U).map(u => `('${u}','${u.slice(-2)}@test.local')`).join(',')};
  INSERT INTO companies (id, name, slug) VALUES ('${A}','Firma A','a'), ('${B}','Firma B','b');
  INSERT INTO company_users (company_id, user_id, role) VALUES
    ('${A}','${U.ownerA}','owner'), ('${A}','${U.managerA}','manager'), ('${A}','${U.viewerA}','viewer'),
    ('${B}','${U.ownerB}','owner');
  INSERT INTO stores (company_id, name) VALUES ('${A}','Nippes'), ('${B}','Filiale B');
  INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50733'), ('${A}','50859'), ('${B}','50667');
  INSERT INTO analytics (company_id) VALUES ('${A}'), ('${B}');
  INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${A}/a.xlsx'), ('uploads','${B}/b.xlsx');
`)
// Zusätzliche Zeilen von Firma B in allen übrigen Firmentabellen (soweit nur
// company_id Pflicht ist), damit die Mandantentrennung überall geprüft wird
for (const t of ['street_analytics', 'marketing_actions', 'alerts', 'uploads']) {
  if (!(await has(t))) continue
  // Pflichtspalten ohne Standardwert automatisch mit einem passenden Wert füllen
  const req = (await db.query(`
    SELECT c.column_name, c.data_type, c.udt_name FROM information_schema.columns c
    WHERE c.table_schema='public' AND c.table_name=$1 AND c.is_nullable='NO'
      AND c.column_default IS NULL AND c.column_name <> 'company_id'`, [t])).rows
  const val = async (col) => {
    if (col.column_name.endsWith('_by') || col.column_name === 'user_id') return `'${U.ownerB}'`
    if (col.column_name === 'analytics_id') return `(SELECT id FROM analytics WHERE company_id='${B}' LIMIT 1)`
    if (col.column_name === 'store_id') return `(SELECT id FROM stores WHERE company_id='${B}' LIMIT 1)`
    if (col.data_type === 'USER-DEFINED') {
      const e = (await db.query(`SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
                                 WHERE t.typname=$1 ORDER BY e.enumsortorder LIMIT 1`, [col.udt_name])).rows[0]
      return `'${e.enumlabel}'`
    }
    if (col.data_type === 'uuid') return 'gen_random_uuid()'
    if (/int|numeric|double|real/.test(col.data_type)) return '1'
    if (col.data_type === 'boolean') return 'false'
    if (/timestamp|date/.test(col.data_type)) return 'now()'
    if (/json/.test(col.data_type)) return `'{}'`
    if (col.data_type === 'ARRAY') return `'{}'`
    return `'test-b'`
  }
  const names = ['company_id', ...req.map(c => c.column_name)]
  const vals = [`'${B}'`, ...(await Promise.all(req.map(val)))]
  try { await db.exec(`INSERT INTO ${t} (${names.join(',')}) VALUES (${vals.join(',')})`) }
  catch (e) { console.log(`Hinweis: Testzeile für ${t} nicht angelegt: ${e.message}`) }
}
const pcCols = await cols('postal_codes')
await db.exec(`INSERT INTO postal_codes (postal_code${pcCols.includes('city') ? ', city' : ''}) VALUES ('50733'${pcCols.includes('city') ? ",'Köln'" : ''})`)
const stCols = await cols('streets')
await db.exec(`INSERT INTO streets (postal_code, name${stCols.includes('name_normalized') ? ', name_normalized' : ''}) VALUES ('50733','Neusser Str.'${stCols.includes('name_normalized') ? ",'neusserstr'" : ''})`)
const upCols = await cols('uploads')
await db.exec(`INSERT INTO uploads (company_id, uploaded_by, filename${upCols.includes('storage_path') ? ', storage_path' : ''}) VALUES ('${A}','${U.ownerA}','a.xlsx'${upCols.includes('storage_path') ? `,'${A}/a.xlsx'` : ''})`)

// ── Hilfen ───────────────────────────────────────────────────────────────────
async function as(role, userId, sql) {
  await db.exec('RESET ROLE')
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ''])
  await db.exec(`SET ROLE ${role}`)
  try { const r = await db.query(sql); return { ok: true, rows: r.rows, affected: r.affectedRows ?? 0 } }
  catch (e) { return { ok: false, error: e.message } }
  finally { await db.exec('RESET ROLE'); await db.query(`SELECT set_config('request.jwt.claim.sub', '', false)`) }
}

async function securityState() {
  const policies = (await db.query(`
    SELECT schemaname, tablename, policyname, permissive, roles::text AS roles, cmd, qual, with_check
    FROM pg_policies
    WHERE (schemaname='public' AND tablename = ANY($1))
       OR (schemaname='storage' AND tablename='objects')
    ORDER BY 1,2,3`, [APP_TABLES])).rows
  const functions = (await db.query(`
    SELECT proname, pg_get_functiondef(oid) AS def, proconfig::text AS cfg, prosecdef
    FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname IN ('get_my_company_id','is_company_member','my_company_role','can_write_company_data','on_auth_user_created')
    ORDER BY 1`)).rows
  const rls = (await db.query(`
    SELECT relname, relrowsecurity FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind='r' AND relname = ANY($1) ORDER BY 1`, [APP_TABLES])).rows
  const bucket = (await db.query(`SELECT id, public FROM storage.buckets ORDER BY id`)).rows
  return JSON.stringify({ policies, functions, rls, bucket })
}

async function dataState() {
  const out = {}
  for (const t of APP_TABLES) {
    if (!(await has(t))) continue
    out[t] = (await db.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h, count(*)::int AS n FROM public.${t} x`)).rows[0]
  }
  out['storage.objects'] = (await db.query(`SELECT md5(string_agg(name, '|' ORDER BY name)) AS h, count(*)::int AS n FROM storage.objects`)).rows[0]
  out['auth.users'] = (await db.query(`SELECT count(*)::int AS n FROM auth.users`)).rows[0]
  return out
}

// Mandantentrennung: owner A gegen alle Daten von Firma B, je Lesen,
// Anlegen, Ändern, Löschen. Jede Probe läuft in BEGIN … ROLLBACK, damit
// auch eine (fälschlich) erfolgreiche Änderung keine Daten hinterlässt.
const TENANT_TABLES = ['company_users','stores','uploads','customers','analytics',
  'street_analytics','marketing_actions','alerts']
async function probe(role, userId, sql) {
  // SET LOCAL gilt nur in dieser Transaktion; ROLLBACK räumt Rolle und Daten ab
  await db.exec('BEGIN')
  try {
    await db.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
    await db.exec(`SET LOCAL ROLE ${role}`)
    const r = await db.query(sql)
    return { ok: true, rows: r.rows, affected: r.affectedRows ?? 0 }
  } catch (e) { return { ok: false, error: e.message } }
  finally { await db.exec('ROLLBACK') }
}
async function tenantChecks() {
  const c = {}
  for (const t of TENANT_TABLES) {
    if (!(await has(t))) continue
    const nB = (await db.query(`SELECT count(*)::int AS n FROM ${t} WHERE company_id='${B}'`)).rows[0].n
    if (nB === 0) continue
    let r = await probe('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM ${t} WHERE company_id='${B}'`)
    c[`${t}: A liest nichts von B`] = r.ok && r.rows[0].n === 0
    r = await probe('authenticated', U.ownerA, `UPDATE ${t} SET company_id=company_id WHERE company_id='${B}'`)
    c[`${t}: A ändert nichts bei B`] = !(r.ok && r.affected > 0)
    r = await probe('authenticated', U.ownerA, `DELETE FROM ${t} WHERE company_id='${B}'`)
    c[`${t}: A löscht nichts bei B`] = !(r.ok && r.affected > 0)
    r = await probe('authenticated', U.ownerA, `UPDATE ${t} SET company_id='${B}' WHERE company_id='${A}'`)
    c[`${t}: A schiebt keine Zeilen zu B`] = !(r.ok && r.affected > 0)
    r = await probe('anon', null, `SELECT count(*)::int AS n FROM ${t}`)
    c[`${t}: ohne Login nichts lesbar`] = !r.ok || r.rows[0].n === 0
  }
  for (const t of ['stores','customers','analytics']) {
    const r = await probe('authenticated', U.ownerA, `INSERT INTO ${t} (company_id) VALUES ('${B}')`)
    c[`${t}: A legt nichts bei B an`] = !r.ok
  }
  let r = await probe('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM companies WHERE id='${B}'`)
  c['companies: A sieht Firma B nicht'] = r.ok && r.rows[0].n === 0
  r = await probe('authenticated', U.ownerA, `UPDATE companies SET name='x' WHERE id='${B}'`)
  c['companies: A ändert Firma B nicht'] = !(r.ok && r.affected > 0)
  r = await probe('authenticated', U.ownerA, `DELETE FROM companies WHERE id='${B}'`)
  c['companies: A löscht Firma B nicht'] = !(r.ok && r.affected > 0)
  r = await probe('authenticated', U.ownerA, `INSERT INTO company_users (company_id, user_id, role) VALUES ('${B}','${U.ownerA}','owner')`)
  c['company_users: A trägt sich nicht bei B ein'] = !r.ok
  r = await probe('authenticated', U.ownerA, `UPDATE storage.objects SET name=name WHERE name LIKE '${B}/%'`)
  c['Storage: A ändert keine Datei von B'] = !(r.ok && r.affected > 0)
  r = await probe('authenticated', U.ownerA, `DELETE FROM storage.objects WHERE name LIKE '${B}/%'`)
  c['Storage: A löscht keine Datei von B'] = !(r.ok && r.affected > 0)
  r = await probe('anon', null, `SELECT count(*)::int AS n FROM storage.objects`)
  c['Storage: ohne Login keine Dateien sichtbar'] = !r.ok || r.rows[0].n === 0
  // Rechteausweitung innerhalb der eigenen Firma
  r = await probe('authenticated', U.managerA, `UPDATE company_users SET role='owner' WHERE user_id='${U.managerA}'`)
  c['manager macht sich nicht selbst zum owner'] = !(r.ok && r.affected > 0)
  r = await probe('authenticated', U.viewerA, `UPDATE company_users SET role='owner' WHERE user_id='${U.viewerA}'`)
  c['viewer macht sich nicht selbst zum owner'] = !(r.ok && r.affected > 0)
  r = await probe('authenticated', U.viewerA, `DELETE FROM customers WHERE company_id='${A}'`)
  c['viewer löscht keine Kunden'] = !(r.ok && r.affected > 0)
  r = await probe('authenticated', U.managerA, `DELETE FROM company_users WHERE user_id='${U.ownerA}'`)
  c['manager entfernt den owner nicht'] = !(r.ok && r.affected > 0)
  return c
}

// Sicherheitsprüfungen: true = sicher
async function securityChecks() {
  const c = {}
  let r = await as('authenticated', U.stranger, `INSERT INTO company_users (company_id, user_id, role) VALUES ('${A}','${U.stranger}','owner')`)
  c['Fremder trägt sich als owner in Firma A ein'] = !r.ok
  await db.exec(`DELETE FROM company_users WHERE user_id='${U.stranger}'`)
  r = await as('authenticated', U.stranger, `INSERT INTO companies (name, slug) VALUES ('X','x-${Date.now()}')`)
  c['Firma direkt aus dem Browser anlegen'] = !r.ok
  await db.exec(`DELETE FROM companies WHERE name='X'`)
  r = await as('authenticated', U.viewerA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','99999')`)
  c['viewer legt Kunden an'] = !r.ok
  await db.exec(`DELETE FROM customers WHERE postal_code='99999'`)
  r = await as('authenticated', U.viewerA, `UPDATE customers SET postal_code=postal_code WHERE company_id='${A}'`)
  c['viewer ändert Kunden'] = !(r.ok && r.affected > 0)
  r = await as('authenticated', U.viewerA, `UPDATE companies SET name=name WHERE id='${A}'`)
  c['viewer ändert Firmenstammdaten'] = !(r.ok && r.affected > 0)
  r = await as('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM customers WHERE company_id='${B}'`)
  c['owner A liest Kunden von B'] = r.ok && r.rows[0].n === 0
  r = await as('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM storage.objects WHERE name LIKE '${B}/%'`)
  c['owner A sieht Dateien von B'] = r.ok && r.rows[0].n === 0
  r = await as('authenticated', U.ownerA, `INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${B}/x.xlsx')`)
  c['owner A legt Datei bei B ab'] = !r.ok
  await db.exec(`DELETE FROM storage.objects WHERE name='${B}/x.xlsx'`)
  r = await as('authenticated', U.viewerA, `INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${A}/v.xlsx')`)
  c['viewer legt Datei ab'] = !r.ok
  await db.exec(`DELETE FROM storage.objects WHERE name='${A}/v.xlsx'`)
  r = await as('anon', null, `UPDATE streets SET postal_code=postal_code`)
  c['ohne Login Straßen ändern'] = !(r.ok && r.affected > 0)
  r = await as('authenticated', U.ownerA, `UPDATE streets SET postal_code=postal_code`)
  c['eingeloggt Straßen ändern'] = !(r.ok && r.affected > 0)
  r = await db.query(`SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND prosecdef
                      AND NOT coalesce(proconfig::text,'') LIKE '%search_path%'`)
  c['SECURITY DEFINER ohne search_path'] = r.rows.length === 0
  return c
}

// App-Zugriffe: true = funktioniert wie benötigt
async function appChecks() {
  const c = {}
  for (const [label, uid] of [['owner', U.ownerA], ['manager', U.managerA], ['viewer', U.viewerA]]) {
    let r = await as('authenticated', uid, `SELECT company_id FROM company_users WHERE user_id='${uid}'`)
    c[`${label}: eigene Firmenzugehörigkeit lesen`] = r.ok && r.rows.length === 1
    r = await as('authenticated', uid, `SELECT count(*)::int AS n FROM companies WHERE id='${A}'`)
    c[`${label}: eigene Firma lesen`] = r.ok && r.rows[0].n === 1
    r = await as('authenticated', uid, `SELECT count(*)::int AS n FROM customers`)
    c[`${label}: Kunden der Firma lesen`] = r.ok && r.rows[0].n === 2
    r = await as('authenticated', uid, `SELECT count(*)::int AS n FROM analytics`)
    c[`${label}: Analysen lesen`] = r.ok && r.rows[0].n === 1
    r = await as('authenticated', uid, `SELECT count(*)::int AS n FROM postal_codes`)
    c[`${label}: PLZ-Daten lesen`] = r.ok && r.rows[0].n >= 1
    r = await as('authenticated', uid, `SELECT count(*)::int AS n FROM poi_businesses`)
    c[`${label}: POI-Daten lesen`] = r.ok
    r = await as('authenticated', uid, `SELECT count(*)::int AS n FROM storage.objects WHERE name LIKE '${A}/%'`)
    c[`${label}: eigene Upload-Dateien sehen`] = r.ok && r.rows[0].n >= 1
  }
  let r = await as('authenticated', U.managerA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','11111')`)
  c['manager: Kunden anlegen'] = r.ok
  await db.exec(`DELETE FROM customers WHERE postal_code='11111'`)
  // Server (Service-Key umgeht RLS) – Registrierung und Upload
  await db.exec('RESET ROLE')
  try {
    await db.exec(`
      BEGIN;
      INSERT INTO companies (id, name, slug) VALUES ('10000000-0000-0000-0000-0000000000ee','Neu GmbH','neu');
      INSERT INTO company_users (company_id, user_id, role) VALUES ('10000000-0000-0000-0000-0000000000ee','${U.newUser}','owner');
      INSERT INTO customers (company_id, postal_code) VALUES ('10000000-0000-0000-0000-0000000000ee','50733');
      INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','10000000-0000-0000-0000-0000000000ee/n.csv');
      ROLLBACK;`)
    c['Server: Registrierung und Upload schreiben'] = true
  } catch (e) { await db.exec('ROLLBACK').catch(() => {}); c['Server: Registrierung und Upload schreiben'] = false }
  r = await as('authenticated', U.newUser, `SELECT 1`)
  c['neuer Nutzer kann sich anmelden (Abfrage möglich)'] = r.ok
  return c
}

// ── Ablauf ───────────────────────────────────────────────────────────────────
const sec0 = await securityState()
// Vorher-Prüfung zuerst: Sie darf vor 002 erlaubte Änderungen machen
// (z. B. Zeitstempel per Trigger). Der Datenstand wird danach festgehalten.
const before = await securityChecks()
const data0 = await dataState()
const srcBefore = (await db.query(`SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='on_auth_user_created'`)).rows[0]?.prosrc ?? null
const openBefore = Object.entries(before).filter(([, ok]) => !ok).map(([n]) => n)
const tenantBefore = await tenantChecks()
const openTenantBefore = Object.entries(tenantBefore).filter(([, ok]) => !ok).map(([n]) => n)

// Fehlerfall: 002 bricht kurz vor dem Ende ab → es darf sich nichts geändert haben
{
  const lastCommit = MIGRATION.lastIndexOf('COMMIT;')
  const broken = MIGRATION.slice(0, lastCommit) + "DO $x$ BEGIN RAISE EXCEPTION 'absichtlicher Testabbruch'; END $x$;\n" + MIGRATION.slice(lastCommit)
  let failed = false
  try { await db.exec(broken) } catch { failed = true; await db.exec('ROLLBACK').catch(() => {}) }
  pass('Fehlerfall: abgebrochene 002 meldet Fehler', failed)
  pass('Fehlerfall: abgebrochene 002 ändert nichts (Regeln, Funktionen, RLS, Bucket)', (await securityState()) === sec0)
  pass('Fehlerfall: abgebrochene 002 hinterlässt keine Sicherung',
    !(await db.query(`SELECT to_regclass('migration_backup.m002_state') IS NOT NULL AS x`)).rows[0].x)
  pass('Fehlerfall: Daten unverändert', JSON.stringify(await dataState()) === JSON.stringify(data0))
}

try { await db.exec(MIGRATION); pass('Migration 002 läuft ohne Fehler', true) }
catch (e) { await db.exec('ROLLBACK').catch(() => {}); pass('Migration 002 läuft ohne Fehler', false, e.message); report() }

const srcOf = async () => (await db.query(`SELECT prosrc FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname='on_auth_user_created'`)).rows[0]?.prosrc ?? null
if (srcBefore !== null) pass('on_auth_user_created: Inhalt durch 002 unverändert', (await srcOf()) === srcBefore)
for (const [n, ok] of Object.entries(await securityChecks())) pass(`Sicher nach 002: ${n}`, ok)
for (const [n, ok] of Object.entries(await tenantChecks())) pass(`Trennung nach 002: ${n}`, ok)
for (const [n, ok] of Object.entries(await appChecks())) pass(`App nach 002: ${n}`, ok)
const data1 = await dataState()
pass('Daten nach 002 unverändert (alle Tabellen, Zeile für Zeile)', JSON.stringify(data0) === JSON.stringify(data1),
  JSON.stringify(data0) === JSON.stringify(data1) ? '' : 'Abweichung')

const backupCount1 = (await db.query(`SELECT count(*)::int AS n FROM migration_backup.m002_state`)).rows[0].n
const sec1 = await securityState()
try { await db.exec(MIGRATION); pass('Zweiter Lauf von 002 ohne Fehler', true) }
catch (e) { await db.exec('ROLLBACK').catch(() => {}); pass('Zweiter Lauf von 002 ohne Fehler', false, e.message) }
pass('Zweiter Lauf ändert nichts', (await securityState()) === sec1)
const backupCount2 = (await db.query(`SELECT count(*)::int AS n FROM migration_backup.m002_state`)).rows[0].n
pass('Sicherung beim zweiten Lauf nicht überschrieben', backupCount1 === backupCount2, `${backupCount1} Einträge`)
let r = await as('authenticated', U.ownerA, `SELECT count(*) FROM migration_backup.m002_state`)
pass('Sicherung für eingeloggte Nutzer nicht lesbar', !r.ok)
r = await as('anon', null, `SELECT count(*) FROM migration_backup.m002_state`)
pass('Sicherung ohne Login nicht lesbar', !r.ok)

try { await db.exec(ROLLBACK); pass('Rückfall läuft ohne Fehler', true) }
catch (e) { await db.exec('ROLLBACK').catch(() => {}); pass('Rückfall läuft ohne Fehler', false, e.message); report() }
const sec2 = await securityState()
pass('Rückfall: Regeln, Funktionen, RLS, Bucket exakt wie vor 002', sec2 === sec0)
pass('Rückfall: Daten unverändert', JSON.stringify(await dataState()) === JSON.stringify(data0))
const afterRollback = await securityChecks()
pass('Rückfall: gleiches Verhalten wie vorher', JSON.stringify(afterRollback) === JSON.stringify(before))

try { await db.exec(MIGRATION); pass('002 nach Rückfall erneut ausführbar', true) }
catch (e) { await db.exec('ROLLBACK').catch(() => {}); pass('002 nach Rückfall erneut ausführbar', false, e.message) }
pass('Nach erneutem 002 wieder sicher', Object.values(await securityChecks()).every(Boolean))
pass('Nach erneutem 002 Mandantentrennung vollständig', Object.values(await tenantChecks()).every(Boolean))
pass('Nach erneutem 002 dieselben Regeln wie beim ersten Mal', (await securityState()) === sec1)

// Rückfall ohne Sicherung muss abbrechen
await db.exec(`DROP SCHEMA migration_backup CASCADE`)
const sec3 = await securityState()
try { await db.exec(ROLLBACK); pass('Rückfall ohne Sicherung bricht ab', false) }
catch { await db.exec('ROLLBACK').catch(() => {}); pass('Rückfall ohne Sicherung bricht ab', true) }
pass('… und ändert dabei nichts', (await securityState()) === sec3)

report()

function report() {
  console.log(`\n=== ${schemaFiles.map(f => f.split('/').pop()).join(' + ')} ===`)
  console.log(`Vor 002 offen (${openBefore.length}): ${openBefore.join('; ') || '–'}`)
  console.log(`Trennung vor 002 offen (${openTenantBefore?.length ?? 0}): ${openTenantBefore?.join('; ') || '–'}\n`)
  for (const x of results) console.log(`${x.ok ? 'ok      ' : 'FEHLER  '} ${x.name}${x.info ? ` (${x.info})` : ''}`)
  const failed = results.filter(x => !x.ok).length
  console.log(`\n${results.length - failed} von ${results.length} bestanden`)
  process.exit(failed ? 1 : 0)
}
