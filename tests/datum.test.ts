// Datum aus Importdateien. Hintergrund: Im fertig gebauten Programm (nicht in
// den Tests) las die alte Fassung „01.07.2026“ als 7. Januar bzw. 6. Januar –
// gefunden im Browsertest gegen den Produktions-Build am 13.11.2026.
import { describe, it, expect } from 'vitest'
import { parseDateString, parseAndCleanRows } from '../src/lib/analysis/engine'

describe('parseDateString', () => {
  it.each([
    ['01.07.2026', '2026-07-01'], ['31.10.2026', '2026-10-31'], ['1.7.2026', '2026-07-01'], ['01.07.26', '2026-07-01'],
    ['12.11.2026', '2026-11-12'], ['11.12.2026', '2026-12-11'],          // Tag und Monat beide ≤ 12: nicht vertauschen
    ['2026-07-01', '2026-07-01'], ['2026-07-01T18:45:00', '2026-07-01'], ['2026-07-01 18:45', '2026-07-01'], ['2026-07-01T23:30:00+02:00', '2026-07-01'],
    ['01.07.2026 18:45', '2026-07-01'], ['01.07.2026 18:45:10', '2026-07-01'],
    ['07/01/2026', '2026-07-01'], ['12/31/2026', '2026-12-31'],
    ['29.02.2028', '2028-02-29'],
    ['46204', '2026-07-01'], ['46204.75', '2026-07-01'],                 // Excel-Seriennummer, auch mit Uhrzeit
  ])('%s → %s', (raw, iso) => expect(parseDateString(raw)).toBe(iso))

  it.each(['', '   ', 'gestern', '31.02.2026', '29.02.2026', '00.07.2026', '01.13.2026', '32.01.2026', '13/40/2026', '2026-13-01', '12345', '99999', '01.07.1850', 'Juli 2026', '1.7.'])('„%s“ ist kein Datum', raw => expect(parseDateString(raw)).toBeUndefined())

  it('Ergebnis hängt nicht von der Zeitzone des Servers ab', () => {
    const old = process.env.TZ
    for (const tz of ['UTC', 'Europe/Berlin', 'America/Los_Angeles', 'Pacific/Auckland']) {
      process.env.TZ = tz
      expect(parseDateString('01.07.2026'), tz).toBe('2026-07-01')
      expect(parseDateString('46204'), tz).toBe('2026-07-01')
    }
    process.env.TZ = old
  })
})

describe('Import: unlesbares Datum wird gemeldet, nicht verschwiegen', () => {
  it('Zeile bleibt, Datum fehlt, Problem steht im Bericht', () => {
    const r = parseAndCleanRows([{ PLZ: '50733', Umsatz: '10,00', Datum: '31.02.2026' }, { PLZ: '50733', Umsatz: '12,00', Datum: '01.03.2026' }], { postal_code: 'PLZ', total_revenue: 'Umsatz', last_order_date: 'Datum' })
    expect(r.rows).toHaveLength(2)
    expect(r.rows[0].last_order_date).toBeUndefined(); expect(r.rows[1].last_order_date).toBe('2026-03-01')
    expect(r.invalid_dates).toBe(1)
    expect(r.problems.some(p => p.row === 2 && /Datum/.test(p.reason))).toBe(true)
  })
})
