// Wiederholte Uploads ohne Doppelzählung, deutschlandweite Daten
import { describe, it, expect } from 'vitest'
import {
  decideImport, fileFingerprint, overlapShare, rowFingerprint, parsePeriodDate, parseImportMode,
  type ExistingUpload,
} from '../src/lib/import/import-guard'
import { mergeCustomers } from '../src/lib/analysis/merge-customers'
import { computeDashboardKPIs, normalizeCity, generateRecommendations, parseAndCleanRows, detectColumns, computeRFM } from '../src/lib/analysis/engine'
import { getPopulation } from '../src/lib/census'
import type { ParsedCustomerRow, StreetAnalysisResult } from '../src/types'

const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer
const up = (p: Partial<ExistingUpload>): ExistingUpload => ({
  id: 'u1', filename: 'oktober.xlsx', created_at: '2026-11-01T10:00:00Z', file_hash: 'aaa',
  period_start: '2026-10-01', period_end: '2026-10-31', ...p,
})

describe('Entscheidung beim Upload', () => {
  it('erster Upload: wird eingelesen', () => {
    expect(decideImport({ mode: 'auto', fileHash: 'x', existing: [], newPeriod: { start: null, end: null } }))
      .toEqual({ ok: true, action: 'first', replaceUploadIds: [] })
  })
  it('dieselbe Datei: abgelehnt, auch beim Ergänzen', () => {
    for (const mode of ['auto', 'append'] as const) {
      const d = decideImport({ mode, fileHash: 'aaa', existing: [up({})], newPeriod: { start: '2026-11-01', end: '2026-11-30' } })
      expect(d.ok).toBe(false)
      if (d.ok === false) {
        expect(d.code).toBe('duplicate_file')
        expect(d.message).toContain('01.11.2026')
        expect(d.message).toContain('nicht noch einmal gezählt')
      }
    }
  })
  it('dieselbe Datei mit „Daten ersetzen“: erlaubt (z. B. nach einer Korrektur neu einlesen)', () => {
    const d = decideImport({ mode: 'replace', fileHash: 'aaa', existing: [up({})], newPeriod: { start: null, end: null } })
    expect(d).toEqual({ ok: true, action: 'replace', replaceUploadIds: ['u1'] })
  })
  it('andere Datei ohne Auswahl: Nutzer muss wählen, nichts wird gespeichert', () => {
    const d = decideImport({ mode: 'auto', fileHash: 'bbb', existing: [up({})], newPeriod: { start: '2026-11-01', end: null } })
    expect(d.ok === false && d.code).toBe('choose_mode')
  })
  it('Ergänzen: Zeitraum danach → erlaubt', () => {
    const d = decideImport({ mode: 'append', fileHash: 'bbb', existing: [up({}), up({ id: 'u0', period_end: '2026-09-30' })], newPeriod: { start: '2026-11-01', end: '2026-11-30' } })
    expect(d).toEqual({ ok: true, action: 'append', replaceUploadIds: [] })
  })
  it('Ergänzen: Zeitraum überschneidet sich → abgelehnt', () => {
    const d = decideImport({ mode: 'append', fileHash: 'bbb', existing: [up({})], newPeriod: { start: '2026-10-15', end: '2026-11-30' } })
    expect(d.ok === false && d.code).toBe('append_overlap')
    if (d.ok === false) expect(d.message).toContain('31.10.2026')
  })
  it('Ergänzen: Zeitraum bisher oder neu unbekannt → abgelehnt', () => {
    expect((decideImport({ mode: 'append', fileHash: 'b', existing: [up({ period_end: null })], newPeriod: { start: '2026-11-01', end: null } }) as { code?: string }).code).toBe('append_period_unknown')
    expect((decideImport({ mode: 'append', fileHash: 'b', existing: [up({})], newPeriod: { start: null, end: null } }) as { code?: string }).code).toBe('append_period_unknown')
  })
  it('Zeitraum rückwärts → abgelehnt', () => {
    expect((decideImport({ mode: 'append', fileHash: 'b', existing: [], newPeriod: { start: '2026-11-30', end: '2026-11-01' } }) as { code?: string }).code).toBe('invalid_period')
  })
  it('Ersetzen nimmt alle bisherigen Uploads', () => {
    const d = decideImport({ mode: 'replace', fileHash: 'c', existing: [up({ id: 'a' }), up({ id: 'b', file_hash: null })], newPeriod: { start: null, end: null } })
    expect(d.ok && d.replaceUploadIds).toEqual(['a', 'b'])
  })
  it('Prüfsumme hängt nur vom Inhalt ab', () => {
    expect(fileFingerprint(enc('PLZ;Umsatz\n50733;10'))).toBe(fileFingerprint(enc('PLZ;Umsatz\n50733;10')))
    expect(fileFingerprint(enc('PLZ;Umsatz\n50733;10'))).not.toBe(fileFingerprint(enc('PLZ;Umsatz\n50733;11')))
  })
  it('Eingaben werden streng geprüft', () => {
    expect(parsePeriodDate('2026-02-30')).toBeNull()
    expect(parsePeriodDate('01.11.2026')).toBeNull()
    expect(parsePeriodDate('2026-11-01')).toBe('2026-11-01')
    expect(parseImportMode('drop table')).toBe('auto')
  })
})

describe('Dieselben Daten als andere Datei (CSV statt Excel)', () => {
  const file = 'PLZ;Straße;Telefon;Bestellungen;Umsatz\n50733;Neusser Str. 5;0221 1234;3;45,50\n50733;Neusser Str. 7;0221 999;1;12,00\n01067;Prager Str. 1;0351 77;2;30'
  it('gleiche Zeilen werden erkannt, egal ob Excel oder CSV', () => {
    const raw = file.split('\n').slice(1).map(l => { const [a, b, c, d, e] = l.split(';'); return { PLZ: a, 'Straße': b, Telefon: c, Bestellungen: d, Umsatz: e } })
    const map = detectColumns(['PLZ', 'Straße', 'Telefon', 'Bestellungen', 'Umsatz'])
    const csvRows = parseAndCleanRows(raw, map).rows
    // Excel liefert Zahlen statt Text
    const xlsxRows = parseAndCleanRows(raw.map(r => ({ ...r, Bestellungen: Number(r.Bestellungen), Umsatz: Number(r.Umsatz.replace(',', '.')) })), map).rows
    expect(overlapShare(xlsxRows.map(rowFingerprint), csvRows.map(rowFingerprint))).toBe(1)
  })
  it('neuer Monat mit anderen Zahlen: kaum Übereinstimmung', () => {
    const a = [{ postal_code: '50733', street_normalized: 'neusser straße', phone_normalized: '+492211234', total_orders: 3, total_revenue: 45.5 }]
    const b = [{ postal_code: '50733', street_normalized: 'neusser straße', phone_normalized: '+492211234', total_orders: 2, total_revenue: 28 }]
    expect(overlapShare(b.map(rowFingerprint), a.map(rowFingerprint))).toBe(0)
  })
})

describe('Zwei Zeiträume: Bestellungen addiert, Personen einmal gezählt', () => {
  const r = (p: Partial<ParsedCustomerRow>): ParsedCustomerRow =>
    ({ postal_code: '50733', total_orders: 1, total_revenue: 10, late_deliveries: 0, _row_index: 0, _errors: [], ...p } as ParsedCustomerRow)
  const oktober = [
    r({ phone_normalized: '+491', total_orders: 3, total_revenue: 60, last_order_date: '2026-10-20' }),
    r({ phone_normalized: '+492', total_orders: 1, total_revenue: 25, last_order_date: '2026-10-05' }),
    r({ full_name: 'Eva Berg', street_normalized: 'ring', house_number: '4', total_orders: 2, total_revenue: 40 }),
    r({ total_orders: 1, total_revenue: 15 }),                // ohne Telefon und Name
  ]
  const november = [
    r({ phone_normalized: '+491', total_orders: 2, total_revenue: 35, last_order_date: '2026-11-12' }),
    r({ full_name: 'eva berg', street_normalized: 'Ring', house_number: '4', total_orders: 1, total_revenue: 20 }),
    r({ phone_normalized: '+493', total_orders: 1, total_revenue: 30, last_order_date: '2026-11-02' }),
    r({ total_orders: 1, total_revenue: 15 }),                // ohne Telefon und Name: nicht zusammenfassen
  ]
  const merged = mergeCustomers([...oktober, ...november], new Date('2026-11-15'))
  const k = computeDashboardKPIs(merged)
  it('Gegenrechnung', () => {
    // Bestellungen 3+1+2+1 + 2+1+1+1 = 12, Umsatz 60+25+40+15 + 35+20+30+15 = 240
    expect(k.total_orders).toBe(12)
    expect(k.total_revenue).toBe(240)
    expect(k.avg_order_value).toBe(20)
    // Personen: +491, +492, Eva Berg, +493, 2× ohne Kennung = 6
    expect(k.total_customers).toBe(6)
  })
  it('zusammengefasster Kunde hat beide Zeiträume', () => {
    const p1 = merged.find(m => m.phone_normalized === '+491')!
    expect(p1.total_orders).toBe(5)
    expect(p1.total_revenue).toBe(95)
    expect(p1.last_order_date).toBe('2026-11-12')
    expect(p1.rfm_segment).toBeDefined()
  })
  it('voraggregierte Zeilen werden nie zusammengefasst', () => {
    const agg = [r({ street_normalized: 'ring', full_name: 'X', _is_aggregated: true }), r({ street_normalized: 'ring', full_name: 'X', _is_aggregated: true })]
    expect(mergeCustomers(agg).length).toBe(2)
  })
  it('ohne Zusammenfassung wären es 8 Kunden – genau der Doppelzählfehler', () => {
    expect(computeDashboardKPIs(computeRFM([...oktober, ...november])).total_customers).toBe(8)
  })
})

describe('Deutschlandweit', () => {
  it.each([
    ['KÖLN', 'Köln'], ['cologne', 'Köln'], ['Frankfurt (Oder)', 'Frankfurt (Oder)'],
    ['FRANKFURT (ODER)', 'Frankfurt (Oder)'], ['frankfurt am main', 'Frankfurt am Main'],
    ['neukölln', 'Neukölln'], ['halle (saale)', 'Halle (Saale)'], ['mülheim an der ruhr', 'Mülheim an der Ruhr'],
    ['GARMISCH-PARTENKIRCHEN', 'Garmisch-Partenkirchen'], ['St. Ingbert', 'St. Ingbert'], ['münchen', 'München'],
  ])('Ortsname %s → %s', (input, expected) => {
    expect(normalizeCity(input)).toBe(expected)
  })
  it('keine erfundene Einwohnerzahl für unbekannte PLZ', () => {
    expect(getPopulation('01067')).toBeNull()   // Dresden: nicht hinterlegt
    expect(getPopulation('80331')).toBeNull()   // München: nicht hinterlegt
    expect(getPopulation('99999')).toBeNull()
  })
})

describe('Flyer für Straßen ohne Bestellung', () => {
  const s = (p: Partial<StreetAnalysisResult>): StreetAnalysisResult => ({
    street_name: 'X', postal_code: '01067', customer_count: 0, order_count: 0, revenue: 0, avg_order_value: 0,
    orders_per_customer: 0, street_class: 'E', is_in_official_list: true, recommendation: '', ...p,
  })
  const k = computeDashboardKPIs([{ postal_code: '01067', total_orders: 2, total_revenue: 40, _row_index: 0, _errors: [] } as ParsedCustomerRow])
  it('nur Straßen mit 0 Bestellungen aus vollständigem Verzeichnis', () => {
    const recs = generateRecommendations(k, [], [
      s({ street_name: 'Leerweg' }),
      s({ street_name: 'Einmalgasse', order_count: 1, customer_count: 1 }),  // Klasse E, aber 1 Bestellung
      s({ street_name: 'Unbekannt', is_in_official_list: null }),          // Verzeichnis unvollständig
    ])
    const flyer = recs.find(r => r.title.includes('ohne Bestellung'))!
    expect(flyer.description).toBe('Leerweg')
  })
})
