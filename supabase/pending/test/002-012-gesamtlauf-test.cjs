// Gesamtlauf der Migrationen 002 bis 012 auf einer produktionsnahen Kopie (lokal, PostgreSQL 17) mit Datenmenge, Reihenfolge,
// Datenintegrität nach jedem Schritt und Rückfall in umgekehrter Reihenfolge. Aufruf: node supabase/pending/test/002-012-gesamtlauf-test.cjs
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
const N = 30000
const otherLines = async c => (await c.query(`SELECT x FROM (
   SELECT 'tab:'||c.relname||':'||coalesce((SELECT string_agg(a.grantee::regrole::text||'='||a.privilege_type||a.is_grantable::text, ',' ORDER BY a.grantee::regrole::text, a.privilege_type) FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a),'')||':'||c.relrowsecurity x FROM pg_class c WHERE c.relnamespace IN ('public'::regnamespace,'storage'::regnamespace,'auth'::regnamespace) AND c.relkind='r' AND c.oid <> 'public.companies'::regclass
   UNION ALL SELECT 'pol:'||schemaname||tablename||policyname||permissive||roles::text||cmd||coalesce(qual,'')||coalesce(with_check,'') FROM pg_policies
   UNION ALL SELECT 'fn:'||p.oid::regprocedure::text||md5(prosrc)||coalesce((SELECT string_agg(CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END||'='||a.privilege_type, ',' ORDER BY CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END) FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a),'')||prosecdef FROM pg_proc p WHERE pronamespace='public'::regnamespace
   UNION ALL SELECT 'trg:'||tgname||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal) s ORDER BY 1`)).rows.map(r => r.x)
const snap = async c => {
  const q = async (t, extra = '') => (await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(id::text,',' ORDER BY id),'')) h ${extra} FROM ${t}`)).rows[0]
  return {
    companies: await q('companies'), company_users: (await c.query(`SELECT count(*)::int n, md5(string_agg(company_id||user_id::text||role::text,',' ORDER BY company_id,user_id)) h FROM company_users`)).rows[0],
    customers: await q('customers', `, sum(total_orders)::int o, sum(total_revenue)::numeric s`), uploads: await q('uploads'), analytics: await q('analytics'),
    street_analytics: await q('street_analytics'), alerts: await q('alerts'), marketing_actions: await q('marketing_actions'), stores: await q('stores'),
    postal_codes: (await c.query(`SELECT count(*)::int n, md5(string_agg(postal_code||city,',' ORDER BY postal_code)) h FROM postal_codes`)).rows[0],
    streets: await q('streets'), poi: await q('poi_businesses'), logs: await q('data_refresh_logs'),
  }
}
const same = (a, b, skip = []) => Object.keys(a).filter(k => !skip.includes(k) && JSON.stringify(a[k]) !== JSON.stringify(b[k]))
;(async () => {
  const c = await fresh('t002_012', { full: false })    // Produktionsstand vor 002 (SETUP, prod-like, Sofortmaßnahmen 11.11.)
  // Datenmenge: 4 Firmen, 30 000 Kunden, Uploads, Auswertungen, Straßen, Meldungen
  await c.query(`INSERT INTO auth.users VALUES ('${UADMIN}','admin@test'),('${UMAN}','man@test'),('${UVIEW}','view@test'),('${UNONE}','none@test') ON CONFLICT DO NOTHING;
    INSERT INTO company_users (company_id, user_id, role) VALUES ('${A}','${UADMIN}','admin'),('${A}','${UMAN}','manager'),('${A}','${UVIEW}','viewer') ON CONFLICT DO NOTHING;
    INSERT INTO stores (company_id, name) VALUES ('${A}','Ursulakloster'),('${A}','Nippes'),('${A}','Weiden'),('${B}','B-Filiale');
    INSERT INTO uploads (company_id, uploaded_by, filename, storage_path, file_size_bytes, status) VALUES ('${A}','${UA}','a1.csv','A/a1.csv',100,'completed'),('${B}','${UB}','b1.csv','B/b1.csv',100,'completed');`)
  await c.query(`INSERT INTO customers (company_id, postal_code, phone_normalized, phone_raw, first_name, last_name, full_name, total_orders, total_revenue, upload_id)
    SELECT CASE WHEN g%10=0 THEN '${B}'::uuid ELSE '${A}'::uuid END, (50670 + g%80)::text, '0221'||lpad(g::text,7,'0'), '0221 '||g, 'Vorname'||g, 'Nachname'||g, 'Vorname'||g||' Nachname'||g, 1+g%7, (10+g%50)::numeric,
      (SELECT id FROM uploads WHERE company_id = CASE WHEN g%10=0 THEN '${B}'::uuid ELSE '${A}'::uuid END LIMIT 1)
    FROM generate_series(1,${N}) g`)
  await c.query(`INSERT INTO postal_codes (postal_code, city) SELECT (50670+g)::text, 'Köln' FROM generate_series(0,79) g ON CONFLICT DO NOTHING;
    INSERT INTO streets (postal_code, name, name_normalized) SELECT (50670+g%80)::text, 'Straße '||g, 'strasse'||g FROM generate_series(1,2000) g ON CONFLICT DO NOTHING;
    INSERT INTO analytics (company_id, postal_code, customer_count, order_count) SELECT '${A}', (50670+g)::text, 10+g, 30+g FROM generate_series(0,79) g;
    INSERT INTO street_analytics (company_id, analytics_id, postal_code, street_name, street_name_normalized) SELECT '${A}', id, postal_code, 'Straße 1', 'strasse1' FROM analytics;
    INSERT INTO alerts (company_id, severity, category, title, message) VALUES ('${A}','info','x','t','m');
    INSERT INTO marketing_actions (company_id, action_type, title) VALUES ('${A}','flyer','t');
    INSERT INTO data_refresh_logs (postal_code, data_type, data_source, status) VALUES ('50733','streets','openplz','success');
    INSERT INTO storage.buckets (id, name, public) VALUES ('uploads','uploads',false) ON CONFLICT DO NOTHING;`)
  const kunden = (await c.query(`SELECT count(*)::int n FROM customers`)).rows[0].n // 3 Kunden aus dem Grundaufbau kommen dazu
  ok(`00 Ausgangslage: ${kunden} Kunden, 4 Firmen, produktionsnaher Stand vor 002`, kunden === N + 3)
  const s0 = await snap(c), oth0 = await other(c), lines0 = await otherLines(c), cust0 = (await c.query(`SELECT count(*) FILTER (WHERE company_id='${B}')::int b FROM customers`)).rows[0].b
  const acl00 = (await c.query(`SELECT md5(string_agg(x,'|' ORDER BY x)) h FROM (SELECT cl.relname||a.grantee::regrole::text||a.privilege_type x FROM pg_class cl, LATERAL aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a WHERE cl.relnamespace='public'::regnamespace AND cl.relkind='r') q`)).rows[0].h
  let r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`); ok('01 Vorher: Tarif durch Owner änderbar, Lücken offen', r.ok && r.n === 1)

  // ── Vorwärts, in dieser Reihenfolge ──
  const ORDER = ['002_security_policies.sql', '003_register_company.sql', '004_upload_import_mode.sql', '005_population_provenance.sql', '006_funktionen_bucket_haertung.sql',
    '007_datenminimierung.sql', '008_loeschen_indizes.sql', '009_geodaten_deutschland.sql', '010_firmenfelder_schutz.sql', '011_places_schluessel_schutz.sql', '012_tabellenrechte_minimum.sql']
  let prev = s0; const times = {}
  for (const f of ORDER) {
    const t0 = Date.now(); r = await run(c, M(f)); times[f] = Date.now() - t0
    ok(`10 ${f.slice(0, 3)} läuft fehlerfrei (${times[f]} ms)`, r.ok, r.err)
    const s = await snap(c); const diff = same(prev, s, f.startsWith('007') ? [] : [])
    ok(`11 ${f.slice(0, 3)}: Zeilenzahlen und Kennungen aller Tabellen unverändert`, diff.length === 0, JSON.stringify(diff))
    ok(`12 ${f.slice(0, 3)}: Kunden: Anzahl, Bestellungen, Umsätze unverändert`, s.customers.n === s0.customers.n && s.customers.o === s0.customers.o && String(s.customers.s) === String(s0.customers.s))
    prev = s
  }
  // 007: Wirkung prüfen
  r = await run(c, `SELECT count(*) FILTER (WHERE phone_normalized LIKE 'p1:%')::int p, count(*) FILTER (WHERE phone_raw IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL OR full_name IS NOT NULL)::int n FROM customers`)
  const k7 = (await c.query(`SELECT count(*) FILTER (WHERE phone_normalized LIKE 'p1:%')::int p, count(*) FILTER (WHERE phone_raw IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL OR full_name IS NOT NULL)::int n, count(DISTINCT (company_id, phone_normalized))::int d FROM customers`)).rows[0]
  ok('20 007: alle Telefonnummern pseudonymisiert, Namen und Klartext-Nummern gelöscht', k7.p === N && k7.n === 0, JSON.stringify(k7))
  // Endzustand: Rechte und Funktion
  for (const [n, uid] of [['owner', UA], ['admin', UADMIN]]) {
    r = await as(c, 'authenticated', uid, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`); ok(`30 Endzustand: ${n} kann Tarif nicht ändern`, !r.ok && r.code === '42501')
    r = await as(c, 'authenticated', uid, `UPDATE companies SET name='Neu' WHERE id='${A}' RETURNING name`); ok(`31 Endzustand: ${n} kann Namen ändern`, r.ok && r.n === 1, r.err)
  }
  r = await as(c, 'authenticated', UVIEW, `DELETE FROM customers WHERE company_id='${A}'`); ok('32 Viewer kann nichts löschen', denied(r))
  r = await as(c, 'authenticated', UMAN, `UPDATE customers SET total_orders=1 WHERE company_id='${A}' AND id=(SELECT id FROM customers WHERE company_id='${A}' LIMIT 1)`); ok('33 Manager darf Kunden ändern', r.ok && r.n === 1, r.err)
  r = await as(c, 'authenticated', UB, `SELECT count(*)::int n FROM customers`); ok('34 Firma B sieht nur ihre Kunden (Mandantentrennung)', r.ok && r.rows[0].n === cust0, JSON.stringify(r).slice(0, 80))
  r = await as(c, 'authenticated', UA, `SELECT count(*)::int n FROM customers`); ok('35 Firma A sieht nur ihre Kunden', r.ok && r.rows[0].n === kunden - cust0)
  r = await as(c, 'authenticated', UNONE, `SELECT count(*)::int n FROM customers`); ok('36 Nutzer ohne Firma sieht nichts', r.ok && r.rows[0].n === 0)
  r = await as(c, 'anon', null, `SELECT 1 FROM customers LIMIT 1`); ok('37 anon: kein Zugriff', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', UA, `TRUNCATE customers`); ok('38 TRUNCATE verboten', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', UVIEW, `SELECT google_places_api_key FROM companies`); ok('39 Schlüssel nicht lesbar', !r.ok && r.code === '42501')
  let rr = await asMulti(c, 'authenticated', UNEW, [`SELECT public.register_company('Neue Pizzeria','neue-pizzeria')`, `SELECT cu.role FROM company_users cu WHERE cu.user_id='${UNEW}'`])
  ok('40 Registrierung nach dem Gesamtlauf funktioniert', rr.every(x => x.ok) && rr[1].rows[0]?.role === 'owner', JSON.stringify(rr).slice(0, 160))
  const sEnd = await snap(c)
  const bk = (await c.query(`SELECT (SELECT count(*) FROM migration_backup.m010_companies_acl)::int a, (SELECT count(*) FROM migration_backup.m011_companies_acl)::int b, (SELECT count(*) FROM migration_backup.m012_acl)::int c`)).rows[0]
  ok('41 Sicherungen aller Migrationen vorhanden', bk.a > 0 && bk.b > 0 && bk.c > 0, JSON.stringify(bk))

  // ── Zweiter Lauf des gesamten Satzes: ändert nichts ──
  const aclEnd = await other(c)
  let again = true; for (const f of ORDER.filter(x => !x.startsWith('007') && !x.startsWith('002') && !x.startsWith('003'))) { r = await run(c, M(f)); if (!r.ok) { again = false; ok(`50 ${f.slice(0, 3)} zweiter Lauf`, false, r.err) } }
  ok('51 Zweiter Lauf von 004–012 (ohne 002/003/007): fehlerfrei', again)
  ok('52 … Zustand danach unverändert', (await other(c)) === aclEnd && same(sEnd, await snap(c)).length === 0)

  // ── Rückfall in umgekehrter Reihenfolge (007 hat keinen Rückfall; 003 nur Funktion löschen) ──
  const RB = ['012_rollback.sql', '011_rollback.sql', '010_rollback.sql', '009_rollback.sql', '008_rollback.sql', '006_rollback.sql', '005_rollback.sql', '004_rollback.sql']
  for (const f of RB) { r = await run(c, M(f)); ok(`60 Rückfall ${f.slice(0, 3)} läuft`, r.ok, r.err) }
  r = await run(c, `DROP FUNCTION IF EXISTS public.register_company(text, text)`); ok('61 Rückfall 003: Funktion entfernt', r.ok, r.err)
  r = await run(c, M('002_rollback.sql')); ok('62 Rückfall 002 läuft', r.ok, r.err)
  const sBack = await snap(c)
  ok('63 Nach Rückfall: Firmen, Mitglieder, Uploads, Auswertungen, Meldungen, Referenzdaten unverändert', same(s0, sBack, ['customers']).length === 0, JSON.stringify(same(s0, sBack, ['customers'])))
  ok('64 Nach Rückfall: Kunden nach Anzahl, Bestellungen, Umsatz gleich (Namen/Telefon durch 007 nicht rückholbar)', sBack.customers.n === s0.customers.n && sBack.customers.o === s0.customers.o && String(sBack.customers.s) === String(s0.customers.s))
  const acl99 = (await c.query(`SELECT md5(string_agg(x,'|' ORDER BY x)) h FROM (SELECT cl.relname||a.grantee::regrole::text||a.privilege_type x FROM pg_class cl, LATERAL aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a WHERE cl.relnamespace='public'::regnamespace AND cl.relkind='r') q`)).rows[0].h
  ok('65 Nach Rückfall: Tabellenrechte exakt wie im Ausgangszustand', acl99 === acl00)
  const oth1 = await other(c)
  const lines1 = await otherLines(c)
  ok('66 Nach Rückfall: Regeln, Funktionen, Auslöser, Rechte wie im Ausgangszustand', JSON.stringify(lines0) === JSON.stringify(lines1), JSON.stringify({ nur_vorher: lines0.filter(x => !lines1.includes(x)).map(x => x.slice(0, 200)), nur_nachher: lines1.filter(x => !lines0.includes(x)).map(x => x.slice(0, 200)) }))
  r = await as(c, 'authenticated', UA, `UPDATE companies SET plan='enterprise' WHERE id='${A}'`); ok('67 Nach Rückfall ist der alte Zustand wieder da (erwartet)', r.ok && r.n === 1)
  await c.end()
  console.log('Laufzeiten ms: ' + JSON.stringify(times))
  console.log(results.join('\n')); const bad = results.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${results.length - bad} von ${results.length} Prüfungen bestanden${bad ? ', ' + bad + ' FEHLER' : ''}`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('Testabbruch:', e.message); console.log(results.join('\n')); process.exit(2) })
