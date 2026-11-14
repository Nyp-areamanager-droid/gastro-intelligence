// Potenzialgebiete in der Nachbarschaft – mit echten Zensus-/OSM-Werten aus dem Testauszug
import { describe, it, expect } from 'vitest'
import { distanceKm, findNearbyPotential, queryBounds, NEARBY_RULES, type PlzCandidate } from '../src/lib/insights/nearby'
import { buildRecommendations } from '../src/lib/insights/recommendations'
import { buildOverview } from '../src/lib/insights/overview'

describe('Entfernung', () => {
  it('Köln Dom – Bonn Hbf rund 25 km', () => {
    expect(distanceKm({ lat: 50.9413, lng: 6.9583 }, { lat: 50.7323, lng: 7.0969 })).toBeGreaterThan(24)
    expect(distanceKm({ lat: 50.9413, lng: 6.9583 }, { lat: 50.7323, lng: 7.0969 })).toBeLessThan(27)
  })
})

describe('Nachbargebiete', () => {
  const M = 'zensus2022_gitter100m_plz_osm'
  const own = [{ postal_code: '50733', lat: 50.962, lng: 6.94 }, { postal_code: '50823', lat: 50.951, lng: 6.927 }]
  const cand = (postal_code: string, lat: number, lng: number, population: number | null, method: string | null = M, households: number | null = 1000): PlzCandidate => ({ postal_code, lat, lng, population, households, population_method: method, city: 'Köln' })
  it('nur benachbart, nicht beliefert, mit belegter und belastbarer Einwohnerzahl', () => {
    const r = findNearbyPotential(own, [
      cand('50733', 50.962, 6.94, 35530),                 // eigene PLZ
      cand('50735', 50.972, 6.95, 30000),                 // ~1,3 km → ja
      cand('50737', 50.982, 6.94, 25000, null),           // ohne Methode → nein (nicht belegt)
      cand('50739', 50.985, 6.93, 800),                   // < 1.000 Einwohner → nein
      cand('53111', 50.733, 7.10, 40000),                 // Bonn, weit weg → nein
      cand('50825', 50.945, 6.915, 28000, M, null),       // Haushalte unbekannt bleibt null
    ])
    expect(r.items.map(x => x.postal_code)).toEqual(['50735', '50825'])
    expect(r.items[1].households).toBeNull()
    expect(r.max_km).toBe(NEARBY_RULES.MIN_KM)            // Abstand der eigenen PLZ ~1,5 km → Mindestwert 3 km
    expect(r.items[0].nearest_own_plz).toBe('50733')
  })
  it('ländlich: Grenze wächst mit dem Abstand der eigenen PLZ, höchstens 10 km', () => {
    const rural = [{ postal_code: '54595', lat: 50.22, lng: 6.42 }, { postal_code: '54597', lat: 50.30, lng: 6.55 }]
    const r = findNearbyPotential(rural, [cand('54608', 50.36, 6.62, 5000)])
    expect(r.max_km).toBeGreaterThan(3); expect(r.max_km).toBeLessThanOrEqual(10)
  })
  it('ohne Koordinaten: kein Ergebnis, keine Annahme', () => {
    expect(findNearbyPotential([{ postal_code: '1', lat: null, lng: null }], [cand('2', 50, 6, 5000)]).items).toEqual([])
    expect(queryBounds([{ postal_code: '1', lat: null, lng: null }])).toBeNull()
  })
  it('Empfehlung nennt Einwohner, Entfernung und Quelle; ohne Nachbargebiete keine Empfehlung', () => {
    const o = buildOverview({ customers: [{ upload_id: 'u1', customer_ref: 'K1', postal_code: '50733', total_orders: 3, total_revenue: 60 }],
      uploads: [{ id: 'u1', filename: 'a.csv', period_start: null, period_end: null, created_at: '2026-11-01' }], postalCodes: [], directories: [], streetRows: [] })
    expect(o.empty).toBe(false)
    expect(buildRecommendations(o).some(r => r.kind === 'nearby_potential')).toBe(false)
    o.nearby = { items: [{ postal_code: '50735', city: 'Köln', population: 30000, households: 15000, nearest_own_plz: '50733', distance_km: 1.3 }], max_km: 3, checked: 4 }
    const rec = buildRecommendations(o).find(r => r.kind === 'nearby_potential')!
    expect(rec.evidence[0]).toBe('PLZ 50735 (Köln): 30.000 Einwohner, 15.000 Haushalte (Zensus 2022), 1,3 km vom Mittelpunkt Ihrer PLZ 50733, 0 Bestellungen.')
    expect(rec.confidence.level).toBe('mittel')
    expect(rec.postal_codes).toEqual(['50735'])
  })
})
