// =============================================================================
// Zensus 2022 Gitterdaten → Einwohner und Haushalte je PLZ
//
// Quelle: Statistisches Bundesamt (Destatis), Zensus 2022, Gitterdaten
// (100-m-Gitter, CSV), Stichtag 15.05.2022. Destatis stellt sie „zur freien
// Nutzung (mit Namensnennung) als OpenData“ bereit.
//
// Die Zellen liegen im europäischen Gitter ETRS89-LAEA (EPSG:3035), die
// Koordinaten in der CSV sind die Zellmittelpunkte. Jede Zelle wird über ihren
// Mittelpunkt GENAU EINER PLZ-Fläche zugeordnet (PLZ-Flächen aus OSM).
// Das Ergebnis ist eine nachvollziehbare Summe amtlicher Zahlen, kein
// amtlicher PLZ-Wert: Zellen auf der PLZ-Grenze fallen ganz auf eine Seite.
// Geheimgehaltene oder fehlende Zellwerte werden NICHT geschätzt, sondern
// gezählt und im Ergebnis ausgewiesen.
// =============================================================================

import { indexPolygon, pointInPolygon, type PlzPolygon, type PolygonIndex, type LngLat } from '@/lib/geo/plz-geometry'

// ── ETRS89-LAEA (EPSG:3035) → WGS84, Formeln nach Snyder (1987) ─────────────
const A = 6378137
const F = 1 / 298.257222101
const E2 = 2 * F - F * F
const E = Math.sqrt(E2)
const LAT0 = 52 * Math.PI / 180
const LON0 = 10 * Math.PI / 180
const FE = 4321000
const FN = 3210000

const q = (phi: number) => {
  const s = Math.sin(phi)
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)))
}
const QP = q(Math.PI / 2)
const BETA1 = Math.asin(q(LAT0) / QP)
const RQ = A * Math.sqrt(QP / 2)
const D = A * (Math.cos(LAT0) / Math.sqrt(1 - E2 * Math.sin(LAT0) ** 2)) / (RQ * Math.cos(BETA1))

/** EPSG:3035 (Meter) → [Länge, Breite] in Grad (WGS84/ETRS89). */
export function laeaToLngLat(x: number, y: number): LngLat {
  const X = x - FE, Y = y - FN
  const rho = Math.sqrt((X / D) ** 2 + (D * Y) ** 2)
  if (rho < 1e-9) return [LON0 * 180 / Math.PI, LAT0 * 180 / Math.PI]
  const C = 2 * Math.asin(rho / (2 * RQ))
  const beta = Math.asin(Math.cos(C) * Math.sin(BETA1) + (D * Y * Math.sin(C) * Math.cos(BETA1)) / rho)
  const lon = LON0 + Math.atan2(X * Math.sin(C), D * rho * Math.cos(BETA1) * Math.cos(C) - D * D * Y * Math.sin(BETA1) * Math.sin(C))
  const e4 = E2 * E2, e6 = e4 * E2
  const lat = beta
    + (E2 / 3 + 31 * e4 / 180 + 517 * e6 / 5040) * Math.sin(2 * beta)
    + (23 * e4 / 360 + 251 * e6 / 3780) * Math.sin(4 * beta)
    + (761 * e6 / 45360) * Math.sin(6 * beta)
  return [lon * 180 / Math.PI, lat * 180 / Math.PI]
}

// ── CSV-Spalten ───────────────────────────────────────────────────────────────

export interface GridColumns { x: number; y: number; value: number }

/** Spalten finden; bricht mit klarer Meldung ab, wenn sie fehlen. */
export function findColumns(header: string[], names: { x: string; y: string; value: string }): GridColumns {
  const clean = header.map(h => h.trim().replace(/^﻿/, '').replace(/^"|"$/g, ''))
  const find = (n: string) => clean.findIndex(h => h.toLowerCase() === n.toLowerCase())
  const cols = { x: find(names.x), y: find(names.y), value: find(names.value) }
  const missing = Object.entries(cols).filter(([, i]) => i < 0).map(([k]) => (names as Record<string, string>)[k])
  if (missing.length) {
    throw new Error(`Spalte(n) nicht gefunden: ${missing.join(', ')}. Vorhanden: ${clean.join(', ')}. Bitte die Datensatzbeschreibung von Destatis prüfen und die Spaltennamen angeben.`)
  }
  return cols
}

/** Zellwert lesen. Nicht-Zahlen (z. B. Geheimhaltungszeichen) → null. */
export function parseCellValue(raw: string | undefined): number | null {
  const s = (raw ?? '').trim().replace(/^"|"$/g, '')
  if (!/^-?\d+([.,]\d+)?$/.test(s)) return null
  const n = Number(s.replace(',', '.'))
  return n >= 0 ? n : null
}

// ── Zuordnung Zelle → PLZ ─────────────────────────────────────────────────────

export interface PlzAggregate { plz: string; sum: number; cells: number; missing_cells: number }

export class PlzAssigner {
  private tiles = new Map<string, { plz: string; idx: PolygonIndex }[]>()
  private static TILE = 0.05 // Grad

  constructor(plzPolygons: { plz: string; polygon: PlzPolygon }[]) {
    for (const p of plzPolygons) {
      const idx = indexPolygon(p.polygon)
      const [w, s, e, n] = idx.bbox
      for (let tx = Math.floor(w / PlzAssigner.TILE); tx <= Math.floor(e / PlzAssigner.TILE); tx++) {
        for (let ty = Math.floor(s / PlzAssigner.TILE); ty <= Math.floor(n / PlzAssigner.TILE); ty++) {
          const k = `${tx}|${ty}`
          const list = this.tiles.get(k)
          if (list) list.push({ plz: p.plz, idx }); else this.tiles.set(k, [{ plz: p.plz, idx }])
        }
      }
    }
  }

  /** PLZ, in der der Punkt liegt, oder null. */
  find(pt: LngLat): string | null {
    const k = `${Math.floor(pt[0] / PlzAssigner.TILE)}|${Math.floor(pt[1] / PlzAssigner.TILE)}`
    for (const c of this.tiles.get(k) || []) if (pointInPolygon(c.idx, pt)) return c.plz
    return null
  }
}

/** Zellen einzeln hinzufügen (für große Dateien, ohne alles in den Speicher zu laden). */
export function createAggregator(assigner: PlzAssigner) {
  const byPlz = new Map<string, PlzAggregate>()
  let outside = 0
  return {
    add(c: { x: number; y: number; value: number | null }) {
      const plz = assigner.find(laeaToLngLat(c.x, c.y))
      if (!plz) { outside++; return }
      let a = byPlz.get(plz)
      if (!a) { a = { plz, sum: 0, cells: 0, missing_cells: 0 }; byPlz.set(plz, a) }
      a.cells++
      if (c.value === null) a.missing_cells++
      else a.sum += c.value
    },
    result: () => ({ byPlz, outside }),
  }
}

/** Zellen (Mittelpunkt in EPSG:3035 + Wert) zu Summen je PLZ zusammenfassen. */
export function aggregateCells(assigner: PlzAssigner, cells: Iterable<{ x: number; y: number; value: number | null }>) {
  const agg = createAggregator(assigner)
  for (const c of cells) agg.add(c)
  return agg.result()
}

/** GeoJSON-Feature (Polygon/MultiPolygon) → PlzPolygon */
export function featureToPolygon(geometry: { type: string; coordinates: unknown }): PlzPolygon | null {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates as LngLat[][]]
    : geometry.type === 'MultiPolygon' ? geometry.coordinates as LngLat[][][] : null
  if (!polys) return null
  return { outer: polys.map(p => p[0]), inner: polys.flatMap(p => p.slice(1)) }
}
