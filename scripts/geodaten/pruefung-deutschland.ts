/*
 * Deutschlandweite Prüfung der Adresszuordnung mit dem VOLLSTÄNDIGEN Verzeichnis.
 *
 *   npx tsx scripts/geodaten/pruefung-deutschland.ts --dir ausgabe/ --out pruefung.json [--n 400] [--seed 42]
 *
 * Erzeugt Testadressen aus dem Verzeichnis selbst (künstliche Bestellungen,
 * keine echten Kundendaten) für Köln, Berlin, Hamburg, München, Dresden,
 * Leipzig und ländliche Gemeinden und verfälscht sie wie echte Exporte:
 * andere Schreibweise, Tippfehler, fehlende PLZ, falsche PLZ, fehlende Straße.
 *
 * Gemessen wird, ob die Zuordnung das richtige Ergebnis liefert – vor allem,
 * dass NIE eine falsche PLZ vergeben wird. Wichtig: Weil die Testadressen aus
 * dem Verzeichnis stammen, misst das die Zuordnungslogik und die
 * Mehrdeutigkeit der echten Straßennamen, nicht die Vollständigkeit von
 * OpenStreetMap gegenüber der Wirklichkeit.
 */
import { readFileSync, writeFileSync, createReadStream } from 'fs'
import { createInterface } from 'readline'
import { join } from 'path'
import { AddressIndex, type LocalityEntry, type GeoStatus } from '../../src/lib/geo/address-match'
import { streetNameKey } from '../../src/lib/geo/street-name'
import { splitCsvLine } from './build-deutschland'

function arg(name: string, fb?: string) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fb }

/** Deterministischer Zufall (Mulberry32), damit die Prüfung wiederholbar ist */
export function rng(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Schreibweise wie in echten Exporten verändern (inhaltlich gleiche Straße) */
export function respell(name: string, r: () => number): string {
  const variants = [
    (s: string) => s.replace(/str\.$/i, 'straße').replace(/Str\./, 'Straße'),
    (s: string) => s.replace(/str\.$/i, 'strasse').replace(/Str\./, 'Strasse'),
    (s: string) => s.toLowerCase(),
    (s: string) => s.toUpperCase(),
    (s: string) => s.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss'),
    (s: string) => s.replace(/-/g, ' '),
    (s: string) => s.replace(/ (?=[A-ZÄÖÜ])/g, '-'),
  ]
  return variants[Math.floor(r() * variants.length)](name)
}

/** Einen Tippfehler einbauen: Buchstabe in der Mitte weglassen (nur lange Namen) */
export function typo(name: string): string | null {
  const letters = [...name.matchAll(/[a-zäöüß]/g)].map(m => m.index!).filter(i => i > 2 && i < name.length - 4)
  if (name.length < 10 || !letters.length) return null
  const i = letters[Math.floor(letters.length / 2)]
  return name.slice(0, i) + name.slice(i + 1)
}

async function readCsv(file: string) {
  const rl = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity })
  const out: Record<string, string>[] = []; let h: string[] | null = null
  for await (const l of rl) { if (!l) continue; const f = splitCsvLine(l); if (!h) { h = f; continue } out.push(Object.fromEntries(h.map((k, i) => [k, f[i] ?? '']))) }
  return out
}

type Case = 'exakt' | 'schreibweise_anders' | 'tippfehler' | 'ohne_plz' | 'ohne_plz_mit_region' | 'falsche_plz' | 'ohne_strasse'

async function main() {
  const dir = arg('dir')!, out = arg('out', 'pruefung.json')!, n = Number(arg('n', '400')), r = rng(Number(arg('seed', '42')))
  const streets = new Map<string, string[]>()
  for (const row of await readCsv(join(dir, 'strassen.csv'))) streets.set(row.postal_code, JSON.parse(row.streets))
  const orte = (await readCsv(join(dir, 'orte.csv'))) as unknown as LocalityEntry[]
  const plzInfo = new Map((await readCsv(join(dir, 'plz.csv'))).map(p => [p.postal_code, p]))
  const known = new Set([...plzInfo.keys()])
  const t0 = Date.now()
  const index = new AddressIndex(streets, orte, known)
  const buildMs = Date.now() - t0

  // Wie viele Straßennamen sind innerhalb ihres Orts eindeutig einer PLZ zugeordnet?
  const plzOfOrt = new Map<string, Set<string>>()
  const ortOfPlz = new Map<string, string[]>()
  for (const o of orte) if (o.kind === 'ort') {
    if (!plzOfOrt.has(o.locality)) plzOfOrt.set(o.locality, new Set())
    plzOfOrt.get(o.locality)!.add(o.postal_code)
    ortOfPlz.set(o.postal_code, [...(ortOfPlz.get(o.postal_code) || []), o.locality])
  }
  let namesInOrt = 0, uniqueInOrt = 0
  for (const [, plzs] of plzOfOrt) {
    const count = new Map<string, number>()
    for (const p of plzs) for (const s of streets.get(p) || []) { const k = streetNameKey(s); count.set(k, (count.get(k) || 0) + 1) }
    for (const c of count.values()) { namesInOrt++; if (c === 1) uniqueInOrt++ }
  }

  const regions: { name: string; plz: string[]; city: (plz: string) => string }[] = [
    ...['Köln', 'Berlin', 'Hamburg', 'München', 'Dresden', 'Leipzig'].map(c => ({ name: c, plz: [...(plzOfOrt.get(c) || [])], city: () => c })),
  ]
  // Ländlich: PLZ mit unter 150 Einwohnern je km² und mindestens 20 Straßen, Ort = Hauptort der PLZ
  const rural = [...plzInfo.values()].filter(p => p.population_density && Number(p.population_density) < 150 && (streets.get(p.postal_code)?.length || 0) >= 20).map(p => p.postal_code)
  regions.push({ name: 'Ländliche Gemeinden', plz: rural, city: p => plzInfo.get(p)!.city })

  const results: Record<string, Record<Case, { n: number; ok: number; falsche_plz: number; status: Partial<Record<GeoStatus, number>> }>> = {}
  const failures: unknown[] = []
  for (const reg of regions) {
    const res = results[reg.name] = {} as (typeof results)[string]
    const add = (c: Case, ok: boolean, wrongPlz: boolean, st: GeoStatus, detail: unknown) => {
      const x = res[c] || (res[c] = { n: 0, ok: 0, falsche_plz: 0, status: {} })
      x.n++; if (ok) x.ok++; if (wrongPlz) x.falsche_plz++
      x.status[st] = (x.status[st] || 0) + 1
      if (!ok && failures.length < 60) failures.push({ region: reg.name, fall: c, ...detail as object, status: st })
    }
    for (let i = 0; i < n; i++) {
      const plz = reg.plz[Math.floor(r() * reg.plz.length)]
      const list = streets.get(plz) || []
      if (!list.length) continue
      const name = list[Math.floor(r() * list.length)]
      const city = reg.city(plz)
      const hn = `${1 + Math.floor(r() * 120)}${r() < 0.15 ? 'a' : ''}`
      const key = streetNameKey(name)
      // Erwartung „ohne PLZ“: in welchen PLZ des Orts kommt die Straße vor?
      const truthPlz = [...(plzOfOrt.get(city) || [])].filter(p => (streets.get(p) || []).some(s => streetNameKey(s) === key)).sort()

      let m = index.match({ postal_code: plz, street: `${name} ${hn}`, city })
      add('exakt', m.status === 'exakt' && m.postal_code === plz, m.postal_code !== plz, m.status, { plz, strasse: name })

      const sp = respell(name, r)
      m = index.match({ postal_code: plz, street: `${sp} ${hn}`, city })
      add('schreibweise_anders', (m.status === 'exakt' || m.status === 'schreibweise') && m.postal_code === plz, m.postal_code !== plz, m.status, { plz, strasse: sp })

      const ty = typo(name)
      if (ty) {
        m = index.match({ postal_code: plz, street: `${ty} ${hn}`, city })
        // Richtig: korrigiert auf DIESE Straße – oder ehrlich „unbekannt“. Falsch: eine andere Straße.
        const okTypo = (m.status === 'schreibweise' && streetNameKey(m.street_name || '') === key) || m.status === 'exakt' || m.status === 'strasse_unbekannt' || m.status === 'plz_pruefen'
        add('tippfehler', okTypo && m.status !== 'strasse_unbekannt' && m.status !== 'plz_pruefen', m.status === 'schreibweise' && streetNameKey(m.street_name || '') !== key, m.status, { plz, strasse: ty, original: name })
      }

      m = index.match({ postal_code: null, street: `${name} ${hn}`, city })
      const expectUnique = truthPlz.length === 1
      const okNo = expectUnique ? (m.status === 'plz_ergaenzt' && m.postal_code === plz) : (m.status === 'mehrdeutig' && m.postal_code === null)
      add('ohne_plz', okNo, m.postal_code !== null && m.postal_code !== plz && !truthPlz.includes(m.postal_code), m.status, { stadt: city, strasse: name, erwartet: truthPlz.slice(0, 6) })

      // Ohne PLZ, aber die Datei enthält weitere Adressen aus der Region (Leitregion = erste zwei Ziffern)
      if (!expectUnique) {
        m = index.match({ postal_code: null, street: `${name} ${hn}`, city, regionPrefixes: new Set([plz.slice(0, 2)]) })
        const inRegion = truthPlz.filter(p => p.slice(0, 2) === plz.slice(0, 2))
        const okR = inRegion.length === 1 ? (m.status === 'plz_ergaenzt' && m.postal_code === plz) : (m.status === 'mehrdeutig' || (m.status === 'plz_ergaenzt' && m.postal_code === plz))
        add('ohne_plz_mit_region', okR, m.postal_code !== null && m.postal_code !== plz && !truthPlz.includes(m.postal_code), m.status, { stadt: city, strasse: name, erwartet: inRegion.slice(0, 6) })
      }

      // Falsche PLZ: eine andere PLZ desselben Orts, in der die Straße NICHT liegt
      const others = [...(plzOfOrt.get(city) || [])].filter(p => p !== plz && !(streets.get(p) || []).some(s => streetNameKey(s) === key))
      if (others.length) {
        const wrong = others[Math.floor(r() * others.length)]
        m = index.match({ postal_code: wrong, street: `${name} ${hn}`, city })
        add('falsche_plz', m.status === 'plz_pruefen' && m.candidates.includes(plz) && m.postal_code === wrong, m.postal_code !== wrong, m.status, { plz: wrong, strasse: name, richtig: plz })
      }

      m = index.match({ postal_code: plz, street: '', city })
      add('ohne_strasse', m.status === 'ohne_strasse', false, m.status, {})
    }
  }

  // Geschwindigkeit: 10.000 Zuordnungen
  const sampleKeys = [...streets.keys()]
  const t1 = Date.now()
  for (let i = 0; i < 10000; i++) { const p = sampleKeys[i % sampleKeys.length]; const l = streets.get(p)!; index.match({ postal_code: p, street: l[i % l.length] + ' 1' }) }
  const perMatchUs = Math.round(((Date.now() - t1) / 10000) * 1000)

  const report = {
    erstellt: new Date().toISOString(), testadressen_je_region: n, seed: Number(arg('seed', '42')),
    verzeichnis: { plz_mit_strassen: streets.size, strassen: [...streets.values()].reduce((s, l) => s + l.length, 0), orte_eintraege: orte.length, index_aufbau_ms: buildMs },
    eindeutigkeit: { strassennamen_je_ort: namesInOrt, davon_in_genau_einer_plz: uniqueInOrt, anteil_pct: Math.round((uniqueInOrt / namesInOrt) * 1000) / 10 },
    geschwindigkeit_us_je_adresse: perMatchUs,
    ergebnisse: results,
    beispiele_abweichungen: failures,
  }
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n')
  for (const [reg, cases] of Object.entries(results)) {
    console.log(reg.padEnd(20), Object.entries(cases).map(([c, x]) => `${c} ${x.ok}/${x.n}${x.falsche_plz ? ` FALSCHE PLZ ${x.falsche_plz}` : ''}`).join(' | '))
  }
  console.log('Eindeutig ohne PLZ zuordenbar:', report.eindeutigkeit, 'Zeit je Adresse (µs):', perMatchUs)
}

if (process.argv[1] && /pruefung-deutschland/.test(process.argv[1])) main().catch(e => { console.error(e); process.exit(1) })
