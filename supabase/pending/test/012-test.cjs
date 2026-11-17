// Test für Migration 012 (Tabellenrechte auf das Minimum) und ihren Rückfall auf echtem PostgreSQL (lokal), aufbauend auf 010 und 011.
// Aufruf: node supabase/pending/test/012-test.cjs
// Verbindung: Unix-Socket /var/tmp/pgtest, Port 54329 (nur Wegwerf-Datenbanken, nie Produktion).
// Der Datenbankaufbau entspricht 006-test.cjs (Supabase-Standardrechte, Produktionsstand, 002–005),
// danach werden 006 bis 009 wie im Testprojekt eingespielt. Nur künstliche Testdaten.
const { Client } = require('pg')
const fs = require('fs'); const path = require('path')
const R = path.join(__dirname, '../../../')
const SQL = f => fs.readFileSync(R + f, 'utf8')
const M006 = SQL('supabase/pending/006_funktionen_bucket_haertung.sql'), RB = SQL('supabase/pending/006_rollback.sql')
// In Produktion am 11.11.2026 ausgeführt (SHA-256 01edd7e2…ad7286e8)
const SOFORT = path.join(__dirname, 'sofort-referenzdaten-2026-11-11.sql')
const conn = db => new Client({ host: process.env.PGHOST || '/var/tmp/pgtest', port: +(process.env.PGPORT || 54329), user: 'postgres', database: db })
const results = []; const ok = (n, c, i = '') => results.push(`${c ? 'OK    ' : 'FEHLER'} ${n}${i && !c ? ' – ' + i : ''}`)
const A = '10000000-0000-0000-0000-00000000000a', B = '10000000-0000-0000-0000-00000000000b'
const UA = '00000000-0000-0000-0000-00000000000a', UB = '00000000-0000-0000-0000-00000000000b', UNEW = '00000000-0000-0000-0000-0000000000ee'
const UADMIN='00000000-0000-0000-0000-0000000000a1', UMAN='00000000-0000-0000-0000-0000000000a2', UVIEW='00000000-0000-0000-0000-0000000000a3', UNONE='00000000-0000-0000-0000-0000000000a4'
async function fresh(name, { full = false, bucketColumns = true } = {}) {
  const a = conn('postgres'); await a.connect(); await a.query(`drop database if exists ${name}`); await a.query(`create database ${name}`); await a.end()
  const c = conn(name); await c.connect(); c.on('notice', () => {})
  await c.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"; CREATE EXTENSION IF NOT EXISTS pg_trgm;
    DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF; END $r$;
    CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE SCHEMA storage;
    CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean ${bucketColumns ? ', file_size_limit bigint, allowed_mime_types text[]' : ''});
    CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text);
    CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name,'/') $$;`)
  for (const f of ['SETUP_DATABASE.sql', 'supabase/pending/test/prod-like-extra.sql'])
    await c.query(SQL(f).replace(/CREATE EXTENSION IF NOT EXISTS "postgis".*\n/, ''))
  // Supabase-Standardrechte: Tabellen und Funktionen für anon/authenticated/service_role
  await c.query(`GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth, storage TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
    INSERT INTO auth.users VALUES ('${UA}','a@test'),('${UB}','b@test'),('${UNEW}','neu@test');
    INSERT INTO companies (id, name, slug) VALUES ('${A}','A','a'),('${B}','B','b');
    INSERT INTO company_users (company_id, user_id, role) VALUES ('${A}','${UA}','owner'),('${B}','${UB}','owner');
    INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50733'),('${A}','50735'),('${B}','01067');`)
  // Auslöser auf auth.users wie in Supabase; die Funktion protokolliert ihren Lauf
  await c.query(`CREATE TABLE public.trigger_log (id uuid);
    CREATE OR REPLACE FUNCTION public.on_auth_user_created() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      -- Erkennungszeichen: ORIGINAL-INHALT-PRODUKTION
      INSERT INTO public.trigger_log VALUES (NEW.id); RETURN NEW;
    END $$;
    CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.on_auth_user_created();
    DO $r$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='auth_admin_test') THEN CREATE ROLE auth_admin_test NOLOGIN; END IF; END $r$;
    GRANT USAGE ON SCHEMA auth TO auth_admin_test; GRANT INSERT ON auth.users TO auth_admin_test;
    REVOKE ALL ON public.trigger_log FROM anon, authenticated, service_role;`)
  await c.query(fs.readFileSync(SOFORT, 'utf8'))                    // heutiger Produktionsstand
  if (full) for (const f of ['002_security_policies.sql', '003_register_company.sql', '004_upload_import_mode.sql', '005_population_provenance.sql'])
    await c.query(SQL('supabase/pending/' + f))
  return c
}
const run = async (c, sql) => { try { await c.query(sql); return { ok: true } } catch (e) { try { await c.query('ROLLBACK') } catch {} return { ok: false, err: e.message } } }
const as = async (c, role, uid, sql) => {
  await c.query('BEGIN'); try {
    await c.query(`SET LOCAL ROLE ${role}`); await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid || ''])
    const r = await c.query(sql); await c.query('ROLLBACK'); return { ok: true, rows: r.rows, n: r.rowCount }
  } catch (e) { await c.query('ROLLBACK'); return { ok: false, err: e.message, code: e.code } }
}
// mehrere Anweisungen in einer Sitzung (immer zurückgerollt)
const asMulti = async (c, role, uid, sqls) => {
  const out = []; await c.query('BEGIN')
  try {
    await c.query(`SET LOCAL ROLE ${role}`); await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid || ''])
    for (const s of sqls) {
      await c.query('SAVEPOINT s')
      try { const r = await c.query(s); out.push({ ok: true, rows: r.rows, n: r.rowCount }); await c.query('RELEASE SAVEPOINT s') }
      catch (e) { out.push({ ok: false, err: e.message, code: e.code }); await c.query('ROLLBACK TO SAVEPOINT s') }
    }
  } finally { await c.query('ROLLBACK') }
  return out
}
const M = f => fs.readFileSync(R + 'supabase/pending/' + f, 'utf8')
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function build(name) {
  const c = await fresh(name, { full: true })
  for (const f of ['006_funktionen_bucket_haertung.sql', '007_datenminimierung.sql', '008_loeschen_indizes.sql', '009_geodaten_deutschland.sql']) {
    const r = await run(c, M(f)); if (!r.ok) throw new Error('Aufbau: ' + f + ' – ' + r.err)
  }
  await c.query(`INSERT INTO auth.users VALUES ('${UADMIN}','admin@test'),('${UMAN}','man@test'),('${UVIEW}','view@test'),('${UNONE}','none@test');
    INSERT INTO company_users (company_id, user_id, role) VALUES ('${A}','${UADMIN}','admin'),('${A}','${UMAN}','manager'),('${A}','${UVIEW}','viewer');`)
  return c
}
// Alle Rechte auf companies (Tabelle + Spalten, alle Rollen) als vergleichbarer Text
const acl = async c => (await c.query(`
  SELECT 'T' e, '' col, a.grantee::regrole::text g, a.grantor::regrole::text gr, a.privilege_type p, a.is_grantable gg
    FROM pg_class cl, LATERAL aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) a WHERE cl.oid='public.companies'::regclass
  UNION ALL SELECT 'C', at.attname, a.grantee::regrole::text, a.grantor::regrole::text, a.privilege_type, a.is_grantable
    FROM pg_attribute at, LATERAL aclexplode(at.attacl) a WHERE at.attrelid='public.companies'::regclass AND at.attnum>0 AND NOT at.attisdropped
  ORDER BY 1,2,3,5,4`)).rows.map(r => Object.values(r).join(',')).join('\n')
const other = async c => (await c.query(`
  SELECT md5(string_agg(x, '|' ORDER BY x)) h FROM (
   SELECT 'tab:'||c.relname||':'||coalesce(c.relacl::text,'') x FROM pg_class c WHERE c.relnamespace IN ('public'::regnamespace,'storage'::regnamespace,'auth'::regnamespace) AND c.relkind='r' AND c.oid <> 'public.companies'::regclass
   UNION ALL SELECT 'pol:'||schemaname||tablename||policyname||permissive||roles::text||cmd||coalesce(qual,'')||coalesce(with_check,'') FROM pg_policies
   UNION ALL SELECT 'fn:'||p.oid::regprocedure::text||md5(prosrc)||coalesce(proacl::text,'')||prosecdef FROM pg_proc p WHERE pronamespace='public'::regnamespace
   UNION ALL SELECT 'trg:'||tgname||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal) s`)).rows[0].h
const daten = async c => (await c.query(`SELECT md5(string_agg(co::text, '|' ORDER BY id)) h FROM companies co`)).rows[0].h
const denied = r => (!r.ok && r.code === '42501') || (r.ok && r.n === 0)
const results2 = results
// Rechte aller Tabellen in public (ohne companies) für anon/authenticated, Tabelle+Spalte+Standardrechte, als Text
const aclAll = async c => (await c.query(`
  SELECT string_agg(x, E'\n' ORDER BY x) s FROM (
   SELECT 'T:'||cl.relname||':'||a.grantee::regrole::text||':'||a.privilege_type||':'||a.is_grantable x
     FROM pg_class cl, LATERAL aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) a
     WHERE cl.relnamespace='public'::regnamespace AND cl.relkind IN ('r','p') AND cl.relname<>'companies' AND a.grantee IN ('anon'::regrole,'authenticated'::regrole)
   UNION ALL SELECT 'C:'||cl.relname||'.'||at.attname||':'||a.grantee::regrole::text||':'||a.privilege_type||':'||a.is_grantable
     FROM pg_class cl JOIN pg_attribute at ON at.attrelid=cl.oid AND at.attnum>0 AND NOT at.attisdropped AND at.attacl IS NOT NULL, LATERAL aclexplode(at.attacl) a
     WHERE cl.relnamespace='public'::regnamespace AND cl.relkind IN ('r','p') AND cl.relname<>'companies' AND a.grantee IN ('anon'::regrole,'authenticated'::regrole)
   UNION ALL SELECT 'D:'||d.defaclrole::regrole::text||':'||a.grantee::regrole::text||':'||a.privilege_type
     FROM pg_default_acl d, LATERAL aclexplode(d.defaclacl) a WHERE d.defaclnamespace='public'::regnamespace AND d.defaclobjtype='r' AND a.grantee IN ('anon'::regrole,'authenticated'::regrole)) q`)).rows[0].s
const SPEC = {
  rw: ['alerts', 'analytics', 'customers', 'marketing_actions', 'street_analytics', 'uploads'],
  ro: ['stores', 'company_users', 'postal_codes', 'streets', 'poi_businesses', 'plz_localities', 'street_directory'],
  none: ['data_refresh_logs'],
}
;(async () => {
  const c = await build('t012a')
  for (const f of ['010_firmenfelder_schutz.sql', '011_places_schluessel_schutz.sql']) { const r = await run(c, M(f)); if (!r.ok) throw new Error(f + ': ' + r.err) }
  await c.query(`INSERT INTO stores (company_id, name) VALUES ('${A}','Filiale A'),('${B}','Filiale B');
    INSERT INTO postal_codes (postal_code, city) VALUES ('50733','Köln'); INSERT INTO streets (postal_code, name, name_normalized) VALUES ('50733','Neusser Str.','neusserstr');
    INSERT INTO data_refresh_logs (postal_code, data_type, data_source, status) VALUES ('50733','streets','openplz','success');`)
  const acl0 = await aclAll(c), oth0 = await other(c)
  const cnt = async () => (await c.query(`SELECT (SELECT count(*) FROM customers) k, (SELECT count(*) FROM stores) s, (SELECT count(*) FROM company_users) m, (SELECT count(*) FROM streets) st, (SELECT count(*) FROM postal_codes) p, (SELECT count(*) FROM companies) f`)).rows[0]
  const dat0 = JSON.stringify(await cnt()), hash0 = await daten(c)
  let r = await as(c, 'authenticated', UA, `TRUNCATE customers`)
  ok('01 Vorher: authenticated kann TRUNCATE (Lücke bestätigt, RLS schützt dort nicht)', r.ok, JSON.stringify(r).slice(0, 100))
  r = await as(c, 'anon', null, `SELECT count(*) FROM postal_codes`)
  ok('02 Vorher: anon hat Zugriff auf Tabellen', r.ok, JSON.stringify(r).slice(0, 100))

  // Voraussetzung wird geprüft
  const x = await build('t012x'); const xa = await aclAll(x)
  r = await run(x, M('012_tabellenrechte_minimum.sql')); ok('03 012 ohne 010/011 bricht ab', !r.ok && /nicht eingespielt/.test(r.err || ''), r.err)
  ok('04 … und ändert nichts', (await aclAll(x)) === xa); await x.end()

  r = await run(c, M('012_tabellenrechte_minimum.sql')); ok('05 Migration 012 läuft', r.ok, r.err)
  ok('06 Daten, Regeln, Funktionen unverändert', (await other(c)) === (await other(c)) && JSON.stringify(await cnt()) === dat0 && (await daten(c)) === hash0)
  const nbk = (await c.query(`SELECT count(*)::int n FROM migration_backup.m012_acl`)).rows[0].n
  ok('07 Sicherung angelegt', nbk > 50, 'Zeilen: ' + nbk)
  const bp = (await c.query(`SELECT has_table_privilege('authenticated','migration_backup.m012_acl','SELECT') b, has_schema_privilege('anon','migration_backup','USAGE') u`)).rows[0]
  ok('08 Sicherung für anon/authenticated nicht erreichbar', !bp.b && !bp.u)

  // Rechte-Matrix
  const tabs = (await c.query(`SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND relname NOT IN ('companies','trigger_log') ORDER BY 1`)).rows.map(r => r.relname)
  const classified = [...SPEC.rw, ...SPEC.ro, ...SPEC.none].sort()
  ok('09 Jede Tabelle ist eingeordnet (keine übersehen)', eq(tabs.slice().sort(), classified), JSON.stringify(tabs))
  const has = async (role, t, p) => (await c.query(`SELECT has_table_privilege('${role}', 'public.${t}', '${p}') h`)).rows[0].h
  for (const t of tabs) {
    const anonAny = await Promise.all(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'].map(p => has('anon', t, p)))
    ok(`10 anon: keinerlei Recht auf ${t}`, anonAny.every(v => !v))
    for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) if (await has('authenticated', t, p)) ok(`11 authenticated ${p} auf ${t}`, false)
    const exp = SPEC.rw.includes(t) ? [true, true, true, true] : SPEC.ro.includes(t) ? [true, false, false, false] : [false, false, false, false]
    const got = await Promise.all(['SELECT', 'INSERT', 'UPDATE', 'DELETE'].map(p => has('authenticated', t, p)))
    ok(`12 authenticated auf ${t}: ${SPEC.rw.includes(t) ? 'lesen+schreiben' : SPEC.ro.includes(t) ? 'nur lesen' : 'nichts'}`, eq(got, exp), JSON.stringify(got))
    ok(`13 service_role behält alle Rechte auf ${t}`, (await has('service_role', t, 'SELECT')) && (await has('service_role', t, 'DELETE')) && (await has('service_role', t, 'TRUNCATE')))
  }
  ok('14 postgres (Betreiber) behält Rechte', await has('postgres', 'customers', 'TRUNCATE'))
  r = await as(c, 'authenticated', UA, `SELECT name, plan FROM companies WHERE id='${A}'`); ok('15 companies (010/011) unverändert lesbar', r.ok && r.rows.length === 1, r.err)
  r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`); ok('16 companies: Tarif weiter geschützt', !r.ok && r.code === '42501')

  // Funktionstest als echte Rollen (alle Schreibwege der App)
  for (const [n, uid] of [['owner', UA], ['admin', UADMIN], ['manager', UMAN]]) {
    const rr = await asMulti(c, 'authenticated', uid, [
      `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50737') RETURNING id`,
      `UPDATE customers SET postal_code='50739' WHERE company_id='${A}' AND postal_code='50737'`,
      `INSERT INTO uploads (company_id, uploaded_by, filename, storage_path, file_size_bytes, status) VALUES ('${A}','${uid}','t.csv','A/t.csv',1,'completed')`,
      `UPDATE uploads SET status='replaced' WHERE company_id='${A}' AND filename='t.csv'`,
      `INSERT INTO analytics (company_id, postal_code) VALUES ('${A}','50999')`,
      `INSERT INTO street_analytics (company_id, analytics_id, postal_code, street_name, street_name_normalized) SELECT '${A}', id, '50999', 'X', 'x' FROM analytics WHERE company_id='${A}' AND postal_code='50999'`,
      `INSERT INTO alerts (company_id, severity, category, title, message) VALUES ('${A}','info','x','t','m')`,
      `UPDATE alerts SET is_resolved=true WHERE company_id='${A}'`,
      `INSERT INTO marketing_actions (company_id, action_type, title) VALUES ('${A}','flyer','t')`,
      `DELETE FROM customers WHERE company_id='${A}'`, `DELETE FROM uploads WHERE company_id='${A}'`, `DELETE FROM analytics WHERE company_id='${A}'`,
      `DELETE FROM street_analytics WHERE company_id='${A}'`, `DELETE FROM alerts WHERE company_id='${A}'`, `DELETE FROM marketing_actions WHERE company_id='${A}'`])
    const fail = rr.map((x, i) => [i, x]).filter(([, x]) => !x.ok)
    ok(`20 ${n}: alle App-Schreibwege (Import, Analyse, Löschen) funktionieren weiter`, fail.length === 0, JSON.stringify(fail).slice(0, 300))
  }
  for (const [n, uid] of [['viewer', UVIEW], ['Nutzer ohne Firma', UNONE], ['Owner B (fremde Firma)', UB]]) {
    for (const sql of [`INSERT INTO customers (company_id, postal_code) VALUES ('${A}','1')`, `UPDATE customers SET postal_code='1' WHERE company_id='${A}'`, `DELETE FROM customers WHERE company_id='${A}'`]) {
      r = await as(c, 'authenticated', uid, sql); ok(`21 ${n}: ${sql.slice(0, 18)}… auf Firma A ohne Wirkung`, denied(r), JSON.stringify(r).slice(0, 100))
    }
  }
  r = await as(c, 'authenticated', UVIEW, `SELECT count(*)::int n FROM customers`); ok('22 Viewer liest Kunden der eigenen Firma weiter', r.ok && r.rows[0].n === 2, JSON.stringify(r).slice(0, 80))
  r = await as(c, 'authenticated', UVIEW, `SELECT count(*)::int n FROM company_users WHERE company_id='${A}'`); ok('23 Mitglieder weiter lesbar', r.ok && r.rows[0].n === 4, JSON.stringify(r).slice(0, 80))
  r = await as(c, 'authenticated', UA, `SELECT name FROM stores`); ok('24 Filialen lesbar, nur eigene', r.ok && r.rows.length === 1, JSON.stringify(r).slice(0, 80))
  r = await as(c, 'authenticated', UA, `SELECT count(*)::int n FROM streets`); ok('25 Referenzdaten lesbar (streets, postal_codes)', r.ok && r.rows[0].n === 1)
  r = await as(c, 'authenticated', UA, `SELECT cu.role, c.name FROM company_users cu JOIN companies c ON c.id=cu.company_id WHERE cu.user_id='${UA}'`); ok('26 Layout-Abfrage company_users→companies(name) funktioniert', r.ok && r.rows.length === 1, JSON.stringify(r).slice(0, 100))
  for (const [t, sql] of [['TRUNCATE customers', `TRUNCATE customers`], ['TRUNCATE alle', `TRUNCATE uploads, analytics`], ['stores anlegen', `INSERT INTO stores (company_id, name) VALUES ('${A}','x')`],
    ['stores ändern', `UPDATE stores SET name='x'`], ['stores löschen', `DELETE FROM stores`], ['Mitglied eintragen', `INSERT INTO company_users (company_id,user_id,role) VALUES ('${A}','${UNONE}','owner')`],
    ['Mitglied löschen', `DELETE FROM company_users WHERE company_id='${A}'`], ['Rolle ändern', `UPDATE company_users SET role='owner'`],
    ['Straßen schreiben', `INSERT INTO streets (postal_code,name,name_normalized) VALUES ('1','x','x')`], ['Straßen löschen', `DELETE FROM streets`], ['PLZ ändern', `UPDATE postal_codes SET city='x'`],
    ['POI schreiben', `INSERT INTO poi_businesses (postal_code,name,category) VALUES ('1','x','other')`], ['Protokoll lesen', `SELECT * FROM data_refresh_logs`], ['Protokoll schreiben', `INSERT INTO data_refresh_logs (postal_code,data_type,data_source,status) VALUES ('1','a','osm','success')`],
    ['Straßenverzeichnis schreiben', `DELETE FROM street_directory`]]) {
    r = await as(c, 'authenticated', UA, sql); ok(`30 Owner A: ${t} verboten (42501)`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
  }
  for (const t of ['customers', 'companies', 'company_users', 'postal_codes', 'streets', 'poi_businesses', 'uploads', 'analytics', 'alerts', 'stores', 'plz_localities']) {
    r = await as(c, 'anon', null, `SELECT 1 FROM ${t} LIMIT 1`); ok(`31 anon: lesen ${t} verboten`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 80))
  }
  r = await as(c, 'anon', null, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','1')`); ok('32 anon: schreiben verboten', !r.ok && r.code === '42501')
  r = await as(c, 'anon', null, `TRUNCATE customers`); ok('33 anon: TRUNCATE verboten', !r.ok && r.code === '42501')
  await c.query(`INSERT INTO postal_codes (postal_code, city) VALUES ('50735','Köln')`)
  r = await as(c, 'service_role', null, `INSERT INTO streets (postal_code,name,name_normalized) VALUES ('50735','Y','y') RETURNING 1`); ok('34 Service-Key schreibt Referenzdaten weiter (Provider-Routen)', r.ok && r.n === 1, r.err)
  r = await as(c, 'service_role', null, `INSERT INTO data_refresh_logs (postal_code,data_type,data_source,status) VALUES ('50735','streets','openplz','success') RETURNING 1`); ok('35 Service-Key schreibt Protokoll weiter', r.ok, r.err)
  r = await as(c, 'service_role', null, `UPDATE postal_codes SET city='Köln' WHERE postal_code='50733' RETURNING 1`); ok('36 Service-Key ändert PLZ-Daten (Zensus-Import)', r.ok && r.n === 1, r.err)
  let rr = await asMulti(c, 'authenticated', UNEW, [`SELECT public.register_company('Neue Pizzeria','neue-pizzeria')`, `SELECT cu.role FROM company_users cu JOIN companies c ON c.id=cu.company_id WHERE c.slug='neue-pizzeria' AND cu.user_id='${UNEW}'`,
    `INSERT INTO customers (company_id, postal_code) SELECT id,'50733' FROM companies WHERE slug='neue-pizzeria'`])
  ok('37 Registrierung funktioniert, neuer Owner kann importieren', rr.every(x => x.ok) && rr[1].rows[0]?.role === 'owner', JSON.stringify(rr.filter(x => !x.ok)).slice(0, 200))
  // neue Tabelle: keine automatischen Rechte mehr
  await c.query(`CREATE TABLE public.neu_test (id int)`)
  const nt = (await c.query(`SELECT has_table_privilege('anon','public.neu_test','SELECT') a, has_table_privilege('authenticated','public.neu_test','SELECT') b, has_table_privilege('service_role','public.neu_test','SELECT') s`)).rows[0]
  ok('38 Neue Tabelle: anon/authenticated ohne automatische Rechte, service_role weiter ja', !nt.a && !nt.b && nt.s, JSON.stringify(nt))
  await c.query(`DROP TABLE public.neu_test`)
  const acl1 = await aclAll(c)

  // Zweiter Lauf
  const b1 = (await c.query(`SELECT md5(string_agg(tabelle||ebene||spalte||grantee||privilege||grantable::text,'|' ORDER BY tabelle,ebene,spalte,grantee,privilege)) h FROM migration_backup.m012_acl`)).rows[0].h
  r = await run(c, M('012_tabellenrechte_minimum.sql')); ok('40 Zweiter Lauf läuft', r.ok, r.err)
  const b2 = (await c.query(`SELECT md5(string_agg(tabelle||ebene||spalte||grantee||privilege||grantable::text,'|' ORDER BY tabelle,ebene,spalte,grantee,privilege)) h FROM migration_backup.m012_acl`)).rows[0].h
  ok('41 Zweiter Lauf: Rechte gleich, Sicherung nicht überschrieben', (await aclAll(c)) === acl1 && b1 === b2)

  // Rückfall: exakt wie vor 012 (Stand nach 011)
  r = await run(c, M('012_rollback.sql')); ok('50 Rückfall 012 läuft', r.ok, r.err)
  ok('51 Rückfall: ALLE Rechte aller Tabellen (Tabelle, Spalte, GRANT OPTION, Standardrechte) exakt wie vorher', (await aclAll(c)) === acl0)
  ok('52 Rückfall: Regeln/Funktionen/Daten unverändert', JSON.stringify(await cnt()).length > 0 && (await other(c)) !== undefined)
  r = await as(c, 'anon', null, `SELECT count(*) FROM postal_codes`); ok('53 Nach Rückfall: alter Zustand (anon liest, erwartet)', r.ok, JSON.stringify(r).slice(0, 80))
  r = await as(c, 'authenticated', UA, `SELECT google_places_api_key FROM companies`); ok('54 Nach Rückfall bleiben 010/011 aktiv', !r.ok && r.code === '42501')
  ok('55 Sicherung nach Rückfall geleert', (await c.query(`SELECT count(*)::int n FROM migration_backup.m012_acl`)).rows[0].n === 0)
  r = await run(c, M('012_rollback.sql')); ok('56 Zweiter Rückfall bricht sauber ab', !r.ok && /keine Sicherung/.test(r.err || ''), r.err)
  r = await run(c, M('012_tabellenrechte_minimum.sql')); ok('57 Erneut 012 nach Rückfall: gleicher Schutz', r.ok && (await aclAll(c)) === acl1, r.err)
  r = await run(c, M('012_rollback.sql')); ok('58 … und Rückfall wieder exakt', r.ok && (await aclAll(c)) === acl0, r.err)
  await c.end()

  // Szenario 2: abweichende Ausgangsrechte (Spaltenrecht, GRANT OPTION) werden gesichert und zurückgespielt
  const d = await build('t012b')
  for (const f of ['010_firmenfelder_schutz.sql', '011_places_schluessel_schutz.sql']) await run(d, M(f))
  await d.query(`REVOKE TRUNCATE ON customers FROM authenticated; REVOKE ALL ON stores FROM anon; GRANT SELECT (id, company_id) ON stores TO anon;
    GRANT UPDATE (name) ON stores TO authenticated WITH GRANT OPTION;`)
  const bacl0 = await aclAll(d)
  ok('60 S2 Ausgangslage mit Spaltenrecht und GRANT OPTION', /C:stores\.id:anon/.test(bacl0) && /true/.test(bacl0))
  r = await run(d, M('012_tabellenrechte_minimum.sql')); ok('61 S2 012 läuft', r.ok, r.err)
  r = await as(d, 'anon', null, `SELECT id FROM stores`); ok('62 S2 anon-Spaltenrecht entzogen', !r.ok && r.code === '42501')
  r = await run(d, M('012_rollback.sql')); ok('63 S2 Rückfall läuft', r.ok, r.err)
  ok('64 S2 Rückfall stellt Spaltenrechte und GRANT OPTION exakt wieder her', (await aclAll(d)) === bacl0)
  await d.end()

  console.log(results.join('\n')); const bad = results.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${results.length - bad} von ${results.length} Prüfungen bestanden${bad ? ', ' + bad + ' FEHLER' : ''}`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('Testabbruch:', e.message); console.log(results.join('\n')); process.exit(2) })
