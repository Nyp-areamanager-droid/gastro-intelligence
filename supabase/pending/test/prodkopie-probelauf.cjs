// Probelauf der Migrationen 002–012 auf einer isolierten lokalen Kopie der echten Produktionssicherung (Stand 17.11.2026, pg_dump 17.12).
// Voraussetzung: Datenbank "prodcopy" (aus der Sicherung wiederhergestellt, siehe docs/produktionskopie-probelauf.md) auf dem lokalen
// Test-PostgreSQL (Unix-Socket /var/tmp/pgtest, Port 54329). Es wird nie eine Verbindung zu Supabase/Produktion aufgebaut.
// Aufruf: node supabase/pending/test/prodkopie-probelauf.cjs
// Ausgabe enthält nur Zählungen/Prüfsummen, keine Kundendaten.
const { Client } = require('pg')
const fs = require('fs'); const path = require('path')
const R = path.join(__dirname, '../../../')
const M = f => fs.readFileSync(R + 'supabase/pending/' + f, 'utf8')
const conn = db => new Client({ host: process.env.PGHOST || '/var/tmp/pgtest', port: +(process.env.PGPORT || 54329), user: 'postgres', database: db })
const results = []; const ok = (n, c, i = '') => results.push(`${c ? 'OK    ' : 'FEHLER'} ${n}${i && !c ? ' – ' + i : ''}`)
const info = []; const note = s => info.push(s)
const run = async (c, sql) => { try { await c.query(sql); return { ok: true } } catch (e) { try { await c.query('ROLLBACK') } catch {} return { ok: false, err: e.message } } }
const as = async (c, role, uid, sql) => {
  await c.query('BEGIN'); try {
    await c.query(`SET LOCAL ROLE ${role}`); await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid || ''])
    const r = await c.query(sql); await c.query('ROLLBACK'); return { ok: true, rows: r.rows, n: r.rowCount }
  } catch (e) { await c.query('ROLLBACK'); return { ok: false, err: e.message, code: e.code } }
}
const UNONE = '00000000-0000-0000-0000-0000000000a4', UNEW = '00000000-0000-0000-0000-0000000000ee'

// Stabile Kennzahlen je Tabelle (bleiben beim Hinzufügen neuer Spalten gleich)
const TABLES = ['companies', 'company_users', 'customers', 'uploads', 'analytics', 'street_analytics', 'alerts', 'marketing_actions', 'stores', 'postal_codes', 'streets', 'poi_businesses', 'data_refresh_logs']
const snap = async c => {
  const o = {}
  for (const t of TABLES) {
    const pk = t === 'company_users' ? `company_id::text||user_id::text` : t === 'postal_codes' ? `postal_code` : 'id::text'
    o[t] = (await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(${pk}, ',' ORDER BY ${pk}), '')) h FROM public.${t}`)).rows[0]
  }
  o.customers = { ...o.customers, ...(await c.query(`SELECT sum(total_orders)::int o, sum(total_revenue)::numeric s, count(DISTINCT company_id)::int f FROM customers`)).rows[0] }
  o.company_users_roles = (await c.query(`SELECT md5(string_agg(company_id::text||user_id::text||role::text, ',' ORDER BY company_id, user_id)) h FROM company_users`)).rows[0]
  o.auth_users = (await c.query(`SELECT count(*)::int n, md5(string_agg(id::text, ',' ORDER BY id)) h FROM auth.users`)).rows[0]
  o.storage_objects = (await c.query(`SELECT count(*)::int n, md5(coalesce(string_agg(id::text||name, ',' ORDER BY id), '')) h FROM storage.objects`)).rows[0]
  return o
}
const same = (a, b) => Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
const rights = async c => (await c.query(`SELECT md5(string_agg(x,'|' ORDER BY x)) h FROM (
  SELECT cl.relname||a.grantee::regrole::text||a.privilege_type x FROM pg_class cl, LATERAL aclexplode(coalesce(cl.relacl,acldefault('r',cl.relowner))) a
   WHERE cl.relnamespace='public'::regnamespace AND cl.relkind='r') s`)).rows[0].h
const lines = async c => (await c.query(`SELECT x FROM (
   SELECT 'pol:'||schemaname||tablename||policyname||permissive||roles::text||cmd||coalesce(qual,'')||coalesce(with_check,'') x FROM pg_policies WHERE schemaname IN ('public','storage')
   UNION ALL SELECT 'fn:'||p.oid::regprocedure::text||md5(prosrc)||prosecdef FROM pg_proc p WHERE pronamespace='public'::regnamespace
   UNION ALL SELECT 'trg:'||tgname||tgrelid::regclass::text FROM pg_trigger WHERE NOT tgisinternal) s ORDER BY 1`)).rows.map(r => r.x)

;(async () => {
  const a = conn('postgres'); await a.connect()
  await a.query(`DROP DATABASE IF EXISTS prodrun`); await a.query(`CREATE DATABASE prodrun TEMPLATE prodcopy`); await a.end()
  const c = conn('prodrun'); await c.connect(); c.on('notice', () => {})

  // ── Ausgangslage aus der echten Sicherung ──
  // Hinweis: Die Sicherung wurde mit --no-acl erstellt. Die Tabellenrechte sind darin NICHT enthalten und werden hier mit den
  // Supabase-Standardrechten nachgebildet (anon/authenticated/service_role: alle Rechte). Bestätigt durch die Nur-Lesen-Abfrage
  // supabase/pending/check_rechte_produktion.sql gegen Produktion am 17.11.2026 (alle 12 Tabellen: anon/authenticated/service_role alle Rechte).
  await c.query(`GRANT USAGE ON SCHEMA public, auth, storage TO anon, authenticated, service_role;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role; GRANT ALL ON ALL TABLES IN SCHEMA storage TO anon, authenticated, service_role;
    GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public, auth, storage TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;`)
  // Wie in Produktion (Abfrage vom 17.11.): public.spatial_ref_sys gehört supabase_admin (PostGIS), anon/authenticated/service_role haben alle Rechte, PUBLIC SELECT.
  // PostGIS gibt es lokal nicht; die Tabelle wird nachgebildet, damit 012 auf einer fremden Tabelle geprüft wird.
  await c.query(`CREATE TABLE public.spatial_ref_sys (srid integer PRIMARY KEY); ALTER TABLE public.spatial_ref_sys OWNER TO supabase_admin;
    GRANT ALL ON public.spatial_ref_sys TO anon, authenticated, service_role; GRANT SELECT ON public.spatial_ref_sys TO PUBLIC;`)
  const hasTrg = (await c.query(`SELECT count(*)::int n FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal`)).rows[0].n
  note(`Auslöser auf auth.users in der Sicherung: ${hasTrg} (Abfrage B in Produktion am 17.11.2026: ebenfalls keiner; die Funktion on_auth_user_created ist nicht angehängt)`)
  const s0 = await snap(c), lines0 = await lines(c), rights0 = await rights(c)
  const e = (await c.query(`SELECT (SELECT count(*)::int FROM companies) f, (SELECT count(*)::int FROM company_users) m, (SELECT count(*)::int FROM customers) k, (SELECT count(*)::int FROM uploads) u, (SELECT count(*)::int FROM storage.objects) o,
    (SELECT count(*)::int FROM customers WHERE phone_normalized IS NOT NULL) tel, (SELECT count(DISTINCT phone_normalized)::int FROM customers) teld, (SELECT count(*)::int FROM customers WHERE full_name IS NOT NULL OR first_name IS NOT NULL) nam`)).rows[0]
  note(`Ausgangslage: ${e.f} Firma, ${e.m} Mitglied(er), ${e.k} Kunden (${e.tel} mit Telefon, ${e.teld} verschiedene, ${e.nam} mit Namen), ${e.u} Uploads, ${e.o} Storage-Objekte`)
  ok('00 Ausgangslage entspricht der Sicherung (4756 Kunden, 1 Firma, 7 Uploads, 7 Storage-Objekte)', e.k === 4756 && e.f === 1 && e.u === 7 && e.o === 7)
  const owner = (await c.query(`SELECT user_id::text u, company_id::text f FROM company_users WHERE role='owner' LIMIT 1`)).rows[0]
  ok('01 Vorher: Owner kann seinen Tarif selbst ändern (bekannte Lücke, wird durch 010 geschlossen)', (await as(c, 'authenticated', owner.u, `UPDATE companies SET plan=plan WHERE id='${owner.f}'`)).n === 1)
  const mem0 = (await as(c, 'authenticated', owner.u, `SELECT count(*)::int n FROM customers`)).rows[0].n
  ok('02 Vorher: Owner sieht seine Kunden', mem0 === e.k)

  const ORDER = ['002_security_policies.sql', '003_register_company.sql', '004_upload_import_mode.sql', '005_population_provenance.sql', '006_funktionen_bucket_haertung.sql',
    '007_datenminimierung.sql', '008_loeschen_indizes.sql', '009_geodaten_deutschland.sql', '010_firmenfelder_schutz.sql', '011_places_schluessel_schutz.sql', '012_tabellenrechte_minimum.sql']
  let prev = s0; const times = {}
  for (const f of ORDER) {
    const t0 = Date.now(); const r = await run(c, M(f)); times[f.slice(0, 3)] = Date.now() - t0
    ok(`10 ${f.slice(0, 3)} läuft fehlerfrei (${times[f.slice(0, 3)]} ms)`, r.ok, r.err)
    if (!r.ok) break
    const s = await snap(c); const d = same(prev, s)
    ok(`11 ${f.slice(0, 3)}: Zeilenzahlen/Kennungen aller Tabellen, auth.users, storage.objects unverändert`, d.length === 0, JSON.stringify(d))
    ok(`12 ${f.slice(0, 3)}: Kunden: Anzahl, Bestellungen, Umsätze unverändert`, s.customers.n === s0.customers.n && s.customers.o === s0.customers.o && String(s.customers.s) === String(s0.customers.s))
    prev = s
  }
  ok('13 012 lässt die PostGIS-Tabelle spatial_ref_sys (fremder Besitzer) unberührt', (await c.query(`SELECT has_table_privilege('anon','public.spatial_ref_sys','DELETE') a, has_table_privilege('authenticated','public.spatial_ref_sys','SELECT') b`)).rows[0].a === true)
  // 007: Wirkung auf die echten Daten
  const k7 = (await c.query(`SELECT count(*)::int n, count(*) FILTER (WHERE phone_normalized LIKE 'p1:%')::int p, count(*) FILTER (WHERE phone_raw IS NOT NULL OR first_name IS NOT NULL OR last_name IS NOT NULL OR full_name IS NOT NULL)::int kl, count(DISTINCT phone_normalized)::int d FROM customers`)).rows[0]
  ok('20 007: Telefonnummern pseudonymisiert, Namen/Klartext-Nummern gelöscht, Anzahl verschiedener Kunden gleich geblieben', k7.n === e.k && k7.p === e.tel && k7.kl === 0 && k7.d === e.teld, JSON.stringify(k7))
  // Endzustand
  const own = owner.u, f = owner.f
  let r = await as(c, 'authenticated', own, `UPDATE companies SET plan='enterprise' WHERE id='${f}'`); ok('30 Endzustand: Owner kann Tarif nicht ändern', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', own, `UPDATE companies SET name=name WHERE id='${f}' RETURNING id`); ok('31 Endzustand: Owner kann Firmendaten (Name) ändern', r.ok && r.n === 1, r.err)
  r = await as(c, 'authenticated', own, `SELECT count(*)::int n FROM customers`); ok('32 Endzustand: Owner sieht weiter alle seine Kunden', r.ok && r.rows[0].n === e.k, JSON.stringify(r).slice(0, 80))
  r = await as(c, 'authenticated', UNONE, `SELECT count(*)::int n FROM customers`); ok('33 Fremder Nutzer sieht keine Kunden', r.ok && r.rows[0].n === 0)
  r = await as(c, 'anon', null, `SELECT 1 FROM customers LIMIT 1`); ok('34 anon: kein Zugriff auf Kunden', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', own, `TRUNCATE customers`); ok('35 TRUNCATE verboten', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', own, `SELECT google_places_api_key FROM companies`); ok('36 Google-Schlüssel nicht direkt lesbar', !r.ok && r.code === '42501')
  r = await as(c, 'authenticated', own, `SELECT count(*)::int n FROM analytics`); ok('37 Owner sieht seine Auswertungen', r.ok && r.rows[0].n === s0.analytics.n)
  await c.query('BEGIN'); let reg
  try {
    await c.query(`INSERT INTO auth.users (id, email) VALUES ('${UNEW}','neu@example.invalid')`)
    await c.query(`SET LOCAL ROLE authenticated`); await c.query(`SELECT set_config('request.jwt.claim.sub','${UNEW}',true)`)
    await c.query(`SELECT public.register_company('Probefirma','probefirma-x')`)
    reg = (await c.query(`SELECT role::text r FROM company_users WHERE user_id='${UNEW}'`)).rows[0]
  } catch (er) { reg = { err: er.message } } finally { await c.query('ROLLBACK') }
  ok('40 Registrierung (register_company) auf den echten Daten funktioniert, neuer Nutzer wird Owner', reg && reg.r === 'owner', JSON.stringify(reg))
  const bk = (await c.query(`SELECT (SELECT count(*) FROM migration_backup.m010_companies_acl)::int a, (SELECT count(*) FROM migration_backup.m011_companies_acl)::int b, (SELECT count(*) FROM migration_backup.m012_acl)::int c`)).rows[0]
  ok('41 Sicherungstabellen der Migrationen 010–012 gefüllt', bk.a > 0 && bk.b > 0 && bk.c > 0, JSON.stringify(bk))
  const sEnd = await snap(c)
  // Zweiter Lauf (außer 002/003/007)
  let again = true; for (const g of ORDER.filter(x => !/^00[237]/.test(x))) { r = await run(c, M(g)); if (!r.ok) { again = false; ok(`50 ${g.slice(0, 3)} zweiter Lauf`, false, r.err) } }
  ok('51 Zweiter Lauf von 004–012 (ohne 007): fehlerfrei, Daten unverändert', again && same(sEnd, await snap(c)).length === 0)
  // Rückfall
  for (const g of ['012_rollback.sql', '011_rollback.sql', '010_rollback.sql', '009_rollback.sql', '008_rollback.sql', '006_rollback.sql', '005_rollback.sql', '004_rollback.sql']) { r = await run(c, M(g)); ok(`60 Rückfall ${g.slice(0, 3)} läuft`, r.ok, r.err) }
  r = await run(c, `DROP FUNCTION IF EXISTS public.register_company(text, text)`); ok('61 Rückfall 003 (Funktion löschen)', r.ok, r.err)
  r = await run(c, M('002_rollback.sql')); ok('62 Rückfall 002 läuft', r.ok, r.err)
  const sb = await snap(c)
  const dback = same(s0, sb).filter(k => k !== 'customers')
  ok('63 Nach Rückfall: alle Tabellen außer Kunden-Inhalt unverändert', dback.length === 0, JSON.stringify(dback))
  ok('64 Nach Rückfall: Kunden nach Anzahl/Bestellungen/Umsatz gleich (Namen/Telefon durch 007 nicht rückholbar)', sb.customers.n === s0.customers.n && sb.customers.o === s0.customers.o && String(sb.customers.s) === String(s0.customers.s))
  ok('65 Nach Rückfall: Tabellenrechte exakt wie im Ausgangszustand', (await rights(c)) === rights0)
  const l1 = await lines(c)
  ok('66 Nach Rückfall: Regeln, Funktionen, Auslöser wie im Ausgangszustand', JSON.stringify(lines0) === JSON.stringify(l1), JSON.stringify({ nur_vorher: lines0.filter(x => !l1.includes(x)).map(x => x.slice(0, 90)), nur_nachher: l1.filter(x => !lines0.includes(x)).map(x => x.slice(0, 90)) }).slice(0, 600))
  await c.end()
  console.log(info.join('\n')); console.log('Laufzeiten ms: ' + JSON.stringify(times)); console.log(results.join('\n'))
  const bad = results.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${results.length - bad} von ${results.length} Prüfungen bestanden${bad ? ', ' + bad + ' FEHLER' : ''}`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error('Testabbruch:', e.message); console.log(results.join('\n')); process.exit(2) })
