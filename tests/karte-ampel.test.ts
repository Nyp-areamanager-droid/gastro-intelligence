// Deutschlandweite Karte (OSM) und Rot-Orange-Grün-Bewertung
import { describe, it, expect } from 'vitest'
import { assembleRings, indexPolygon, pointInPolygon, clipLine, buildPlzMap, overpassQuery, type LngLat } from '../src/lib/geo/plz-geometry'
import { loadPlzMap, clearPlzMapCache } from '../src/lib/geo/overpass'
import { rateStreets, MIN_PLZ_ORDERS } from '../src/lib/analysis/street-rating'
import { streetNameKey as k } from '../src/lib/geo/street-name'

// Quadratische PLZ 0..1 mit Loch 0.4..0.6, aus vier Grenzlinien zusammengesetzt
const g = (pts: LngLat[]) => pts.map(([lon, lat]) => ({ lon, lat }))
const square = { outer: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] as LngLat[][], inner: [[[0.4, 0.4], [0.6, 0.4], [0.6, 0.6], [0.4, 0.6], [0.4, 0.4]]] as LngLat[][] }

describe('PLZ-Fläche', () => {
  it('setzt Grenzlinien in beliebiger Reihenfolge und Richtung zu einem Ring zusammen', () => {
    const rings = assembleRings([[[1, 1], [0, 1]], [[0, 0], [1, 0]], [[0, 0], [0, 1]], [[1, 0], [1, 1]]])
    expect(rings).toHaveLength(1)
    expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1])
    expect(rings[0]).toHaveLength(5)
  })
  it('innen, außen, im Loch', () => {
    const idx = indexPolygon(square)
    expect(pointInPolygon(idx, [0.2, 0.2])).toBe(true)
    expect(pointInPolygon(idx, [1.2, 0.2])).toBe(false)
    expect(pointInPolygon(idx, [0.5, 0.5])).toBe(false) // Loch, z. B. andere PLZ als Enklave
  })
})

describe('Straßen über mehrere PLZ', () => {
  const idx = indexPolygon(square)
  it('Straße ganz innen: unverändert, nicht partial', () => {
    const r = clipLine([[0.1, 0.1], [0.3, 0.1]], idx)
    expect(r.partial).toBe(false)
    expect(r.parts).toEqual([[[0.1, 0.1], [0.3, 0.1]]])
  })
  it('Straße quer über die Grenze: nur der Abschnitt innen, partial', () => {
    const r = clipLine([[-0.5, 0.2], [0.5, 0.2]], idx)
    expect(r.partial).toBe(true)
    expect(r.parts).toHaveLength(1)
    expect(r.parts[0][0][0]).toBeCloseTo(0, 6)
    expect(r.parts[0][1][0]).toBeCloseTo(0.5, 6)
  })
  it('Straße durch das Loch: zwei getrennte Abschnitte', () => {
    const r = clipLine([[0.2, 0.5], [0.8, 0.5]], idx)
    expect(r.partial).toBe(true)
    expect(r.parts).toHaveLength(2)
    expect(r.parts[0][1][0]).toBeCloseTo(0.4, 6)
    expect(r.parts[1][0][0]).toBeCloseTo(0.6, 6)
  })
  it('Straße ganz außen: entfällt', () => {
    expect(clipLine([[2, 2], [3, 3]], idx).parts).toHaveLength(0)
  })
})

const overpassFixture = (plz = '04109') => ({
  elements: [
    { type: 'relation', id: 1, tags: { boundary: 'postal_code', postal_code: plz }, members: [
      { type: 'way', role: 'outer', geometry: g([[0, 0], [1, 0], [1, 1]]) },
      { type: 'way', role: 'outer', geometry: g([[1, 1], [0, 1], [0, 0]]) },
    ] },
    { type: 'way', id: 10, tags: { highway: 'residential', name: 'Lindenstraße' }, geometry: g([[0.1, 0.5], [0.9, 0.5]]) },
    { type: 'way', id: 11, tags: { highway: 'primary', name: 'Grenzallee' }, geometry: g([[0.5, 0.5], [1.5, 0.5]]) },
    { type: 'way', id: 12, tags: { highway: 'residential' }, geometry: g([[0.2, 0.2], [0.3, 0.3]]) }, // ohne Namen
    { type: 'node', id: 20, tags: { 'addr:street': 'Lindenstraße', 'addr:housenumber': '1' } },
    { type: 'way', id: 21, tags: { 'addr:street': 'Lindenstr.', 'addr:housenumber': '1', building: 'yes' } }, // gleiche Adresse
    { type: 'node', id: 22, tags: { 'addr:street': 'Lindenstraße', 'addr:housenumber': '3a' } },
    { type: 'node', id: 23, tags: { 'addr:street': 'Grenzallee', 'addr:housenumber': '7' } },
  ],
})

describe('Karte aus OpenStreetMap', () => {
  it('baut Fläche, Straßen (abgeschnitten) und Adresszahlen', () => {
    const m = buildPlzMap('04109', overpassFixture().elements as never, '2026-11-09T00:00:00Z')
    expect(m.status).toBe('ok')
    expect(m.bbox).toEqual([0, 0, 1, 1])
    expect(m.streets.map(s => s.properties.name)).toEqual(['Lindenstraße', 'Grenzallee'])
    expect(m.streets.find(s => s.properties.name === 'Grenzallee')!.properties.partial).toBe(true)
    expect(m.streets.find(s => s.properties.name === 'Lindenstraße')!.properties.partial).toBe(false)
    // „Lindenstr. 1“ und „Lindenstraße 1“ sind dieselbe Adresse
    expect(m.address_counts).toEqual({ [k('Lindenstraße')]: 2, [k('Grenzallee')]: 1 })
    expect(m.address_total).toBe(3)
    expect(m.source.attribution).toBe('© OpenStreetMap-Mitwirkende')
  })
  it('ohne PLZ-Fläche in OSM: ausdrücklich „no_boundary“, keine erfundene Karte', () => {
    const m = buildPlzMap('99999', overpassFixture('04109').elements as never, 'x')
    expect(m.status).toBe('no_boundary')
    expect(m.streets).toHaveLength(0)
  })
  it('Abfrage nur mit gültiger PLZ', () => {
    expect(overpassQuery('01067')).toContain('"postal_code"="01067"')
    expect(() => overpassQuery('0106"; out;')).toThrow()
  })
  it('Kartendienst ausgelastet: verständliche Meldung, zweiter Server wird versucht', async () => {
    clearPlzMapCache()
    const urls: string[] = []
    const res = await loadPlzMap('04109', async (url: string) => { urls.push(url); return new Response('busy', { status: 429 }) })
    expect(res.ok).toBe(false)
    if (res.ok === false) expect(res.error).toContain('ausgelastet')
    expect(urls).toHaveLength(2)
  })
  it('Ergebnis wird zwischengespeichert', async () => {
    clearPlzMapCache()
    let calls = 0
    const f = async () => { calls++; return new Response(JSON.stringify(overpassFixture()), { status: 200 }) }
    expect((await loadPlzMap('04109', f)).ok).toBe(true)
    const second = await loadPlzMap('04109', f)
    expect(second.ok && second.cached).toBe(true)
    expect(calls).toBe(1)
  })
})

describe('Rot-Orange-Grün', () => {
  // 4 Straßen, 40 Bestellungen; je Straße im Schnitt 10
  const streets = [
    { street_name: 'A-Straße', order_count: 20 },
    { street_name: 'B-Straße', order_count: 12 },
    { street_name: 'C-Straße', order_count: 6 },
    { street_name: 'D-Straße', order_count: 2 },
    { street_name: 'E-Straße', order_count: 0 },
  ]
  it('Vergleich je Straße (ohne Adressen): Gegenrechnung', () => {
    const r = rateStreets({ streets, directoryComplete: true })
    expect(r.basis).toBe('streets')
    expect(r.plz_average).toBe(8)            // 40 / 5
    const g = (n: string) => r.ratings.get(n)!
    expect(g(k('A-Straße'))).toMatchObject({ rating: 'green', index: 2.5, expected: 8 })
    expect(g(k('B-Straße'))).toMatchObject({ rating: 'green', index: 1.5 })
    expect(g(k('C-Straße'))).toMatchObject({ rating: 'orange', index: 0.75 })
    expect(g(k('D-Straße'))).toMatchObject({ rating: 'red', index: 0.25 })
    expect(g(k('E-Straße'))).toMatchObject({ rating: 'red', index: 0 })     // vollständiges Verzeichnis: echte 0
    expect(g(k('D-Straße')).reason).toContain('2 Bestellungen, erwartet 8,0')
  })
  it('Vergleich je Hausadresse: lange Straße nicht automatisch grün', () => {
    // A hat 20 Bestellungen auf 100 Adressen, B 12 auf 10 Adressen
    const addr = { [k('A-Straße')]: 100, [k('B-Straße')]: 10, [k('C-Straße')]: 10, [k('D-Straße')]: 10, [k('E-Straße')]: 10 }
    const r = rateStreets({ streets, directoryComplete: true, addressCounts: addr })
    expect(r.basis).toBe('addresses')
    // Durchschnitt 40 / 140 Adressen
    expect(r.plz_average).toBeCloseTo(40 / 140, 6)
    expect(r.ratings.get(k('A-Straße'))!.rating).toBe('orange')   // 20 / 28,6 = 0,7
    expect(r.ratings.get(k('B-Straße'))!.rating).toBe('green')    // 12 / 2,86 = 4,2
    // C: erwartet 2,86 < 3 → zu klein für eine sichere Aussage, NICHT rot
    expect(r.ratings.get(k('C-Straße'))!.rating).toBe('green')    // 6 ≥ 3 und über Erwartung
    expect(r.ratings.get(k('D-Straße'))!.rating).toBe('none')
    expect(r.ratings.get(k('E-Straße'))!.rating).toBe('none')
  })
  it('Adressen nur für wenige Straßen bekannt: Vergleich je Straße', () => {
    const r = rateStreets({ streets, directoryComplete: true, addressCounts: { [k('A-Straße')]: 50 } })
    expect(r.basis).toBe('streets')
  })
  it('Adressen fehlen für eine Straße: diese nicht bewertbar, nicht rot', () => {
    const addr = { [k('A-Straße')]: 10, [k('B-Straße')]: 10, [k('C-Straße')]: 10, [k('D-Straße')]: 10 }
    const r = rateStreets({ streets, directoryComplete: true, addressCounts: addr })
    expect(r.basis).toBe('addresses')
    expect(r.ratings.get(k('E-Straße'))!.rating).toBe('none')
    expect(r.ratings.get(k('E-Straße'))!.reason).toContain('keine Hausadressen')
  })
  it('unvollständiges Verzeichnis: alles grau, nie rot', () => {
    const r = rateStreets({ streets, directoryComplete: false })
    expect([...r.ratings.values()].every(x => x.rating === 'none')).toBe(true)
  })
  it(`zu wenige Bestellungen (< ${MIN_PLZ_ORDERS}): alles grau`, () => {
    const r = rateStreets({ streets: [{ street_name: 'X', order_count: 10 }, { street_name: 'Y', order_count: 0 }], directoryComplete: true })
    expect([...r.ratings.values()].every(x => x.rating === 'none')).toBe(true)
    expect(r.summary).toContain('mindestens 30')
  })
  it('branchenunabhängig: zehnfaches Volumen ergibt dieselben Farben', () => {
    const a = rateStreets({ streets, directoryComplete: true })
    const b = rateStreets({ streets: streets.map(s => ({ ...s, order_count: s.order_count * 10 })), directoryComplete: true })
    for (const [k, v] of a.ratings) expect(b.ratings.get(k)!.rating).toBe(v.rating)
  })
})
