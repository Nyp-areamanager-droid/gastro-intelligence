// Kennzahlen, Warnungen, Empfehlungen und Spaltenerkennung – mit Gegenrechnung
import { describe, it, expect } from 'vitest'
import { computeDashboardKPIs, generateAlerts, generateRecommendations, detectColumns, parseAndCleanRows } from '../src/lib/analysis/engine'
import type { ParsedCustomerRow } from '../src/types'

function row(p: Partial<ParsedCustomerRow>): ParsedCustomerRow {
  return { postal_code: '50733', street: 'Neusser Straße', total_orders: 1, total_revenue: 20, late_deliveries: 0,
    _row_index: 0, _errors: [], ...p } as ParsedCustomerRow
}

describe('Einmalkäufer-Warnung', () => {
  it('80 % Einmalkäufer → kritische Warnung mit 80,0 %', () => {
    const rows = [...Array(80)].map(() => row({ total_orders: 1 })).concat([...Array(20)].map(() => row({ total_orders: 5 })))
    const k = computeDashboardKPIs(rows)
    expect(k.repeat_rate_pct).toBe(20)
    const a = generateAlerts(k).find(x => x.category === 'customers')!
    expect(a.severity).toBe('critical')
    expect(a.message).toContain('80.0%')
  })
  it('65 % Einmalkäufer → Warnung, 50 % → keine', () => {
    const mk = (one: number) => computeDashboardKPIs([...Array(one)].map(() => row({ total_orders: 1 })).concat([...Array(100 - one)].map(() => row({ total_orders: 3 }))))
    expect(generateAlerts(mk(65)).find(x => x.category === 'customers')?.severity).toBe('warning')
    expect(generateAlerts(mk(50)).find(x => x.category === 'customers')).toBeUndefined()
  })
})

describe('Empfehlungen und ROI', () => {
  const rows = [...Array(70)].map(() => row({ total_orders: 1, total_revenue: 25 })).concat([...Array(30)].map(() => row({ total_orders: 4, total_revenue: 100 })))
  const k = computeDashboardKPIs(rows)
  const recs = generateRecommendations(k, [], [])
  it('kein ROI „unendlich“: Maßnahmen ohne Kosten haben roi null', () => {
    for (const r of recs) {
      if (r.estimated_cost === 0) expect(r.roi).toBeNull()
      else expect(r.roi).toBeCloseTo(r.estimated_potential / r.estimated_cost, 1)
    }
    expect(recs.some(r => r.roi === 99)).toBe(false)
  })
  it('SMS-Reaktivierung nennt die echte Zahl der Einmalkäufer (70), keine Schätzung', () => {
    const sms = recs.find(r => r.action_type === 'sms')!
    expect(sms.description).toContain('70 Einmalkäufer')
  })
  it('keine „undefined Einwohner“, wenn die Einwohnerzahl fehlt', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plz: any = { postal_code: '50733', city: 'Köln', market_penetration_pct: 0.5, not_reached_residents: null, streets_without_orders: null, population: null }
    const flyer = generateRecommendations(k, [plz], []).find(r => r.action_type === 'flyer')!
    expect(flyer.description).not.toContain('undefined')
    expect(flyer.description).not.toContain('null')
    expect(flyer.description).not.toContain('0 Straßen ohne Bestellung')
  })
})

describe('Spaltenerkennung: genauestes Stichwort gewinnt', () => {
  it.each([
    [['Standort', 'PLZ', 'Umsatz'], { store: 'Standort' }],
    [['PLZ', 'Kundenanzahl', 'Umsatz'], { customer_count: 'Kundenanzahl' }],
    [['PLZ', 'Durchschnittlicher Bestellwert', 'Gesamtumsatz'], { avg_order_value: 'Durchschnittlicher Bestellwert', total_revenue: 'Gesamtumsatz' }],
    [['PLZ', 'Ø Bestellwert', 'Umsatz'], { avg_order_value: 'Ø Bestellwert', total_revenue: 'Umsatz' }],
    [['Kundennummer', 'PLZ', 'Umsatz'], { total_revenue: 'Umsatz' }],
    [['Postleitzahl', 'Ort', 'Anzahl Bestellungen', 'Letzte Bestellung'], { city: 'Ort', total_orders: 'Anzahl Bestellungen', last_order_date: 'Letzte Bestellung' }],
  ])('%j', (headers, expected) => {
    const m = detectColumns(headers as string[])
    for (const [f, h] of Object.entries(expected)) expect(m[f]).toBe(h)
    expect(m['city'] === 'Standort').toBe(false)
    expect(m['customer_count'] === 'Kundennummer').toBe(false)
    expect(m['_ignore']).toBeUndefined()
  })
})

describe('Unlesbare Werte werden gemeldet', () => {
  it('Umsatz „abc“ zählt als 0 €, wird aber als unlesbar gezählt', () => {
    const map = detectColumns(['PLZ', 'Straße', 'Umsatz', 'Bestellungen'])
    const r = parseAndCleanRows([
      { PLZ: '50733', 'Straße': 'A-Weg', Umsatz: 'abc', Bestellungen: '2' },
      { PLZ: '50733', 'Straße': 'B-Weg', Umsatz: '10,50', Bestellungen: 'zwei' },
      { PLZ: '50733', 'Straße': 'C-Weg', Umsatz: '', Bestellungen: '' },
      { PLZ: '50733', 'Straße': 'D-Weg', Umsatz: '5', Bestellungen: '1' },
    ], map)
    expect(r.rows.length).toBe(4)
    expect(r.invalid_values).toBe(2)
    expect(r.rows[0].total_revenue).toBe(0)
  })
})
