// =============================================================================
// RLS-Test für die Datenbankregeln – läuft lokal ohne Supabase-Zugang.
// Baut eine Supabase-ähnliche Postgres-Instanz im Speicher nach (PGlite) und
// prüft, was eingeloggte Nutzer, viewer und Fremde dürfen.
//
// Benötigt das Paket @electric-sql/pglite. Es ist BEWUSST NICHT in
// package.json eingetragen (neue Abhängigkeit = Freigabe nötig).
// Ausführen (--no-save ändert package.json und package-lock.json nicht):
//   npm install --no-save @electric-sql/pglite
//   node supabase/pending/rls-test.mjs SETUP_DATABASE.sql
//   node supabase/pending/rls-test.mjs SETUP_DATABASE.sql supabase/pending/002_security_policies.sql
// =============================================================================
// Testet die RLS-Regeln in einer lokalen Postgres-Instanz (PGlite).
// Nachbau der Supabase-Umgebung: auth.uid(), Rollen anon/authenticated, storage.
// Aufruf: node rls-test.mjs <schema.sql> [<migration-002.sql>]
import { PGlite } from '@electric-sql/pglite'
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readFileSync } from 'node:fs'

const [schemaPath, migrationPath] = process.argv.slice(2)
process.on('unhandledRejection', e => { console.log('FEHLER:', e.message, e.position ? '@'+e.position : ''); process.exit(1) })
const db = new PGlite({ extensions: { uuid_ossp, pg_trgm } })

// ── Supabase-Umgebung nachbauen ──────────────────────────────────────────────
await db.exec(`
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
    $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  CREATE SCHEMA storage;
  CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
  CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
  CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS
    $$ SELECT (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'),1)-1] $$;
`)

let schema = readFileSync(schemaPath, 'utf8').replace(/CREATE EXTENSION IF NOT EXISTS "postgis".*\n/, '')
await db.exec(schema)
if (migrationPath) { try { await db.exec(readFileSync(migrationPath, 'utf8')); await db.exec(readFileSync(migrationPath, 'utf8')) } catch (e) { console.log('MIGRATION FEHLER:', e.message); process.exit(1) } }

// Supabase-Standardrechte: API-Rollen dürfen grundsätzlich alles, RLS filtert
await db.exec(`
  GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated;
  GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated;
  GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth, storage TO anon, authenticated;
`)

// ── Testdaten (als Superuser, wie der Service-Key) ───────────────────────────
const U = {
  ownerA:   '00000000-0000-0000-0000-00000000000a',
  viewerA:  '00000000-0000-0000-0000-0000000000a2',
  ownerB:   '00000000-0000-0000-0000-00000000000b',
  attacker: '00000000-0000-0000-0000-0000000000ff', // eingeloggt, keine Firma
  multi:    '00000000-0000-0000-0000-0000000000aa', // owner in A, viewer in B
}
const A = '10000000-0000-0000-0000-00000000000a'
const B = '10000000-0000-0000-0000-00000000000b'
await db.exec(`
  INSERT INTO auth.users VALUES ${Object.values(U).map(u => `('${u}')`).join(',')};
  INSERT INTO companies (id, name, slug) VALUES ('${A}','Firma A','a'), ('${B}','Firma B','b');
  INSERT INTO company_users (company_id, user_id, role, joined_at) VALUES
    ('${A}','${U.ownerA}','owner', now()), ('${A}','${U.viewerA}','viewer', now()),
    ('${B}','${U.ownerB}','owner', now()),
    ('${B}','${U.multi}','viewer', now() - interval '1 day'), ('${A}','${U.multi}','owner', now());
  INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50733'), ('${B}','50823');
  INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${A}/a.xlsx'), ('uploads','${B}/b.xlsx');
  INSERT INTO postal_codes (postal_code, city) VALUES ('50733','Köln');
  INSERT INTO streets (postal_code, name, name_normalized) VALUES ('50733','Neusser Str.','neusserstr');
`)

// ── Hilfen ───────────────────────────────────────────────────────────────────
async function as(role, userId, sql) {
  await db.exec('RESET ROLE')
  await db.query(`SELECT set_config('request.jwt.claim.sub', $1, false)`, [userId ?? ''])
  await db.exec(`SET ROLE ${role}`)
  try { const r = await db.query(sql); return { ok: true, rows: r.rows, affected: r.affectedRows } }
  catch (e) { return { ok: false, error: e.message } }
  finally { await db.exec('RESET ROLE') }
}
const results = []
function check(name, unsafe) { results.push([unsafe ? 'UNSICHER' : 'ok', name]) }

// 1. Fremde Firma beitreten
let r = await as('authenticated', U.attacker,
  `INSERT INTO company_users (company_id, user_id, role) VALUES ('${B}','${U.attacker}','owner')`)
check('Eingeloggter Nutzer trägt sich als owner in fremde Firma ein', r.ok)
await db.exec(`DELETE FROM company_users WHERE user_id = '${U.attacker}'`)

// 2. Firma aus dem Browser anlegen
r = await as('authenticated', U.attacker, `INSERT INTO companies (name, slug) VALUES ('X','x')`)
check('Firma direkt aus dem Browser anlegen', r.ok)

// 4. viewer liest eigene Daten (muss gehen)
r = await as('authenticated', U.viewerA, `SELECT count(*)::int AS n FROM customers`)
results.push([r.ok && r.rows[0].n >= 1 ? 'ok' : 'FEHLER', 'viewer liest Kunden der eigenen Firma'])

// 3. viewer schreibt Kundendaten
r = await as('authenticated', U.viewerA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50000')`)
check('viewer legt Kunden in eigener Firma an', r.ok)
r = await as('authenticated', U.viewerA, `DELETE FROM customers WHERE company_id = '${A}'`)
check('viewer löscht Kunden der eigenen Firma', r.ok && r.affected > 0)


// 5. Fremde Kundendaten lesen
r = await as('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM customers WHERE company_id = '${B}'`)
check('owner A liest Kunden von Firma B', r.ok && r.rows[0].n > 0)

// 6. Fremde Upload-Dateien lesen
r = await as('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM storage.objects WHERE name LIKE '${B}/%'`)
check('owner A sieht Upload-Dateien von Firma B', r.ok && r.rows[0].n > 0)
r = await as('authenticated', U.ownerA, `INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${B}/fremd.xlsx')`)
check('owner A legt Datei in den Ordner von Firma B', r.ok)
r = await as('authenticated', U.viewerA, `INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${A}/viewer.xlsx')`)
check('viewer legt Datei in eigenen Firmenordner', r.ok)

// 7. Referenzdaten ohne Login verändern
r = await as('anon', null, `DELETE FROM streets`)
check('Nicht eingeloggt: Straßenverzeichnis löschen', r.ok && r.affected > 0)
await db.exec(`INSERT INTO streets (postal_code, name, name_normalized) VALUES ('50733','Neusser Str.','neusserstr') ON CONFLICT DO NOTHING`)
r = await as('authenticated', U.viewerA, `SELECT count(*)::int AS n FROM streets`)
results.push([r.ok && r.rows[0].n >= 1 ? 'ok' : 'FEHLER', 'Eingeloggt: Straßenverzeichnis lesen'])

// 8. Mehrere Firmen: Rolle aus der richtigen Firma?
r = await as('authenticated', U.multi, `SELECT get_my_company_id()::text AS c, my_company_role()::text AS role`)
const multiCompany = r.rows?.[0]
check(`Nutzer in 2 Firmen bekommt Rolle der falschen Firma (Firma=${multiCompany?.c === A ? 'A' : 'B'}, Rolle=${multiCompany?.role})`,
  multiCompany && !((multiCompany.c === A && multiCompany.role === 'owner') || (multiCompany.c === B && multiCompany.role === 'viewer')))

// 9. search_path der SECURITY-DEFINER-Funktionen
r = await db.query(`SELECT proname, proconfig FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosecdef`)
const noPath = r.rows.filter(p => !(p.proconfig || []).some(c => c.startsWith('search_path='))).map(p => p.proname)
check(`SECURITY DEFINER ohne festen search_path: ${noPath.join(', ') || '–'}`, noPath.length > 0)

// 10. Positive Fälle: berechtigte Rollen dürfen weiter arbeiten
r = await as('authenticated', U.ownerA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50111')`)
results.push([r.ok ? 'ok' : 'FEHLER', 'owner legt Kunden in eigener Firma an'])
await db.exec(`INSERT INTO company_users (company_id, user_id, role) VALUES ('${A}','${U.attacker}','manager')`)
r = await as('authenticated', U.attacker, `UPDATE customers SET city = 'Köln' WHERE company_id = '${A}'`)
results.push([r.ok && r.affected > 0 ? 'ok' : 'FEHLER', 'manager ändert Kunden der eigenen Firma'])
r = await as('authenticated', U.attacker, `INSERT INTO customers (company_id, postal_code) VALUES ('${B}','50999')`)
check('manager von A legt Kunden in Firma B an', r.ok)
await db.exec(`DELETE FROM company_users WHERE user_id = '${U.attacker}'`)
r = await as('authenticated', U.ownerA, `INSERT INTO storage.objects (bucket_id, name) VALUES ('uploads','${A}/neu.xlsx')`)
results.push([r.ok ? 'ok' : 'FEHLER', 'owner legt Datei in eigenen Firmenordner'])
r = await as('authenticated', U.ownerA, `SELECT count(*)::int AS n FROM storage.objects WHERE name LIKE '${A}/%'`)
results.push([r.ok && r.rows[0].n >= 1 ? 'ok' : 'FEHLER', 'owner sieht eigene Upload-Dateien'])
r = await as('authenticated', U.viewerA, `UPDATE companies SET name = 'gehackt' WHERE id = '${A}'`)
check('viewer ändert Firmenstammdaten', r.ok && r.affected > 0)

console.log(`\n=== ${schemaPath.split('/').pop()}${migrationPath ? ' + ' + migrationPath.split('/').pop() : ''} ===`)
for (const [s, n] of results) console.log(`${s.padEnd(9)} ${n}`)
