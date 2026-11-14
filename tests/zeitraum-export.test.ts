// Zeitraumfilter der Übersicht und CSV-Ausgabe
import { describe, it, expect } from 'vitest'
import { filterByRange, buildOverview, type OverviewCustomerRow, type OverviewUpload } from '../src/lib/insights/overview'
import { csvCell, toCsv } from '../src/lib/export/csv'

const ORDER_MAP = { postal_code: 'PLZ', last_order_date: 'Datum', total_revenue: 'Umsatz' }
const up = (id: string, start: string, end: string, mapping: Record<string, string> = ORDER_MAP): OverviewUpload => ({ id, filename: id + '.csv', period_start: start, period_end: end, created_at: start, column_mapping: mapping } as OverviewUpload)
const row = (upload_id: string, date: string | null, revenue = 10, orders = 1, ref = 'K1'): OverviewCustomerRow => ({ upload_id, customer_ref: ref, phone_normalized: null, postal_code: '50733', street: 'Neusser Straße', street_normalized: 'neusser strasse', total_orders: orders, total_revenue: revenue, last_order_date: date, platform: null } as OverviewCustomerRow)

describe('filterByRange', () => {
  const uploads = [up('a', '2026-07-01', '2026-08-31'), up('b', '2026-09-01', '2026-10-31')]
  const rows = [row('a', '2026-07-01'), row('a', '2026-08-31', 20), row('b', '2026-09-01', 30), row('b', '2026-10-31', 40)]

  it('ohne Angabe: nichts gefiltert', () => {
    const f = filterByRange(rows, uploads, null, null)
    expect(f.applied).toBe(false); expect(f.reason).toBeNull(); expect(f.customers).toHaveLength(4)
  })
  it('Grenzen zählen mit, Zeiträume der Importe werden zugeschnitten', () => {
    const f = filterByRange(rows, uploads, '2026-08-31', '2026-09-01')
    expect(f.applied).toBe(true)
    expect(f.customers.map(r => r.total_revenue)).toEqual([20, 30])
    expect(f.uploads.map(u => [u.period_start, u.period_end])).toEqual([['2026-08-31', '2026-08-31'], ['2026-09-01', '2026-09-01']])
  })
  it('Import außerhalb des Zeitraums fällt weg; Tage stimmen danach', () => {
    const f = filterByRange(rows, uploads, '2026-09-01', '2026-09-30')
    expect(f.uploads).toHaveLength(1)
    const o = buildOverview({ customers: f.customers, uploads: f.uploads, postalCodes: [], directories: [], streetRows: [] })
    expect(o.coverage.days).toBe(30)
    expect(o.totals.orders).toBe(1); expect(o.totals.revenue).toBe(30)
  })
  it('Summen je Kunde (keine Einzelbestellungen): kein Filter, mit Begründung, alle Daten bleiben', () => {
    const agg = [up('a', '2026-07-01', '2026-08-31', { postal_code: 'PLZ', total_orders: 'Bestellungen', last_order_date: 'Datum' })]
    const f = filterByRange([row('a', '2026-08-01', 100, 5)], agg, '2026-08-01', '2026-08-31')
    expect(f.applied).toBe(false); expect(f.reason).toMatch(/eine Zeile je Bestellung/); expect(f.customers).toHaveLength(1)
  })
  it('eine Zeile ohne Datum: kein Filter', () => {
    expect(filterByRange([...rows, row('b', null)], uploads, '2026-09-01', '2026-09-30').applied).toBe(false)
  })
  it('ungültiger Zeitraum: kein Filter', () => {
    expect(filterByRange(rows, uploads, '2026-10-01', '2026-09-01').applied).toBe(false)
    expect(filterByRange(rows, uploads, 'gestern', null).applied).toBe(false)
  })
  it('Summe der Monate = Gesamtsumme (nichts geht verloren, nichts doppelt)', () => {
    const months = [['2026-07-01', '2026-07-31'], ['2026-08-01', '2026-08-31'], ['2026-09-01', '2026-09-30'], ['2026-10-01', '2026-10-31']]
    const sum = months.reduce((s, [a, b]) => s + filterByRange(rows, uploads, a, b).customers.reduce((x, r) => x + Number(r.total_revenue), 0), 0)
    expect(sum).toBe(100)
  })
})

describe('CSV', () => {
  it('Zahlen mit Komma, Texte mit Semikolon in Anführungszeichen', () => {
    expect(csvCell(12.5)).toBe('12,5'); expect(csvCell(null)).toBe(''); expect(csvCell('a;b')).toBe('"a;b"'); expect(csvCell('Sagte "ja"')).toBe('"Sagte ""ja"""')
  })
  it.each(['=1+1', '+49 221', '-5', '@SUM(A1)', '\t=1'])('Formelbeginn wird entschärft: %s', v => {
    expect(csvCell(v).replace(/^"/, '').startsWith("'")).toBe(true)
  })
  it('BOM, Kopfzeile, Windows-Zeilenenden', () => {
    expect(toCsv(['PLZ', 'Umsatz'], [['50733', 10.25]])).toBe('﻿PLZ;Umsatz\r\n50733;10,25\r\n')
  })
})
