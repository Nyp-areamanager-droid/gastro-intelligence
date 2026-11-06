import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { parseLocaleNumber, detectColumns, parseAndCleanRows, computeDashboardKPIs } from '../src/lib/analysis/engine'
import { readWorkbook } from '../src/lib/import/read-table'

describe('parseLocaleNumber', () => {
  it.each([
    ['143,91', 143.91], ['1.234,56', 1234.56], ['1,234.56', 1234.56], ['12 €', 12], ['12,50 €', 12.5],
    ['€ 7,9', 7.9], ['1.234.567', 1234567], ['99.90', 99.9], ['-3,5', -3.5], ['0', 0], [42, 42], ['12 EUR', 12],
  ])('%s → %s', (raw, want) => expect(parseLocaleNumber(raw)).toBe(want))
  it.each([[''], ['abc'], ['12,3x'], [null], [undefined]])('%s → NaN', raw => expect(parseLocaleNumber(raw)).toBeNaN())
})

function importCsv(text: string) {
  const buf = new TextEncoder().encode(text).buffer
  const wb = readWorkbook(buf, 'kunden.csv', 'text/csv')
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
  return parseAndCleanRows(rows, detectColumns(Object.keys(rows[0]))).rows
}

describe('CSV-Import mit deutschen Zahlen', () => {
  it('liest Umsatz mit Dezimalkomma richtig (nicht hundertfach)', () => {
    const r = importCsv('PLZ;Straße;Bestellungen;Umsatz\n50733;Neusser Straße;5;143,91\n')
    expect(r[0].total_revenue).toBe(143.91)
    expect(r[0].total_orders).toBe(5)
  })
  it('liest Tausenderpunkt und Euro-Zeichen', () => {
    const r = importCsv('PLZ;Straße;Umsatz\n50733;Neusser Straße;1.234,56 €\n')
    expect(r[0].total_revenue).toBe(1234.56)
  })
  it('behält führende Null der PLZ', () => {
    const r = importCsv('PLZ;Straße;Umsatz\n01067;Prager Straße;10,00\n')
    expect(r[0].postal_code).toBe('01067')
  })
  it('liest deutsches Datum als Text', () => {
    const r = importCsv('PLZ;Straße;Umsatz;Letztes Bestelldatum\n50733;Neusser Straße;10,00;13.09.2026\n')
    expect(r[0].last_order_date).toBe('2026-09-13')
  })
  it('liest englisches Format ebenso', () => {
    const r = importCsv('zip,street,revenue\n50733,Neusser Straße,143.91\n')
    expect(r[0].total_revenue).toBe(143.91)
  })
})

function importXlsx(aoa: unknown[][]) {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
  const wb0 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb0, ws, 'Kunden')
  const buf = XLSX.write(wb0, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const wb = readWorkbook(buf, 'kunden.xlsx', '')
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
  return parseAndCleanRows(rows, detectColumns(Object.keys(rows[0])))
}

describe('Excel-Import (.xlsx)', () => {
  const H = ['PLZ', 'Straße', 'Bestellungen', 'Umsatz', 'Letztes Bestelldatum']
  it('Zahlenzellen, Text mit Komma und Euro werden richtig gelesen', () => {
    const r = importXlsx([H, [50733, 'Neusser Straße', 5, 143.91, '13.09.2026'], [50733, 'Florastraße', 2, '1.234,56', ''], [50733, 'Am Hof', 3, '12,50 €', '']]).rows
    expect(r.map(x => x.total_revenue)).toEqual([143.91, 1234.56, 12.5])
    expect(r.map(x => x.total_orders)).toEqual([5, 2, 3])
  })
  it('Datumszelle geht nicht verloren', () => {
    const r = importXlsx([H, [50733, 'Neusser Straße', 1, 10, new Date(Date.UTC(2026, 8, 13))]]).rows
    expect(r[0].last_order_date).toBe('2026-09-13')
  })
  it('Datum als Seriennummer und als Text', () => {
    const r = importXlsx([H, [50733, 'A-Weg', 1, 10, 46278], [50733, 'B-Weg', 1, 10, '13.09.2026']]).rows
    expect(r.map(x => x.last_order_date)).toEqual(['2026-09-13', '2026-09-13'])
  })
  it('PLZ als Zahl 1067 wird zu 01067, nicht verworfen', () => {
    const res = importXlsx([H, [1067, 'Prager Straße', 2, 20, '']])
    expect(res.errors).toBe(0)
    expect(res.rows[0].postal_code).toBe('01067')
  })
  it('PLZ mit 3 Stellen bleibt ungültig', () => {
    expect(importXlsx([H, [507, 'X-Weg', 1, 1, '']]).errors).toBe(1)
  })
})

describe('Auswertung stimmt mit unabhängiger Gegenrechnung', () => {
  it('Summe Umsatz, Bestellungen und Durchschnittsbon über 300 Zeilen', () => {
    let csv = 'PLZ;Straße;Bestellungen;Umsatz\n'
    let sumRev = 0, sumOrd = 0
    for (let i = 0; i < 300; i++) {
      const ord = (i % 17) + 1
      const cents = 1000 + ((i * 7919) % 90000)          // 10,00 € bis 909,99 €
      const big = i % 50 === 0 ? 100000 : 0               // jede 50. Zeile mit Tausenderpunkt
      const val = cents + big
      const euro = Math.floor(val / 100), ct = String(val % 100).padStart(2, '0')
      const txt = euro >= 1000 ? `${Math.floor(euro / 1000)}.${String(euro % 1000).padStart(3, '0')},${ct}` : `${euro},${ct}`
      csv += `50733;Weg ${i};${ord};${txt}\n`
      sumRev += val; sumOrd += ord
    }
    const rows = importCsv(csv)
    const k = computeDashboardKPIs(rows)
    expect(rows.length).toBe(300)
    expect(Math.round(k.total_revenue * 100)).toBe(sumRev)
    expect(k.total_orders).toBe(sumOrd)
    expect(k.avg_order_value).toBe(Math.round(sumRev / sumOrd) / 100)
  })
})
