// Geografische Zuordnung von Bestelladressen – mit echten Verzeichnisdaten
// (Auszug: tests/fixtures/geodaten-auszug.json, OpenStreetMap/ODbL)
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AddressIndex, localityKey, localityVariants, editDistance, summarizeMatches, cleanDirectoryName, type LocalityEntry } from '../src/lib/geo/address-match'
import { assignRows } from '../src/lib/geo/assign-rows'
import { parseAndCleanRows } from '../src/lib/analysis/engine'
import { loadAddressIndex } from '../src/lib/geo/directory'
import type { ParsedCustomerRow } from '../src/types'

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures/geodaten-auszug.json'), 'utf8')) as {
  strassen: Record<string, string[]>; orte: LocalityEntry[]; plz: Record<string, string>[]
}
const known = new Set([...Object.keys(fx.strassen), '60306']) // 60306: Großkunden-PLZ mit Fläche, ohne Straßen
const idx = new AddressIndex(Object.entries(fx.strassen), fx.orte, known)
const m = (postal_code: string | null, street: string | null, city: string | null = null) => idx.match({ postal_code, street, city })

describe('Ortsnamen vergleichen', () => {
  it('Schreibweisen desselben Orts ergeben denselben Schlüssel', () => {
    expect(localityKey('Köln')).toBe(localityKey('KOELN'))
    expect(localityKey('Frankfurt am Main')).toBe(localityKey('Frankfurt a. M.'))
    expect(localityKey('Frankfurt am Main')).toBe(localityKey('frankfurt a.m.'))
    expect(localityKey('Frankfurt (Oder)')).not.toBe(localityKey('Frankfurt am Main'))
    expect(localityKey('Halle (Saale)')).toBe('hallesaale')
  })
  it('Ortsteile und PLZ in der Ortsangabe', () => {
    expect(localityVariants('Köln-Ehrenfeld')).toEqual(expect.arrayContaining(['koelnehrenfeld', 'koeln', 'ehrenfeld']))
    expect(localityVariants('50823 Köln')).toEqual(['koeln'])
    expect(localityVariants('')).toEqual([])
  })
  it('Namen aus der Quelle werden bereinigt', () => {
    expect(cleanDirectoryName('" 7 Berge "')).toBe('7 Berge')
    expect(editDistance('venloerstr', 'venlorstr', 2)).toBe(1)
    expect(editDistance('abc', 'xyzabc', 1)).toBe(2)
  })
})

describe('Adresse mit PLZ (Großstädte)', () => {
  it.each([
    ['50823', 'Venloer Str. 12', 'Venloer Str.'],          // Köln
    ['50823', 'Venloer Straße 12a', 'Venloer Str.'],
    ['50823', 'venloer strasse 12', 'Venloer Str.'],
    ['10115', 'Invalidenstraße 117', 'Invalidenstr.'],     // Berlin
    ['10115', 'Chausseestr. 1-3', 'Chausseestr.'],
    ['80331', 'Marienplatz 8', 'Marienplatz'],             // München
    ['80331', 'Sendlinger Strasse 3', 'Sendlinger Str.'],
    ['01067', 'Wilsdruffer Str. 2', 'Wilsdruffer Str.'],   // Dresden
    ['01067', 'Postplatz 1', 'Postplatz'],
  ])('%s %s → exakt', (plz, street, name) => {
    const r = m(plz, street)
    expect(r.status).toBe('exakt')
    expect(r.postal_code).toBe(plz)
    expect(r.street_name).toBe(name)
  })
  it('Hamburg und Leipzig: Straße aus dem Verzeichnis wird gefunden', () => {
    for (const plz of ['20095', '04109']) {
      const street = fx.strassen[plz][10]
      expect(m(plz, `${street} 5`).status).toBe('exakt')
    }
  })
  it('PLZ als Zahl ohne führende Null (Dresden 1067)', () => {
    expect(m('1067', 'Postplatz 1').postal_code).toBe('01067')
  })
  it('Tippfehler werden eindeutig korrigiert, die PLZ bleibt', () => {
    expect(m('10115', 'Invalidenstrase 5')).toMatchObject({ status: 'schreibweise', street_name: 'Invalidenstr.', postal_code: '10115' })
    expect(m('01067', 'Wilsdrufer Str. 2')).toMatchObject({ status: 'schreibweise', street_name: 'Wilsdruffer Str.' })
    expect(m('80331', 'Sendlinger Strasze 3')).toMatchObject({ status: 'schreibweise', street_name: 'Sendlinger Str.' })
  })
  it('Kurze Namen werden nicht „korrigiert“ (zu riskant)', () => {
    expect(m('50823', 'Weg 4').status).not.toBe('schreibweise')
  })
  it('Straße liegt in anderer PLZ desselben Orts → PLZ prüfen, PLZ wird NICHT geändert', () => {
    const r = m('50823', 'Venloer Wall 3')         // Venloer Wall liegt in 50672
    expect(r.status).toBe('plz_pruefen')
    expect(r.postal_code).toBe('50823')
    expect(r.candidates).toEqual(['50672'])
  })
  it('Unbekannte Straße, unbekannte PLZ, fehlende Straße', () => {
    expect(m('50823', 'Gibtsnichtweg 1').status).toBe('strasse_unbekannt')
    expect(m('99999', 'Hauptstr. 1').status).toBe('plz_unbekannt')
    expect(m('50823', '').status).toBe('ohne_strasse')
    expect(m('60306', 'Irgendwo 1').status).toBe('strasse_unbekannt') // PLZ bekannt, aber ohne Straßenliste
  })
})

describe('Adresse ohne PLZ', () => {
  // Straße, die im Auszug in genau einer PLZ dieses Orts vorkommt
  const uniqueIn = (plz: string, city: string) => {
    const cityPlz = fx.orte.filter(o => o.locality === city && o.kind === 'ort').map(o => o.postal_code)
    return fx.strassen[plz].find(s => cityPlz.every(p => p === plz || !fx.strassen[p]?.includes(s)) && s.length > 8)!
  }
  it('Straße über zwei PLZ (Invalidenstraße, Berlin 10115/10117) → mehrdeutig', () => {
    expect(m(null, 'Invalidenstraße 117', 'Berlin')).toMatchObject({ status: 'mehrdeutig', candidates: ['10115', '10117'], postal_code: null })
  })
  it('Eindeutig: PLZ wird ergänzt (Berlin, Dresden, München)', () => {
    expect(m(null, `${uniqueIn('10115', 'Berlin')} 4`, 'Berlin')).toMatchObject({ status: 'plz_ergaenzt', postal_code: '10115' })
    expect(m(null, 'Wilsdruffer Str. 2', 'Dresden')).toMatchObject({ status: 'plz_ergaenzt', postal_code: '01067' })
    expect(m(null, 'Marienplatz 1', 'München')).toMatchObject({ status: 'plz_ergaenzt', postal_code: '80331' })
  })
  it('Straße über mehrere PLZ (Venloer Str., Köln) → mehrdeutig, keine PLZ', () => {
    const r = m(null, 'Venloer Str. 300', 'Köln')
    expect(r.status).toBe('mehrdeutig')
    expect(r.postal_code).toBeNull()
    expect(r.candidates).toEqual(['50672', '50823', '50825', '50827', '50829'])
  })
  it('Stadtteil als Ortsangabe (Köln-Ehrenfeld) grenzt ein', () => {
    const r = m(null, 'Venloer Str. 300', 'Köln-Ehrenfeld')
    // Ehrenfeld umfasst mehrere PLZ – weiter mehrdeutig, aber nur innerhalb Kölns
    expect(['mehrdeutig', 'plz_ergaenzt']).toContain(r.status)
    expect(r.candidates.every(p => p.startsWith('508') || p.startsWith('506'))).toBe(true)
  })
  it('Frankfurt am Main und Frankfurt (Oder) werden nicht verwechselt', () => {
    const fm = fx.strassen['60311'].find(s => !fx.strassen['15230'].includes(s) && !fx.strassen['60313'].includes(s))!
    expect(m(null, fm, 'Frankfurt a. M.')).toMatchObject({ status: 'plz_ergaenzt', postal_code: '60311' })
    expect(m(null, fm, 'Frankfurt (Oder)').status).toBe('strasse_unbekannt')
    expect(m(null, fm, 'Frankfurt').status).toBe('ohne_ort')    // mehrdeutiger Ortsname: keine Annahme
  })
  it('Ländliche Gemeinde (Prüm, Eifel)', () => {
    const r = m(null, 'Hauptstraße 4', 'Prüm')
    expect(r.status === 'plz_ergaenzt' || r.status === 'mehrdeutig').toBe(true)
    if (r.status === 'plz_ergaenzt') expect(['54595', '54597']).toContain(r.postal_code)
  })
  it('Unbekannter Ort oder fehlende Angaben', () => {
    expect(m(null, 'Hauptstr. 1', 'Atlantis').status).toBe('ohne_ort')
    expect(m(null, 'Hauptstr. 1', null).status).toBe('ohne_ort')
    expect(m(null, null, 'Köln').status).toBe('ohne_ort')
  })
})

describe('Import: Zeilen zuordnen', () => {
  const row = (i: number, p: Partial<ParsedCustomerRow>): ParsedCustomerRow => ({ _row_index: i, _errors: [], total_orders: 1, total_revenue: 10, ...p })

  it('eindeutige PLZ wird ergänzt, mehrdeutige Zeile aussortiert und gemeldet, Summen stimmen', () => {
    const rows = [
      row(2, { postal_code: '50823', street: 'Venloer Str.', city: 'Köln', total_revenue: 20 }),
      row(3, { _needs_postal_code: true, street: 'Wilsdruffer Str.', city: 'Dresden', total_revenue: 30 }),
      row(4, { _needs_postal_code: true, street: 'Venloer Str.', city: 'Köln', total_revenue: 40 }),
      row(5, { postal_code: '50823', street: 'Venloer Wall', city: 'Köln', total_revenue: 50 }),
    ]
    const res = assignRows(rows, idx, 'v-test')
    expect(res.rows.map(r => [r.postal_code, r.geo_status])).toEqual([['50823', 'exakt'], ['01067', 'plz_ergaenzt'], ['50823', 'plz_pruefen']])
    expect(res.dropped).toBe(1)
    expect(res.rows.reduce((s, r) => s + r.total_revenue, 0)).toBe(100)   // 20 + 30 + 50, die 40 € ohne PLZ zählen nicht
    expect(res.problems.map(p => p.row)).toEqual([4, 5])
    expect(res.problems[0].reason).toMatch(/mehreren PLZ \(50672, 50823, 50825, 50827, 50829\)/)
    expect(res.summary).toMatchObject({ total: 4, reliable_pct: 50, directory_version: 'v-test' })
    expect(res.summary!.by_status).toMatchObject({ exakt: 1, plz_ergaenzt: 1, mehrdeutig: 1, plz_pruefen: 1 })
  })

  it('ohne Verzeichnis: Zeilen ohne PLZ werden nicht übernommen, alles andere wie bisher', () => {
    const rows = [row(2, { postal_code: '50823', street: 'X' }), row(3, { _needs_postal_code: true, street: 'Y', city: 'Köln' })]
    const res = assignRows(rows, null)
    expect(res.rows).toHaveLength(1)
    expect(res.rows[0].geo_status).toBeUndefined()
    expect(res.summary).toBeNull()
    expect(res.problems[0].reason).toMatch(/Postleitzahl fehlt/)
  })

  it('Datei ohne PLZ-Spalte: Zeilen werden nur mit Freigabe der Zuordnung übernommen', () => {
    const raw = [{ Straße: 'Wilsdruffer Straße 2', Ort: 'Dresden', Umsatz: '12,50' }, { Straße: 'Venloer Str. 3', Ort: 'Köln', Umsatz: '8' }]
    const map = { street: 'Straße', city: 'Ort', total_revenue: 'Umsatz' }
    expect(parseAndCleanRows(raw, map).rows).toHaveLength(0)                 // wie bisher: ohne PLZ keine Zeile
    const withGeo = parseAndCleanRows(raw, map, { allowMissingPostalCode: true })
    expect(withGeo.rows).toHaveLength(2)
    expect(withGeo.rows.every(r => r._needs_postal_code)).toBe(true)
    const res = assignRows(withGeo.rows, idx)
    expect(res.rows.map(r => r.postal_code)).toEqual(['01067'])
    expect(res.rows[0].total_revenue).toBe(12.5)
  })

  it('eine ungültige PLZ wird nicht durch Raten ersetzt', () => {
    const raw = [{ PLZ: '5O823', Straße: 'Venloer Str. 3', Ort: 'Köln' }]
    const res = parseAndCleanRows(raw, { postal_code: 'PLZ', street: 'Straße', city: 'Ort' }, { allowMissingPostalCode: true })
    expect(res.rows).toHaveLength(0)
    expect(res.errors).toBe(1)
  })
})

describe('Zusammenfassung', () => {
  it('Erfolgsquote und Beispiele', () => {
    const s = summarizeMatches([
      { input: { street: 'A' }, result: { status: 'exakt', postal_code: '1', street_name: 'A', candidates: [] } },
      { input: { street: 'B', city: 'Köln' }, result: { status: 'mehrdeutig', postal_code: null, street_name: 'B', candidates: ['1', '2'] } },
    ])
    expect(s.reliable_pct).toBe(50)
    expect(s.examples.mehrdeutig![0]).toMatchObject({ street: 'B', candidates: ['1', '2'] })
    expect(summarizeMatches([]).reliable_pct).toBeNull()
  })
})

describe('Laden aus der Datenbank (Attrappe)', () => {
  function fakeDb(tables: Record<string, Record<string, unknown>[]>, fail = false) {
    return {
      from(table: string) {
        let rows = tables[table] || []
        const q = {
          select: () => q,
          limit: (n: number) => Promise.resolve(fail ? { data: null, error: { message: 'relation does not exist' } } : { data: rows.slice(0, n), error: null }),
          in: (col: string, vals: string[]) => { rows = rows.filter(r => vals.includes(String(r[col]))); return q },
          order: () => q,
          range: (a: number, b: number) => Promise.resolve({ data: rows.slice(a, b + 1), error: null }),
        }
        return q
      },
    }
  }
  const tables = {
    street_directory: Object.entries(fx.strassen).map(([postal_code, streets]) => ({ postal_code, streets, version: 'v1' })),
    plz_localities: fx.orte as unknown as Record<string, unknown>[],
    postal_codes: [{ postal_code: '60306', reference_version: 'v1' }],
  }
  it('lädt Straßen der PLZ und der genannten Orte, Ergebnis wie mit vollem Index', async () => {
    const loaded = await loadAddressIndex(fakeDb(tables), [{ postal_code: '50823' }, { city: 'Berlin' }, { postal_code: '60306' }])
    expect(loaded).not.toBeNull()
    expect(loaded!.version).toBe('v1')
    expect(loaded!.streets.has('50823') && loaded!.streets.has('50672') && loaded!.streets.has('10115')).toBe(true)
    expect(loaded!.index.match({ postal_code: '50823', street: 'Venloer Wall 1' }).status).toBe('plz_pruefen')
    expect(loaded!.index.match({ street: 'Invalidenstr. 1', city: 'Berlin' })).toMatchObject({ status: 'mehrdeutig', candidates: ['10115', '10117'] })
    expect(loaded!.index.hasPostalCode('60306')).toBe(true)
  })
  it('ohne Migration 009 oder leeres Verzeichnis: null (Import läuft wie bisher)', async () => {
    expect(await loadAddressIndex(fakeDb(tables, true), [{ postal_code: '50823' }])).toBeNull()
    expect(await loadAddressIndex(fakeDb({}), [{ postal_code: '50823' }])).toBeNull()
  })
})

describe('Gleichnamige Orte und Leitregion', () => {
  // Zwei Orte „Neudorf“ in verschiedenen Regionen, beide mit „Hauptstr.“
  const i2 = new AddressIndex(
    [['12345', ['Hauptstr.', 'Ring']], ['98765', ['Hauptstr.']], ['12399', ['Lindenweg']]],
    [{ postal_code: '12345', locality: 'Neudorf', locality_key: 'neudorf', kind: 'ort' }, { postal_code: '98765', locality: 'Neudorf', locality_key: 'neudorf', kind: 'ort' }],
    new Set(['12345', '98765', '12399']),
  )
  it('ohne Hinweis: mehrdeutig', () => {
    expect(i2.match({ street: 'Hauptstr. 1', city: 'Neudorf' })).toMatchObject({ status: 'mehrdeutig', candidates: ['12345', '98765'] })
  })
  it('mit Leitregion der übrigen Datei: eindeutig', () => {
    expect(i2.match({ street: 'Hauptstr. 1', city: 'Neudorf', regionPrefixes: new Set(['12']) })).toMatchObject({ status: 'plz_ergaenzt', postal_code: '12345' })
    expect(i2.match({ street: 'Hauptstr. 1', city: 'Neudorf', regionPrefixes: new Set(['12', '98']) }).status).toBe('mehrdeutig')
  })
  it('assignRows nutzt nur gesicherte PLZ der Datei als Hinweis', () => {
    const rows = [
      { _row_index: 2, _errors: [], total_orders: 1, total_revenue: 1, postal_code: '12399', street: 'Lindenweg', city: 'Neudorf' },
      { _row_index: 3, _errors: [], total_orders: 1, total_revenue: 1, _needs_postal_code: true, street: 'Hauptstr. 5', city: 'Neudorf' },
    ] as ParsedCustomerRow[]
    const res = assignRows(rows, i2)
    expect(res.rows.map(r => r.postal_code)).toEqual(['12399', '12345'])
  })
  it('Tippfehler-Angleichung lässt andere Wörter unberührt', async () => {
    const { fixStreetTypos } = await import('../src/lib/geo/address-match')
    expect(fixStreetTypos('Hauptstrase 3')).toBe('Hauptstraße 3')
    expect(fixStreetTypos('Strasburger Weg')).toBe('Strasburger Weg')
    expect(fixStreetTypos('Bergstrasze')).toBe('Bergstraße')
  })
})
