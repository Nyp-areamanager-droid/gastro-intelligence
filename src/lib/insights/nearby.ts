// =============================================================================
// Potenzialgebiete in der Nachbarschaft
//
// Postleitzahlen direkt neben dem eigenen Liefergebiet, aus denen noch keine
// Bestellung kommt, mit belegter Einwohnerzahl (Zensus 2022). Keine Prognose:
// gezeigt werden nur Fakten (Einwohner, Haushalte, Entfernung zur nächsten
// eigenen PLZ). Ob ein Gebiet beliefert werden kann, entscheidet der Betrieb.
//
// „Nachbarschaft“: Der Mittelpunkt der PLZ liegt höchstens MAX_KM von einem
// eigenen PLZ-Mittelpunkt entfernt. MAX_KM richtet sich nach dem typischen
// Abstand zwischen den eigenen PLZ (Stadt: eng, Land: weiter), mindestens
// 3 km, höchstens 10 km.
// =============================================================================

import { MIN_RELIABLE_POPULATION } from '@/lib/geo/population'

export const NEARBY_RULES = {
  MIN_KM: 3,
  MAX_KM: 10,
  /** Faktor auf den mittleren Abstand benachbarter eigener PLZ */
  SPREAD_FACTOR: 1.3,
  MAX_RESULTS: 8,
  /** Rand um die eigenen PLZ für die Abfrage (Grad, ca. 11 km) */
  QUERY_MARGIN_DEG: 0.1,
} as const

export interface PlzPoint { postal_code: string; lat: number | null; lng: number | null }
export interface PlzCandidate extends PlzPoint {
  city?: string | null
  population: number | null
  households: number | null
  population_method: string | null
}
export interface NearbyPotential {
  postal_code: string
  city: string | null
  population: number
  households: number | null
  nearest_own_plz: string
  distance_km: number
}
export interface NearbyResult { items: NearbyPotential[]; max_km: number; checked: number }

/** Entfernung zweier Punkte auf der Erde in km (Haversine) */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

const hasPos = (p: PlzPoint): p is PlzPoint & { lat: number; lng: number } => typeof p.lat === 'number' && typeof p.lng === 'number' && Number.isFinite(p.lat) && Number.isFinite(p.lng)

/** Grenzen der Abfrage: eigene PLZ plus Rand */
export function queryBounds(own: PlzPoint[]): { south: number; north: number; west: number; east: number } | null {
  const pts = own.filter(hasPos)
  if (!pts.length) return null
  const m = NEARBY_RULES.QUERY_MARGIN_DEG
  return {
    south: Math.min(...pts.map(p => p.lat)) - m, north: Math.max(...pts.map(p => p.lat)) + m,
    west: Math.min(...pts.map(p => p.lng)) - m * 1.6, east: Math.max(...pts.map(p => p.lng)) + m * 1.6,
  }
}

export function findNearbyPotential(own: PlzPoint[], candidates: PlzCandidate[]): NearbyResult {
  const ownPts = own.filter(hasPos)
  const ownSet = new Set(own.map(p => p.postal_code))
  if (!ownPts.length) return { items: [], max_km: NEARBY_RULES.MIN_KM, checked: 0 }
  // Typischer Abstand: Median der Entfernung jeder eigenen PLZ zur nächsten eigenen PLZ
  const nn = ownPts.length > 1
    ? ownPts.map(p => Math.min(...ownPts.filter(q => q !== p).map(q => distanceKm(p, q)))).sort((a, b) => a - b)
    : []
  const spread = nn.length ? nn[Math.floor(nn.length / 2)] * NEARBY_RULES.SPREAD_FACTOR : NEARBY_RULES.MIN_KM
  const maxKm = Math.round(Math.min(NEARBY_RULES.MAX_KM, Math.max(NEARBY_RULES.MIN_KM, spread)) * 10) / 10

  let checked = 0
  const items: NearbyPotential[] = []
  for (const c of candidates) {
    if (ownSet.has(c.postal_code) || !hasPos(c)) continue
    // Nur belegte und belastbare Einwohnerzahl
    if (!c.population_method || typeof c.population !== 'number' || c.population < MIN_RELIABLE_POPULATION) continue
    checked++
    let best = Infinity, bestPlz = ''
    for (const p of ownPts) { const d = distanceKm(c, p); if (d < best) { best = d; bestPlz = p.postal_code } }
    if (best > maxKm) continue
    items.push({ postal_code: c.postal_code, city: c.city ?? null, population: c.population, households: typeof c.households === 'number' && c.households > 0 ? c.households : null, nearest_own_plz: bestPlz, distance_km: Math.round(best * 10) / 10 })
  }
  items.sort((a, b) => b.population - a.population || a.distance_km - b.distance_km)
  return { items: items.slice(0, NEARBY_RULES.MAX_RESULTS), max_km: maxKm, checked }
}
