// Zensus-2022-Gitter → Einwohner/Haushalte je PLZ
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { laeaToLngLat, PlzAssigner, aggregateCells, findColumns, parseCellValue, featureToPolygon } from '../src/lib/geo/zensus-grid'
import { ZENSUS_METHOD } from '../src/lib/geo/population'

describe('Koordinaten EPSG:3035 → WGS84', () => {
  // Vergleichswerte aus der Referenzbibliothek proj4 (2.11.0)
  it.each([
    [4321000, 3210000, 10, 52],
    [4110050, 3080050, 7.007331050484508, 50.79319405116277],   // bei Köln/Bonn
    [4553350, 3271650, 13.42320548568168, 52.50492179287449],   // Berlin
    [4288950, 2716150, 9.574426271573007, 47.5581364763237],    // Bodensee
    [4675050, 2847050, 14.805554126214338, 48.632949699986256], // Ostgrenze
  ])('(%d, %d) → %f, %f', (x, y, lon, lat) => {
    const [l, b] = laeaToLngLat(x, y)
    expect(Math.abs(l - lon)).toBeLessThan(1e-7)   // < 1 cm
    expect(Math.abs(b - lat)).toBeLessThan(1e-7)
  })
})

describe('Zellen den PLZ zuordnen', () => {
  // Zwei PLZ nebeneinander um den Ursprung des Gitters (10°/52°)
  const [lon0, lat0] = [10, 52]
  const west = { plz: '11111', polygon: { outer: [[[lon0 - 0.02, lat0 - 0.01], [lon0, lat0 - 0.01], [lon0, lat0 + 0.01], [lon0 - 0.02, lat0 + 0.01], [lon0 - 0.02, lat0 - 0.01]] as [number, number][]], inner: [] } }
  const east = { plz: '22222', polygon: { outer: [[[lon0, lat0 - 0.01], [lon0 + 0.02, lat0 - 0.01], [lon0 + 0.02, lat0 + 0.01], [lon0, lat0 + 0.01], [lon0, lat0 - 0.01]] as [number, number][]], inner: [] } }
  const assigner = new PlzAssigner([west, east])
  it('Summen, fehlende Werte gezählt, Zellen außerhalb gezählt', () => {
    const cells = [
      { x: 4321000 - 450, y: 3210000 + 50, value: 120 },   // West
      { x: 4321000 - 950, y: 3210000 - 250, value: 80 },   // West
      { x: 4321000 + 350, y: 3210000 + 50, value: 40 },    // Ost
      { x: 4321000 + 550, y: 3210000 + 150, value: null }, // Ost, geheim
      { x: 4321000, y: 3210000 + 50000, value: 999 },      // weit außerhalb
    ]
    const { byPlz, outside } = aggregateCells(assigner, cells)
    expect(byPlz.get('11111')).toEqual({ plz: '11111', sum: 200, cells: 2, missing_cells: 0 })
    expect(byPlz.get('22222')).toEqual({ plz: '22222', sum: 40, cells: 2, missing_cells: 1 })
    expect(outside).toBe(1)
  })
  it('Zellwerte: Geheimhaltungszeichen sind keine Zahl', () => {
    expect(parseCellValue('17')).toBe(17)
    expect(parseCellValue('2,4')).toBe(2.4)
    expect(parseCellValue('–')).toBeNull()
    expect(parseCellValue('-1')).toBeNull()
    expect(parseCellValue('')).toBeNull()
  })
  it('fehlende Spalte: klare Meldung mit den vorhandenen Spalten', () => {
    expect(() => findColumns(['GITTER_ID_100m', 'x_mp_100m', 'y_mp_100m', 'Einwohner'], { x: 'x_mp_100m', y: 'y_mp_100m', value: 'Insgesamt' }))
      .toThrow(/Insgesamt.*Vorhanden: GITTER_ID_100m, x_mp_100m, y_mp_100m, Einwohner/)
  })
  it('GeoJSON-MultiPolygon mit Loch', () => {
    const p = featureToPolygon({ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.1], [0.3, 0.1], [0.3, 0.2], [0.2, 0.1]]]] })
    expect(p!.outer).toHaveLength(1)
    expect(p!.inner).toHaveLength(1)
  })
})

describe('Importprogramm (Ende-zu-Ende mit künstlichen Dateien)', () => {
  it('erzeugt SQL mit Herkunft und einen Bericht', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zensus-'))
    const sq = (lon: number, lat: number, d = 0.01) => [[[lon - d, lat - d], [lon + d, lat - d], [lon + d, lat + d], [lon - d, lat + d], [lon - d, lat - d]]]
    writeFileSync(join(dir, 'plz.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: { postal_code: '33333' }, geometry: { type: 'Polygon', coordinates: sq(10, 52) } },
      // Zweite Fläche derselben PLZ (kommt in OSM vor, z. B. 75378): darf nicht doppelt zählen
      { type: 'Feature', properties: { postal_code: '33333' }, geometry: { type: 'Polygon', coordinates: sq(10.5, 52.5, 0.001) } },
    ] }))
    writeFileSync(join(dir, 'ew.csv'), 'GITTER_ID_100m;x_mp_100m;y_mp_100m;Einwohner\nA;4321050;3210050;100\nB;4321150;3210050;23\nC;4321250;3210050;–\nD;4500050;3300050;50\n')
    writeFileSync(join(dir, 'hh.csv'), 'GITTER_ID_100m;x_mp_100m;y_mp_100m;Insgesamt\nA;4321050;3210050;48\nB;4321150;3210050;11\n')
    const out = join(dir, 'out.sql')
    execFileSync('npx', ['tsx', 'scripts/zensus-plz-import.ts', '--plz', join(dir, 'plz.geojson'), '--einwohner', join(dir, 'ew.csv'), '--haushalte', join(dir, 'hh.csv'), '--out', out], { cwd: join(__dirname, '..'), stdio: 'pipe' })
    const sql = readFileSync(out, 'utf8')
    expect(sql).toContain(`VALUES ('33333', '33333', 123, 59, 'census', 2022, '${ZENSUS_METHOD}', '2022-05-15')`)
    expect(sql).toMatch(/^-- Einwohner\/Haushalte je PLZ aus Zensus 2022/)
    expect(sql.trim().endsWith('COMMIT;')).toBe(true)
    expect(readFileSync(join(dir, 'out.csv'), 'utf8')).toContain('33333;123;3;1;59;0')
    expect(sql.match(/VALUES \('33333'/g)).toHaveLength(1)
    expect(readFileSync(join(dir, 'out.csv'), 'utf8').match(/^33333;/gm)).toHaveLength(1)
  }, 60000)
})
