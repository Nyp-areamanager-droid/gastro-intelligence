// Datenminimierung beim Import und Bremse gegen Missbrauch
import { describe, it, expect, beforeEach } from 'vitest'
import { pseudonymizePhone, minimizeRow, isPhonePseudonym } from '../src/lib/privacy/pseudonym'
import { detectColumns, parseAndCleanRows } from '../src/lib/analysis/engine'
import { mergeCustomers } from '../src/lib/analysis/merge-customers'
import { rateLimit, resetRateLimits } from '../src/lib/security/rate-limit'
import type { ParsedCustomerRow } from '../src/types'

const A = '10000000-0000-0000-0000-00000000000a', B = '10000000-0000-0000-0000-00000000000b'

describe('Telefonnummer → Kennzeichen', () => {
  it('gleiche Nummer, gleiche Firma → gleiches Kennzeichen; andere Firma → anderes', () => {
    const a1 = pseudonymizePhone(A, '+4922112345'), a2 = pseudonymizePhone(A, '+4922112345'), b = pseudonymizePhone(B, '+4922112345')
    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(a1).toMatch(/^p1:[0-9a-f]{64}$/)
    expect(a1).not.toContain('22112345')
  })
  it('Rechenweg wie in Migration 007: SHA-256 über „Firmen-ID:Nummer“', async () => {
    const { createHash } = await import('crypto')
    expect(pseudonymizePhone(A, '+4922112345')).toBe('p1:' + createHash('sha256').update(`${A}:+4922112345`, 'utf8').digest('hex'))
  })
  it('ein Kennzeichen wird nicht noch einmal umgerechnet; leer bleibt leer', () => {
    const p = pseudonymizePhone(A, '+491')!
    expect(pseudonymizePhone(A, p)).toBe(p)
    expect(isPhonePseudonym(p)).toBe(true)
    expect(pseudonymizePhone(A, undefined)).toBeUndefined()
    expect(pseudonymizePhone(A, '')).toBeUndefined()
  })
})

describe('Import übernimmt keine Namen, E-Mails oder Telefonnummern im Klartext', () => {
  const headers = ['Telefon', 'Vorname', 'Nachname', 'E-Mail', 'Straße', 'PLZ', 'Bestellungen', 'Umsatz']
  const raw = [
    { Telefon: '0221 1000000', Vorname: 'Nina', Nachname: 'Weiß', 'E-Mail': 'nina@example.org', Straße: 'Aachener Straße 10', PLZ: '50859', Bestellungen: 5, Umsatz: '143,91' },
    { Telefon: '0221 1000000', Vorname: 'Nina', Nachname: 'Weiß', 'E-Mail': 'nina@example.org', Straße: 'Aachener Straße 10', PLZ: '50859', Bestellungen: 2, Umsatz: '40,00' },
    { Telefon: '0221 1000001', Vorname: 'Yusuf', Nachname: 'Kaya', 'E-Mail': '', Straße: 'Hohe Straße 12', PLZ: '50667', Bestellungen: 2, Umsatz: '43,61' },
  ]
  const mapping = detectColumns(headers)
  const { rows } = parseAndCleanRows(raw, mapping)
  const stored = rows.map(r => minimizeRow(A, r))

  it('E-Mail-Spalte wird erkannt und landet in keinem anderen Feld', () => {
    expect(mapping.email).toBe('E-Mail')
    expect(Object.values(mapping).filter(v => v === 'E-Mail')).toHaveLength(1)
  })
  it('gespeicherte Zeilen enthalten nichts davon', () => {
    const text = JSON.stringify(stored)
    for (const secret of ['Nina', 'Weiß', 'Yusuf', 'Kaya', 'example.org', '1000000', '1000001', '0221']) expect(text).not.toContain(secret)
    for (const r of stored) {
      expect(r.phone_raw).toBeUndefined(); expect(r.first_name).toBeUndefined(); expect(r.last_name).toBeUndefined(); expect(r.full_name).toBeUndefined()
      expect(isPhonePseudonym(r.phone_normalized)).toBe(true)
    }
  })
  it('Kunden werden trotzdem richtig gezählt: 2 Personen, 9 Bestellungen, 227,52 €', () => {
    const merged = mergeCustomers(stored as ParsedCustomerRow[])
    expect(merged).toHaveLength(2)
    expect(merged.reduce((s, r) => s + r.total_orders, 0)).toBe(9)
    expect(Math.round(merged.reduce((s, r) => s + r.total_revenue, 0) * 100) / 100).toBe(227.52)
  })
})

describe('Bremse gegen Missbrauch', () => {
  beforeEach(() => resetRateLimits())
  it('lässt bis zur Grenze durch, danach nicht mehr; nach Ablauf wieder', () => {
    for (let i = 0; i < 3; i++) expect(rateLimit('k', 3, 1000, 0).ok).toBe(true)
    const blocked = rateLimit('k', 3, 1000, 500)
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterSeconds).toBe(1)
    expect(rateLimit('k', 3, 1000, 1001).ok).toBe(true)
  })
  it('zählt je Nutzer getrennt', () => {
    expect(rateLimit('a', 1, 1000, 0).ok).toBe(true)
    expect(rateLimit('a', 1, 1000, 1).ok).toBe(false)
    expect(rateLimit('b', 1, 1000, 1).ok).toBe(true)
  })
})
