// Ende-zu-Ende-Test im Browser (Chromium) gegen die LOKALE Umgebung.
// Bedient die App wie ein Nutzer und vergleicht jede Zahl mit einer eigenen
// Gegenrechnung aus den Testdateien.
// Aufruf: node tests/e2e/ablauf-browser.cjs <basis-url> <ordner-mit-testdaten> [screenshot-ordner]
// Voraussetzung: frische lokale Datenbank (umgebung/db-aufbau.cjs), App läuft.
const BASE = process.argv[2] || 'http://localhost:3100', TD = process.argv[3], SHOTS = process.argv[4]
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(BASE)) { console.error('Nur gegen die lokale Umgebung erlaubt'); process.exit(2) }
const { chromium, devices } = require('playwright'); const fs = require('fs'); const path = require('path')
const res = []; const ok = (n, c, i = '') => { res.push(`${c ? 'OK    ' : 'FEHLER'} ${n}${i && !c ? ' – ' + String(i).replace(/\s+/g, ' ').slice(0, 220) : ''}`); if (!c) console.log('FEHLER', n, String(i).slice(0, 300)) }
const de = (n, d = 0) => n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mN8/+F9PQAJNgNlXyqkkAAAAABJRU5ErkJggg==', 'base64')

// ── Gegenrechnung direkt aus den Dateien ─────────────────────────────────────
function read(name) {
  const lines = fs.readFileSync(path.join(TD, name), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/); const h = lines[0].split(';')
  return lines.slice(1).map(l => Object.fromEntries(l.split(';').map((v, i) => [h[i], v])))
}
const A = read('11a-demo-bestellungen-juli-august.csv'), B = read('11b-demo-bestellungen-september-oktober.csv'), ALL = A.concat(B)
const eur = rows => Math.round(rows.reduce((s, r) => s + Number(r.Umsatz.replace(',', '.')), 0) * 100) / 100
const cust = rows => new Set(rows.map(r => r.Kundennummer)).size
const OCT = ALL.filter(r => r.Datum.slice(3, 5) === '10')
const NEUSSER = ALL.filter(r => r.PLZ === '50733' && r['Straße'] === 'Neusser Straße')

const stamp = Date.now()
const U1 = { email: `e2e-a-${stamp}@test.local`, pw: 'Test-Passwort-1!', firma: 'E2E Pizzeria A' }
const U2 = { email: `e2e-b-${stamp}@test.local`, pw: 'Test-Passwort-2!', firma: 'E2E Burger B' }

async function register(page, u) {
  await page.goto(BASE + '/auth/register')
  await page.fill('#company', u.firma); await page.fill('#email', u.email); await page.fill('#password', u.pw)
  await Promise.all([page.waitForURL('**/dashboard', { timeout: 30000 }), page.click('button[type=submit]')])
}
const mainText = async page => (await page.locator('main').innerText()).replace(/ /g, ' ')
async function chooseFile(page, name, buffer) {
  await page.goto(BASE + '/uploads'); await page.waitForSelector('text=Datei auswählen')
  await page.setInputFiles('input[type=file]', buffer ? { name, mimeType: 'text/csv', buffer } : path.join(TD, name))
}

;(async () => {
  const browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE', acceptDownloads: true })
  await ctx.route(/tile\.openstreetmap\.org|cdnjs\.cloudflare\.com.*\.png/, r => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }))
  const page = await ctx.newPage()
  const errors = []
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(page.url().replace(BASE, '') + ' :: ' + m.text().slice(0, 160)) })
  page.on('pageerror', e => errors.push(page.url().replace(BASE, '') + ' :: ' + String(e).slice(0, 160)))

  // ── 1. Zugang ───────────────────────────────────────────────────────────────
  await page.goto(BASE + '/dashboard'); await page.waitForURL('**/auth/login**')
  ok('01 Ohne Anmeldung führt /dashboard zur Anmeldung', page.url().includes('/auth/login'))
  await page.fill('#email', 'niemand@test.local'); await page.fill('#password', 'falsch-falsch'); await page.click('button[type=submit]')
  await page.waitForSelector('.notice-bad')
  ok('02 Falsches Passwort: verständliche Meldung auf Deutsch', /stimmen nicht/.test(await page.locator('.notice-bad').innerText()))
  await register(page, U1); await page.waitForSelector('text=/Noch keine Bestelldaten|Liefergebiete/')
  ok('03 Registrierung führt zur leeren Übersicht mit Hinweis auf den Import', /Noch keine Bestelldaten/.test(await mainText(page)))

  // ── 2. Import: fehlerhafte Dateien ──────────────────────────────────────────
  await chooseFile(page, 'kunden.html', Buffer.from('<html></html>'))
  await page.waitForSelector('.notice-bad'); ok('04 Falsches Dateiformat wird abgelehnt', /nicht unterstützt/.test(await page.locator('.notice-bad').innerText()))
  await chooseFile(page, '6-leer.csv'); await page.waitForSelector('.notice-bad')
  ok('05 Leere Datei: Meldung, nichts gespeichert', /keine Datenzeilen/.test(await page.locator('.notice-bad').innerText()), await mainText(page))
  await chooseFile(page, 'getarnt.xlsx', Buffer.from('PLZ;Straße\n50733;Teststr. 1')); await page.waitForSelector('.notice-bad')
  ok('06 Getarnte Datei (.xlsx mit Textinhalt) wird abgelehnt', /passt nicht zur Endung|nicht unterstützt/.test(await page.locator('.notice-bad').innerText()))
  await chooseFile(page, '4-fehler-ohne-plz.csv'); await page.waitForSelector('text=/Postleitzahl nicht gefunden|.notice-bad|Adressprüfung/')
  const t4 = await mainText(page)
  if (/Adressprüfung/.test(t4)) {
    // Mit deutschlandweitem Straßenverzeichnis (Migration 009): PLZ nur eindeutig ergänzt.
    // Gegenrechnung: eindeutig sind Rhöndorfer Str. (50939), Breite Str. (50667), Gocher Str. (50733)
    // = 3 Zeilen, 273,38 + 601,92 + 573,22 = 1.448,52 €. Neusser, Kempener (2×), Ludwig-Jahn-, Aachener Str.
    // liegen in Köln in mehreren PLZ; „Weidener Straße“ (2×) gibt es in Köln laut Verzeichnis nicht.
    ok('07 Datei ohne PLZ-Spalte: PLZ nur eindeutig ergänzt (3 von 10), Rest im Fehlerbericht mit Grund',
      t4.includes('3 Zeilen') && t4.includes('1.448,52 €') && /mehreren PLZ/.test(t4) && /7 ohne gültige oder eindeutig bestimmbare Postleitzahl/.test(t4), t4.slice(0, 1500))
    await page.click('text=Abbrechen')
  } else {
    ok('07 Datei ohne PLZ-Spalte: Zuordnung wird verlangt, Import gesperrt', /Postleitzahl/.test(t4) && (await page.locator('button:has-text("Import starten")').count() === 0 || await page.locator('button:has-text("Import starten")').isDisabled()))
  }
  await chooseFile(page, '5-fehlerhafte-zeilen.csv'); await page.waitForSelector('text=Wird übernommen')
  const t5 = await mainText(page)
  ok('08 Fehlerhafte Zeilen: Vorschau nennt Auffälligkeiten und bietet Fehlerbericht', /Zeilen mit Auffälligkeiten/.test(t5) && /Fehlerbericht herunterladen/.test(t5), t5)
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('text=Fehlerbericht herunterladen')])
  const report = fs.readFileSync(await dl.path(), 'utf8')
  ok('09 Fehlerbericht ist eine CSV mit Zeile und Grund', /^﻿Zeile;Grund/.test(report) && report.trim().split(/\r?\n/).length > 1, report.slice(0, 120))
  await page.click('text=Abbrechen')
  await page.goto(BASE + '/dashboard'); await page.waitForSelector('text=Noch keine Bestelldaten')
  ok('10 Nach abgebrochener Vorschau ist nichts gespeichert', true)

  // ── 3. Import Datei A (erster Import) ───────────────────────────────────────
  await chooseFile(page, '11a-demo-bestellungen-juli-august.csv'); await page.waitForSelector('text=So werden die Daten gespeichert')
  let t = await mainText(page)
  ok('11 Vorschau A: Zeilen, Bestellungen, Umsatz, Zeitraum stimmen mit der Gegenrechnung', t.includes(`${de(A.length)} Zeilen`) && t.includes(de(eur(A), 2) + ' €') && t.includes('01.07.2026 – 31.08.2026'), t)
  ok('12 Vorschau: Hinweis zum Datenschutz', /Namen und E-Mail-Adressen werden nicht gespeichert/.test(t))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-vorschau.png`, fullPage: true })
  await page.click('button:has-text("Import starten")'); await page.waitForSelector('text=/Import abgeschlossen|Das hat nicht geklappt/', { timeout: 90000 })
  t = await mainText(page)
  ok('13 Ergebnis A: Bestand = Gegenrechnung (Kunden, Bestellungen, Umsatz)', t.includes(de(cust(A))) && t.includes(de(A.length)) && t.includes(de(eur(A), 2) + ' €'), t)

  // ── 4. Dieselbe Datei noch einmal ───────────────────────────────────────────
  await chooseFile(page, '11a-demo-bestellungen-juli-august.csv'); await page.waitForSelector('text=Sie haben bereits Daten importiert')
  t = await mainText(page)
  ok('14 Dieselbe Datei: Warnung, „ergänzen“ gesperrt', /schon importiert/.test(t) && await page.locator('input[type=radio]').first().isDisabled(), t)
  await page.click('text=Abbrechen')

  // ── 5. Import Datei B (ergänzen) ────────────────────────────────────────────
  await chooseFile(page, '11b-demo-bestellungen-september-oktober.csv'); await page.waitForSelector('text=Sie haben bereits Daten importiert')
  ok('15 Datei B: „Neuen Zeitraum ergänzen“ ist vorgewählt', await page.locator('input[type=radio]').first().isChecked())
  await page.click('button:has-text("Import starten")'); await page.waitForSelector('text=/Import abgeschlossen|Das hat nicht geklappt/', { timeout: 90000 })
  t = await mainText(page)
  ok('16 Ergebnis A+B: Bestand = Gegenrechnung, Kunden aus beiden Dateien einmal gezählt', t.includes(de(cust(ALL))) && t.includes(de(ALL.length)) && t.includes(de(eur(ALL), 2) + ' €'), t)

  // ── 6. Übersicht ────────────────────────────────────────────────────────────
  await page.goto(BASE + '/dashboard'); await page.waitForSelector('text=Liefergebiete nach Postleitzahl')
  t = await mainText(page)
  ok('17 Übersicht: Umsatz, Bestellungen, Bestellwert, Kunden', t.includes(de(Math.round(eur(ALL))) + ' €') && t.includes(de(ALL.length)) && t.includes(de(eur(ALL) / ALL.length, 2) + ' €') && t.includes(de(cust(ALL))), t.slice(0, 500))
  ok('18 Übersicht: Zeitraum und Zahl der Tage', t.includes('01.07.2026 bis 31.10.2026') && t.includes('123 Tage'))
  for (const plz of ['50667', '50733', '50823', '50859', '50931']) {
    const rows = ALL.filter(r => r.PLZ === plz); const line = (await page.locator(`tr:has(a:text-is("${plz}"))`).first().innerText()).replace(/ /g, ' ')
    ok(`19 PLZ ${plz}: Umsatz, Bestellungen, Kunden`, line.includes(de(Math.round(eur(rows))) + ' €') && line.includes(de(rows.length)) && line.includes(de(cust(rows))), line)
  }
  if (process.env.GEO_PLZ_CSV) {
    // Mit geladenen Zensus-Zahlen (scripts/geodaten): Bestellungen je 1.000 Einwohner gegenrechnen
    const head = fs.readFileSync(process.env.GEO_PLZ_CSV, 'utf8').split('\n')[0].split(',')
    const rec = fs.readFileSync(process.env.GEO_PLZ_CSV, 'utf8').split('\n').find(l => l.startsWith('50733,')).split(',')
    const pop = Number(rec[head.indexOf('population')])
    const rows = ALL.filter(r => r.PLZ === '50733')
    const line = (await page.locator('tr:has(a:text-is("50733"))').first().innerText()).replace(/\u202f/g, ' ')
    ok('20 Mit Zensus-Zahl: „je 1.000 Einwohner“ = Bestellungen ÷ Einwohner × 1.000 (Gegenrechnung)', pop > 1000 && line.includes(de(rows.length / pop * 1000, 1)), `${line} | erwartet ${de(rows.length / pop * 1000, 1)} (Einwohner ${pop})`)
  } else {
    ok('20 Ohne belegte Einwohnerzahl bleibt „je 1.000 Einwohner“ leer (—), keine Schätzung', /—/.test(await page.locator('tr:has(a:text-is("50733"))').first().innerText()))
  }
  ok('21 Empfehlungen werden angezeigt', /Was jetzt wichtig ist/.test(t))

  // Zeitraumfilter
  await page.selectOption('select[aria-label=Zeitraum]', { label: 'Oktober 2026' }); await page.waitForSelector('text=Gezeigt wird nur der gewählte Zeitraum')
  await page.waitForFunction(n => document.querySelector('main').innerText.replace(/ /g, ' ').includes(n), de(OCT.length))
  t = await mainText(page)
  ok('22 Zeitraum Oktober: Bestellungen und Umsatz = Gegenrechnung für Oktober', t.includes(de(OCT.length)) && t.includes(de(Math.round(eur(OCT))) + ' €') && t.includes('01.10.2026 bis 31.10.2026'), t.slice(0, 400))
  await page.selectOption('select[aria-label=Zeitraum]', { index: 0 })

  // ── 7. Karte und Straßen ────────────────────────────────────────────────────
  await page.goto(BASE + '/streets?plz=50733'); await page.waitForSelector('text=Straßen in 50733', { timeout: 30000 })
  const line = (await page.locator('tr:has-text("Neusser Straße")').first().innerText()).replace(/ /g, ' ')
  ok('23 Neusser Straße: Bestellungen, Kunden (einmal je Person), Umsatz', line.includes(de(NEUSSER.length)) && new RegExp(`\\b${cust(NEUSSER)}\\b`).test(line) && line.includes(de(Math.round(eur(NEUSSER))) + ' €') && cust(NEUSSER) < NEUSSER.length, line)
  await page.waitForFunction(() => document.querySelectorAll('.leaflet-overlay-pane path').length > 5, null, { timeout: 30000 }).catch(() => {})
  ok('24 Karte wird gezeichnet (Straßenlinien vorhanden)', await page.locator('.leaflet-overlay-pane path').count() > 5)
  await page.locator('tr:has-text("Neusser Straße")').first().click()
  ok('25 Klick auf Straße zeigt die Begründung der Bewertung', /Durchschnitt|bewertbar/i.test(await page.locator('tr:has-text("Neusser Straße")').first().innerText()))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-karte.png`, fullPage: true })

  // ── 8. Weitere Seiten laden ohne Fehler ─────────────────────────────────────
  for (const [p, marker] of [['plz', 'Postleitzahlen'], ['customers', 'Kunden'], ['trends', 'Entwicklung'], ['marketing', 'Empfehlungen'], ['alerts', 'Hinweise'], ['competitors', 'Wettbewerber'], ['b2b', 'Firmenkunden'], ['uploads', 'Bisherige Importe'], ['settings', 'Nutzer und Rollen']]) {
    await page.goto(`${BASE}/${p}`); await page.waitForLoadState('networkidle').catch(() => {})
    const txt = await mainText(page)
    ok(`26 Seite /${p} lädt`, txt.includes(marker) && !/konnten nicht geladen werden|Application error/.test(txt), txt.slice(0, 200))
  }

  // ── 9. Export ───────────────────────────────────────────────────────────────
  await page.goto(BASE + '/settings'); await page.waitForSelector('text=Auswertungen herunterladen')
  const [d2] = await Promise.all([page.waitForEvent('download'), page.locator('a[href="/api/export?type=plz"]').click()])
  const csv = fs.readFileSync(await d2.path(), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).map(l => l.split(';'))
  const sumRev = Math.round(csv.slice(1).reduce((s, r) => s + Number(r[4].replace(',', '.')), 0) * 100) / 100, sumOrd = csv.slice(1).reduce((s, r) => s + Number(r[3]), 0)
  ok('27 Export Postleitzahlen: Summe Umsatz und Bestellungen = Gegenrechnung', csv.length === 6 && sumRev === eur(ALL) && sumOrd === ALL.length, `${sumRev} / ${sumOrd}`)
  const [d3] = await Promise.all([page.waitForEvent('download'), page.locator('a[href="/api/export?type=strassen"]').click()])
  const csvS = fs.readFileSync(await d3.path(), 'utf8').trim().split(/\r?\n/).slice(1).map(l => l.split(';'))
  ok('28 Export Straßen: Summe der Bestellungen = Gegenrechnung', csvS.reduce((s, r) => s + Number(r[3]), 0) === ALL.length, csvS.length)

  // ── 10. Zweite Firma sieht nichts ───────────────────────────────────────────
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'de-DE' }); const p2 = await ctx2.newPage()
  await register(p2, U2); await p2.waitForSelector('text=/Noch keine Bestelldaten|Liefergebiete/')
  ok('29 Zweite Firma: Übersicht ist leer', /Noch keine Bestelldaten/.test(await mainText(p2)))
  const r2 = await p2.evaluate(async () => { const o = await (await fetch('/api/overview')).json(); const s = await fetch('/api/analysis/streets?plz=50733').then(r => r.json()).catch(() => ({})); const e = await (await fetch('/api/export?type=plz')).text(); return { empty: o.overview?.empty, orders: o.overview?.totals?.orders, streets: (s.streets || []).length, exportLines: e.trim().split('\n').length } })
  ok('30 Zweite Firma: Schnittstellen liefern keine Daten der ersten', r2.empty === true && r2.orders === 0 && r2.streets === 0 && r2.exportLines === 1, JSON.stringify(r2))
  await p2.goto(BASE + '/settings'); await p2.waitForSelector('text=Daten löschen')
  ok('31 Zweite Firma: keine fremden Importe in der Liste', !/11a-demo/.test(await p2.locator('body').innerText()))
  await ctx2.close()

  // ── 11. Smartphone ──────────────────────────────────────────────────────────
  const mob = await browser.newContext({ ...devices['iPhone 13'], locale: 'de-DE' }); await mob.addCookies(await ctx.cookies())
  await mob.route(/tile\.openstreetmap\.org|cdnjs\.cloudflare\.com.*\.png/, r => r.fulfill({ status: 200, contentType: 'image/png', body: TILE }))
  const mp = await mob.newPage()
  for (const p of ['dashboard', 'streets', 'plz', 'customers', 'marketing', 'uploads', 'settings']) {
    await mp.goto(`${BASE}/${p}`); await mp.waitForLoadState('networkidle').catch(() => {}); await mp.waitForTimeout(400)
    const over = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    ok(`32 Smartphone /${p}: Seite passt in die Breite (kein Querscrollen der Seite)`, over <= 1, 'Überstand ' + over + ' px')
  }
  await mp.goto(BASE + '/dashboard'); await mp.click('button[aria-label="Menü öffnen"]'); await mp.waitForSelector('[role=dialog]')
  await mp.locator('[role=dialog] a:has-text("Postleitzahlen")').click(); await mp.waitForURL('**/plz'); await mp.waitForTimeout(500)
  ok('33 Smartphone: Menü öffnet, Navigation funktioniert, Menü schließt', await mp.locator('[role=dialog]').count() === 0)
  await mob.close()

  // ── Gegenprobe in der Datenbank: Adressprüfung gespeichert (nur mit Verzeichnis) ──
  if (process.env.GEO_DB) {
    const { Client } = require('pg'); const db = new Client({ host: '/var/tmp/pgtest', port: 54329, user: 'postgres', database: process.env.GEO_DB }); await db.connect()
    const st = (await db.query(`SELECT count(*) FILTER (WHERE geo_status IS NOT NULL)::int mit, count(*)::int alle FROM customers`)).rows[0]
    const up = (await db.query(`SELECT count(*) FILTER (WHERE geo_summary IS NOT NULL AND (geo_summary->>'total')::int > 0)::int mit, count(*) FILTER (WHERE status IN ('completed','replaced'))::int alle FROM uploads`)).rows[0]
    await db.end()
    ok('33b Jeder importierte Datensatz hat einen Zuordnungsstatus, jeder Import eine Adressprüfung', st.alle > 0 && st.mit === st.alle && up.mit === up.alle, JSON.stringify({ st, up }))
  }

  // ── 12. Daten löschen ───────────────────────────────────────────────────────
  await page.goto(BASE + '/settings'); await page.click('text=Alle importierten Daten löschen …')
  ok('34 Löschen ist ohne Bestätigungswort gesperrt', await page.locator('button:has-text("Endgültig löschen")').isDisabled())
  await page.fill('input[placeholder="LÖSCHEN"]', 'LÖSCHEN'); await page.click('button:has-text("Endgültig löschen")')
  await page.waitForSelector('text=Alle importierten Daten wurden gelöscht')
  await page.goto(BASE + '/dashboard'); await page.waitForSelector('text=Noch keine Bestelldaten')
  ok('35 Nach dem Löschen ist die Übersicht leer', true)
  await page.goto(BASE + '/uploads'); await page.waitForLoadState('networkidle').catch(() => {})
  ok('36 Nach dem Löschen: keine Importe mehr in der Liste', /Noch keine Importe/.test(await mainText(page)))
  await page.click('text=Abmelden'); await page.waitForURL('**/auth/login**')
  await page.goto(BASE + '/dashboard'); await page.waitForURL('**/auth/login**')
  ok('37 Nach dem Abmelden ist die Übersicht nicht mehr erreichbar', page.url().includes('/auth/login'))

  ok('38 Keine Fehler in der Browser-Konsole', errors.length === 0, [...new Set(errors)].join(' | '))
  await browser.close()
  console.log('Ende-zu-Ende-Test im Browser (lokale Umgebung)\n' + res.join('\n'))
  const bad = res.filter(x => x.startsWith('FEHLER')).length; console.log(`\n${res.length - bad}/${res.length} bestanden`); process.exit(bad ? 1 : 0)
})().catch(e => { console.log(res.join('\n')); console.error('ABBRUCH', e.message.slice(0, 400)); process.exit(2) })
