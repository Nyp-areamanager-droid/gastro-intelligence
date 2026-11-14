// Übersicht und Empfehlungen: jede Zahl von Hand nachgerechnet
import { describe, it, expect } from 'vitest'
import { buildOverview, isoWeek, isOrderLevel, daysInclusive, type OverviewCustomerRow, type OverviewUpload } from '../src/lib/insights/overview'
import { buildRecommendations, RULES } from '../src/lib/insights/recommendations'

const NOW = new Date('2026-11-13T00:00:00Z')
const up = (id: string, start: string | null, end: string | null, mapping: Record<string, string> = { total_orders: 'Bestellungen', last_order_date: 'Datum' }): OverviewUpload =>
  ({ id, filename: id + '.csv', period_start: start, period_end: end, created_at: '2026-11-01', column_mapping: mapping })
const row = (o: Partial<OverviewCustomerRow>): OverviewCustomerRow => ({ upload_id: 'u1', postal_code: '50733', street: 'Neusser Straße', street_normalized: 'neusser straße', total_orders: 1, total_revenue: 20, ...o })

describe('Hilfsfunktionen', () => {
  it('Tage inklusive, Kalenderwoche, Erkennung „eine Zeile je Bestellung“', () => {
    expect(daysInclusive('2026-10-01', '2026-10-31')).toBe(31)
    expect(isoWeek('2026-01-01')).toBe('2026-W01')
    expect(isoWeek('2027-01-03')).toBe('2026-W53')
    expect(isoWeek('2026-11-13')).toBe('2026-W46')
    expect(isOrderLevel({ last_order_date: 'Datum', total_revenue: 'Umsatz' })).toBe(true)
    expect(isOrderLevel({ last_order_date: 'Datum', total_orders: 'Bestellungen' })).toBe(false)
    expect(isOrderLevel(null)).toBe(false)
  })
})

describe('Übersicht: Summen, Kunden, Zeiträume', () => {
  const customers = [
    row({ phone_normalized: 'p1:a', total_orders: 4, total_revenue: 80 }),
    row({ phone_normalized: 'p1:b', total_orders: 1, total_revenue: 25, street: 'Ring', street_normalized: 'ring' }),
    row({ upload_id: 'u2', phone_normalized: 'p1:a', total_orders: 2, total_revenue: 30 }),          // derselbe Kunde wie oben
    row({ upload_id: 'u2', customer_ref: 'K7', postal_code: '50735', total_orders: 3, total_revenue: 75, street: 'Amsterdamer Straße', street_normalized: 'amsterdamer straße' }),
    row({ upload_id: 'u2', postal_code: '50735', total_orders: 1, total_revenue: 10, street: null }),  // ohne Kennung
  ]
  const o = buildOverview({
    customers, uploads: [up('u1', '2026-09-01', '2026-09-30'), up('u2', '2026-10-01', '2026-10-31')],
    postalCodes: [{ postal_code: '50733', city: 'Köln', population: 20000, households: 11000, population_method: 'zensus2022_gitter100m_plz_osm', population_reference_date: '2022-05-15' },
      { postal_code: '50735', city: 'Köln', population: 15000, households: null, population_method: null }],   // ohne Methode = nicht belegt
    directories: [{ postal_code: '50733', streets_total: 40, streets_with_orders: 2, streets_without_orders: 38 }],
    streetRows: [{ postal_code: '50733', street_name: 'Lindenweg', order_count: 0, customer_count: 0, revenue: 0, is_in_official_list: true }],
    now: NOW,
  })
  it('Summen: 11 Bestellungen, 220 €, 20 € je Bestellung', () => {
    expect(o.totals.orders).toBe(11); expect(o.totals.revenue).toBe(220); expect(o.totals.avg_order_value).toBe(20)
  })
  it('Kunden: derselbe Kunde aus zwei Zeiträumen zählt einmal → 4 Kunden', () => {
    expect(o.totals.customers).toBe(4)
    expect(o.totals.unidentified_records).toBe(1)
    expect(o.totals.identified_share_pct).toBe(80)
    expect(o.totals.repeat_customers_pct).toBe(50)       // a (6 Bestellungen) und K7 (3) von 4
    expect(o.totals.one_time_customers_pct).toBe(50)
  })
  it('Zeiträume: je Tag gerechnet', () => {
    expect(o.periods.map(p => [p.days, p.orders, p.revenue])).toEqual([[30, 5, 105], [31, 6, 115]])
    expect(o.periods[0].revenue_per_day).toBe(3.5); expect(o.periods[1].revenue_per_day).toBe(3.71)
    expect(o.coverage.days).toBe(61)
    expect(o.change!.comparable).toBe(true)
    expect(o.change!.revenue_per_day_pct).toBe(6)        // 3,71 / 3,50 − 1 = 6,0 %
  })
  it('PLZ: Einwohner nur mit belegter Methode; je 1.000 Einwohner nachgerechnet', () => {
    const a = o.plz.find(p => p.postal_code === '50733')!, b = o.plz.find(p => p.postal_code === '50735')!
    expect(a.orders).toBe(7); expect(a.population).toBe(20000)
    expect(a.orders_per_1000).toBe(0.4)                  // 7 / 20.000 × 1.000 = 0,35 → 0,4
    expect(a.orders_per_1000_30d).toBe(0.2)              // 0,35 / 61 × 30 = 0,17 → 0,2
    expect(a.customers).toBe(2)
    expect(b.population).toBeNull(); expect(b.orders_per_1000).toBeNull(); expect(b.streets_total).toBeNull()
    expect(a.revenue_share_pct + b.revenue_share_pct).toBeCloseTo(100, 0)
  })
  it('Straßen: Summen je Straße, Straßen ohne Bestellung nur aus dem Verzeichnis', () => {
    expect(o.streets.top[0]).toEqual({ postal_code: '50733', street_name: 'Neusser Straße', orders: 6, customers: 1, revenue: 110 })
    expect(o.streets.without_orders).toEqual([{ postal_code: '50733', street_name: 'Lindenweg' }])
  })
  it('Verlauf nach Tagen gibt es nicht, weil die Dateien Summen je Kunde enthalten', () => {
    expect(o.series.available).toBe(false); expect(o.series.reason).toMatch(/Zeile je Bestellung/)
    expect(o.series.daily).toEqual([])
  })
  it('ohne Zeitraum: kein Wert je Tag, kein Vergleich', () => {
    const x = buildOverview({ customers, uploads: [up('u1', null, null), up('u2', '2026-10-01', '2026-10-31')], postalCodes: [], directories: [], streetRows: [], now: NOW })
    expect(x.coverage.days).toBeNull(); expect(x.change).toBeNull(); expect(x.periods.find(p => p.upload_id === 'u1')!.revenue_per_day).toBeNull()
  })
  it('zu viele Datensätze ohne Kennung: kein Stammkunden-Anteil', () => {
    const x = buildOverview({ customers: [row({}), row({}), row({ customer_ref: 'K1' })], uploads: [up('u1', '2026-09-01', '2026-09-30')], postalCodes: [], directories: [], streetRows: [], now: NOW })
    expect(x.totals.repeat_customers_pct).toBeNull(); expect(x.segments).toBeNull(); expect(x.segments_note).toMatch(/wiedererkennen/)
  })
  it('leer', () => {
    const x = buildOverview({ customers: [], uploads: [], postalCodes: [], directories: [], streetRows: [], now: NOW })
    expect(x.empty).toBe(true); expect(buildRecommendations(x)).toEqual([])
  })
})

describe('Verlauf und Wochentage (eine Zeile je Bestellung)', () => {
  // 8 Wochen ab Montag 07.09.2026: Mo–Sa je 4 Bestellungen, dienstags nur 1, sonntags keine
  const customers: OverviewCustomerRow[] = []
  for (let d = 0; d < 56; d++) {
    const date = new Date(Date.UTC(2026, 8, 7 + d)); const wd = date.getUTCDay()
    const n = wd === 0 ? 0 : wd === 2 ? 1 : 4
    for (let i = 0; i < n; i++) customers.push(row({ customer_ref: `K${(d * 7 + i) % 60}`, last_order_date: date.toISOString().slice(0, 10), total_revenue: 25 }))
  }
  const o = buildOverview({ customers, uploads: [up('u1', '2026-09-07', '2026-11-01', { last_order_date: 'Datum', total_revenue: 'Umsatz', customer_ref: 'Kundennummer' })], postalCodes: [], directories: [], streetRows: [], now: NOW })
  it('Tages-, Wochen- und Monatswerte', () => {
    expect(o.series.available).toBe(true)
    expect(o.series.daily).toHaveLength(48)                       // 8 × 6 Tage mit Bestellungen
    expect(o.series.weekly).toHaveLength(8)
    expect(o.series.weekly[0]).toMatchObject({ key: '2026-W37', orders: 21, revenue: 525 })   // 5 × 4 + 1
    expect(o.series.monthly.reduce((s, m) => s + m.orders, 0)).toBe(168)
  })
  it('Wochentage je Tag', () => {
    const by = Object.fromEntries(o.series.weekdays.map(w => [w.label, w]))
    expect(by.Montag).toMatchObject({ orders: 32, occurrences: 8, orders_per_day: 4 })
    expect(by.Dienstag.orders_per_day).toBe(1)
    expect(by.Sonntag.orders).toBe(0)
  })
  it('Empfehlung: Dienstag schwach, Sonntag als Ruhetag genannt, keine Euro-Prognose', () => {
    const r = buildRecommendations(o).find(x => x.kind === 'weak_weekday')!
    expect(r.title).toBe('Dienstag: deutlich weniger Bestellungen')
    expect(r.evidence.join(' ')).toMatch(/Dienstag: 1,0 Bestellungen je Tag \(8 Dienstage/)
    expect(r.evidence.join(' ')).toMatch(/Ruhetag\): Sonntag/)
    expect(r.confidence.level).toBe('mittel')                     // 55 Tage < 84
    expect(JSON.stringify(r)).not.toMatch(/Potenzial|€ mehr|ROI/)
  })
})

describe('Empfehlungen', () => {
  const pc = (plz: string, pop: number) => ({ postal_code: plz, city: 'Teststadt', population: pop, households: null, population_method: 'zensus2022_gitter100m_plz_osm', population_reference_date: '2022-05-15' })
  const mk = (plz: string, orders: number, upload = 'u1') => row({ upload_id: upload, postal_code: plz, customer_ref: plz + upload, total_orders: orders, total_revenue: orders * 20 })
  it('viele Einwohner, wenige Bestellungen – mit Zahlen und Vergleichswert', () => {
    const o = buildOverview({
      customers: [mk('10001', 400), mk('10002', 380), mk('10003', 60), mk('10004', 900)],
      uploads: [up('u1', '2026-09-01', '2026-10-31')],
      postalCodes: [pc('10001', 10000), pc('10002', 10000), pc('10003', 12000), pc('10004', 10000)],
      directories: [], streetRows: [], now: NOW,
    })
    const recs = buildRecommendations(o)
    const low = recs.find(r => r.kind === 'plz_low_reach')!
    expect(low.postal_codes).toEqual(['10003'])                   // 5,0 je 1.000 gegenüber Median 39,0
    expect(low.evidence[0]).toBe('PLZ 10003: 12.000 Einwohner (Zensus 2022), 60 Bestellungen, das sind 5,0 je 1.000 Einwohner.')
    expect(low.evidence[1]).toMatch(/Median\) Ihrer 4 Gebiete mit Einwohnerzahl: 39,0/)
    expect(low.confidence.level).toBe('mittel')                   // nur 4 Gebiete
    const high = recs.find(r => r.kind === 'plz_high_reach')!
    expect(high.postal_codes).toEqual(['10004'])                  // 90 > 1,5 × 39
    for (const r of recs) { expect(r.finding).toBeTruthy(); expect(r.evidence.length).toBeGreaterThan(0); expect(r.relevance).toBeTruthy(); expect(r.action).toBeTruthy(); expect(r.confidence.reason).toBeTruthy() }
  })
  it('weniger als 3 Gebiete mit Einwohnerzahl: kein Vergleich, dafür Hinweis auf die Datenlage', () => {
    const o = buildOverview({ customers: [mk('10001', 400), mk('10003', 60)], uploads: [up('u1', '2026-09-01', '2026-10-31')], postalCodes: [pc('10001', 10000)], directories: [], streetRows: [], now: NOW })
    const recs = buildRecommendations(o)
    expect(recs.some(r => r.kind === 'plz_low_reach')).toBe(false)
    expect(recs.find(r => r.kind === 'data_gap')!.evidence.join(' ')).toMatch(/Für 1 von 2 PLZ fehlt eine belegte Einwohnerzahl \(10003\)/)
  })
  it('Umsatzrückgang je Tag: −25 % → Priorität 1, mit beiden Zeiträumen als Beleg', () => {
    const o = buildOverview({
      customers: [mk('10001', 200, 'u1'), mk('10001', 150, 'u2')],
      uploads: [up('u1', '2026-09-01', '2026-09-30'), up('u2', '2026-10-01', '2026-10-30')], postalCodes: [], directories: [], streetRows: [], now: NOW,
    })
    const r = buildRecommendations(o).find(x => x.kind === 'revenue_drop')!
    expect(r.priority).toBe(1)
    expect(r.title).toBe('Umsatz je Tag um 25,0 % gesunken')
    expect(r.evidence[0]).toMatch(/4\.000,00 € in 30 Tagen = 133,33 € je Tag/)
    expect(r.evidence[1]).toMatch(/3\.000,00 € in 30 Tagen = 100,00 € je Tag/)
    expect(r.confidence.level).toBe('hoch')
    expect(r.action).toMatch(/weniger Bestellungen/)
  })
  it('unterschiedlich lange Zeiträume werden je Tag verglichen (kein falscher Rückgang)', () => {
    const o = buildOverview({
      customers: [mk('10001', 300, 'u1'), mk('10001', 150, 'u2')],                   // halb so viele Bestellungen …
      uploads: [up('u1', '2026-09-01', '2026-09-30'), up('u2', '2026-10-01', '2026-10-15')], postalCodes: [], directories: [], streetRows: [], now: NOW,   // … in halb so vielen Tagen
    })
    expect(o.change!.revenue_per_day_pct).toBe(0)
    expect(buildRecommendations(o).some(r => r.kind === 'revenue_drop')).toBe(false)
  })
  it('zu kurze oder überlappende Zeiträume: kein Vergleich, Begründung steht im Hinweis', () => {
    const o = buildOverview({ customers: [mk('10001', 200, 'u1'), mk('10001', 20, 'u2')], uploads: [up('u1', '2026-09-01', '2026-09-30'), up('u2', '2026-10-01', '2026-10-07')], postalCodes: [], directories: [], streetRows: [], now: NOW })
    expect(o.change!.comparable).toBe(false)
    const recs = buildRecommendations(o)
    expect(recs.some(r => r.kind === 'revenue_drop')).toBe(false)
    expect(recs.find(r => r.kind === 'data_gap')!.evidence.join(' ')).toMatch(/kürzer als 14 Tage/)
  })
  it('Straßen mit Rückgang: nur ab 8 Bestellungen im Vorzeitraum, Sicherheit niedrig', () => {
    const s = (upload: string, street: string, orders: number) => row({ upload_id: upload, customer_ref: street + upload, street, street_normalized: street.toLowerCase(), total_orders: orders, total_revenue: orders * 20 })
    const o = buildOverview({
      customers: [s('u1', 'Hauptstraße', 20), s('u2', 'Hauptstraße', 6), s('u1', 'Nebenweg', 3), s('u2', 'Nebenweg', 0 + 1), s('u1', 'Ring', 30), s('u2', 'Ring', 31)],
      uploads: [up('u1', '2026-09-01', '2026-09-30'), up('u2', '2026-10-01', '2026-10-30')], postalCodes: [], directories: [], streetRows: [], now: NOW,
    })
    const r = buildRecommendations(o).find(x => x.kind === 'streets_declining')!
    expect(r.streets).toEqual(['Hauptstraße'])                    // Nebenweg hatte zu wenige Bestellungen
    expect(r.evidence[0]).toBe('Hauptstraße (50733): von 20,0 auf 6,0 Bestellungen je 30 Tage (-70,0 %).')
    expect(r.confidence.level).toBe('niedrig')
  })
  it('Straßen ohne Bestellung nur bei vollständigem Verzeichnis und genug Bestellungen im Gebiet', () => {
    const base = { customers: [mk('50733', 40)], uploads: [up('u1', '2026-09-01', '2026-10-31')], postalCodes: [], now: NOW,
      streetRows: [{ postal_code: '50733', street_name: 'Lindenweg', order_count: 0, customer_count: 0, revenue: 0, is_in_official_list: true }] }
    expect(buildRecommendations(buildOverview({ ...base, directories: [{ postal_code: '50733', streets_total: 12, streets_with_orders: 11, streets_without_orders: 1 }] })).find(r => r.kind === 'streets_without_orders')!.streets).toEqual(['Lindenweg'])
    expect(buildRecommendations(buildOverview({ ...base, directories: [] })).some(r => r.kind === 'streets_without_orders')).toBe(false)
  })
  it('Bestellwege: Anteil fremder Plattformen ohne Annahme über Gebühren', () => {
    const o = buildOverview({ customers: [row({ customer_ref: 'a', total_orders: 60, platform: 'Lieferando' }), row({ customer_ref: 'b', total_orders: 40, platform: 'Website' })], uploads: [up('u1', '2026-09-01', '2026-10-31')], postalCodes: [], directories: [], streetRows: [], now: NOW })
    const r = buildRecommendations(o).find(x => x.kind === 'platform_share')!
    expect(r.title).toBe('60,0 % über Lieferando')
    expect(JSON.stringify(r)).not.toMatch(/30\s?%|\d+ € (sparen|Ersparnis)/)
  })
  it('Einmalkunden: Empfehlung erst ab 60 % und ohne Telefonwerbung', () => {
    const many = Array.from({ length: 60 }, (_, i) => row({ customer_ref: 'K' + i, total_orders: i < 45 ? 1 : 3 }))
    const o = buildOverview({ customers: many, uploads: [up('u1', '2026-08-01', '2026-10-31')], postalCodes: [], directories: [], streetRows: [], now: NOW })
    const r = buildRecommendations(o).find(x => x.kind === 'one_time_customers')!
    expect(r.title).toBe('75,0 % der Kunden haben nur einmal bestellt')
    expect(r.action).not.toMatch(/SMS|WhatsApp|anrufen/i)
    expect(RULES.ONE_TIME_SHARE_PCT).toBe(60)
  })
})
