// =============================================================================
// PLZ-Fläche und Straßen aus OpenStreetMap (Overpass) für die Karte
//
// - Die PLZ-Fläche kommt als OSM-Relation boundary=postal_code. Ihre Außen-
//   und Innenringe werden aus den einzelnen Grenzlinien zusammengesetzt.
// - Straßen, die über die PLZ-Grenze hinausgehen, werden an der Grenze
//   abgeschnitten. Nur der Abschnitt innerhalb der PLZ wird angezeigt und
//   gefärbt; die Straße ist als „partial“ markiert.
// - Hausadressen (addr:street + addr:housenumber) werden je Straße gezählt.
//   Hausadressen sind KEINE Haushalte, sie dienen nur als Vergleichsgröße.
// Reine Rechenfunktionen ohne Netzwerk, damit sie testbar sind.
// =============================================================================

import { streetNameKey } from '@/lib/geo/street-name'

export type LngLat = [number, number]
export type Ring = LngLat[]
export interface PlzPolygon { outer: Ring[]; inner: Ring[] }

interface OverpassGeomPoint { lat: number; lon: number }
interface OverpassElement {
  type: 'node' | 'way' | 'relation'
  id: number
  tags?: Record<string, string>
  geometry?: OverpassGeomPoint[]
  members?: { type: string; role: string; geometry?: OverpassGeomPoint[] }[]
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
const toLngLat = (g: OverpassGeomPoint[]): LngLat[] => g.map(p => [round(p.lon), round(p.lat)])
const same = (a: LngLat, b: LngLat) => a[0] === b[0] && a[1] === b[1]

/** Grenzlinien einer Relation zu geschlossenen Ringen verbinden. */
export function assembleRings(lines: LngLat[][]): Ring[] {
  const open = lines.filter(l => l.length >= 2).map(l => [...l])
  const rings: Ring[] = []
  while (open.length) {
    let cur = open.shift()!
    let grown = true
    while (!same(cur[0], cur[cur.length - 1]) && grown) {
      grown = false
      for (let i = 0; i < open.length; i++) {
        const l = open[i]
        const end = cur[cur.length - 1]
        if (same(end, l[0])) cur = cur.concat(l.slice(1))
        else if (same(end, l[l.length - 1])) cur = cur.concat([...l].reverse().slice(1))
        else if (same(cur[0], l[l.length - 1])) cur = l.slice(0, -1).concat(cur)
        else if (same(cur[0], l[0])) cur = [...l].reverse().slice(0, -1).concat(cur)
        else continue
        open.splice(i, 1)
        grown = true
        break
      }
    }
    // Nur geschlossene Ringe sind Flächen; offene Reste (Datenfehler) fallen weg
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) rings.push(cur)
  }
  return rings
}

// ── Schneller Punkt-in-Fläche-Test über Kanten-Bänder ────────────────────────

interface Edge { x1: number; y1: number; x2: number; y2: number }
export interface PolygonIndex {
  polygon: PlzPolygon
  bbox: [number, number, number, number] // west, south, east, north
  bands: Edge[][]
  minY: number
  bandH: number
}

const BANDS = 256

export function indexPolygon(polygon: PlzPolygon): PolygonIndex {
  const all = [...polygon.outer, ...polygon.inner]
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const r of all) for (const [x, y] of r) {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y
  }
  const bandH = (n - s) / BANDS || 1e-9
  const bands: Edge[][] = Array.from({ length: BANDS }, () => [])
  for (const r of all) for (let i = 0; i < r.length - 1; i++) {
    const edge = { x1: r[i][0], y1: r[i][1], x2: r[i + 1][0], y2: r[i + 1][1] }
    const b0 = Math.max(0, Math.floor((Math.min(edge.y1, edge.y2) - s) / bandH))
    const b1 = Math.min(BANDS - 1, Math.floor((Math.max(edge.y1, edge.y2) - s) / bandH))
    for (let b = b0; b <= b1; b++) bands[b].push(edge)
  }
  return { polygon, bbox: [w, s, e, n], bands, minY: s, bandH }
}

/** Gerade-Ungerade-Regel über alle Ringe: innen = in einem Außenring, nicht in einem Loch. */
export function pointInPolygon(idx: PolygonIndex, [x, y]: LngLat): boolean {
  const [w, s, e, n] = idx.bbox
  if (x < w || x > e || y < s || y > n) return false
  const b = Math.min(BANDS - 1, Math.max(0, Math.floor((y - idx.minY) / idx.bandH)))
  let inside = false
  for (const ed of idx.bands[b]) {
    if ((ed.y1 > y) !== (ed.y2 > y)) {
      const xi = ed.x1 + (y - ed.y1) * (ed.x2 - ed.x1) / (ed.y2 - ed.y1)
      if (x < xi) inside = !inside
    }
  }
  return inside
}

function segmentParams(a: LngLat, b: LngLat, idx: PolygonIndex): number[] {
  const ts: number[] = []
  const y0 = Math.min(a[1], b[1]), y1 = Math.max(a[1], b[1])
  const b0 = Math.max(0, Math.floor((y0 - idx.minY) / idx.bandH))
  const b1 = Math.min(BANDS - 1, Math.floor((y1 - idx.minY) / idx.bandH))
  const seen = new Set<Edge>()
  const dx = b[0] - a[0], dy = b[1] - a[1]
  for (let k = b0; k <= b1; k++) for (const ed of idx.bands[k]) {
    if (seen.has(ed)) continue
    seen.add(ed)
    const ex = ed.x2 - ed.x1, ey = ed.y2 - ed.y1
    const den = dx * ey - dy * ex
    if (den === 0) continue
    const t = ((ed.x1 - a[0]) * ey - (ed.y1 - a[1]) * ex) / den
    const u = ((ed.x1 - a[0]) * dy - (ed.y1 - a[1]) * dx) / den
    if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t)
  }
  return ts.sort((p, q) => p - q)
}

/**
 * Schneidet eine Linie auf die PLZ-Fläche zu.
 * partial = true, wenn ein Teil der Linie außerhalb liegt.
 */
export function clipLine(line: LngLat[], idx: PolygonIndex): { parts: LngLat[][]; partial: boolean } {
  const parts: LngLat[][] = []
  let cur: LngLat[] = []
  let partial = false
  const lerp = (a: LngLat, b: LngLat, t: number): LngLat => [round(a[0] + (b[0] - a[0]) * t), round(a[1] + (b[1] - a[1]) * t)]
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1]
    const cuts = [0, ...segmentParams(a, b, idx), 1]
    for (let j = 0; j < cuts.length - 1; j++) {
      const p = lerp(a, b, cuts[j]), q = lerp(a, b, cuts[j + 1])
      const mid = lerp(a, b, (cuts[j] + cuts[j + 1]) / 2)
      if (pointInPolygon(idx, mid)) {
        if (!cur.length || !same(cur[cur.length - 1], p)) {
          if (cur.length >= 2) parts.push(cur)
          cur = [p]
        }
        cur.push(q)
      } else {
        partial = true
        if (cur.length >= 2) parts.push(cur)
        cur = []
      }
    }
  }
  if (cur.length >= 2) parts.push(cur)
  return { parts, partial }
}

// ── Overpass-Antwort → Karte ──────────────────────────────────────────────────

export interface PlzStreetFeature {
  type: 'Feature'
  geometry: { type: 'MultiLineString'; coordinates: LngLat[][] }
  properties: { name: string; key: string; osm_id: number; partial: boolean; highway: string }
}

export interface PlzMap {
  plz: string
  status: 'ok' | 'no_boundary'
  boundary: { type: 'Feature'; geometry: { type: 'MultiPolygon'; coordinates: LngLat[][][] }; properties: { plz: string } } | null
  bbox: [number, number, number, number] | null
  streets: PlzStreetFeature[]
  /** Anzahl verschiedener Hausadressen je Straße (Schlüssel wie streetNameKey) */
  address_counts: Record<string, number>
  address_total: number
  source: { name: 'OpenStreetMap'; license: 'ODbL 1.0'; attribution: '© OpenStreetMap-Mitwirkende'; fetched_at: string }
}

export function buildPlzMap(plz: string, elements: OverpassElement[], fetchedAt: string): PlzMap {
  const source = { name: 'OpenStreetMap' as const, license: 'ODbL 1.0' as const, attribution: '© OpenStreetMap-Mitwirkende' as const, fetched_at: fetchedAt }
  const rel = elements.find(e => e.type === 'relation' && e.tags?.boundary === 'postal_code' && e.tags?.postal_code === plz)
  const empty: PlzMap = { plz, status: 'no_boundary', boundary: null, bbox: null, streets: [], address_counts: {}, address_total: 0, source }
  if (!rel?.members) return empty

  const outerLines = rel.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry).map(m => toLngLat(m.geometry!))
  const innerLines = rel.members.filter(m => m.type === 'way' && m.role === 'inner' && m.geometry).map(m => toLngLat(m.geometry!))
  const polygon: PlzPolygon = { outer: assembleRings(outerLines), inner: assembleRings(innerLines) }
  if (!polygon.outer.length) return empty
  const idx = indexPolygon(polygon)

  const streets: PlzStreetFeature[] = []
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags?.highway || !el.tags?.name || !el.geometry?.length) continue
    const { parts, partial } = clipLine(toLngLat(el.geometry), idx)
    if (!parts.length) continue
    streets.push({
      type: 'Feature',
      geometry: { type: 'MultiLineString', coordinates: parts },
      properties: { name: el.tags.name, key: streetNameKey(el.tags.name), osm_id: el.id, partial, highway: el.tags.highway },
    })
  }

  // Hausadressen: verschiedene Kombinationen Straße + Hausnummer
  const addresses = new Set<string>()
  for (const el of elements) {
    const st = el.tags?.['addr:street'], hn = el.tags?.['addr:housenumber']
    if (!st || !hn) continue
    addresses.add(`${streetNameKey(st)}|${hn.trim().toLowerCase()}`)
  }
  const address_counts: Record<string, number> = {}
  for (const a of addresses) {
    const key = a.slice(0, a.lastIndexOf('|'))
    address_counts[key] = (address_counts[key] || 0) + 1
  }

  const rings = polygon.outer.map(o => [o, ...polygon.inner.filter(i => o.length && pointInPolygon(indexPolygon({ outer: [o], inner: [] }), i[0]))])
  return {
    plz, status: 'ok',
    boundary: { type: 'Feature', geometry: { type: 'MultiPolygon', coordinates: rings }, properties: { plz } },
    bbox: idx.bbox,
    streets,
    address_counts,
    address_total: addresses.size,
    source,
  }
}

/** Overpass-Abfrage: PLZ-Fläche, benannte Straßen darin, Hausadressen darin. */
export function overpassQuery(plz: string): string {
  if (!/^\d{5}$/.test(plz)) throw new Error('Ungültige PLZ')
  return `[out:json][timeout:90];
rel["boundary"="postal_code"]["postal_code"="${plz}"]->.r;
.r out geom;
.r map_to_area->.a;
way(area.a)["highway"~"^(primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|service|road|trunk|primary_link|secondary_link|tertiary_link)$"]["name"];
out geom;
nwr(area.a)["addr:street"]["addr:housenumber"];
out tags;`
}
