/*
 * Aufbereitete Deutschland-Referenzdaten (scripts/geodaten/build-deutschland.ts)
 * in eine Datenbank laden: street_directory ersetzen, postal_codes ergänzen.
 *
 * NUR gegen Test-/Wegwerfdatenbanken ohne Freigabe. Gegen das produktive
 * Supabase-Projekt verweigert das Skript den Lauf, solange nicht
 * GEODATEN_PRODUKTION_FREIGABE=ja gesetzt ist (Freigabe von Redouan nötig).
 *
 * Aufruf:
 *   npm install --no-save pg
 *   DATABASE_URL=postgres://… npx tsx scripts/geodaten/laden.ts --dir ausgabe/
 *   (lokal: --host /var/tmp/pgtest --port 54329 --db gipsec)
 *
 * Ablauf in EINER Transaktion: Dateien gegen manifest.json prüfen → in
 * Zwischentabellen laden → Zählungen prüfen → Verzeichnis ersetzen und PLZ
 * aktualisieren → Protokolleintrag. Schlägt etwas fehl, bleibt der alte
 * Stand vollständig erhalten.
 *
 * Firmendaten (Kunden, Auswertungen) werden nicht angefasst.
 */
import { createHash } from 'crypto'
import { createReadStream, readFileSync } from 'fs'
import { createInterface } from 'readline'
import { join } from 'path'
import { splitCsvLine } from './build-deutschland'
import { ZENSUS_METHOD } from '../../src/lib/geo/population'

const PRODUCTION_REF = 'ebxsbjaelgjnmfqtofet'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

export function refuseProduction(target: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (target.includes(PRODUCTION_REF) && env.GEODATEN_PRODUKTION_FREIGABE !== 'ja') {
    return 'Ziel ist das produktive Supabase-Projekt. Abbruch: Dafür ist eine ausdrückliche Freigabe nötig (GEODATEN_PRODUKTION_FREIGABE=ja).'
  }
  return null
}

async function* csvRows(file: string) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  let header: string[] | null = null
  for await (const line of rl) {
    if (!line) continue
    const f = splitCsvLine(line)
    if (!header) { header = f; continue }
    yield Object.fromEntries(header.map((h, i) => [h, f[i] ?? ''])) as Record<string, string>
  }
}

// PostgreSQL erlaubt höchstens 65.535 Parameter je Abfrage
export const MAX_PARAMS = 65535

async function insertBatches(client: { query: (q: string, v?: unknown[]) => Promise<unknown> }, table: string, cols: string[], rows: AsyncIterable<unknown[]>) {
  const batch = Math.floor((MAX_PARAMS - 1) / cols.length)
  let buf: unknown[][] = [], n = 0
  const flush = async () => {
    if (!buf.length) return
    const vals: unknown[] = []
    const tuples = buf.map(r => `(${r.map(v => { vals.push(v); return `$${vals.length}` }).join(',')})`)
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, vals)
    n += buf.length; buf = []
  }
  for await (const r of rows) { buf.push(r); if (buf.length >= batch) await flush() }
  await flush()
  return n
}

async function main() {
  const dir = arg('dir')
  if (!dir) { console.error('Bitte --dir <Ausgabeordner von build-deutschland> angeben.'); process.exit(1) }
  const url = process.env.DATABASE_URL
  const target = url || `${arg('host') || '/var/tmp/pgtest'}:${arg('port') || '54329'}/${arg('db') || 'gipsec'}`
  const refusal = refuseProduction(target)
  if (refusal) { console.error(refusal); process.exit(2) }

  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  for (const [file, hash] of Object.entries(manifest.dateien as Record<string, string>)) {
    const actual = createHash('sha256').update(readFileSync(join(dir, file))).digest('hex')
    if (actual !== hash) { console.error(`Abbruch: ${file} stimmt nicht mit manifest.json überein.`); process.exit(3) }
  }
  const version = `${String(manifest.erstellt).slice(0, 10)}/osm-${String(manifest.quellen?.strassen?.commit || '').slice(0, 7)}/zensus2022`

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('pg')
  const client = url
    ? new Client({ connectionString: url })
    : new Client({ host: arg('host') || '/var/tmp/pgtest', port: Number(arg('port') || 54329), user: arg('user') || 'postgres', database: arg('db') || 'gipsec' })
  await client.connect()
  client.on('notice', () => {})
  const started = Date.now()
  try {
    const has009 = (await client.query(`SELECT to_regclass('public.street_directory') IS NOT NULL AND to_regclass('public.plz_localities') IS NOT NULL AS t`)).rows[0].t
    if (!has009) throw new Error('Migration 009 fehlt (Tabellen street_directory/plz_localities). Es wurde nichts geändert.')
    await client.query('BEGIN')
    await client.query(`CREATE TEMP TABLE sd_neu (LIKE public.street_directory INCLUDING DEFAULTS) ON COMMIT DROP`)
    let nStreets = 0
    const nPlzStreets = await insertBatches(client, 'sd_neu', ['postal_code', 'streets', 'street_count', 'version'],
      (async function* () {
        for await (const r of csvRows(join(dir, 'strassen.csv'))) {
          const names = JSON.parse(r.streets) as string[]
          if (names.length !== Number(r.street_count)) throw new Error(`PLZ ${r.postal_code}: Straßenzahl passt nicht.`)
          nStreets += names.length
          yield [r.postal_code, names, names.length, version]
        }
      })())
    if (nStreets !== manifest.zaehlung.strassen_eintraege || nPlzStreets !== manifest.zaehlung.strassen_plz_zeilen) {
      throw new Error(`Straßen: ${nStreets} in ${nPlzStreets} PLZ geladen, laut Manifest ${manifest.zaehlung.strassen_eintraege} in ${manifest.zaehlung.strassen_plz_zeilen}. Abbruch.`)
    }
    await client.query(`CREATE TEMP TABLE orte_neu (LIKE public.plz_localities INCLUDING DEFAULTS) ON COMMIT DROP`)
    const nOrte = await insertBatches(client, 'orte_neu', ['postal_code', 'locality', 'locality_key', 'kind'],
      (async function* () { for await (const r of csvRows(join(dir, 'orte.csv'))) yield [r.postal_code, r.locality, r.locality_key, r.kind] })())
    if (nOrte !== manifest.zaehlung.orte_eintraege) throw new Error(`Orte: ${nOrte} geladen, laut Manifest ${manifest.zaehlung.orte_eintraege}. Abbruch.`)

    const plzCols = ['postal_code', 'city', 'ags', 'state', 'lat', 'lng', 'bbox_south', 'bbox_north', 'bbox_west', 'bbox_east', 'area_km2', 'population', 'households', 'population_density', 'avg_household_size', 'population_quality', 'households_quality']
    await client.query(`CREATE TEMP TABLE plz_neu (postal_code TEXT PRIMARY KEY, city TEXT, ags TEXT, state TEXT, lat NUMERIC, lng NUMERIC, bbox_south NUMERIC, bbox_north NUMERIC, bbox_west NUMERIC, bbox_east NUMERIC, area_km2 NUMERIC, population INTEGER, households INTEGER, population_density NUMERIC, avg_household_size NUMERIC, population_quality TEXT, households_quality TEXT) ON COMMIT DROP`)
    const nPlz = await insertBatches(client, 'plz_neu', plzCols,
      (async function* () { for await (const r of csvRows(join(dir, 'plz.csv'))) yield plzCols.map(c => r[c] === '' ? null : r[c]) })())
    if (nPlz !== manifest.zaehlung.plz_gesamt) throw new Error(`PLZ: ${nPlz} geladen, laut Manifest ${manifest.zaehlung.plz_gesamt}. Abbruch.`)

    await client.query('DELETE FROM public.street_directory')
    await client.query('INSERT INTO public.street_directory SELECT * FROM sd_neu')
    await client.query('DELETE FROM public.plz_localities')
    await client.query('INSERT INTO public.plz_localities SELECT * FROM orte_neu')

    // PLZ: Stammdaten immer aktualisieren; Einwohner nur, wenn eine Fläche da ist
    // (sonst bleibt ein vorhandener Wert unangetastet, aber ohne Methode = ungültig nach 005).
    const r = await client.query(`
      INSERT INTO public.postal_codes AS p (postal_code, city, state, municipality, ags, lat, lng, bbox_south, bbox_north, bbox_west, bbox_east,
        area_km2, population, households, population_density, avg_household_size, population_source, population_year,
        population_method, population_reference_date, population_quality, households_quality, reference_version, data_source, trust_level, last_fetched_at)
      SELECT n.postal_code, coalesce(n.city, n.postal_code), n.state, n.city, n.ags, n.lat, n.lng, n.bbox_south, n.bbox_north, n.bbox_west, n.bbox_east,
        n.area_km2, n.population, n.households, n.population_density, n.avg_household_size,
        CASE WHEN n.population IS NOT NULL THEN 'census'::data_source END,
        CASE WHEN n.population IS NOT NULL THEN 2022 END,
        CASE WHEN n.population IS NOT NULL THEN $1 END,
        CASE WHEN n.population IS NOT NULL THEN DATE '2022-05-15' END,
        n.population_quality, n.households_quality, $2, 'osm'::data_source, 'public'::data_trust_level, now()
      FROM plz_neu n
      ON CONFLICT (postal_code) DO UPDATE SET
        city = EXCLUDED.city, state = EXCLUDED.state, municipality = EXCLUDED.municipality, ags = EXCLUDED.ags,
        lat = coalesce(EXCLUDED.lat, p.lat), lng = coalesce(EXCLUDED.lng, p.lng),
        bbox_south = coalesce(EXCLUDED.bbox_south, p.bbox_south), bbox_north = coalesce(EXCLUDED.bbox_north, p.bbox_north),
        bbox_west = coalesce(EXCLUDED.bbox_west, p.bbox_west), bbox_east = coalesce(EXCLUDED.bbox_east, p.bbox_east),
        area_km2 = coalesce(EXCLUDED.area_km2, p.area_km2),
        population = CASE WHEN EXCLUDED.population_method IS NOT NULL THEN EXCLUDED.population ELSE p.population END,
        households = CASE WHEN EXCLUDED.population_method IS NOT NULL THEN EXCLUDED.households ELSE p.households END,
        population_density = CASE WHEN EXCLUDED.population_method IS NOT NULL THEN EXCLUDED.population_density ELSE p.population_density END,
        avg_household_size = CASE WHEN EXCLUDED.population_method IS NOT NULL THEN EXCLUDED.avg_household_size ELSE p.avg_household_size END,
        population_source = coalesce(EXCLUDED.population_source, p.population_source),
        population_year = coalesce(EXCLUDED.population_year, p.population_year),
        population_method = CASE WHEN EXCLUDED.population_method IS NOT NULL THEN EXCLUDED.population_method ELSE p.population_method END,
        population_reference_date = coalesce(EXCLUDED.population_reference_date, p.population_reference_date),
        population_quality = EXCLUDED.population_quality, households_quality = EXCLUDED.households_quality,
        reference_version = EXCLUDED.reference_version, updated_at = now()`, [ZENSUS_METHOD, version])

    if (await client.query(`SELECT to_regclass('public.data_refresh_logs') AS t`).then((x: { rows: { t: string | null }[] }) => x.rows[0].t)) {
      await client.query(`INSERT INTO public.data_refresh_logs (data_type, data_source, status, records_fetched, duration_ms, error_message)
        VALUES ('geodaten_deutschland', 'osm', 'ok', $1, $2, $3)`, [nStreets, Date.now() - started, `Version ${version}: ${nStreets} Straßen in ${nPlzStreets} PLZ, ${nOrte} Ortseinträge, ${nPlz} PLZ-Stammdaten`])
    }
    await client.query('COMMIT')
    console.log(`Geladen (Version ${version}): ${nStreets} Straßen in ${nPlzStreets} PLZ, ${nOrte} Ortseinträge, ${nPlz} PLZ (${r.rowCount} aktualisiert/neu), ${Math.round((Date.now() - started) / 1000)} s`)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Abbruch, alter Stand bleibt erhalten:', e instanceof Error ? e.message : e)
    process.exitCode = 1
  } finally {
    await client.end()
  }
}

if (process.argv[1] && /laden\.ts$/.test(process.argv[1])) main()
