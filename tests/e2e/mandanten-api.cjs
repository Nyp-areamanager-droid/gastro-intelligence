// Mandantentrennung über die echte Schnittstelle (HTTP → PostgREST → Zugriffsregeln).
// Läuft gegen die LOKALE Umgebung (siehe Übernahmeplan), nie gegen Produktion.
// Aufruf: GIP_API=http://127.0.0.1:54410 GIP_ANON=… GIP_DB=gipsec node tests/e2e/mandanten-api.cjs
const { Client } = require('pg')
const API = process.env.GIP_API, ANON = process.env.GIP_ANON, DB = process.env.GIP_DB
if (!API || !ANON || !DB) { console.error('GIP_API, GIP_ANON und GIP_DB müssen gesetzt sein'); process.exit(2) }
if (!/^http:\/\/(127\.0\.0\.1|localhost):/.test(API)) { console.error('Nur gegen die lokale Umgebung erlaubt'); process.exit(2) }
const res = []; const ok = (n, c, i = '') => res.push(`${c ? 'OK    ' : 'FEHLER'} ${n}${i && !c ? ' – ' + String(i).slice(0, 160) : ''}`)
const call = async (token, method, path, body, prefer) => {
  const r = await fetch(API + path, { method, headers: { apikey: ANON, Authorization: 'Bearer ' + (token || ANON), 'content-type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) }, body: body ? JSON.stringify(body) : undefined })
  let data = null; try { data = await r.json() } catch {}
  return { status: r.status, data }
}
const signup = async (email) => (await call(null, 'POST', '/auth/v1/signup', { email, password: 'Test-Passwort-1!' })).data
const rows = r => Array.isArray(r.data) ? r.data.length : -1

;(async () => {
  const stamp = Date.now()
  const ua = await signup(`a${stamp}@test.local`), ub = await signup(`b${stamp}@test.local`), uc = await signup(`c${stamp}@test.local`), uv = await signup(`v${stamp}@test.local`)
  const A = ua.access_token, B = ub.access_token, C = uc.access_token, V = uv.access_token
  const ra = await call(A, 'POST', '/rest/v1/rpc/register_company', { p_name: 'Firma A', p_slug: 'firma-a-' + stamp })
  const rb = await call(B, 'POST', '/rest/v1/rpc/register_company', { p_name: 'Firma B', p_slug: 'firma-b-' + stamp })
  ok('01 Zwei Firmen über die Registrierung angelegt', ra.status === 200 && rb.status === 200, JSON.stringify([ra, rb]))
  const idA = typeof ra.data === 'string' ? ra.data : ra.data?.company_id || ra.data?.id || ra.data, idB = typeof rb.data === 'string' ? rb.data : rb.data?.company_id || rb.data?.id || rb.data
  // Betrachter (viewer) für Firma A – Vorbereitung direkt in der Datenbank
  const db = new Client({ host: '/var/tmp/pgtest', port: 54329, user: 'postgres', database: DB }); await db.connect()
  await db.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'viewer')`, [idA, uv.user.id])

  const mk = (cid, plz) => ({ company_id: cid, postal_code: plz, street: 'Teststraße', street_normalized: 'teststraße', total_orders: 3, total_revenue: 60 })
  const ia = await call(A, 'POST', '/rest/v1/customers', [mk(idA, '50733'), mk(idA, '50735')], 'return=representation')
  const ib = await call(B, 'POST', '/rest/v1/customers', [mk(idB, '01067')], 'return=representation')
  ok('02 Jede Firma kann eigene Kunden anlegen', ia.status === 201 && ib.status === 201, JSON.stringify([ia.status, ia.data, ib.status]))
  const custA = ia.data?.[0]?.id, custB = ib.data?.[0]?.id
  const upA = await call(A, 'POST', '/rest/v1/uploads', { company_id: idA, uploaded_by: ua.user.id, filename: 'a.csv', storage_path: `${idA}/a.csv`, status: 'completed' }, 'return=representation')
  ok('03 Firma A legt einen Upload-Eintrag an', upA.status === 201, JSON.stringify(upA))
  const anA = await call(A, 'POST', '/rest/v1/analytics', { company_id: idA, postal_code: '50733', customer_count: 2, order_count: 6, revenue: 120 }, 'return=representation')
  ok('04 Firma A legt eine Auswertung an', anA.status === 201, JSON.stringify(anA))

  // ── Lesen: B darf nichts von A sehen ──────────────────────────────────────
  for (const t of ['customers', 'analytics', 'uploads', 'street_analytics', 'alerts', 'marketing_actions', 'stores', 'company_users', 'companies']) {
    const col = t === 'companies' ? 'id' : 'company_id'
    const r = await call(B, 'GET', `/rest/v1/${t}?${col}=eq.${idA}&select=*`)
    ok(`05 Firma B liest ${t} von Firma A: nichts`, r.status === 200 && rows(r) === 0, JSON.stringify(r).slice(0, 200))
  }
  const allB = await call(B, 'GET', '/rest/v1/customers?select=company_id')
  ok('06 Firma B sieht ohne Filter nur eigene Kunden', rows(allB) === 1 && allB.data[0].company_id === idB, JSON.stringify(allB))
  const allA = await call(A, 'GET', '/rest/v1/customers?select=company_id')
  ok('07 Firma A sieht ohne Filter nur eigene Kunden', rows(allA) === 2 && allA.data.every(x => x.company_id === idA))

  // ── Schreiben: B darf nichts bei A ändern ─────────────────────────────────
  let r = await call(B, 'POST', '/rest/v1/customers', mk(idA, '99999'), 'return=representation')
  ok('08 B legt Kunden in Firma A an: abgelehnt', r.status >= 400, JSON.stringify(r))
  r = await call(B, 'PATCH', `/rest/v1/customers?id=eq.${custA}`, { total_revenue: 999999 }, 'return=representation')
  ok('09 B ändert Kunden von A: nichts geändert', rows(r) === 0, JSON.stringify(r))
  r = await call(B, 'DELETE', `/rest/v1/customers?company_id=eq.${idA}`, null, 'return=representation')
  ok('10 B löscht Kunden von A: nichts gelöscht', rows(r) === 0, JSON.stringify(r))
  r = await call(B, 'PATCH', `/rest/v1/customers?id=eq.${custB}`, { company_id: idA }, 'return=representation')
  ok('11 B schiebt eigenen Kunden zu Firma A: abgelehnt', r.status >= 400 || rows(r) === 0, JSON.stringify(r))
  r = await call(B, 'POST', '/rest/v1/company_users', { company_id: idA, user_id: ub.user.id, role: 'owner' }, 'return=representation')
  ok('12 B trägt sich selbst als Inhaber von A ein: abgelehnt', r.status >= 400, JSON.stringify(r))
  r = await call(B, 'PATCH', `/rest/v1/companies?id=eq.${idA}`, { name: 'Übernommen' }, 'return=representation')
  ok('13 B benennt Firma A um: nichts geändert', rows(r) === 0 || r.status >= 400, JSON.stringify(r))
  r = await call(B, 'DELETE', `/rest/v1/uploads?company_id=eq.${idA}`, null, 'return=representation')
  ok('14 B löscht Uploads von A: nichts gelöscht', rows(r) === 0 || r.status >= 400, JSON.stringify(r))
  r = await call(B, 'POST', '/rest/v1/analytics', { company_id: idA, postal_code: '50733', revenue: 1 }, 'return=representation')
  ok('15 B schreibt Auswertung für A: abgelehnt', r.status >= 400, JSON.stringify(r))
  r = await call(B, 'POST', '/rest/v1/rpc/register_company', { p_name: 'Zweitfirma', p_slug: 'zweit-' + stamp })
  const nB = (await db.query('SELECT count(*)::int n FROM company_users WHERE user_id = $1', [ub.user.id])).rows[0].n
  ok('16 B legt eine zweite Firma an: keine neue Firma (bleibt bei der eigenen)', (r.status >= 400 || r.data?.company_id === idB) && nB === 1, JSON.stringify(r))
  const check = (await db.query('SELECT count(*)::int n, sum(total_revenue)::int s FROM customers WHERE company_id = $1', [idA])).rows[0]
  ok('17 Gegenprobe in der Datenbank: Daten von A unverändert (2 Kunden, 120 €)', check.n === 2 && check.s === 120, JSON.stringify(check))

  // ── Rollen innerhalb einer Firma ──────────────────────────────────────────
  r = await call(V, 'GET', '/rest/v1/customers?select=id')
  ok('18 Betrachter von A liest Kunden von A', rows(r) === 2, JSON.stringify(r))
  r = await call(V, 'POST', '/rest/v1/customers', mk(idA, '50737'), 'return=representation')
  ok('19 Betrachter legt Kunden an: abgelehnt', r.status >= 400, JSON.stringify(r))
  r = await call(V, 'DELETE', `/rest/v1/customers?company_id=eq.${idA}`, null, 'return=representation')
  ok('20 Betrachter löscht Kunden: nichts gelöscht', rows(r) === 0 || r.status >= 400, JSON.stringify(r))
  r = await call(V, 'PATCH', `/rest/v1/company_users?user_id=eq.${uv.user.id}`, { role: 'owner' }, 'return=representation')
  ok('21 Betrachter macht sich zum Inhaber: nichts geändert', rows(r) === 0 || r.status >= 400, JSON.stringify(r))
  const role = (await db.query('SELECT role FROM company_users WHERE user_id = $1', [uv.user.id])).rows[0].role
  ok('22 Gegenprobe: Rolle ist weiter viewer', role === 'viewer', role)

  // ── Konto ohne Firma, ohne Anmeldung ──────────────────────────────────────
  for (const t of ['customers', 'companies', 'uploads', 'analytics']) { r = await call(C, 'GET', `/rest/v1/${t}?select=*`); ok(`23 Konto ohne Firma liest ${t}: nichts`, rows(r) === 0, JSON.stringify(r).slice(0, 150)) }
  for (const t of ['customers', 'companies', 'company_users', 'uploads', 'analytics', 'postal_codes', 'streets', 'poi_businesses', 'data_refresh_logs']) {
    r = await call(null, 'GET', `/rest/v1/${t}?select=*`); ok(`24 Ohne Anmeldung ${t}: keine Daten`, r.status >= 400 || rows(r) === 0, JSON.stringify(r).slice(0, 150)) }
  for (const f of ['get_my_company_id', 'my_company_role', 'can_write_company_data', 'on_auth_user_created']) {
    r = await call(null, 'POST', `/rest/v1/rpc/${f}`, {}); ok(`25 Ohne Anmeldung Funktion ${f}: abgelehnt`, r.status >= 400, JSON.stringify(r)) }
  r = await call(null, 'POST', '/rest/v1/rpc/register_company', { p_name: 'x', p_slug: 'x-' + stamp }); ok('26 Ohne Anmeldung Firma anlegen: abgelehnt', r.status >= 400, JSON.stringify(r))

  // ── Gemeinsame Referenzdaten: lesen ja, schreiben nein ────────────────────
  await db.query(`INSERT INTO postal_codes (postal_code, city, data_source, trust_level) VALUES ('99998','Teststadt','openplz','official') ON CONFLICT DO NOTHING`).catch(async () => { await db.query(`INSERT INTO postal_codes (postal_code, city) VALUES ('99998','Teststadt') ON CONFLICT DO NOTHING`).catch(() => {}) })
  r = await call(A, 'GET', '/rest/v1/postal_codes?select=postal_code'); ok('27 Angemeldet: Referenzdaten lesbar', r.status === 200, JSON.stringify(r).slice(0, 150))
  r = await call(A, 'POST', '/rest/v1/postal_codes', { postal_code: '99997', city: 'Gefälscht' }, 'return=representation'); ok('28 Angemeldet: Referenzdaten schreiben abgelehnt', r.status >= 400, JSON.stringify(r))
  r = await call(A, 'PATCH', '/rest/v1/postal_codes?postal_code=eq.99998', { population: 1 }, 'return=representation'); ok('29 Angemeldet: Einwohnerzahl fälschen: nichts geändert', rows(r) === 0 || r.status >= 400, JSON.stringify(r))
  r = await call(A, 'GET', '/rest/v1/data_refresh_logs?select=*'); ok('30 Angemeldet: Abruf-Protokoll nicht lesbar', rows(r) === 0 || r.status >= 400, JSON.stringify(r).slice(0, 150))

  // ── Dateispeicher ─────────────────────────────────────────────────────────
  const put = async (token, path) => (await fetch(`${API}/storage/v1/object/uploads/${path}`, { method: 'POST', headers: { Authorization: 'Bearer ' + (token || ANON), 'content-type': 'text/csv' }, body: 'PLZ\n50733\n' })).status
  ok('31 A speichert Datei im eigenen Ordner', await put(A, `${idA}/t-${stamp}.csv`) === 200)
  ok('32 B speichert Datei im Ordner von A: abgelehnt', await put(B, `${idA}/b-${stamp}.csv`) >= 400)
  ok('33 Ohne Anmeldung Datei speichern: abgelehnt', await put(null, `${idA}/x-${stamp}.csv`) >= 400)
  ok('34 Betrachter speichert Datei: abgelehnt', await put(V, `${idA}/v-${stamp}.csv`) >= 400)
  const get = async (token, path) => (await fetch(`${API}/storage/v1/object/uploads/${path}`, { headers: { Authorization: 'Bearer ' + token } })).status
  ok('35 B lädt Datei von A herunter: abgelehnt', await get(B, `${idA}/t-${stamp}.csv`) >= 400)
  ok('36 A lädt eigene Datei herunter', await get(A, `${idA}/t-${stamp}.csv`) === 200)

  // Löschen gespeicherter Dateien (Migration 008): nur Inhaber/Administrator der eigenen Firma
  const del = async (token, paths) => { const r = await fetch(`${API}/storage/v1/object/uploads`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + (token || ANON), 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: paths }) }); let d = null; try { d = await r.json() } catch {} return Array.isArray(d) ? d.length : -r.status }
  ok('37 B löscht Datei von A: nichts gelöscht', await del(B, [`${idA}/t-${stamp}.csv`]) <= 0)
  ok('38 Betrachter von A löscht Datei: nichts gelöscht', await del(V, [`${idA}/t-${stamp}.csv`]) <= 0)
  ok('39 Ohne Anmeldung Datei löschen: nichts gelöscht', await del(null, [`${idA}/t-${stamp}.csv`]) <= 0)
  ok('40 Datei von A ist noch da', await get(A, `${idA}/t-${stamp}.csv`) === 200)
  ok('41 Inhaber von A löscht eigene Datei', await del(A, [`${idA}/t-${stamp}.csv`]) === 1)
  ok('42 Datei ist danach weg', await get(A, `${idA}/t-${stamp}.csv`) >= 400)

  // Deutschlandweite Geodaten (Migration 009): gemeinsame Referenz, nur lesen, nur angemeldet
  const has009 = (await db.query(`SELECT to_regclass('public.street_directory') IS NOT NULL AS x`)).rows[0].x
  if (has009) {
    for (const t of ['street_directory', 'plz_localities']) {
      r = await call(null, 'GET', `/rest/v1/${t}?select=*&limit=1`); ok(`43 Ohne Anmeldung ${t}: keine Daten`, r.status >= 400 || rows(r) === 0, JSON.stringify(r).slice(0, 150))
      r = await call(B, 'GET', `/rest/v1/${t}?select=*&limit=1`); ok(`44 Angemeldet (B) liest ${t}`, r.status === 200, JSON.stringify(r).slice(0, 150))
      r = await call(A, 'POST', `/rest/v1/${t}`, t === 'street_directory' ? { postal_code: '99996', streets: ['X'], street_count: 1, version: 'x' } : { postal_code: '99996', locality: 'X', locality_key: 'x', kind: 'ort' }, 'return=representation')
      ok(`45 Inhaber (A) schreibt in ${t}: abgelehnt`, r.status >= 400, JSON.stringify(r))
      r = await call(A, 'DELETE', `/rest/v1/${t}?postal_code=eq.50823`, null, 'return=representation'); ok(`46 Inhaber (A) löscht aus ${t}: nichts gelöscht`, rows(r) === 0 || r.status >= 400, JSON.stringify(r).slice(0, 150))
    }
    r = await call(B, 'PATCH', `/rest/v1/customers?company_id=eq.${idA}`, { geo_status: 'exakt' }, 'return=representation'); ok('47 B setzt Zuordnungsstatus bei Kunden von A: nichts geändert', rows(r) === 0 || r.status >= 400, JSON.stringify(r))
    r = await call(B, 'GET', `/rest/v1/uploads?select=geo_summary&company_id=eq.${idA}`); ok('48 B liest Adressprüfung von A: nichts', r.status === 200 && rows(r) === 0, JSON.stringify(r).slice(0, 150))
  }

  await db.end()
  console.log('Mandantentrennung über die Schnittstelle (lokal)\n' + res.join('\n'))
  const bad = res.filter(x => x.startsWith('FEHLER')).length; console.log(`\n${res.length - bad}/${res.length} bestanden`); process.exit(bad ? 1 : 0)
})().catch(e => { console.error(e); process.exit(2) })
