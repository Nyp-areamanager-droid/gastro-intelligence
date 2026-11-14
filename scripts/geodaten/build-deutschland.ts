/*
 * Deutschlandweite Referenzdaten aufbereiten: Straßenverzeichnis, PLZ-Stammdaten,
 * Einwohner und Haushalte je PLZ. Schreibt NUR Dateien, nichts in eine Datenbank.
 * Laden: scripts/geodaten/laden.ts (nur Testdatenbank ohne Freigabe).
 *
 * Aufruf:
 *   npx tsx scripts/geodaten/build-deutschland.ts \
 *     --strassen  <openplzapi.data>/src/de/osm/streets.updated.csv \
 *     --plz       postleitzahlen.geojson            (yetzt/postleitzahlen, OSM) \
 *     --einwohner population_0.csv                   (Zensus 2022, 100 m, x_mp_100m;y_mp_100m;Einwohner) \
 *     --haushalte households_0.csv                   (Zensus 2022, 100 m, …;Insgesamt) \
 *     --quellen   quellen.json                       (Versionen/Commits der Quellen, für das Protokoll) \
 *     --out       ausgabe/
 *
 * Ausgabe:
 *   strassen.csv   postal_code,street_count,streets (JSON-Liste der Straßennamen je PLZ)
 *   orte.csv       postal_code,locality,locality_key,kind (Ort/Stadtbezirk/Stadtteil je PLZ)
 *   plz.csv        PLZ-Stammdaten mit Mittelpunkt, Ausdehnung, Fläche, Einwohnern, Haushalten
 *   manifest.json  Quellen, Lizenzen, Stand, Zählungen, SHA-256 der Ausgabedateien
 *
 * Keine Schätzung: Einwohner/Haushalte sind Summen der veröffentlichten
 * Zensus-Gitterzellen, deren Mittelpunkt in der PLZ-Fläche liegt. Geheim
 * gehaltene Zellen fehlen in der Quelle; das wird im Manifest beziffert.
 */
import { createHash } from 'crypto'
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'
import { join } from 'path'
import { PlzAssigner, createAggregator, featureToPolygon, findColumns, parseCellValue, type PlzAggregate } from '../../src/lib/geo/zensus-grid'
import type { PlzPolygon } from '../../src/lib/geo/plz-geometry'
import { ZENSUS_METHOD } from '../../src/lib/geo/population'
import { streetNameKey } from '../../src/lib/geo/street-name'
import { cleanDirectoryName, localityKey } from '../../src/lib/geo/address-match'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export const STATES: Record<string, string> = {
  '01': 'Schleswig-Holstein', '02': 'Hamburg', '03': 'Niedersachsen', '04': 'Bremen', '05': 'Nordrhein-Westfalen',
  '06': 'Hessen', '07': 'Rheinland-Pfalz', '08': 'Baden-Württemberg', '09': 'Bayern', '10': 'Saarland',
  '11': 'Berlin', '12': 'Brandenburg', '13': 'Mecklenburg-Vorpommern', '14': 'Sachsen', '15': 'Sachsen-Anhalt', '16': 'Thüringen',
}

/** Eine CSV-Zeile mit Anführungszeichen nach RFC 4180 zerlegen (Felder ohne Zeilenumbruch) */
export function splitCsvLine(line: string, sep = ','): string[] {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++ } else q = false } else cur += c
    } else if (c === '"') q = true
    else if (c === sep) { out.push(cur); cur = '' } else cur += c
  }
  out.push(cur)
  return out
}

const csvField = (v: unknown) => {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Fläche eines Rings auf der Kugel in m² (Formel wie geojson-area, R = 6378137 m) */
function ringArea(ring: [number, number][]): number {
  const R = 6378137, rad = Math.PI / 180
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    a += (x2 - x1) * rad * (2 + Math.sin(y1 * rad) + Math.sin(y2 * rad))
  }
  return Math.abs((a * R * R) / 2)
}

/** Flächenschwerpunkt (eben, in Grad – genügt zum Zentrieren der Karte) */
function ringCentroid(ring: [number, number][]): { a: number; x: number; y: number } {
  let a = 0, cx = 0, cy = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    const f = x1 * y2 - x2 * y1
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f
  }
  a /= 2
  return { a, x: a ? cx / (6 * a) : ring[0][0], y: a ? cy / (6 * a) : ring[0][1] }
}

export function polygonStats(polys: PlzPolygon[]) {
  let area = 0, w = 180, s = 90, e = -180, n = -90, sa = 0, sx = 0, sy = 0
  for (const p of polys) {
    for (const r of p.outer) {
      area += ringArea(r as [number, number][])
      const c = ringCentroid(r as [number, number][])
      sa += Math.abs(c.a); sx += c.x * Math.abs(c.a); sy += c.y * Math.abs(c.a)
      for (const [x, y] of r) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y }
    }
    for (const r of p.inner) area -= ringArea(r as [number, number][])
  }
  const round = (v: number, d = 7) => Math.round(v * 10 ** d) / 10 ** d
  return { area_km2: round(area / 1e6, 4), lng: round(sa ? sx / sa : (w + e) / 2), lat: round(sa ? sy / sa : (s + n) / 2), bbox: { west: round(w), south: round(s), east: round(e), north: round(n) } }
}

async function* lines(file: string) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  for await (const l of rl) if (l.trim()) yield l
}

async function aggregateGrid(assigner: PlzAssigner, file: string, valueCol: string) {
  const agg = createAggregator(assigner)
  let cols: ReturnType<typeof findColumns> | null = null, total = 0, rows = 0
  for await (const line of lines(file)) {
    const parts = line.split(';')
    if (!cols) { cols = findColumns(parts, { x: 'x_mp_100m', y: 'y_mp_100m', value: valueCol }); continue }
    const v = parseCellValue(parts[cols.value])
    rows++
    if (v !== null) total += v
    agg.add({ x: Number(parts[cols.x]), y: Number(parts[cols.y]), value: v })
  }
  return { ...agg.result(), total, rows }
}

// Zuverlässigkeit (siehe docs/geodaten-deutschland.md):
// Der Zensus hält Zellen mit sehr kleinen Werten geheim und verrauscht kleine
// Werte. Bei kleinen PLZ wiegt das schwer; Haushaltszahlen fehlen in dünn
// besiedelten Gebieten oft zellenweise, was sich als unplausible Haushalts-
// größe zeigt. Solche Haushaltszahlen werden nicht übernommen (leer statt falsch).
export const MIN_RELIABLE_POPULATION = 1000
export const HOUSEHOLD_SIZE_RANGE: [number, number] = [1.3, 3.0]
export const MIN_HOUSEHOLD_CELL_SHARE = 0.7

export function populationQuality(population: number): 'gut' | 'eingeschraenkt' | 'keine_bewohner' {
  if (population <= 0) return 'keine_bewohner'
  return population >= MIN_RELIABLE_POPULATION ? 'gut' : 'eingeschraenkt'
}

export function householdsQuality(population: number, households: number, popCells: number, hhCells: number): 'gut' | 'eingeschraenkt' | 'keine_bewohner' {
  if (population <= 0) return 'keine_bewohner'
  if (households <= 0) return 'eingeschraenkt'
  const size = population / households
  return size >= HOUSEHOLD_SIZE_RANGE[0] && size <= HOUSEHOLD_SIZE_RANGE[1] && hhCells >= MIN_HOUSEHOLD_CELL_SHARE * popCells ? 'gut' : 'eingeschraenkt'
}

const sha256 = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')

async function main() {
  const strassen = arg('strassen'), plzFile = arg('plz'), ew = arg('einwohner'), hh = arg('haushalte'), out = arg('out')
  if (!strassen || !plzFile || !ew || !hh || !out) {
    console.error('Aufruf siehe Kopf der Datei: --strassen --plz --einwohner --haushalte --out')
    process.exit(1)
  }
  const quellen = arg('quellen') ? JSON.parse(readFileSync(arg('quellen')!, 'utf8')) : {}
  mkdirSync(out, { recursive: true })
  const started = Date.now()

  // ── 1. Straßenverzeichnis ─────────────────────────────────────────────────
  // Je PLZ eine Liste eindeutiger Straßennamen (gleicher Vergleichsschlüssel =
  // eine Straße, auch wenn sie in mehreren Ortsteilen der PLZ vorkommt).
  const streetsByPlz = new Map<string, Map<string, string>>()
  const localityRows = new Set<string>()
  const nameAgs = new Set<string>()
  const plzLocalities = new Map<string, Map<string, { n: number; ags: string }>>()
  let read = 0, skipped = 0, dupes = 0
  let header: string[] | null = null
  for await (const line of lines(strassen)) {
    const f = splitCsvLine(line)
    if (!header) { header = f; continue }
    read++
    const [name0, plz, locality, ags, borough, suburb] = f
    const name = cleanDirectoryName(name0 || '')
    const key = streetNameKey(name)
    if (!/^\d{5}$/.test(plz || '') || !key || !locality) { skipped++; continue }
    nameAgs.add(`${ags}|${key}`)
    let byKey = streetsByPlz.get(plz)
    if (!byKey) { byKey = new Map(); streetsByPlz.set(plz, byKey) }
    if (byKey.has(key)) dupes++; else byKey.set(key, name)
    for (const [loc, kind] of [[locality, 'ort'], [borough, 'bezirk'], [suburb, 'stadtteil']] as const) {
      const lk = localityKey(loc)
      if (lk) localityRows.add([plz, loc, lk, kind].map(csvField).join(','))
    }
    let m = plzLocalities.get(plz)
    if (!m) { m = new Map(); plzLocalities.set(plz, m) }
    const c = m.get(locality)
    if (c) c.n++; else m.set(locality, { n: 1, ags: ags || '' })
  }
  const streetRows = ['postal_code,street_count,streets']
  let streetCount = 0
  for (const plz of [...streetsByPlz.keys()].sort()) {
    const names = [...streetsByPlz.get(plz)!.values()].sort((a, b) => a.localeCompare(b, 'de'))
    streetCount += names.length
    streetRows.push([plz, names.length, JSON.stringify(names)].map(csvField).join(','))
  }
  writeFileSync(join(out, 'strassen.csv'), streetRows.join('\n') + '\n')
  writeFileSync(join(out, 'orte.csv'), ['postal_code,locality,locality_key,kind', ...[...localityRows].sort()].join('\n') + '\n')
  console.log(`Straßen: ${read} gelesen, ${streetCount} eindeutig je PLZ, ${dupes} zusammengefasst, ${skipped} unbrauchbar; ${localityRows.size} Ortseinträge`)

  // ── 2. PLZ-Flächen ────────────────────────────────────────────────────────
  const geo = JSON.parse(readFileSync(plzFile, 'utf8'))
  const polysByPlz = new Map<string, PlzPolygon[]>()
  for (const feat of geo.features || []) {
    const plz = String(feat.properties?.postal_code ?? feat.properties?.postcode ?? feat.properties?.plz ?? '')
    const poly = feat.geometry ? featureToPolygon(feat.geometry) : null
    if (!/^\d{5}$/.test(plz) || !poly) continue
    const list = polysByPlz.get(plz)
    if (list) list.push(poly); else polysByPlz.set(plz, [poly])
  }
  const assigner = new PlzAssigner([...polysByPlz].flatMap(([plz, ps]) => ps.map(polygon => ({ plz, polygon }))))
  console.log(`PLZ-Flächen: ${polysByPlz.size} PLZ`)

  // ── 3. Zensus 2022 ────────────────────────────────────────────────────────
  const pop = await aggregateGrid(assigner, ew, 'Einwohner')
  const hhs = await aggregateGrid(assigner, hh, 'Insgesamt')
  const assignedPop = [...pop.byPlz.values()].reduce((s, a) => s + a.sum, 0)
  console.log(`Einwohner: Gitter ${pop.total}, zugeordnet ${assignedPop}, Zellen außerhalb ${pop.outside}`)

  // ── 4. PLZ-Stammdaten ─────────────────────────────────────────────────────
  const allPlz = [...new Set([...polysByPlz.keys(), ...plzLocalities.keys()])].sort()
  const plzRows = ['postal_code,city,ags,state,lat,lng,bbox_south,bbox_north,bbox_west,bbox_east,area_km2,population,households,population_density,avg_household_size,population_cells,households_cells,population_quality,households_quality,households_zensus_roh,has_area,has_streets']
  let withPop = 0, withHh = 0, withArea = 0, withStreets = 0, hhLimited = 0, popLimited = 0
  for (const plz of allPlz) {
    const locs = plzLocalities.get(plz)
    const main = locs ? [...locs].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))[0] : null
    const polys = polysByPlz.get(plz)
    const st = polys ? polygonStats(polys) : null
    const p: PlzAggregate | undefined = polys ? pop.byPlz.get(plz) : undefined
    const h: PlzAggregate | undefined = polys ? hhs.byPlz.get(plz) : undefined
    // Ohne PLZ-Fläche kann nichts zugeordnet werden → unbekannt, nicht 0.
    // Mit Fläche, aber ohne bewohnte Zelle → 0 (z. B. Gewerbe-/Postfach-PLZ).
    const population = polys ? Math.round(p?.sum ?? 0) : null
    const hhRaw = polys ? Math.round(h?.sum ?? 0) : null
    const popQ = population !== null ? populationQuality(population) : null
    const hhQ = population !== null && hhRaw !== null ? householdsQuality(population, hhRaw, p?.cells ?? 0, h?.cells ?? 0) : null
    // Lückenhafte Haushaltszahlen werden NICHT übernommen
    const households = hhQ === 'gut' ? hhRaw : hhQ === 'keine_bewohner' ? 0 : null
    if (population !== null) withPop++
    if (households !== null) withHh++
    if (hhQ === 'eingeschraenkt') hhLimited++
    if (popQ === 'eingeschraenkt') popLimited++
    if (polys) withArea++
    if (locs) withStreets++
    const ags = main?.[1].ags || ''
    plzRows.push([
      plz, main?.[0] || plz, ags, STATES[ags.slice(0, 2)] || '',
      st?.lat ?? '', st?.lng ?? '', st?.bbox.south ?? '', st?.bbox.north ?? '', st?.bbox.west ?? '', st?.bbox.east ?? '',
      st?.area_km2 ?? '', population ?? '', households ?? '',
      population !== null && st && st.area_km2 > 0 ? Math.round((population / st.area_km2) * 100) / 100 : '',
      population && households ? Math.round((population / households) * 100) / 100 : '',
      p?.cells ?? (polys ? 0 : ''), h?.cells ?? (polys ? 0 : ''), popQ ?? '', hhQ ?? '', hhRaw ?? '', polys ? 1 : 0, locs ? 1 : 0,
    ].map(csvField).join(','))
  }
  writeFileSync(join(out, 'plz.csv'), plzRows.join('\n') + '\n')

  const manifest = {
    erstellt: new Date().toISOString(),
    dauer_s: Math.round((Date.now() - started) / 1000),
    methode_einwohner: ZENSUS_METHOD,
    stichtag_einwohner: '2022-05-15',
    quellen: {
      strassen: { beschreibung: 'OpenPLZ API Data – Straßen Deutschland aus OpenStreetMap (streets.updated.csv)', lizenz: 'ODbL 1.0, © OpenStreetMap-Mitwirkende', url: 'https://github.com/openpotato/openplzapi.data', datei_sha256: sha256(strassen), ...quellen.strassen },
      plz_flaechen: { beschreibung: 'PLZ-Gebiete aus OpenStreetMap (boundary=postal_code)', lizenz: 'ODbL 1.0, © OpenStreetMap-Mitwirkende', url: 'https://github.com/yetzt/postleitzahlen', stand: geo.timestamp || null, datei_sha256: sha256(plzFile), ...quellen.plz_flaechen },
      zensus: { beschreibung: 'Zensus 2022, Gitterdaten 100 m: Einwohner, Haushalte (Statistisches Bundesamt)', lizenz: 'Datenlizenz Deutschland – Namensnennung – 2.0, © Statistisches Bundesamt (Destatis)', url: 'https://www.zensus2022.de', aufbereitung: 'https://github.com/JsLth/z22data (Parquet, unverändert in CSV umgewandelt)', einwohner_sha256: sha256(ew), haushalte_sha256: sha256(hh), ...quellen.zensus },
    },
    zaehlung: {
      strassen_zeilen_quelle: read,
      strassen_eintraege: streetCount,
      strassen_zusammengefasst: dupes,
      strassen_plz_zeilen: streetRows.length - 1,
      orte_eintraege: localityRows.size,
      strassen_eindeutig_name_gemeinde: nameAgs.size,
      strassen_unbrauchbar: skipped,
      plz_gesamt: allPlz.length,
      plz_mit_strassen: withStreets,
      plz_mit_flaeche: withArea,
      plz_nur_flaeche: [...polysByPlz.keys()].filter(p => !plzLocalities.has(p)).sort(),
      plz_nur_strassen: [...plzLocalities.keys()].filter(p => !polysByPlz.has(p)).sort(),
      plz_mit_einwohnern: withPop,
      plz_mit_haushalten: withHh,
      plz_einwohner_eingeschraenkt: popLimited,
      plz_haushalte_nicht_uebernommen: hhLimited,
      gemeindeschluessel: new Set([...plzLocalities.values()].flatMap(m => [...m.values()].map(v => v.ags))).size,
      orte: new Set([...plzLocalities.values()].flatMap(m => [...m.keys()])).size,
      einwohner_gitter_summe: pop.total,
      einwohner_gitter_zellen: pop.rows,
      einwohner_zugeordnet: Math.round(assignedPop),
      einwohner_zellen_ausserhalb: pop.outside,
      haushalte_gitter_summe: hhs.total,
      haushalte_zugeordnet: Math.round([...hhs.byPlz.values()].reduce((s, a) => s + a.sum, 0)),
    },
    dateien: {
      'strassen.csv': sha256(join(out, 'strassen.csv')),
      'plz.csv': sha256(join(out, 'plz.csv')),
      'orte.csv': sha256(join(out, 'orte.csv')),
    },
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(JSON.stringify(manifest.zaehlung, null, 1))
}

if (process.argv[1] && /build-deutschland/.test(process.argv[1])) {
  main().catch(e => { console.error(e instanceof Error ? e.stack : e); process.exit(1) })
}
