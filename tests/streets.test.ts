// =============================================================================
// Straßenanalyse – Sofortkorrektur
// Paging OpenPLZ, Vollständigkeit, Normalisierung, Straßen ohne Bestellungen,
// doppelte Straßennamen, 1.000-Zeilen-Grenze von Supabase.
// Läuft ohne Netz und ohne Datenbank (fetch und Supabase sind Attrappen).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { normalizeStreetName, stripHouseNumber, isSameStreet } from '@/lib/geo/street-name'
import {
  fetchStreetDirectory, getStreetDirectory, clearStreetDirectoryCache,
  mergeDirectoryEntries, OPENPLZ_MAX_PAGE_SIZE,
} from '@/lib/geo/street-directory'
import { analyzeStreets, analyzePLZ, NO_STREET_DIRECTORY } from '@/lib/analysis/engine'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { ParsedCustomerRow } from '@/types'

// ── Hilfen ───────────────────────────────────────────────────────────────────

type Street = { name: string; postalCode: string; locality: string }

function streetsFor(plz: string, n: number, locality = 'Köln'): Street[] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Teststraße ${String.fromCharCode(65 + Math.floor(i / 26) % 26)}${String.fromCharCode(65 + i % 26)}${i >= 676 ? i : ''}`,
    postalCode: plz,
    locality,
  }))
}

/**
 * Ahmt OpenPLZ nach: pageSize max. 50 (sonst 400), Header x-total-count,
 * optional Fehler auf einer bestimmten Seite.
 */
function fakeOpenPLZ(all: Street[], opts: {
  failOnPage?: number
  failStatus?: number
  throwOnPage?: number
  omitTotalHeader?: boolean
  reportTotal?: number
} = {}) {
  const calls: string[] = []
  const impl = vi.fn(async (url: string) => {
    calls.push(url)
    const u = new URL(url)
    const page = Number(u.searchParams.get('page'))
    const pageSize = Number(u.searchParams.get('pageSize'))
    if (opts.throwOnPage === page) throw new Error('ECONNRESET')
    if (pageSize < 1 || pageSize > 50) {
      return new Response(JSON.stringify({ title: 'One or more validation errors occurred.' }), { status: 400 })
    }
    if (opts.failOnPage === page) return new Response('fail', { status: opts.failStatus ?? 500 })
    const slice = all.slice((page - 1) * pageSize, page * pageSize)
    const headers = new Headers({ 'content-type': 'application/json' })
    if (!opts.omitTotalHeader) headers.set('x-total-count', String(opts.reportTotal ?? all.length))
    return new Response(JSON.stringify(slice), { status: 200, headers })
  })
  return { impl, calls }
}

function row(street: string, orders: number, plz = '50733', extra: Partial<ParsedCustomerRow> = {}): ParsedCustomerRow {
  return {
    postal_code: plz, street, total_orders: orders, total_revenue: orders * 20,
    _row_index: 0, _errors: [], ...extra,
  } as ParsedCustomerRow
}

// ── 1. Normalisierung ────────────────────────────────────────────────────────

describe('normalizeStreetName (gemeinsam für Import, Verzeichnis, Karte)', () => {
  it.each([
    ['Neusser Straße', 'Neusser Str.'],
    ['Neusser Strasse', 'neusser str'],
    ['Neußer Str. 12', 'Neusser Straße'],
    ['Mülheimer Freiheit', 'Muelheimer Freiheit'],
    ['St.-Apern-Straße', 'Sankt-Apern-Str.'],
    ['Hans-Böckler-Platz 1-3', 'Hans-Böckler-Pl.'],
    ['Am Hof 12a', 'Am Hof'],
    ['Venloer Str. 85/87', 'Venloer Straße'],
  ])('"%s" und "%s" sind dieselbe Straße', (a, b) => {
    expect(normalizeStreetName(a)).toBe(normalizeStreetName(b))
    expect(isSameStreet(a, b)).toBe(true)
  })

  it('Zahlen im Namen bleiben erhalten', () => {
    expect(normalizeStreetName('Straße des 17. Juni')).toBe('strdes17juni')
    expect(stripHouseNumber('Straße des 17. Juni 5')).toBe('Straße des 17. Juni')
  })

  it('verschiedene Straßen bleiben verschieden', () => {
    expect(isSameStreet('Neusser Str.', 'Neusser Wall')).toBe(false)
    expect(isSameStreet('Am Hof', 'Hofweg')).toBe(false)
    expect(isSameStreet('', '')).toBe(false)
  })
})

// ── 2. OpenPLZ-Paging ────────────────────────────────────────────────────────

describe('fetchStreetDirectory – OpenPLZ-Paging', () => {
  it('fragt nie mehr als 50 pro Seite an und verankert die PLZ', async () => {
    const { impl, calls } = fakeOpenPLZ(streetsFor('50733', 10))
    await fetchStreetDirectory('50733', impl)
    for (const url of calls) {
      const u = new URL(url)
      expect(Number(u.searchParams.get('pageSize'))).toBeLessThanOrEqual(OPENPLZ_MAX_PAGE_SIZE)
      expect(u.searchParams.get('postalCode')).toBe('^50733$')
    }
  })

  it('lädt alle Seiten: 122 Straßen = 3 Seiten, vollständig', async () => {
    const { impl, calls } = fakeOpenPLZ(streetsFor('50733', 122))
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('complete')
    expect(r.streets).toHaveLength(122)
    expect(r.totalReported).toBe(122)
    expect(calls).toHaveLength(3)
  })

  it('genau 100 Straßen: keine überflüssige leere Seite', async () => {
    const { impl, calls } = fakeOpenPLZ(streetsFor('50733', 100))
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('complete')
    expect(calls).toHaveLength(2)
  })

  it('Serverfehler auf Seite 2: unvollständig, Teilergebnis nicht als vollständig', async () => {
    const { impl } = fakeOpenPLZ(streetsFor('50733', 122), { failOnPage: 2 })
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('incomplete')
    expect(r.reason).toContain('Seite 2')
    expect(r.totalFetched).toBe(50)
  })

  it('Netzwerkabbruch auf Seite 3: unvollständig', async () => {
    const { impl } = fakeOpenPLZ(streetsFor('50733', 122), { throwOnPage: 3 })
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('incomplete')
    expect(r.totalFetched).toBe(100)
  })

  it('Quelle meldet 130, liefert aber nur 122: unvollständig', async () => {
    const { impl } = fakeOpenPLZ(streetsFor('50733', 122), { reportTotal: 130 })
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('incomplete')
  })

  it('400 (Anfragefehler) wird nicht sinnlos wiederholt', async () => {
    const { impl } = fakeOpenPLZ(streetsFor('50733', 10), { failOnPage: 1, failStatus: 400 })
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('incomplete')
    expect(impl).toHaveBeenCalledTimes(1)
  })

  it('PLZ ohne Straßen: "empty", nicht "complete"', async () => {
    const { impl } = fakeOpenPLZ([])
    const r = await fetchStreetDirectory('99999', impl)
    expect(r.status).toBe('empty')
  })

  it('ohne x-total-count: Ende an der nicht vollen Seite', async () => {
    const { impl, calls } = fakeOpenPLZ(streetsFor('50733', 75), { omitTotalHeader: true })
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('complete')
    expect(r.streets).toHaveLength(75)
    expect(calls).toHaveLength(2)
  })

  it('ungültige PLZ: keine Anfrage', async () => {
    const { impl } = fakeOpenPLZ([])
    const r = await fetchStreetDirectory('5073', impl)
    expect(r.status).toBe('incomplete')
    expect(impl).not.toHaveBeenCalled()
  })

  it('Zwischenspeicher hält nur vollständige Ergebnisse', async () => {
    clearStreetDirectoryCache()
    const failing = fakeOpenPLZ(streetsFor('50859', 60), { failOnPage: 2 })
    await getStreetDirectory('50859', failing.impl)
    const ok = fakeOpenPLZ(streetsFor('50859', 60))
    const r = await getStreetDirectory('50859', ok.impl)
    expect(r.status).toBe('complete')
    expect(ok.impl).toHaveBeenCalled()
    const again = fakeOpenPLZ(streetsFor('50859', 60))
    await getStreetDirectory('50859', again.impl)
    expect(again.impl).not.toHaveBeenCalled()
    clearStreetDirectoryCache()
  })
})

// ── 3. Doppelte Straßennamen ─────────────────────────────────────────────────

describe('Doppelte Straßennamen', () => {
  it('Verzeichnis: Schreibvarianten werden eine Straße', () => {
    const merged = mergeDirectoryEntries([
      { name: 'Neusser Str.', postalCode: '50733', locality: 'Köln' },
      { name: 'Neusser Straße', postalCode: '50733', locality: 'Köln' },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].name).toBe('Neusser Str.')
  })

  it('Verzeichnis: gleicher Name in zwei Orten derselben PLZ bleibt eine Straße mit beiden Orten', () => {
    const merged = mergeDirectoryEntries([
      { name: 'Hauptstr.', postalCode: '51503', locality: 'Rösrath' },
      { name: 'Hauptstr.', postalCode: '51503', locality: 'Hoffnungsthal' },
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].localities.sort()).toEqual(['Hoffnungsthal', 'Rösrath'])
  })

  it('Verzeichnis über Seitengrenzen hinweg doppelt: wird zusammengefasst, Vollständigkeit bleibt', async () => {
    const all = streetsFor('50733', 51)
    all[50] = { ...all[49] } // Eintrag 50 und 51 gleich, liegen auf Seite 1 und 2
    const { impl } = fakeOpenPLZ(all)
    const r = await fetchStreetDirectory('50733', impl)
    expect(r.status).toBe('complete')
    expect(r.totalFetched).toBe(51)
    expect(r.streets).toHaveLength(50)
  })

  it('Kunden: verschiedene Schreibweisen derselben Straße werden zusammengezählt', () => {
    const res = analyzeStreets([
      row('Neusser Str. 12', 3),
      row('Neußer Straße 40', 2),
      row('neusser strasse 7', 1),
    ], NO_STREET_DIRECTORY)
    expect(res).toHaveLength(1)
    expect(res[0].customer_count).toBe(3)
    expect(res[0].order_count).toBe(6)
  })

  it('Kunden: gleicher Straßenname in zwei PLZ bleibt getrennt', () => {
    const res = analyzeStreets([
      row('Hauptstr. 1', 4, '50733'),
      row('Hauptstr. 9', 1, '50859'),
    ], NO_STREET_DIRECTORY)
    expect(res).toHaveLength(2)
    expect(res.map(r => r.postal_code).sort()).toEqual(['50733', '50859'])
  })

  it('Namen mit Zahl ("Weg 1", "Weg 2") bleiben im Verzeichnis getrennt', () => {
    const merged = mergeDirectoryEntries([
      { name: 'Weg 1', postalCode: '50859', locality: 'Köln' },
      { name: 'Weg 2', postalCode: '50859', locality: 'Köln' },
      { name: 'An der B 5', postalCode: '50859', locality: 'Köln' },
    ])
    expect(merged).toHaveLength(3)
  })

  it('Kundenadresse "Weg 2 15" und "Weg 2" werden der Straße "Weg 2" zugeordnet', () => {
    const res = analyzeStreets([row('Weg 2 15', 3), row('Weg 2', 1)], { streets: ['Weg 1', 'Weg 2'], complete: true })
    const weg2 = res.find(r => r.street_name === 'Weg 2')!
    expect(weg2.order_count).toBe(4)
    expect(weg2.customer_count).toBe(2)
    expect(res.find(r => r.street_name === 'Weg 1')!.street_class).toBe('E')
  })

  it('Anzeigename kommt aus dem Verzeichnis, wenn vorhanden', () => {
    const res = analyzeStreets([row('neusser strasse 7', 1)], { streets: ['Neusser Str.'], complete: true })
    expect(res.find(r => r.order_count > 0)!.street_name).toBe('Neusser Str.')
  })
})

// ── 4. Straßen ohne Bestellungen ─────────────────────────────────────────────

describe('Straßen ohne Bestellungen', () => {
  const directory = ['Neusser Str.', 'Kempener Str.', 'Niehler Str.', 'Wilhelmstr.']

  it('vollständiges Verzeichnis: Straßen ohne Kunden erscheinen als Klasse E', () => {
    const res = analyzeStreets([row('Neusser Straße 1', 12), row('Kempener Str. 3', 2)], { streets: directory, complete: true })
    expect(res).toHaveLength(4)
    const e = res.filter(r => r.street_class === 'E').map(r => r.street_name).sort()
    expect(e).toEqual(['Niehler Str.', 'Wilhelmstr.'])
    expect(res.filter(r => r.order_count > 0).every(r => r.is_in_official_list === true)).toBe(true)
  })

  it('unvollständiges Verzeichnis: KEINE Straße wird als 0 Bestellungen ausgewiesen', () => {
    const res = analyzeStreets([row('Neusser Straße 1', 12)], { streets: directory.slice(0, 2), complete: false })
    expect(res).toHaveLength(1)
    expect(res.some(r => r.street_class === 'E')).toBe(false)
    expect(res[0].is_in_official_list).toBeNull()
  })

  it('kein Verzeichnis: nur Straßen mit Kunden', () => {
    const res = analyzeStreets([row('Neusser Straße 1', 12)], NO_STREET_DIRECTORY)
    expect(res).toHaveLength(1)
  })

  it('Kundenstraße fehlt im vollständigen Verzeichnis: als "nicht enthalten" markiert', () => {
    const res = analyzeStreets([row('Privatweg 3', 1)], { streets: directory, complete: true })
    expect(res.find(r => r.order_count > 0)!.is_in_official_list).toBe(false)
  })

  it('A–E-Grenzen bleiben unverändert', () => {
    const res = analyzeStreets([
      row('A-Str. 1', 20), row('B-Str. 1', 10), row('C-Str. 1', 3),
    ], NO_STREET_DIRECTORY)
    const cls = Object.fromEntries(res.map(r => [r.street_name, r.street_class]))
    expect(cls['A-Str.']).toBe('A')
    expect(cls['B-Str.']).toBe('B')
  })

  it('aggregierter Import: 20 Kunden, 65 Bestellungen bleiben 20 und 65', () => {
    const res = analyzeStreets([
      row('Neusser Str.', 40, '50733', { _is_aggregated: true, _aggregated_customer_count: 12 } as Partial<ParsedCustomerRow>),
      row('Neusser Straße', 25, '50733', { _is_aggregated: true, _aggregated_customer_count: 8 } as Partial<ParsedCustomerRow>),
    ], NO_STREET_DIRECTORY)
    expect(res).toHaveLength(1)
    expect(res[0].customer_count).toBe(20)
    expect(res[0].order_count).toBe(65)
  })

  it('PLZ-Analyse: ohne vollständiges Verzeichnis keine Straßenquote, dafür Warnung', () => {
    const a = analyzePLZ([row('Neusser Str. 1', 5)], { streets: directory, complete: false }, null, null)
    expect(a.streets_total).toBeNull()
    expect(a.streets_without_orders).toBeNull()
    expect(a.streets_coverage_pct).toBeNull()
    expect(a.warnings.join(' ')).toContain('unvollständig')
  })

  it('PLZ-Analyse: mit vollständigem Verzeichnis echte Zahlen, Duplikate einmal gezählt', () => {
    const a = analyzePLZ([row('Neusser Str. 1', 5)], { streets: [...directory, 'Neusser Straße'], complete: true }, null, null)
    expect(a.streets_total).toBe(4)
    expect(a.streets_with_orders).toBe(1)
    expect(a.streets_without_orders).toBe(3)
  })
})

// ── 5. Supabase: mehr als 1.000 Zeilen ───────────────────────────────────────

describe('fetchAllRows – Supabase-Grenze', () => {
  function fakeTable(total: number, serverMaxRows: number) {
    const rows = Array.from({ length: total }, (_, i) => ({ id: i }))
    const calls: [number, number][] = []
    const build = (from: number, to: number) => {
      calls.push([from, to])
      const end = Math.min(to, from + serverMaxRows - 1)
      return Promise.resolve({ data: rows.slice(from, end + 1), error: null, count: total })
    }
    return { build, calls }
  }

  it('2.500 Zeilen bei Standardgrenze 1.000: alle geladen', async () => {
    const { build } = fakeTable(2500, 1000)
    const r = await fetchAllRows(build)
    expect(r.data).toHaveLength(2500)
    expect(r.complete).toBe(true)
  })

  it('Grenze im Projekt auf 500 gesenkt: trotzdem alle geladen', async () => {
    const { build } = fakeTable(1700, 500)
    const r = await fetchAllRows(build)
    expect(r.data).toHaveLength(1700)
    expect(new Set(r.data.map(x => x.id)).size).toBe(1700)
  })

  it('Fehler mitten im Laden: nicht vollständig, Fehler wird gemeldet', async () => {
    let n = 0
    const r = await fetchAllRows((from: number, to: number) => {
      n++
      return Promise.resolve(n === 2
        ? { data: null, error: { message: 'timeout' }, count: null }
        : { data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })), error: null, count: 3000 })
    })
    expect(r.complete).toBe(false)
    expect(r.error?.message).toBe('timeout')
  })
})

// ── 6. Upload-Route: Speichern ───────────────────────────────────────────────

type Call = { table: string; ops: [string, unknown[]][] }
const db: { calls: Call[] } = { calls: [] }

function makeServiceClient() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] }
      db.calls.push(call)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'insert', 'update', 'delete', 'upsert', 'order', 'limit', 'range']) {
        b[op] = (...args: unknown[]) => { call.ops.push([op, args]); return b }
      }
      const result = () => {
        if (table === 'uploads' && call.ops.some(([o]) => o === 'insert')) return { data: { id: 'up1' }, error: null }
        if (table === 'analytics' && call.ops.some(([o]) => o === 'insert')) return { data: { id: 'an1' }, error: null }
        if (table === 'companies') return { data: { google_places_api_key: null }, error: null }
        // Firmenzugehörigkeit (für die Sicherheitsprüfung aus Phase 0)
        if (table === 'company_users') return { data: [{ company_id: 'A', role: 'manager' }], error: null }
        return { data: null, error: null }
      }
      b.single = () => Promise.resolve(result())
      b.maybeSingle = () => Promise.resolve(result())
      b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, err)
      return b
    },
    storage: { from: () => ({ upload: () => Promise.resolve({ error: null }) }) },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createReferenceDataClient: () => makeServiceClient(),
  createServerSupabaseClient: () => makeServiceClient(),
}))

const directoryMock: { result: { streets: string[]; complete: boolean; status: string; source: string; count: number; error?: string } } = {
  result: { streets: [], complete: false, status: 'incomplete', source: 'openplz', count: 0 },
}
vi.mock('@/lib/providers', async (orig) => {
  const actual = await orig<typeof import('@/lib/providers')>()
  class Orchestrator {
    async getStreets() { return directoryMock.result }
    async getPostalCodeData(plz: string) { return { info: { postal_code: plz, city: 'Köln' }, census: null } }
  }
  return { ...actual, DataProviderOrchestrator: Orchestrator }
})

function csvUpload(lines: string[]) {
  const fd = new FormData()
  fd.append('file', new File([['PLZ,Straße,Bestellungen,Umsatz', ...lines].join('\n')], 'kunden.csv', { type: 'text/csv' }))
  fd.append('company_id', 'A')
  fd.append('user_id', 'u1')
  return new Request('http://localhost/api/upload', { method: 'POST', body: fd })
}

describe('POST /api/upload – Straßen speichern', () => {
  beforeEach(() => { db.calls = [] })

  it('vollständiges Verzeichnis mit 250 Straßen: alle 250 werden gespeichert (früher max. 200)', async () => {
    const names = streetsFor('50733', 250).map(s => s.name)
    directoryMock.result = { streets: names, complete: true, status: 'complete', source: 'openplz', count: 250 }
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(csvUpload(['50733,Teststraße AA 4,3,60']) as any)
    expect(res.status).toBe(200)
    const inserted = db.calls
      .filter(c => c.table === 'street_analytics')
      .flatMap(c => c.ops.filter(([o]) => o === 'insert').flatMap(([, a]) => a[0] as unknown[]))
    expect(inserted).toHaveLength(250)
    const zero = (inserted as { order_count: number; street_class: string }[]).filter(s => s.order_count === 0)
    expect(zero).toHaveLength(249)
    expect(zero.every(s => s.street_class === 'E')).toBe(true)
    // vollständige Liste wird als Cache geschrieben (alte Einträge vorher entfernt)
    expect(db.calls.some(c => c.table === 'streets' && c.ops.some(([o]) => o === 'delete'))).toBe(true)
  })

  it('unvollständiges Verzeichnis: kein Cache, keine E-Straßen, Straßenquote leer', async () => {
    directoryMock.result = { streets: ['Teststraße AA', 'Teststraße AB'], complete: false, status: 'incomplete', source: 'openplz', count: 2, error: 'Seite 2: HTTP 500' }
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(csvUpload(['50733,Teststraße AA 4,3,60']) as any)
    expect(db.calls.some(c => c.table === 'streets')).toBe(false)
    const inserted = db.calls
      .filter(c => c.table === 'street_analytics')
      .flatMap(c => c.ops.filter(([o]) => o === 'insert').flatMap(([, a]) => a[0] as { street_class: string }[]))
    expect(inserted).toHaveLength(1)
    expect(inserted.some(s => s.street_class === 'E')).toBe(false)
    const analytics = db.calls.find(c => c.table === 'analytics' && c.ops.some(([o]) => o === 'insert'))!
    const row = analytics.ops.find(([o]) => o === 'insert')![1][0] as Record<string, unknown>
    expect(row.streets_total).toBeNull()
    expect(row.streets_without_orders).toBeNull()
  })
})

// ── 7. CSV-Zeichensatz ───────────────────────────────────────────────────────

describe('readWorkbook – CSV-Zeichensatz', () => {
  async function headersOf(text: string, encoding: 'utf-8' | 'utf-8-bom' | 'windows-1252', sep = ',') {
    const { readWorkbook } = await import('@/lib/import/read-table')
    const XLSX = await import('xlsx')
    const body = text.replace(/,/g, sep)
    let bytes: Uint8Array
    if (encoding === 'windows-1252') {
      bytes = Uint8Array.from([...body].map(ch => ch === 'ß' ? 0xdf : ch === 'ü' ? 0xfc : ch.charCodeAt(0)))
    } else {
      const enc = new TextEncoder().encode(body)
      bytes = encoding === 'utf-8-bom' ? Uint8Array.from([0xef, 0xbb, 0xbf, ...enc]) : enc
    }
    const wb = readWorkbook(bytes.buffer as ArrayBuffer, 'kunden.csv', 'text/csv')
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' })
    return { headers: Object.keys(rows[0]), first: rows[0] }
  }
  const csv = 'PLZ,Straße,Bestellungen\n50733,Neusser Straße 12,3'

  it.each(['utf-8', 'utf-8-bom', 'windows-1252'] as const)('Spalte "Straße" bleibt lesbar (%s)', async (enc) => {
    const { headers, first } = await headersOf(csv, enc)
    expect(headers).toContain('Straße')
    expect(first['Straße']).toBe('Neusser Straße 12')
  })

  it('Semikolon als Trennzeichen (deutsche Excel-CSV) wird erkannt', async () => {
    const { headers } = await headersOf(csv, 'utf-8', ';')
    expect(headers).toEqual(['PLZ', 'Straße', 'Bestellungen'])
  })
})

// ── 8. Folgeanzeigen: keine "0" aus fehlenden Daten ──────────────────────────

describe('Empfehlungen – fehlendes Verzeichnis wird nicht zu "0 Straßen"', () => {
  async function flyerText(streetsWithout: number | null) {
    const { generateRecommendations, computeDashboardKPIs } = await import('@/lib/analysis/engine')
    const kpis = computeDashboardKPIs([row('Neusser Str. 1', 2)])
    const plz = analyzePLZ([row('Neusser Str. 1', 2)], { streets: [], complete: false }, 50000, null)
    plz.streets_without_orders = streetsWithout
    plz.market_penetration_pct = 0.01
    plz.not_reached_residents = 49999
    const recs = generateRecommendations(kpis, [plz], [])
    return recs.find(r => r.action_type === 'flyer')!.description
  }

  it('ohne Verzeichnis: keine Straßenzahl im Text', async () => {
    const text = await flyerText(null)
    expect(text).not.toMatch(/null|0 Straßen/)
    expect(text).not.toContain('Straßen ohne Bestellung')
  })

  it('mit Verzeichnis: echte Zahl im Text', async () => {
    expect(await flyerText(37)).toContain('37 Straßen ohne Bestellung')
  })
})
