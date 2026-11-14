// Test für Migration 007 (Datenminimierung) auf lokalem PostgreSQL.
// Prüft auch, dass Datenbank und Programm dasselbe Kennzeichen berechnen.
const { Client } = require('pg'); const fs = require('fs'); const path = require('path'); const crypto = require('crypto')
const R = path.join(__dirname, '../../../'); const SQL = f => fs.readFileSync(R + f, 'utf8')
const conn = db => new Client({ host: '/var/tmp/pgtest', port: 54329, user: 'postgres', database: db })
const res = []; const ok = (n, c, i = '') => res.push(`${c ? 'OK    ' : 'FEHLER'} ${n}${i && !c ? ' – ' + i : ''}`)
const A = '10000000-0000-0000-0000-00000000000a', B = '10000000-0000-0000-0000-00000000000b'
const js = (cid, tel) => 'p1:' + crypto.createHash('sha256').update(`${cid}:${tel}`, 'utf8').digest('hex')
;(async () => {
  const a = conn('postgres'); await a.connect(); await a.query('drop database if exists t007'); await a.query('create database t007'); await a.end()
  const c = conn('t007'); await c.connect(); c.on('notice', () => {})
  await c.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pg_trgm;
    DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $r$;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
    CREATE SCHEMA storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean);
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name,'/') $$;`)
  await c.query(SQL('SETUP_DATABASE.sql').replace(/CREATE EXTENSION IF NOT EXISTS "postgis".*\n/, ''))
  await c.query(SQL('supabase/pending/004_upload_import_mode.sql'))
  await c.query(`INSERT INTO companies (id, name, slug) VALUES ('${A}','A','a'),('${B}','B','b');
    INSERT INTO customers (company_id, postal_code, phone_normalized, phone_raw, first_name, last_name, full_name, total_orders, total_revenue, customer_ref) VALUES
      ('${A}','50733','+4922112345','0221 12345','Nina','Weiß','Nina Weiß',5,143.91,NULL),
      ('${A}','50733','+4922112345','0221-12345','Nina','Weiß','Nina Weiß',2,40.00,NULL),
      ('${A}','50735','+491701234567','0170 1234567','Yusuf','Kaya','Yusuf Kaya',1,19.90,NULL),
      ('${A}','50735',NULL,NULL,NULL,NULL,NULL,3,60.00,'K-77'),
      ('${B}','01067','+4922112345','0221 12345','Nina','Weiß','Nina Weiß',7,200.00,NULL),
      ('${B}','01067','${js(B, '+49351999')}',NULL,NULL,NULL,NULL,1,10.00,NULL);`)
  const snap = async () => (await c.query(`SELECT count(*)::int n, sum(total_orders)::int o, sum(total_revenue)::text r FROM customers`)).rows[0]
  const policies = async () => (await c.query(`SELECT md5(string_agg(tablename||policyname||coalesce(qual,''), ',' ORDER BY 1)) h FROM pg_policies`)).rows[0].h
  const s0 = await snap(), p0 = await policies()
  let e = null; try { await c.query(SQL('supabase/pending/007_datenminimierung.sql')) } catch (x) { e = x.message }
  ok('1 Migration 007 läuft', !e, e)
  const rows = (await c.query(`SELECT company_id, phone_normalized, phone_raw, first_name, last_name, full_name, customer_ref, total_orders FROM customers ORDER BY company_id, total_orders`)).rows
  ok('2 Keine Namen und Rohnummern mehr', rows.every(r => !r.phone_raw && !r.first_name && !r.last_name && !r.full_name))
  ok('3 Keine Telefonnummer mehr im Klartext', rows.every(r => !r.phone_normalized || r.phone_normalized.startsWith('p1:')))
  const nina = rows.filter(r => r.company_id === A && [5, 2].includes(r.total_orders))
  ok('4 Derselbe Kunde behält in derselben Firma dasselbe Kennzeichen', nina.length === 2 && nina[0].phone_normalized === nina[1].phone_normalized)
  ok('5 Datenbank rechnet wie das Programm', nina[0].phone_normalized === js(A, '+4922112345'), nina[0].phone_normalized)
  const ninaB = rows.find(r => r.company_id === B && r.total_orders === 7)
  ok('6 Dieselbe Nummer ergibt in einer anderen Firma ein anderes Kennzeichen', ninaB.phone_normalized !== nina[0].phone_normalized && ninaB.phone_normalized === js(B, '+4922112345'))
  ok('7 Bereits ersetzte Kennzeichen bleiben unverändert', rows.find(r => r.company_id === B && r.total_orders === 1).phone_normalized === js(B, '+49351999'))
  ok('8 Kundennummer bleibt, fehlende Nummer bleibt leer', rows.find(r => r.customer_ref === 'K-77').phone_normalized === null)
  const s1 = await snap(); ok('9 Datensätze, Bestellungen, Umsatz unverändert', JSON.stringify(s0) === JSON.stringify(s1), JSON.stringify([s0, s1]))
  ok('10 Zugriffsregeln unverändert', p0 === await policies())
  const before = JSON.stringify((await c.query('SELECT * FROM customers ORDER BY id')).rows)
  e = null; try { await c.query(SQL('supabase/pending/007_datenminimierung.sql')) } catch (x) { e = x.message }
  ok('11 Zweiter Lauf: kein Fehler, nichts geändert', !e && before === JSON.stringify((await c.query('SELECT * FROM customers ORDER BY id')).rows), e)
  const ctrl = (await c.query(`SELECT count(*) FILTER (WHERE phone_normalized IS NOT NULL AND phone_normalized NOT LIKE 'p1:%')::int a, count(*) FILTER (WHERE phone_raw IS NOT NULL)::int b FROM customers`)).rows[0]
  ok('12 Kontrollabfrage: 0 / 0', ctrl.a === 0 && ctrl.b === 0)
  await c.end(); console.log('Migration 007 – Test\n' + res.join('\n')); const bad = res.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${res.length - bad}/${res.length} bestanden`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
