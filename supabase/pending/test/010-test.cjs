// Test für Migration 010 (geschützte Firmenfelder) und ihren Rückfall auf echtem PostgreSQL (lokal).
// Aufruf: node supabase/pending/test/010-test.cjs
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

;(async () => {
  // ═══ Szenario 1: Produktionsnahe Ausgangslage (Rechte wie im Testprojekt: arwdDxtm für alle vier) ═══
  const c = await build('t010a')
  const acl0 = await acl(c), oth0 = await other(c), dat0 = await daten(c)
  ok('00 Ausgangslage: authenticated hat volle Tabellenrechte (wie Testprojekt)', /T,,authenticated,postgres,UPDATE/.test(acl0) && /T,,anon,postgres,SELECT/.test(acl0))
  let r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`)
  ok('01 Vorher: Owner kann den eigenen Tarif ändern (Lücke bestätigt)', r.ok && r.n === 1, r.err)

  r = await run(c, M('010_firmenfelder_schutz.sql')); ok('02 Migration 010 läuft', r.ok, r.err)
  const acl1 = await acl(c)
  ok('03 Daten, Regeln, Funktionen, andere Tabellen unverändert', (await other(c)) === oth0 && (await daten(c)) === dat0)
  const bk = (await c.query(`SELECT count(*)::int n FROM migration_backup.m010_companies_acl`)).rows[0].n
  ok('04 Sicherung der Rechte angelegt', bk >= 8, 'Zeilen: ' + bk)
  const bkPriv = (await c.query(`SELECT has_table_privilege('anon','migration_backup.m010_companies_acl','SELECT') a, has_table_privilege('authenticated','migration_backup.m010_companies_acl','SELECT') b, has_schema_privilege('authenticated','migration_backup','USAGE') u`)).rows[0]
  ok('05 Sicherung für anon/authenticated nicht erreichbar', !bkPriv.a && !bkPriv.b && !bkPriv.u, JSON.stringify(bkPriv))
  ok('06 service_role und postgres behalten alle Rechte', /T,,service_role,postgres,UPDATE/.test(acl1) && /T,,postgres,postgres,UPDATE/.test(acl1) && /T,,service_role,postgres,DELETE/.test(acl1))

  // erlaubte Spalten (Stammdaten)
  const allowedSets = { name: `'Neuer Name'`, address: `'Teststr. 1'`, city: `'Köln'`, postal_code: `'50733'`, country: `'DE'`, phone: `'0221'`, email: `'a@b.de'`, website: `'https://x.de'`, logo_url: `'https://x.de/l.png'` }
  for (const role of ['owner', 'admin']) {
    const uid = role === 'owner' ? UA : UADMIN
    for (const [col, val] of Object.entries(allowedSets)) {
      r = await as(c, 'authenticated', uid, `UPDATE companies SET ${col}=${val} WHERE id='${A}' RETURNING ${col}`)
      ok(`10 ${role} darf ${col} ändern`, r.ok && r.n === 1, r.err)
    }
    const all = await as(c, 'authenticated', uid, `UPDATE companies SET name='N', address='a', city='c', postal_code='50733', country='DE', phone='1', email='e@e.de', website='w', logo_url='l' WHERE id='${A}'`)
    ok(`11 ${role}: alle Stammdaten gemeinsam ändern`, all.ok && all.n === 1, all.err)
    // geschützte Spalten
    const prot = { id: `gen_random_uuid()`, slug: `'neuer-slug'`, plan: `'enterprise'`, plan_expires_at: `now() + interval '10 years'`, settings: `'{"x":1}'::jsonb`, google_places_api_key: `'KEY'`, created_at: `now()`, updated_at: `now()` }
    for (const [col, val] of Object.entries(prot)) {
      r = await as(c, 'authenticated', uid, `UPDATE companies SET ${col}=${val} WHERE id='${A}'`)
      ok(`12 ${role} darf ${col} NICHT ändern (Fehler 42501)`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 140))
    }
    r = await as(c, 'authenticated', uid, `UPDATE companies SET name='X', plan='enterprise' WHERE id='${A}'`)
    ok(`13 ${role}: Mischung aus erlaubter und geschützter Spalte wird ganz abgelehnt`, !r.ok && r.code === '42501', r.err)
    r = await as(c, 'authenticated', uid, `UPDATE companies SET plan=plan WHERE id='${A}'`)
    ok(`14 ${role}: auch "plan=plan" (gleicher Wert) ist abgelehnt`, !r.ok && r.code === '42501', r.err)
    r = await as(c, 'authenticated', uid, `UPDATE companies SET name=name WHERE id='${A}' AND plan='trial'`)
    ok(`15 ${role}: Lesen einer geschützten Spalte in der Bedingung bleibt erlaubt`, r.ok && r.n === 1, r.err)
  }
  // Zusammenspiel mit RLS und Trigger
  let rr = await asMulti(c, 'authenticated', UA, [`SELECT updated_at FROM companies WHERE id='${A}'`, `SELECT pg_sleep(0.05)`, `UPDATE companies SET name='Trigger-Test' WHERE id='${A}' RETURNING updated_at`, `SELECT updated_at FROM companies WHERE id='${A}'`])
  ok('16 Trigger updated_at wird bei erlaubter Änderung weiter gesetzt', rr[2].ok && rr[2].rows[0].updated_at > rr[0].rows[0].updated_at, JSON.stringify(rr[2]).slice(0, 120))
  r = await as(c, 'authenticated', UA, `UPDATE companies SET name='Fremd' WHERE id='${B}'`)
  ok('17 Owner A ändert Name von Firma B: 0 Zeilen (RLS)', r.ok && r.n === 0, r.err)
  r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${B}'`)
  ok('18 Owner A ändert Tarif von Firma B: abgelehnt', denied(r), JSON.stringify(r).slice(0, 120))
  r = await as(c, 'authenticated', UA, `UPDATE companies SET name='Alle' RETURNING id`)
  ok('19 UPDATE ohne WHERE trifft nur die eigene Firma', r.ok && r.n === 1 && r.rows[0].id === A, JSON.stringify(r).slice(0, 120))
  for (const [rolle, uid] of [['manager', UMAN], ['viewer', UVIEW], ['Nutzer ohne Firma', UNONE], ['Owner Firma B', UB]]) {
    r = await as(c, 'authenticated', uid, `UPDATE companies SET name='Hack' WHERE id='${A}'`)
    ok(`20 ${rolle}: Name von Firma A ändern geht nicht`, denied(r), JSON.stringify(r).slice(0, 120))
    r = await as(c, 'authenticated', uid, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`)
    ok(`21 ${rolle}: Tarif von Firma A ändern geht nicht`, denied(r), JSON.stringify(r).slice(0, 120))
    r = await as(c, 'authenticated', uid, `UPDATE companies SET name='Hack'`)
    ok(`22 ${rolle}: UPDATE ohne WHERE ändert keine fremde Zeile`, denied(r) || (r.ok && r.rows.length === 0), JSON.stringify(r).slice(0, 120))
  }
  ok('23 Keine Zeile durch die Angriffe verändert (Prüfsumme)', (await daten(c)) === dat0)
  // Einfügen, Löschen, Leeren, anon
  for (const [t, sql] of [['INSERT', `INSERT INTO companies (name, slug) VALUES ('X','x-neu')`], ['DELETE', `DELETE FROM companies WHERE id='${A}'`], ['TRUNCATE', `TRUNCATE companies`]]) {
    r = await as(c, 'authenticated', UA, sql); ok(`30 authenticated: ${t} auf companies verboten`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 120))
  }
  for (const [t, sql] of [['SELECT', `SELECT * FROM companies`], ['UPDATE', `UPDATE companies SET name='x'`], ['INSERT', `INSERT INTO companies (name, slug) VALUES ('X','y')`], ['DELETE', `DELETE FROM companies`]]) {
    r = await as(c, 'anon', null, sql); ok(`31 anon: ${t} auf companies verboten`, !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 120))
  }
  // App-Lesepfade (account, overview, upload) und Registrierung
  r = await as(c, 'authenticated', UA, `SELECT name, plan, created_at FROM companies WHERE id='${A}'`)
  ok('40 Lesepfad /api/account und overview: name, plan, created_at lesbar', r.ok && r.rows.length === 1, r.err)
  r = await as(c, 'authenticated', UVIEW, `SELECT name, plan, created_at FROM companies WHERE id='${A}'`)
  ok('41 Viewer kann seine Firma weiter lesen', r.ok && r.rows.length === 1, r.err)
  r = await as(c, 'authenticated', UB, `SELECT id FROM companies`)
  ok('42 Firma B sieht nur sich selbst', r.ok && r.rows.length === 1 && r.rows[0].id === B, r.err)
  r = await as(c, 'authenticated', UA, `SELECT google_places_api_key FROM companies WHERE id='${A}'`)
  ok('43 Lesepfad /api/upload (google_places_api_key) funktioniert unverändert [bekannt offen: eigener Fix]', r.ok && r.rows.length === 1, r.err)
  r = await as(c, 'authenticated', UVIEW, `SELECT google_places_api_key FROM companies WHERE id='${A}'`)
  ok('44 HINWEIS Viewer kann den Schlüssel weiterhin lesen (bewusst nicht Teil von 010)', r.ok && r.rows.length === 1, r.err)
  rr = await asMulti(c, 'authenticated', UNEW, [`SELECT public.register_company('Neue Pizzeria','neue-pizzeria')`, `SELECT c.plan, c.name, cu.role FROM companies c JOIN company_users cu ON cu.company_id=c.id WHERE c.slug='neue-pizzeria' AND cu.user_id='${UNEW}'`,
    `UPDATE companies SET name='Neue Pizzeria 2' WHERE slug='neue-pizzeria' RETURNING name`, `UPDATE companies SET plan='enterprise' WHERE slug='neue-pizzeria'`])
  ok('45 Registrierung (register_company) funktioniert nach 010', rr[0].ok && rr[1].ok && rr[1].rows[0]?.plan === 'trial' && rr[1].rows[0]?.role === 'owner', JSON.stringify(rr[0]).slice(0, 160))
  ok('46 Neuer Owner darf Name seiner neuen Firma ändern', rr[2].ok && rr[2].n === 1, JSON.stringify(rr[2]).slice(0, 120))
  ok('47 Neuer Owner darf seinen Tarif nicht ändern', !rr[3].ok && rr[3].code === '42501', JSON.stringify(rr[3]).slice(0, 120))
  r = await as(c, 'authenticated', UA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50737') RETURNING id`)
  ok('48 Übrige Schreibwege (Kunden einfügen) unverändert', r.ok, r.err)
  r = await as(c, 'service_role', null, `UPDATE companies SET plan='business' WHERE id='${A}' RETURNING plan`)
  ok('49 Betreiber (service_role) kann den Tarif weiterhin setzen', r.ok && r.n === 1, r.err)
  ok('50 Datenbestand nach allen Tests unverändert', (await daten(c)) === dat0)

  // Zweiter Lauf: keine Änderung, Sicherung bleibt
  const bkBefore = (await c.query(`SELECT md5(string_agg(ebene||spalte||grantee||privilege||grantable::text, '|' ORDER BY ebene,spalte,grantee,privilege)) h, count(*)::int n FROM migration_backup.m010_companies_acl`)).rows[0]
  r = await run(c, M('010_firmenfelder_schutz.sql')); ok('60 Zweiter Lauf 010 läuft ohne Fehler', r.ok, r.err)
  const bkAfter = (await c.query(`SELECT md5(string_agg(ebene||spalte||grantee||privilege||grantable::text, '|' ORDER BY ebene,spalte,grantee,privilege)) h, count(*)::int n FROM migration_backup.m010_companies_acl`)).rows[0]
  ok('61 Zweiter Lauf: Rechte gleich, Sicherung NICHT überschrieben', (await acl(c)) === acl1 && eq(bkBefore, bkAfter), JSON.stringify([bkBefore, bkAfter]))

  // Rückfall
  r = await run(c, M('010_rollback.sql')); ok('70 Rückfall 010 läuft', r.ok, r.err)
  ok('71 Rückfall: ALLE ursprünglichen Rechte (Tabelle+Spalten, alle Rollen) exakt wie vorher', (await acl(c)) === acl0, 'abweichend')
  ok('72 Rückfall: Daten, Regeln, Funktionen, andere Tabellen unverändert', (await other(c)) === oth0 && (await daten(c)) === dat0)
  r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`)
  ok('73 Nach Rückfall ist der alte Zustand wieder da (Lücke offen, erwartet)', r.ok && r.n === 1, r.err)
  ok('74 Sicherung nach Rückfall geleert', (await c.query(`SELECT count(*)::int n FROM migration_backup.m010_companies_acl`)).rows[0].n === 0)
  r = await run(c, M('010_rollback.sql')); ok('75 Zweiter Rückfall ohne Sicherung bricht sauber ab', !r.ok && /keine Sicherung/.test(r.err || ''), r.err)
  ok('76 Abgebrochener Rückfall hat nichts verändert', (await acl(c)) === acl0)
  r = await run(c, M('010_firmenfelder_schutz.sql')); ok('77 Migration nach Rückfall erneut: läuft', r.ok, r.err)
  ok('78 … und ergibt denselben geschützten Zustand', (await acl(c)) === acl1)
  r = await run(c, M('010_rollback.sql')); ok('79 … und Rückfall wieder exakt', r.ok && (await acl(c)) === acl0, r.err)
  await c.end()

  // ═══ Szenario 2: abweichende Ausgangsrechte (Spaltenrechte, GRANT OPTION, teilweise entzogen) ═══
  const d = await build('t010b')
  await d.query(`REVOKE UPDATE, DELETE, TRUNCATE ON companies FROM authenticated;
    GRANT UPDATE (name, plan) ON companies TO authenticated WITH GRANT OPTION;
    GRANT SELECT (name) ON companies TO anon; REVOKE SELECT ON companies FROM anon;
    GRANT INSERT (name, slug) ON companies TO anon;`)
  const bAcl0 = await acl(d), bOth0 = await other(d)
  ok('80 S2 Ausgangslage hat Spaltenrechte und GRANT OPTION', /C,name,authenticated/.test(bAcl0) && /true/.test(bAcl0))
  r = await run(d, M('010_firmenfelder_schutz.sql')); ok('81 S2 Migration läuft', r.ok, r.err)
  r = await as(d, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`)
  ok('82 S2 Tarif nach Migration geschützt', !r.ok && r.code === '42501', JSON.stringify(r).slice(0, 120))
  r = await as(d, 'authenticated', UA, `UPDATE companies SET name='ok' WHERE id='${A}'`); ok('83 S2 Name änderbar', r.ok && r.n === 1, r.err)
  r = await as(d, 'anon', null, `INSERT INTO companies (name, slug) VALUES ('x','x')`); ok('84 S2 anon-Spaltenrecht entfernt', !r.ok && r.code === '42501', r.err)
  r = await run(d, M('010_rollback.sql')); ok('85 S2 Rückfall läuft', r.ok, r.err)
  ok('86 S2 Rückfall stellt Spaltenrechte und GRANT OPTION exakt wieder her', (await acl(d)) === bAcl0)
  ok('87 S2 Regeln/Funktionen/andere Tabellen unverändert', (await other(d)) === bOth0)
  await d.end()

  // ═══ Szenario 3: Sicherheitsnetz (PUBLIC-Recht würde Schutz aushebeln → Migration muss abbrechen) ═══
  const e = await build('t010c')
  await e.query(`GRANT UPDATE (plan) ON companies TO PUBLIC`)
  const cAcl0 = await acl(e)
  r = await run(e, M('010_firmenfelder_schutz.sql'))
  ok('90 S3 Migration bricht ab, wenn Tarif über PUBLIC änderbar bliebe', !r.ok && /plan ist noch änderbar/.test(r.err || ''), r.err)
  ok('91 S3 Nach Abbruch nichts geändert (alles oder nichts)', (await acl(e)) === cAcl0)
  ok('92 S3 Auch keine Sicherung zurückgeblieben', (await e.query(`SELECT to_regclass('migration_backup.m010_companies_acl') t`)).rows[0].t === null)
  await e.end()

  console.log(results.join('\n')); const bad = results.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${results.length - bad} von ${results.length} Prüfungen bestanden${bad ? ', ' + bad + ' FEHLER' : ''}`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('Testabbruch:', e.message); console.log(results.join('\n')); process.exit(2) })
