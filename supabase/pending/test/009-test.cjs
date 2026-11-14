// Test für Migration 009 (deutschlandweite Geodaten), Ladeskript und Rückfall.
// Braucht die lokale Datenbank gipsec (Aufbau mit allen Migrationen) und die
// Ausgabe von scripts/geodaten/build-deutschland.ts.
// Aufruf: node supabase/pending/test/009-test.cjs <ausgabeordner>
const { Client } = require('pg'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process')
const R = path.join(__dirname, '..') + '/'
const ROOT = path.join(__dirname, '../../..')
const DIR = process.argv[2]
const out = []; const ok = (n, c, info = '') => out.push(`${c ? 'OK    ' : 'FEHLER'} ${n}${!c && info ? ' – ' + info : ''}`)

;(async () => {
  const c = new Client({ host: '/var/tmp/pgtest', port: 54329, user: 'postgres', database: 'gipsec' }); await c.connect(); c.on('notice', () => {})
  const q = async (s, v) => (await c.query(s, v)).rows
  const as = async (role, uid, sql) => {
    await c.query('BEGIN')
    try {
      await c.query(`SET LOCAL ROLE ${role}`); await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [uid || ''])
      const r = await c.query(sql); await c.query('ROLLBACK'); return { ok: true, rows: r.rows }
    } catch (e) { await c.query('ROLLBACK'); return { ok: false, err: e.message } }
  }
  const load = (dir) => { try { execFileSync('npx', ['tsx', 'scripts/geodaten/laden.ts', '--dir', dir, '--db', 'gipsec'], { cwd: ROOT, stdio: 'pipe' }); return 0 } catch (e) { return e.status } }
  const state = async () => JSON.stringify(await q(`SELECT (SELECT count(*) FROM street_directory) sd, (SELECT sum(street_count) FROM street_directory) st, (SELECT count(*) FROM plz_localities) lo,
    (SELECT count(*) FROM postal_codes WHERE population_method IS NOT NULL) pop, (SELECT count(*) FROM customers) cu, (SELECT md5(string_agg(policyname||cmd||roles::text||coalesce(qual,''), ',' ORDER BY policyname)) FROM pg_policies) pol`))
  // Künstliche Testfirma mit einem Kunden (keine echten Daten)
  await c.query(`INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000009a1', 'geo-test@example.invalid') ON CONFLICT DO NOTHING;
    INSERT INTO companies (id, name, slug) VALUES ('10000000-0000-0000-0000-0000000009a1', 'Geo-Test', 'geo-test') ON CONFLICT DO NOTHING;
    INSERT INTO company_users (company_id, user_id, role) VALUES ('10000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-0000000009a1', 'owner') ON CONFLICT DO NOTHING;
    INSERT INTO customers (company_id, postal_code, street, total_orders, total_revenue) SELECT '10000000-0000-0000-0000-0000000009a1', '50823', 'Venloer Str.', 3, 42.5
      WHERE NOT EXISTS (SELECT 1 FROM customers WHERE company_id = '10000000-0000-0000-0000-0000000009a1');`)
  const users = await q(`SELECT cu.user_id, cu.company_id, cu.role FROM company_users cu WHERE cu.company_id = '10000000-0000-0000-0000-0000000009a1' LIMIT 1`)
  const uid = users[0]?.user_id

  // Laden (vorher mit build-deutschland erzeugt)
  ok('Laden ins leere Verzeichnis', load(DIR) === 0)
  const s1 = await state(); const st1 = JSON.parse(s1)[0]
  ok('Verzeichnis gefüllt (Straßen, Orte, Einwohner)', +st1.sd > 8000 && +st1.st > 1_000_000 && +st1.lo > 20000 && +st1.pop > 8000, s1)

  // 009 erneut: ändert nichts
  await c.query(fs.readFileSync(R + '009_geodaten_deutschland.sql', 'utf8'))
  ok('Zweiter Lauf 009 ändert nichts', (await state()) === s1)

  // Rechte
  let r = await as('anon', null, `SELECT count(*) FROM street_directory`)
  ok('Ohne Anmeldung: Straßenverzeichnis nicht lesbar', !r.ok && /permission denied/.test(r.err), r.err)
  r = await as('anon', null, `SELECT count(*) FROM plz_localities`)
  ok('Ohne Anmeldung: Ortstabelle nicht lesbar', !r.ok && /permission denied/.test(r.err), r.err)
  r = await as('authenticated', uid, `SELECT streets FROM street_directory WHERE postal_code = '50823'`)
  ok('Angemeldet: Straßen einer PLZ lesbar', r.ok && r.rows[0]?.streets?.includes('Venloer Str.'), r.err)
  for (const sql of [`INSERT INTO street_directory VALUES ('99999', '{X}', 1, 'x')`, `UPDATE street_directory SET street_count = 0`, `DELETE FROM plz_localities`, `INSERT INTO plz_localities VALUES ('99999','X','x','ort')`]) {
    r = await as('authenticated', uid, sql)
    ok(`Angemeldet darf nicht schreiben: ${sql.slice(0, 32)}…`, !r.ok && /permission denied/.test(r.err), r.err)
  }
  r = await as('authenticated', uid, `UPDATE customers SET geo_status = 'erfunden' WHERE company_id = '${users[0]?.company_id}'`)
  ok('Ungültiger Zuordnungsstatus wird abgelehnt', !r.ok, 'angenommen')

  // Integritätsschutz beim Laden: veränderte Datei → Abbruch, alter Stand bleibt
  const tmp = fs.mkdtempSync('/tmp/geo-'); for (const f of fs.readdirSync(DIR)) fs.copyFileSync(path.join(DIR, f), path.join(tmp, f))
  fs.appendFileSync(path.join(tmp, 'orte.csv'), '99999,Manipuliert,manipuliert,ort\n')
  ok('Manipulierte Datei: Laden bricht ab', load(tmp) === 3)
  ok('… und der alte Stand bleibt vollständig erhalten', (await state()) === s1)

  // Erneutes Laden derselben Daten: identischer Stand
  ok('Erneutes Laden: gleicher Stand', load(DIR) === 0 && (await state()) === s1)

  // Produktionssperre
  let refused = false
  try { execFileSync('npx', ['tsx', 'scripts/geodaten/laden.ts', '--dir', DIR], { cwd: ROOT, stdio: 'pipe', env: { ...process.env, DATABASE_URL: 'postgres://x@db.ebxsbjaelgjnmfqtofet.supabase.co:5432/postgres' } }) } catch (e) { refused = e.status === 2 }
  ok('Gegen das Produktionsprojekt verweigert das Ladeskript den Lauf', refused)

  // Rückfall
  const cust = (await q(`SELECT count(*) n, sum(total_revenue) s FROM customers`))[0]
  await c.query(fs.readFileSync(R + '009_rollback.sql', 'utf8'))
  const gone = await q(`SELECT to_regclass('public.street_directory') a, to_regclass('public.plz_localities') b,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND column_name IN ('geo_status','geo_summary','population_quality','households_quality','ags','reference_version')) cols`)
  const cust2 = (await q(`SELECT count(*) n, sum(total_revenue) s FROM customers`))[0]
  ok('Rückfall entfernt Tabellen und Spalten', !gone[0].a && !gone[0].b && +gone[0].cols === 0, JSON.stringify(gone))
  ok('Rückfall: Kundendaten unverändert, Einwohner bleiben', cust.n === cust2.n && cust.s === cust2.s && +(await q(`SELECT count(*) n FROM postal_codes WHERE population_method IS NOT NULL`))[0].n > 8000)
  await c.query(fs.readFileSync(R + '009_rollback.sql', 'utf8'))
  ok('Zweiter Rückfall ändert nichts', true)
  await c.query(fs.readFileSync(R + '009_geodaten_deutschland.sql', 'utf8'))
  ok('Erneut einspielen und laden: gleicher Stand', load(DIR) === 0 && (await state()) === s1)

  const sizes = (await q(`SELECT pg_size_pretty(pg_total_relation_size('street_directory')) sd, pg_size_pretty(pg_total_relation_size('plz_localities')) lo, pg_size_pretty(pg_total_relation_size('postal_codes')) pc`))[0]
  console.log(`Migration 009 – Test auf PostgreSQL 17 (lokal)\n${out.join('\n')}\nSpeicher: Straßenverzeichnis ${sizes.sd}, Orte ${sizes.lo}, PLZ ${sizes.pc}`)
  const bad = out.filter(x => x.startsWith('FEHLER')).length
  console.log(`\n${out.length - bad}/${out.length} bestanden`); await c.end(); process.exit(bad ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
