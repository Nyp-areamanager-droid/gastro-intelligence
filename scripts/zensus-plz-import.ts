/*
 * Einwohner und Haushalte je PLZ aus den Zensus-2022-Gitterdaten berechnen
 * und als SQL für die Tabelle postal_codes ausgeben (mit Herkunft und Methode).
 *
 * Aufruf (auf einem Rechner mit Internet, NICHT gegen Produktion ausführen
 * ohne Freigabe – das Skript schreibt selbst nichts in eine Datenbank):
 *
 *   npx tsx scripts/zensus-plz-import.ts \
 *     --plz plz-flaechen.geojson \
 *     --einwohner Zensus2022_Bevoelkerungszahl_100m-Gitter.csv \
 *     [--haushalte Zensus2022_Groesse_des_privaten_Haushalts_100m-Gitter.csv --haushalte-spalte Insgesamt] \
 *     [--x x_mp_100m --y y_mp_100m --einwohner-spalte Einwohner] \
 *     --out zensus-plz.sql
 *
 * Eingaben:
 *   - PLZ-Flächen als GeoJSON (FeatureCollection, Polygon/MultiPolygon,
 *     PLZ in properties.postal_code oder properties.plz), z. B. aus
 *     OpenStreetMap (boundary=postal_code, Lizenz ODbL).
 *   - Zensus-Gitter-CSV(s) von Destatis, 100-m-Gitter, Trennzeichen „;“.
 *     Spaltennamen vorher in der Datensatzbeschreibung prüfen.
 * Ausgabe:
 *   - SQL mit INSERT … ON CONFLICT für postal_codes
 *   - Bericht (gleicher Name, .csv): je PLZ Zellen, fehlende Zellwerte
 */
import { createReadStream, readFileSync, writeFileSync } from 'fs'
import { createInterface } from 'readline'
import { PlzAssigner, createAggregator, featureToPolygon, findColumns, parseCellValue, type PlzAggregate } from '../src/lib/geo/zensus-grid'
import { ZENSUS_METHOD } from '../src/lib/geo/population'

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

async function* readCells(file: string, x: string, y: string, value: string) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  let cols: ReturnType<typeof findColumns> | null = null
  for await (const line of rl) {
    if (!line.trim()) continue
    const parts = line.split(';')
    if (!cols) { cols = findColumns(parts, { x, y, value }); continue }
    const cx = Number(parts[cols.x]), cy = Number(parts[cols.y])
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue
    yield { x: cx, y: cy, value: parseCellValue(parts[cols.value]) }
  }
}

async function main() {
  const plzFile = arg('plz'), popFile = arg('einwohner'), hhFile = arg('haushalte'), out = arg('out', 'zensus-plz.sql')!
  if (!plzFile || !popFile) {
    console.error('Bitte --plz <geojson> und --einwohner <csv> angeben (siehe Kopf der Datei).')
    process.exit(1)
  }
  const x = arg('x', 'x_mp_100m')!, y = arg('y', 'y_mp_100m')!

  const geo = JSON.parse(readFileSync(plzFile, 'utf8'))
  const polys: { plz: string; polygon: NonNullable<ReturnType<typeof featureToPolygon>> }[] = []
  for (const f of geo.features || []) {
    const plz = String(f.properties?.postal_code ?? f.properties?.plz ?? '')
    const polygon = f.geometry ? featureToPolygon(f.geometry) : null
    if (/^\d{5}$/.test(plz) && polygon) polys.push({ plz, polygon })
  }
  console.log(`${polys.length} PLZ-Flächen gelesen`)
  const assigner = new PlzAssigner(polys)

  const pop = await aggregateFile(assigner, popFile, x, y, arg('einwohner-spalte', 'Einwohner')!)
  console.log(`Einwohner: ${pop.byPlz.size} PLZ, ${pop.outside} Zellen außerhalb aller PLZ-Flächen`)
  const hh = hhFile ? await aggregateFile(assigner, hhFile, x, y, arg('haushalte-spalte', 'Insgesamt')!) : null
  if (hh) console.log(`Haushalte: ${hh.byPlz.size} PLZ`)

  const esc = (s: string) => s.replace(/'/g, "''")
  const lines = [
    '-- Einwohner/Haushalte je PLZ aus Zensus 2022 (Destatis, Gitterdaten 100 m, Stichtag 15.05.2022),',
    '-- Zellen über ihren Mittelpunkt den PLZ-Flächen zugeordnet. Quelle bitte mit Namensnennung angeben.',
    `-- Erzeugt am ${new Date().toISOString()} aus ${esc(plzFile)}, ${esc(popFile)}${hhFile ? ', ' + esc(hhFile) : ''}`,
    'BEGIN;',
  ]
  const report = ['plz;einwohner;zellen;zellen_ohne_wert;haushalte;haushalte_zellen_ohne_wert']
  for (const p of polys) {
    const a: PlzAggregate | undefined = pop.byPlz.get(p.plz)
    if (!a) continue
    const h = hh?.byPlz.get(p.plz)
    const population = Math.round(a.sum)
    const households = h ? Math.round(h.sum) : null
    report.push([p.plz, population, a.cells, a.missing_cells, households ?? '', h?.missing_cells ?? ''].join(';'))
    lines.push(
      `INSERT INTO public.postal_codes (postal_code, city, population, households, population_source, population_year, population_method, population_reference_date) ` +
      `VALUES ('${p.plz}', '${p.plz}', ${population}, ${households ?? 'NULL'}, 'census', 2022, '${ZENSUS_METHOD}', '2022-05-15') ` +
      `ON CONFLICT (postal_code) DO UPDATE SET population = EXCLUDED.population, households = EXCLUDED.households, ` +
      `population_source = EXCLUDED.population_source, population_year = EXCLUDED.population_year, ` +
      `population_method = EXCLUDED.population_method, population_reference_date = EXCLUDED.population_reference_date;`,
    )
  }
  lines.push('COMMIT;')
  writeFileSync(out, lines.join('\n') + '\n')
  writeFileSync(out.replace(/\.sql$/, '') + '.csv', report.join('\n') + '\n')
  console.log(`Geschrieben: ${out} und Bericht ${out.replace(/\.sql$/, '')}.csv`)
}

async function aggregateFile(assigner: PlzAssigner, file: string, x: string, y: string, value: string) {
  const agg = createAggregator(assigner)
  for await (const c of readCells(file, x, y, value)) agg.add(c)
  return agg.result()
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
