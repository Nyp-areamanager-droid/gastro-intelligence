/**
 * Engine Unit-Tests
 * Importiert direkt aus der produktiven Analyse-Engine.
 * Kein Supabase, kein Netzwerk erforderlich.
 */
import { describe, it, expect } from 'vitest'
import {
  detectColumns,
  normalizePhone,
  normalizeStreetName,
  extractHouseNumber,
  validatePLZ,
  normalizeCity,
  parseAndCleanRows,
  computeRFM,
  computeDashboardKPIs,
} from '@/lib/analysis/engine'

// ─────────────────────────────────────────────────────────────────────────────
// 1. detectColumns — Spaltenerkennung
// ─────────────────────────────────────────────────────────────────────────────

describe('detectColumns', () => {
  it('erkennt deutsche Standardspalten (NYP-typisches Export-Format)', () => {
    const headers = ['Telefon', 'Vorname', 'Nachname', 'Straße', 'PLZ', 'Ort',
                     'Bestellungen', 'Umsatz', 'Durchschnitt', 'Datum', 'Plattform', 'Filiale']
    const map = detectColumns(headers)
    expect(map.phone).toBe('Telefon')
    expect(map.first_name).toBe('Vorname')
    expect(map.last_name).toBe('Nachname')   // Bug-Regression: darf NICHT "Vorname" sein
    expect(map.street).toBe('Straße')
    expect(map.postal_code).toBe('PLZ')
    expect(map.city).toBe('Ort')
    expect(map.total_orders).toBe('Bestellungen')
    expect(map.total_revenue).toBe('Umsatz')
    expect(map.avg_order_value).toBe('Durchschnitt')
    expect(map.last_order_date).toBe('Datum')
    expect(map.platform).toBe('Plattform')
    expect(map.store).toBe('Filiale')
  })

  it('erkennt englische Spaltenbezeichnungen', () => {
    const headers = ['Phone', 'First Name', 'Last Name', 'Street', 'Postal Code',
                     'City', 'Total Orders', 'Revenue', 'Average', 'Last Order Date',
                     'Platform', 'Store']
    const map = detectColumns(headers)
    expect(map.phone).toBe('Phone')
    expect(map.first_name).toBe('First Name')
    expect(map.last_name).toBe('Last Name')
    expect(map.street).toBe('Street')
    expect(map.postal_code).toBe('Postal Code')
    expect(map.city).toBe('City')
    expect(map.total_orders).toBe('Total Orders')
    expect(map.total_revenue).toBe('Revenue')
    expect(map.last_order_date).toBe('Last Order Date')
  })

  it('erkennt Lieferando-typische Spaltennamen', () => {
    const headers = ['Handynummer', 'Vorname', 'Familienname', 'Straße und Hausnummer',
                     'Postleitzahl', 'Stadt', 'Gesamtbestellungen', 'Gesamtbestellwert',
                     'Letztes Bestelldatum', 'Quelle']
    const map = detectColumns(headers)
    expect(map.phone).toBe('Handynummer')
    expect(map.first_name).toBe('Vorname')
    expect(map.last_name).toBe('Familienname')
    expect(map.postal_code).toBe('Postleitzahl')
    expect(map.city).toBe('Stadt')
    expect(map.total_orders).toBe('Gesamtbestellungen')
    expect(map.total_revenue).toBe('Gesamtbestellwert')
    expect(map.last_order_date).toBe('Letztes Bestelldatum')
    expect(map.platform).toBe('Quelle')
  })

  it('vergibt keine Spalte doppelt', () => {
    // "Name" würde ohne usedColumns-Fix sowohl first_name als auch last_name treffen
    const headers = ['Telefon', 'Vorname', 'Nachname', 'PLZ']
    const map = detectColumns(headers)
    const values = Object.values(map)
    const unique = new Set(values)
    expect(values.length).toBe(unique.size)
  })

  it('gibt leeres Objekt zurück für unbekannte Spalten', () => {
    const map = detectColumns(['Spalte1', 'Spalte2', 'Spalte3'])
    expect(Object.keys(map).length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. normalizePhone
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  it('normalisiert deutsche Festnetznummer', () => {
    expect(normalizePhone('0221-1234567')).toBe('+492211234567')
  })
  it('normalisiert Mobilnummer mit Leerzeichen', () => {
    expect(normalizePhone('0177 123 45 67')).toBe('+4917712345 67'.replace(/\s/g, ''))
  })
  it('normalisiert 00-Präfix zu +', () => {
    expect(normalizePhone('004915112345678')).toBe('+4915112345678')
  })
  it('behält + bei bereits normalisierter Nummer', () => {
    expect(normalizePhone('+4917612345678')).toBe('+4917612345678')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. normalizeStreetName
// ─────────────────────────────────────────────────────────────────────────────

describe('normalizeStreetName', () => {
  it('entfernt Hausnummer', () => {
    expect(normalizeStreetName('Neusser Str. 45')).not.toContain('45')
  })
  it('normalisiert "straße" zu "str"', () => {
    const result = normalizeStreetName('Hauptstraße')
    expect(result).toContain('str')
    expect(result).not.toContain('straße')
  })
  it('zwei Schreibweisen derselben Straße ergeben gleichen Key', () => {
    const a = normalizeStreetName('Venloer Straße 85')
    const b = normalizeStreetName('Venloer Str. 85')
    expect(a).toBe(b)
  })
  it('Groß-/Kleinschreibung wird egalisiert', () => {
    const a = normalizeStreetName('HAUPTSTRASSE 1')
    const b = normalizeStreetName('Hauptstraße 1')
    expect(a).toBe(b)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. extractHouseNumber
// ─────────────────────────────────────────────────────────────────────────────

describe('extractHouseNumber', () => {
  it('trennt Straße und Hausnummer', () => {
    const { street, houseNumber } = extractHouseNumber('Neusser Str. 45')
    expect(street).toBe('Neusser Str.')
    expect(houseNumber).toBe('45')
  })
  it('erkennt Buchstabenzusatz (45a)', () => {
    const { houseNumber } = extractHouseNumber('Hauptstraße 12a')
    expect(houseNumber).toBe('12a')
  })
  it('gibt Originalstring zurück wenn keine Hausnummer', () => {
    const { street, houseNumber } = extractHouseNumber('Barbarossaplatz')
    expect(street).toBe('Barbarossaplatz')
    expect(houseNumber).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 5. validatePLZ
// ─────────────────────────────────────────────────────────────────────────────

describe('validatePLZ', () => {
  it('akzeptiert gültige Kölner PLZ', () => {
    expect(validatePLZ('50733')).toBe(true)
    expect(validatePLZ('50667')).toBe(true)
  })
  it('lehnt zu kurze PLZ ab', () => {
    expect(validatePLZ('5073')).toBe(false)
  })
  it('lehnt Buchstaben ab', () => {
    expect(validatePLZ('5073A')).toBe(false)
  })
  it('lehnt leeren String ab', () => {
    expect(validatePLZ('')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 6. parseAndCleanRows — End-to-End Parsing
// ─────────────────────────────────────────────────────────────────────────────

// Hilfsfunktion: Minimale gültige Roh-Zeile
function makeRow(overrides: Record<string, string> = {}) {
  return {
    'Telefon':      '0177-1234567',
    'Vorname':      'Test',
    'Nachname':     'Kunde',
    'Straße':       'Neusser Str. 45',
    'PLZ':          '50733',
    'Ort':          'Köln',
    'Bestellungen': '5',
    'Umsatz':       '74.50',
    'Datum':        '2024-11-01',
    'Plattform':    'Lieferando',
    ...overrides,
  }
}

const STD_HEADERS = ['Telefon','Vorname','Nachname','Straße','PLZ','Ort',
                     'Bestellungen','Umsatz','Datum','Plattform']

describe('parseAndCleanRows', () => {
  it('parst eine gültige Zeile korrekt', () => {
    const colMap = detectColumns(STD_HEADERS)
    const { rows, duplicates, errors } = parseAndCleanRows([makeRow()], colMap)
    expect(rows.length).toBe(1)
    expect(duplicates).toBe(0)
    expect(errors).toBe(0)
    expect(rows[0].postal_code).toBe('50733')
    expect(rows[0].total_orders).toBe(5)
    expect(rows[0].total_revenue).toBe(74.50)
  })

  it('erkennt ungültige PLZ und zählt als Fehler', () => {
    const colMap = detectColumns(STD_HEADERS)
    const { rows, errors } = parseAndCleanRows([makeRow({ 'PLZ': 'ABC' })], colMap)
    expect(rows.length).toBe(0)
    expect(errors).toBe(1)
  })

  it('erkennt Duplikate anhand Telefon + Straße + PLZ', () => {
    const colMap = detectColumns(STD_HEADERS)
    const { rows, duplicates } = parseAndCleanRows([makeRow(), makeRow()], colMap)
    expect(rows.length).toBe(1)
    expect(duplicates).toBe(1)
  })

  it('behandelt fehlende Bestellanzahl als 1', () => {
    const colMap = detectColumns(STD_HEADERS)
    const { rows } = parseAndCleanRows([makeRow({ 'Bestellungen': '' })], colMap)
    expect(rows[0].total_orders).toBe(1)
  })

  it('parst Umsatz mit Komma als Dezimaltrennzeichen', () => {
    const colMap = detectColumns(STD_HEADERS)
    const { rows } = parseAndCleanRows([makeRow({ 'Umsatz': '74,50' })], colMap)
    expect(rows[0].total_revenue).toBe(74.50)
  })

  it('parst 30 Test-Kunden aus test_nyp_kunden.csv-Format', () => {
    const colMap = detectColumns(STD_HEADERS)
    const testRows = Array.from({ length: 30 }, (_, i) => makeRow({
      'Telefon':      `017${i.toString().padStart(8, '0')}`,
      'Straße':       `Teststraße ${i + 1}`,
      'PLZ':          ['50733','50823','50674','50825','50735'][i % 5],
      'Bestellungen': String(Math.floor(Math.random() * 20) + 1),
      'Umsatz':       String((Math.random() * 300 + 20).toFixed(2)),
    }))
    const { rows, errors } = parseAndCleanRows(testRows, colMap)
    expect(errors).toBe(0)
    expect(rows.length).toBe(30)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 7. computeRFM
// ─────────────────────────────────────────────────────────────────────────────

describe('computeRFM', () => {
  // Datumsangaben relativ zu heute (Test läuft zeitunabhängig)
  function daysAgo(n: number): string {
    const d = new Date()
    d.setDate(d.getDate() - n)
    return d.toISOString().split('T')[0]
  }

  function makeCustomer(orders: number, revenue: number, lastOrderDate: string) {
    return {
      _row_index: 1, _errors: [],
      postal_code: '50733',
      total_orders: orders,
      total_revenue: revenue,
      last_order_date: lastOrderDate,
    }
  }

  // Segmentnamen der Engine: 'vip' | 'loyal' | 'potential' | 'at_risk' | 'lost' | 'new'
  it('weist vip-Segment bei sehr hohen Werten zu', () => {
    // rScore >= 4 (letzte Bestellung < 30 Tage), fScore >= 4 (>= 20 Bestellungen), mScore >= 4 (>= 200 €)
    const rows = computeRFM([makeCustomer(25, 500, daysAgo(10))])
    expect(rows[0].rfm_segment).toBe('vip')
  })

  it('weist lost-Segment bei alten, wenigen Bestellungen zu', () => {
    // rScore === 1 (über 180 Tage her)
    const rows = computeRFM([makeCustomer(1, 15, daysAgo(400))])
    expect(rows[0].rfm_segment).toBe('lost')
  })

  it('berechnet RFM-Score als Zahl zwischen 1 und 5', () => {
    const rows = computeRFM([makeCustomer(5, 80, daysAgo(60))])
    expect(rows[0].rfm_score).toBeGreaterThanOrEqual(1)
    expect(rows[0].rfm_score).toBeLessThanOrEqual(5)
  })

  it('setzt rfm_segment bei allen Kunden (echte Engine-Werte)', () => {
    const VALID_SEGMENTS = ['vip', 'loyal', 'potential', 'at_risk', 'lost', 'new']
    const input = [
      makeCustomer(1, 15, daysAgo(400)),
      makeCustomer(5, 80, daysAgo(80)),
      makeCustomer(25, 500, daysAgo(10)),
    ]
    const result = computeRFM(input)
    result.forEach(r => {
      expect(r.rfm_segment).toBeDefined()
      expect(VALID_SEGMENTS).toContain(r.rfm_segment)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 8. computeDashboardKPIs
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDashboardKPIs', () => {
  it('berechnet Gesamtumsatz korrekt', () => {
    const rows = [
      { _row_index: 1, _errors: [], postal_code: '50733', total_orders: 5, total_revenue: 100 },
      { _row_index: 2, _errors: [], postal_code: '50733', total_orders: 3, total_revenue: 60 },
    ]
    const kpis = computeDashboardKPIs(rows)
    expect(kpis.total_revenue).toBe(160)
    expect(kpis.total_customers).toBe(2)
    expect(kpis.total_orders).toBe(8)
  })

  it('gibt 0-Werte zurück bei leerem Input', () => {
    const kpis = computeDashboardKPIs([])
    expect(kpis.total_customers).toBe(0)
    expect(kpis.total_revenue).toBe(0)
  })
})
