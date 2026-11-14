// Test für Migration 006 und ihren Rückfall auf echtem PostgreSQL (lokal).
// Aufruf: node supabase/pending/test/006-test.cjs
// Verbindung: Unix-Socket /var/tmp/pgtest, Port 54329 (nur Wegwerf-Datenbanken)
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
const HELPERS = ['public.get_my_company_id()', 'public.is_company_member(uuid)', 'public.my_company_role()', 'public.can_write_company_data()']
const TRIGGER_FN = 'public.on_auth_user_created()'

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
    const r = await c.query(sql); await c.query('ROLLBACK'); return { ok: true, rows: r.rows }
  } catch (e) { await c.query('ROLLBACK'); return { ok: false, err: e.message } }
}
const state = async c => {
  const q = async s => (await c.query(s)).rows.map(r => Object.values(r).map(v => JSON.stringify(v)).join('|')).join('\n')
  return {
    funktionen: await q(`SELECT p.oid::regprocedure::text, md5(prosrc), prosecdef,
        (SELECT array_agg(x ORDER BY x) FROM (SELECT (a.grantee::regrole::text, a.privilege_type, a.is_grantable)::text x FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) s),
        proconfig FROM pg_proc p WHERE pronamespace = 'public'::regnamespace ORDER BY 1`),
    regeln: await q(`SELECT schemaname, tablename, policyname, permissive, roles::text, cmd, coalesce(qual,''), coalesce(with_check,'') FROM pg_policies ORDER BY 1,2,3`),
    rls: await q(`SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1`),
    tabellenrechte: await q(`SELECT table_schema, table_name, grantee, privilege_type FROM information_schema.role_table_grants WHERE table_schema IN ('public','auth','storage') ORDER BY 1,2,3,4`),
    daten: await q(`SELECT 'cu', count(*), md5(string_agg(id::text||postal_code, ',' ORDER BY id)) FROM customers UNION ALL SELECT 'co', count(*), '' FROM companies UNION ALL SELECT 'cu_users', count(*), '' FROM company_users`),
    bucket: await q(`SELECT * FROM storage.buckets ORDER BY id`),
  }
}
const without = (s, keys) => Object.fromEntries(Object.entries(s).filter(([k]) => !keys.includes(k)))
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// regprocedure::text zeigt Funktionen aus public ohne Schemanamen
const otherFunctions = s => s.funktionen.split('\n').filter(l => !HELPERS.concat('public.update_updated_at()', TRIGGER_FN).some(h => l.startsWith(JSON.stringify(h.replace(/^public\./, ''))))).join('\n')

async function scenario(tag, full) {
  const c = await fresh('t006' + tag.toLowerCase(), { full })
  const present = full ? HELPERS : HELPERS.slice(0, 3)
  const s0 = await state(c)
  const anonBefore = await as(c, 'anon', null, `SELECT public.get_my_company_id()`)
  ok(`${tag}0 Vorher: ohne Anmeldung aufrufbar (Ausgangslage wie im Advisor)`, anonBefore.ok)

  let r = await run(c, M006); ok(`${tag}1 Migration 006 läuft`, r.ok, r.err)
  const s1 = await state(c)
  for (const f of present) {
    const priv = (await c.query(`SELECT has_function_privilege('anon',$1,'EXECUTE') a, has_function_privilege('authenticated',$1,'EXECUTE') u, has_function_privilege('service_role',$1,'EXECUTE') s`, [f])).rows[0]
    ok(`${tag}2 ${f}: anon nein, authenticated ja, service_role ja`, !priv.a && priv.u && priv.s, JSON.stringify(priv))
  }
  r = await as(c, 'anon', null, `SELECT public.get_my_company_id()`)
  ok(`${tag}3 Aufruf ohne Anmeldung wird abgelehnt`, !r.ok && /permission denied/.test(r.err), r.err)
  r = await as(c, 'anon', null, `SELECT count(*) FROM customers`)
  ok(`${tag}4 Firmendaten ohne Anmeldung: Fehler statt Daten (vorher leere Liste)`, !r.ok && /permission denied/.test(r.err), r.err)
  r = await as(c, 'authenticated', UA, `SELECT company_id FROM customers`)
  ok(`${tag}5 Angemeldet (Firma A): sieht genau die eigenen 2 Kunden`, r.ok && r.rows.length === 2 && r.rows.every(x => x.company_id === A), r.err || JSON.stringify(r.rows))
  r = await as(c, 'authenticated', UB, `SELECT company_id FROM customers`)
  ok(`${tag}6 Angemeldet (Firma B): sieht nur den eigenen Kunden`, r.ok && r.rows.length === 1 && r.rows[0].company_id === B, r.err)
  r = await as(c, 'authenticated', UA, `INSERT INTO customers (company_id, postal_code) VALUES ('${A}','50737') RETURNING id`)
  ok(`${tag}7 Angemeldet: eigene Firma schreiben geht weiter`, r.ok, r.err)
  r = await as(c, 'authenticated', UA, `INSERT INTO customers (company_id, postal_code) VALUES ('${B}','50737') RETURNING id`)
  ok(`${tag}8 Angemeldet: fremde Firma schreiben weiter verboten`, !r.ok, 'wurde angenommen')
  r = await as(c, 'authenticated', UA, `UPDATE customers SET postal_code = postal_code, updated_at = '2000-01-01' WHERE company_id = '${A}' RETURNING updated_at`)
  ok(`${tag}9 Trigger update_updated_at arbeitet mit leerem Suchpfad (Zeitstempel neu)`, r.ok && r.rows.length === 2 && r.rows.every(x => new Date(x.updated_at).getFullYear() > 2020), r.err || JSON.stringify(r.rows))
  r = await as(c, 'authenticated', UA, `SELECT * FROM companies`)
  ok(`${tag}10 Angemeldet: eigene Firma lesbar (Regel mit is_company_member)`, r.ok && r.rows.length === 1, r.err)
  if (full) {
    r = await as(c, 'authenticated', UNEW, `SELECT public.register_company('Neu GmbH','neu-gmbh') AS id`)
    ok(`${tag}11 Registrierung (register_company) funktioniert weiter`, r.ok && r.rows[0].id, r.err)
  }
  const tp = (await c.query(`SELECT has_function_privilege('anon','public.on_auth_user_created()','EXECUTE') a, has_function_privilege('authenticated','public.on_auth_user_created()','EXECUTE') u`)).rows[0]
  ok(`${tag}11b on_auth_user_created: weder anon noch authenticated direkt aufrufbar`, !tp.a && !tp.u, JSON.stringify(tp))
  r = await run(c, `SET ROLE auth_admin_test; INSERT INTO auth.users VALUES (gen_random_uuid(), 'trigger@test'); RESET ROLE`)
  await c.query('RESET ROLE')
  const fired = (await c.query(`SELECT count(*)::int n FROM trigger_log`)).rows[0].n
  ok(`${tag}11c Auslöser bei neuem Konto läuft weiter (Rolle ohne Aufrufrecht)`, r.ok && fired === 1, r.err || 'n=' + fired)
  const cfg = (await c.query(`SELECT proconfig FROM pg_proc WHERE oid='public.update_updated_at()'::regprocedure`)).rows[0].proconfig
  ok(`${tag}12 update_updated_at: fester Suchpfad`, eq(cfg, ['search_path=""']), JSON.stringify(cfg))
  const bk = (await c.query(`SELECT file_size_limit, allowed_mime_types FROM storage.buckets WHERE id='uploads'`)).rows[0]
  ok(`${tag}13 Bucket uploads: 4 MB, 5 Dateiarten`, +bk.file_size_limit === 4194304 && bk.allowed_mime_types.length === 5, JSON.stringify(bk))
  ok(`${tag}14 Unverändert: Regeln, RLS, Tabellenrechte, Daten`, eq(without(s1, ['funktionen', 'bucket']), without(s0, ['funktionen', 'bucket'])))
  ok(`${tag}15 Unverändert: alle anderen Funktionen (Inhalt, Rechte, Einstellungen)`, otherFunctions(s1) === otherFunctions(s0) && otherFunctions(s0).split('\n').length === s0.funktionen.split('\n').length - present.length - 2, otherFunctions(s1).split('\n').filter((l, i) => l !== otherFunctions(s0).split('\n')[i]).join(' / '))
  ok(`${tag}16 Funktionsinhalte der Hilfsfunktionen unverändert`, s1.funktionen.split('\n').map(l => l.split('|').slice(0, 3).join('|')).join() === s0.funktionen.split('\n').map(l => l.split('|').slice(0, 3).join('|')).join())

  r = await run(c, M006); ok(`${tag}17 Zweiter Lauf: kein Fehler, nichts geändert`, r.ok && eq(await state(c), s1), r.err)

  r = await run(c, RB); ok(`${tag}18 Rückfall läuft`, r.ok, r.err)
  const s2 = await state(c)
  ok(`${tag}19 Rückfall: Funktionsrechte und Einstellungen exakt wie vorher`, s2.funktionen === s0.funktionen, s2.funktionen.split('\n').filter((l, i) => l !== s0.funktionen.split('\n')[i]).join(' / '))
  ok(`${tag}20 Rückfall: Bucket exakt wie vorher`, s2.bucket === s0.bucket)
  ok(`${tag}21 Rückfall: Regeln, RLS, Tabellenrechte wie vorher`, eq(without(s2, ['daten']), without(s0, ['daten'])))
  r = await as(c, 'anon', null, `SELECT public.get_my_company_id()`)
  ok(`${tag}22 Rückfall: Aufruf ohne Anmeldung wieder wie vorher möglich`, r.ok, r.err)
  r = await run(c, RB); ok(`${tag}23 Zweiter Rückfall ohne Sicherung: Abbruch`, !r.ok && /Keine Sicherung/.test(r.err), r.err)

  // Nach erneutem Einspielen jemand ändert etwas → Rückfall bricht ab
  r = await run(c, M006); ok(`${tag}24 Erneut einspielen nach Rückfall`, r.ok, r.err)
  await c.query(`UPDATE storage.buckets SET file_size_limit = 1000 WHERE id='uploads'`)
  const s3 = await state(c)
  r = await run(c, RB); ok(`${tag}25 Zustand seit 006 verändert: Rückfall bricht ab, ändert nichts`, !r.ok && /verändert/.test(r.err) && eq(await state(c), s3), r.err)
  r = await run(c, M006); ok(`${tag}26 … und Migration erkennt Abweichung (Abbruch statt still überschreiben)`, !r.ok && /weicht vom Ziel ab/.test(r.err), r.err)
  await c.end()
}

;(async () => {
  await scenario('P', false)   // heutiger Produktionsstand (nach Sofortmaßnahme, ohne 002)
  await scenario('G', true)    // nach Gesamtpaket 002–005

  // Fehlende Bucket-Spalten → Abbruch ohne Änderung
  const c = await fresh('t006x', { bucketColumns: false })
  const s0 = await state(c)
  const r = await run(c, M006)
  ok('X1 storage.buckets ohne Grenzspalten: Abbruch', !r.ok && /file_size_limit/.test(r.err), r.err)
  const s1 = await state(c)
  ok('X2 … nichts geändert, keine Sicherungstabelle', eq(s1, s0) && !(await c.query(`SELECT to_regclass('migration_backup.m006_state') x`)).rows[0].x)
  await c.end()

  const v = (await (async () => { const a = conn('postgres'); await a.connect(); const x = (await a.query('show server_version')).rows[0].server_version; await a.end(); return x })())
  console.log(`Migration 006 – Test auf PostgreSQL ${v}\n` + results.join('\n'))
  const bad = results.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${results.length - bad}/${results.length} bestanden`)
  process.exit(bad ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
