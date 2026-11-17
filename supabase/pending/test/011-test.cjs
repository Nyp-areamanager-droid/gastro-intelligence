// Test für Migration 011 (Google-Places-Schlüssel) und ihren Rückfall auf echtem PostgreSQL (lokal), aufbauend auf 010.
// Aufruf: node supabase/pending/test/011-test.cjs
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
const KEY = 'SECRET-KEY-123'
;(async () => {
  const c = await build('t011a')
  let r = await run(c, M('010_firmenfelder_schutz.sql')); ok('00 010 eingespielt (Voraussetzung)', r.ok, r.err)
  await c.query(`UPDATE companies SET google_places_api_key='${KEY}' WHERE id='${A}'; UPDATE companies SET google_places_api_key='KEY-B' WHERE id='${B}'`)
  const acl0 = await acl(c), oth0 = await other(c), dat0 = await daten(c)
  r = await as(c, 'authenticated', UVIEW, `SELECT google_places_api_key FROM companies WHERE id='${A}'`)
  ok('01 Vorher: Viewer kann den Schlüssel lesen (Lücke bestätigt)', r.ok && r.rows[0]?.google_places_api_key === KEY, r.err)

  // Voraussetzung wird geprüft: ohne 010 bricht 011 ab, ohne Änderung
  const x = await build('t011x'); const xAcl = await acl(x)
  r = await run(x, M('011_places_schluessel_schutz.sql'))
  ok('02 011 ohne 010 bricht ab', !r.ok && /010 ist nicht eingespielt/.test(r.err || ''), r.err)
  ok('03 … und ändert nichts', (await acl(x)) === xAcl); await x.end()

  r = await run(c, M('011_places_schluessel_schutz.sql')); ok('04 Migration 011 läuft', r.ok, r.err)
  ok('05 Daten, Regeln, andere Tabellen unverändert (Funktionen: nur die neue kommt dazu)', (await daten(c)) === dat0)
  const fn = (await c.query(`SELECT count(*)::int n FROM pg_proc WHERE proname='get_company_places_key' AND pronamespace='public'::regnamespace`)).rows[0].n
  ok('06 Funktion get_company_places_key angelegt', fn === 1)
  const bk = (await c.query(`SELECT count(*)::int n FROM migration_backup.m011_companies_acl`)).rows[0].n
  ok('07 Sicherung angelegt', bk >= 8, 'Zeilen: ' + bk)
  const bp = (await c.query(`SELECT has_table_privilege('authenticated','migration_backup.m011_companies_acl','SELECT') b, has_schema_privilege('anon','migration_backup','USAGE') u`)).rows[0]
  ok('08 Sicherung für anon/authenticated nicht erreichbar', !bp.b && !bp.u)

  // Schlüssel direkt lesen: für alle abgelehnt
  const roles = [['owner', UA], ['admin', UADMIN], ['manager', UMAN], ['viewer', UVIEW], ['Nutzer ohne Firma', UNONE], ['Owner Firma B', UB]]
  for (const [n, uid] of roles) {
    r = await as(c, 'authenticated', uid, `SELECT google_places_api_key FROM companies`)
    ok(`10 ${n}: Schlüssel direkt lesen abgelehnt (42501)`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 120))
    r = await as(c, 'authenticated', uid, `SELECT * FROM companies`)
    ok(`11 ${n}: SELECT * abgelehnt (App darf nie * wählen)`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
    r = await as(c, 'authenticated', uid, `SELECT id FROM companies WHERE google_places_api_key LIKE 'SECRET%'`)
    ok(`12 ${n}: Schlüssel über Bedingung ausforschen abgelehnt`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
    r = await as(c, 'authenticated', uid, `UPDATE companies SET name='x' WHERE id='${A}' AND google_places_api_key='${KEY}' RETURNING id`)
    ok(`13 ${n}: Schlüssel über UPDATE-Bedingung ausforschen abgelehnt`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
    r = await as(c, 'authenticated', uid, `SELECT c.google_places_api_key FROM company_users u JOIN companies c ON c.id=u.company_id`)
    ok(`14 ${n}: Schlüssel über Join abgelehnt`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
    r = await as(c, 'authenticated', uid, `SELECT row_to_json(c)::text t FROM companies c`)
    ok(`15 ${n}: ganze Zeile als JSON abgelehnt`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
  }
  r = await as(c, 'anon', null, `SELECT google_places_api_key FROM companies`); ok('16 anon: abgelehnt', !r.ok && r.code === '42501')
  // Funktion: nur owner/admin der eigenen Firma
  for (const [n, uid, erw] of [['owner', UA, KEY], ['admin', UADMIN, KEY], ['manager', UMAN, null], ['viewer', UVIEW, null], ['Nutzer ohne Firma', UNONE, null]]) {
    r = await as(c, 'authenticated', uid, `SELECT public.get_company_places_key() k`)
    ok(`20 ${n}: Funktion liefert ${erw ? 'den Schlüssel der eigenen Firma' : 'NULL'}`, r.ok && (r.rows[0].k ?? null) === erw, JSON.stringify(r).slice(0, 120))
  }
  r = await as(c, 'authenticated', UB, `SELECT public.get_company_places_key() k`)
  ok('21 Owner B bekommt nur den Schlüssel von B, nie den von A', r.ok && r.rows[0].k === 'KEY-B', JSON.stringify(r).slice(0, 100))
  r = await as(c, 'anon', null, `SELECT public.get_company_places_key()`); ok('22 anon: Funktion nicht ausführbar', !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 100))
  r = await as(c, 'service_role', null, `SELECT google_places_api_key FROM companies WHERE id='${A}'`)
  ok('23 Betreiber (service_role) liest den Schlüssel weiterhin', r.ok && r.rows[0].google_places_api_key === KEY, r.err)
  r = await as(c, 'service_role', null, `UPDATE companies SET google_places_api_key='NEU' WHERE id='${B}' RETURNING 1`)
  ok('24 Betreiber kann den Schlüssel setzen', r.ok && r.n === 1, r.err)

  // Lesepfade der App und 010-Verhalten unverändert
  for (const [n, uid] of [['owner', UA], ['manager', UMAN], ['viewer', UVIEW]]) {
    r = await as(c, 'authenticated', uid, `SELECT name, plan, created_at FROM companies WHERE id='${A}'`)
    ok(`30 ${n}: /api/account und overview lesen name, plan, created_at`, r.ok && r.rows.length === 1, r.err)
  }
  r = await as(c, 'authenticated', UB, `SELECT id, name, slug, plan, plan_expires_at, settings, logo_url FROM companies`)
  ok('31 Firma B sieht nur sich selbst (RLS), alle anderen Spalten lesbar', r.ok && r.rows.length === 1 && r.rows[0].id === B, r.err)
  r = await as(c, 'authenticated', UA, `UPDATE companies SET name='Neu' WHERE id='${A}' RETURNING name`)
  ok('32 Owner darf Stammdaten weiter ändern (inkl. RETURNING)', r.ok && r.n === 1, r.err)
  r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`)
  ok('33 Tarif bleibt geschützt (010)', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', UA, `UPDATE companies SET google_places_api_key='X' WHERE id='${A}'`)
  ok('34 Schlüssel setzen für Owner weiter verboten', !r.ok && r.code === '42501')
  let rr = await asMulti(c, 'authenticated', UNEW, [`SELECT public.register_company('Neue Pizzeria','neue-pizzeria')`, `SELECT c.plan, c.name, cu.role FROM companies c JOIN company_users cu ON cu.company_id=c.id WHERE c.slug='neue-pizzeria' AND cu.user_id='${UNEW}'`, `SELECT public.get_company_places_key() k`])
  ok('35 Registrierung funktioniert', rr[0].ok && rr[1].ok && rr[1].rows[0]?.role === 'owner', JSON.stringify(rr[0]).slice(0, 140))
  ok('36 Neue Firma ohne Schlüssel: Funktion liefert NULL, kein Fehler', rr[2].ok && (rr[2].rows[0].k ?? null) === null, JSON.stringify(rr[2]).slice(0, 100))
  r = await as(c, 'authenticated', UA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50737') RETURNING id`)
  ok('37 Übrige Schreibwege unverändert', r.ok, r.err)
  r = await as(c, 'authenticated', UA, `SELECT count(*)::int n FROM company_users WHERE company_id='${A}'`)
  ok('38 Mitglieder weiter lesbar', r.ok && r.rows[0].n === 4, JSON.stringify(r).slice(0, 80))
  const acl1 = await acl(c)

  // Zweiter Lauf
  const b1 = (await c.query(`SELECT md5(string_agg(ebene||spalte||grantee||privilege||grantable::text,'|' ORDER BY ebene,spalte,grantee,privilege)) h FROM migration_backup.m011_companies_acl`)).rows[0].h
  r = await run(c, M('011_places_schluessel_schutz.sql')); ok('40 Zweiter Lauf läuft', r.ok, r.err)
  const b2 = (await c.query(`SELECT md5(string_agg(ebene||spalte||grantee||privilege||grantable::text,'|' ORDER BY ebene,spalte,grantee,privilege)) h FROM migration_backup.m011_companies_acl`)).rows[0].h
  ok('41 Zweiter Lauf: Rechte gleich, Sicherung nicht überschrieben', (await acl(c)) === acl1 && b1 === b2)

  // Rückfall 011 -> Stand nach 010
  const c0 = await build('t011ref'); await run(c0, M('010_firmenfelder_schutz.sql')); const refAcl = await acl(c0), refOth = await other(c0); await c0.end()
  r = await run(c, M('011_rollback.sql')); ok('50 Rückfall 011 läuft', r.ok, r.err)
  ok('51 Rückfall: Rechte exakt wie nach 010 (Tabelle+Spalten, alle Rollen)', (await acl(c)) === refAcl)
  r = await as(c, 'authenticated', UVIEW, `SELECT google_places_api_key FROM companies WHERE id='${A}'`)
  ok('52 Nach Rückfall: alter Zustand (Schlüssel lesbar, Lücke offen, erwartet)', r.ok && r.rows.length === 1, r.err)
  r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`)
  ok('53 Nach Rückfall bleibt 010 aktiv (Tarif geschützt)', !r.ok && r.code === '42501')
  ok('54 Funktion entfernt, Sicherung geleert', (await c.query(`SELECT (SELECT count(*) FROM pg_proc WHERE proname='get_company_places_key')::int f, (SELECT count(*) FROM migration_backup.m011_companies_acl)::int b`)).rows[0].f === 0
     && (await c.query(`SELECT count(*)::int b FROM migration_backup.m011_companies_acl`)).rows[0].b === 0)
  ok('55 Daten unverändert', (await daten(c)).length > 0)
  r = await run(c, M('011_rollback.sql')); ok('56 Zweiter Rückfall bricht sauber ab', !r.ok && /keine Sicherung/.test(r.err || ''), r.err)
  r = await run(c, M('011_places_schluessel_schutz.sql')); ok('57 Erneut 011 nach Rückfall läuft und ergibt denselben Schutz', r.ok && (await acl(c)) === acl1, r.err)
  await c.end()

  // Szenario 2: PUBLIC-Leserecht auf die Spalte würde den Schutz aushebeln -> Abbruch ohne Änderung
  const d = await build('t011b'); await run(d, M('010_firmenfelder_schutz.sql'))
  await d.query(`GRANT SELECT (google_places_api_key) ON companies TO PUBLIC`)
  const dAcl = await acl(d)
  r = await run(d, M('011_places_schluessel_schutz.sql'))
  ok('60 S2 Abbruch, wenn der Schlüssel über PUBLIC lesbar bliebe', !r.ok && /Rechte stimmen nicht/.test(r.err || ''), r.err)
  ok('61 S2 Nach Abbruch nichts geändert', (await acl(d)) === dAcl && (await d.query(`SELECT to_regclass('migration_backup.m011_companies_acl') t`)).rows[0].t === null)
  await d.end()

  console.log(results.join('\n')); const bad = results.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${results.length - bad} von ${results.length} Prüfungen bestanden${bad ? ', ' + bad + ' FEHLER' : ''}`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('Testabbruch:', e.message); console.log(results.join('\n')); process.exit(2) })
