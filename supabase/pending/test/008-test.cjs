// Test für Migration 008 und Rückfall. Braucht die lokale Datenbank gipsec
// (Aufbau mit allen Migrationen, siehe Übernahmeplan). Aufruf: node supabase/pending/test/008-test.cjs
const { Client } = require('pg'); const fs = require('fs'); const path = require('path')
const R = path.join(__dirname, '..') + '/'
;(async () => { const c = new Client({ host: '/var/tmp/pgtest', port: 54329, user: 'postgres', database: 'gipsec' }); await c.connect(); c.on('notice', () => {})
  const st = async () => JSON.stringify([(await c.query(`select policyname, cmd, roles::text, qual from pg_policies where schemaname='storage' order by 1`)).rows, (await c.query(`select indexname from pg_indexes where schemaname='public' order by 1`)).rows, (await c.query(`select (select count(*) from customers) c, (select count(*) from uploads) u`)).rows])
  const s1 = await st(); const out = []
  await c.query(fs.readFileSync(R + '008_loeschen_indizes.sql', 'utf8')); out.push(['Zweiter Lauf 008 ändert nichts', (await st()) === s1])
  await c.query(fs.readFileSync(R + '008_rollback.sql', 'utf8')); const s0 = await st()
  out.push(['Rückfall entfernt Lösch-Regel und 7 Indizes, Daten unverändert', !/uploads_storage_delete/.test(s0) && !/customers_company_plz_idx/.test(s0) && JSON.parse(s0)[2][0].c === JSON.parse(s1)[2][0].c])
  await c.query(fs.readFileSync(R + '008_rollback.sql', 'utf8')); out.push(['Zweiter Rückfall ändert nichts', (await st()) === s0])
  await c.query(fs.readFileSync(R + '008_loeschen_indizes.sql', 'utf8')); out.push(['Erneutes Einspielen stellt denselben Zustand her', (await st()) === s1])
  await c.query('set enable_seqscan = off')   // Testtabelle ist winzig; so zeigt sich, ob der Index verwendbar ist
  const plan = (await c.query(`explain select * from street_analytics where analytics_id = '00000000-0000-0000-0000-000000000001'`)).rows.map(r => r['QUERY PLAN']).join(' ')
  out.push(['Abfrage der Straßen einer Auswertung nutzt den neuen Index', /street_analytics_analytics_idx/.test(plan)])
  console.log('Migration 008 – Test auf PostgreSQL 17 (lokal)\n' + out.map(([n, ok]) => (ok ? 'OK     ' : 'FEHLER ') + n).join('\n')); await c.end() })()
