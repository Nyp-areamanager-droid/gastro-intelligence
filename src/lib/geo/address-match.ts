// =============================================================================
// Geografische Zuordnung von Bestelladressen (ganz Deutschland)
//
// Prüft jede Adresse gegen das Straßenverzeichnis (OpenPLZ-Datensatz aus
// OpenStreetMap, Tabelle street_directory) und sagt ehrlich, wie sicher die
// Zuordnung ist. Grundsätze:
//   - Eine angegebene, gültige PLZ wird NIE stillschweigend geändert. Passt
//     die Straße nicht dazu, wird das gemeldet („PLZ prüfen“), gezählt wird
//     weiter unter der angegebenen PLZ.
//   - Eine FEHLENDE PLZ wird nur ergänzt, wenn Straße und Ort genau EINE
//     PLZ ergeben. Sonst bleibt die Adresse „mehrdeutig“ und wird nicht
//     einer zufälligen PLZ zugeschlagen.
//   - Schreibweisen (Str./Straße/Strasse, ß/ss, Umlaute, Bindestriche,
//     Groß/klein) gelten als gleich. Tippfehler werden nur bei eindeutigem
//     Treffer und kleinem Abstand korrigiert.
//
// Grenze der Quelle: Das Verzeichnis enthält keine Hausnummern. Eine Straße,
// die über mehrere PLZ läuft, lässt sich ohne PLZ deshalb nicht auf eine
// Hausnummer genau zuordnen.
// =============================================================================

import { normalizeStreetName, streetNameKey, stripHouseNumber } from './street-name'

/** Ort, Stadtbezirk oder Stadtteil, in dem eine PLZ (teilweise) liegt */
export interface LocalityEntry {
  postal_code: string
  locality: string
  /** localityKey(locality) */
  locality_key: string
  /** 'ort' = Gemeinde/Stadt, 'bezirk' = Stadtbezirk, 'stadtteil' = Stadtteil (aus OSM) */
  kind: 'ort' | 'bezirk' | 'stadtteil'
}

export type GeoStatus =
  | 'exakt'             // Straße liegt in der angegebenen PLZ
  | 'schreibweise'      // Straße in der PLZ gefunden, nach Korrektur eines Tippfehlers
  | 'plz_ergaenzt'      // PLZ fehlte, aus Straße + Ort eindeutig bestimmt
  | 'mehrdeutig'        // PLZ fehlte, Straße + Ort passen zu mehreren PLZ
  | 'plz_pruefen'       // Straße nicht in der angegebenen PLZ, aber in einer anderen PLZ desselben Orts
  | 'strasse_unbekannt' // Straße nirgends im Verzeichnis gefunden
  | 'plz_unbekannt'     // PLZ ist keine deutsche Zustell-PLZ laut Verzeichnis
  | 'ohne_strasse'      // Keine Straße angegeben
  | 'ohne_ort'          // Weder gültige PLZ noch bekannter Ort

export const GEO_STATUSES: GeoStatus[] = ['exakt', 'schreibweise', 'plz_ergaenzt', 'mehrdeutig', 'plz_pruefen', 'strasse_unbekannt', 'plz_unbekannt', 'ohne_strasse', 'ohne_ort']

export const GEO_STATUS_TEXT: Record<GeoStatus, string> = {
  exakt: 'Straße und PLZ passen zusammen',
  schreibweise: 'Straße nach Korrektur der Schreibweise gefunden',
  plz_ergaenzt: 'PLZ fehlte und wurde aus Straße und Ort eindeutig ergänzt',
  mehrdeutig: 'PLZ fehlt, die Straße liegt im Ort in mehreren PLZ',
  plz_pruefen: 'Straße liegt laut Verzeichnis in einer anderen PLZ dieses Orts',
  strasse_unbekannt: 'Straße im Verzeichnis nicht gefunden',
  plz_unbekannt: 'Diese PLZ gibt es laut Verzeichnis nicht',
  ohne_strasse: 'Keine Straße angegeben',
  ohne_ort: 'Weder PLZ noch bekannter Ort angegeben',
}

/** Status, bei denen Straße UND PLZ belastbar sind */
export const RELIABLE_STATUSES: ReadonlySet<GeoStatus> = new Set(['exakt', 'schreibweise', 'plz_ergaenzt'])

export interface MatchInput {
  postal_code?: string | null
  city?: string | null
  /** Straße, ggf. mit Hausnummer */
  street?: string | null
  /**
   * Leitregionen (erste zwei PLZ-Ziffern) der gesicherten Adressen derselben
   * Datei. Nur bei fehlender PLZ genutzt: Gibt es den Ort mehrfach in
   * Deutschland („Neuenkirchen“), zählt der Treffer in der eigenen Region.
   */
  regionPrefixes?: ReadonlySet<string> | null
}

export interface MatchResult {
  status: GeoStatus
  /** PLZ, unter der die Bestellung gezählt wird (angegeben oder eindeutig ergänzt), sonst null */
  postal_code: string | null
  /** Straßenname aus dem Verzeichnis, sonst die Eingabe ohne Hausnummer */
  street_name: string | null
  /** Bei mehrdeutig/plz_pruefen: mögliche PLZ (sortiert, höchstens 10) */
  candidates: string[]
}

const UML: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

/**
 * Vergleichsschlüssel für Ortsnamen: „Frankfurt am Main“ = „Frankfurt a. M.“;
 * „Köln“ = „Koeln“ = „KÖLN“. Klammerzusätze („Frankfurt (Oder)“) bleiben Teil
 * des Namens, damit verschiedene Orte nicht zusammenfallen.
 */
export function localityKey(raw: string | null | undefined): string {
  if (!raw) return ''
  let s = raw.normalize('NFC').toLowerCase().trim()
  s = s.replace(/[äöüß]/g, c => UML[c])
  s = s.replace(/\ba\.\s*m\.?(?=\s|$|\))/g, 'am main')
    .replace(/\ba\.\s*d\.\s*/g, 'an der ')
    .replace(/\bi\.\s*/g, 'im ')
    .replace(/\bst\.\s*/g, 'sankt ')
  return s.replace(/[^a-z0-9]+/g, '')
}

/** Ortsangabe in Varianten: „Köln-Nippes“ → [koelnnippes, koeln, nippes]; „50823 Köln“ → [koeln] */
export function localityVariants(raw: string | null | undefined): string[] {
  if (!raw) return []
  const text = raw.replace(/\b\d{4,5}\b/g, ' ').trim()
  const out = new Set<string>()
  const full = localityKey(text)
  if (full) out.add(full)
  for (const part of text.split(/\s*[-–/,]\s*|\s+(?=\()/)) {
    const k = localityKey(part)
    if (k && k.length >= 3) out.add(k)
  }
  return [...out]
}

/** Zusätze an Straßennamen der Quelle entfernen: „"7 Berge"“ → „7 Berge“ */
export function cleanDirectoryName(raw: string): string {
  return raw.replace(/^[\s"„“”']+|[\s"„“”']+$/g, '').replace(/\s+/g, ' ')
}

/**
 * Häufige Tippfehler bei „Straße“ vor dem Vergleich angleichen:
 * „Strase“, „Strasze“, „Straase“, „Strasee“ → „Straße“. Nur am Wortende bzw.
 * vor Leerzeichen/Ziffer, damit „Strasburg“ o. ä. unberührt bleibt.
 */
export function fixStreetTypos(raw: string): string {
  return raw.replace(/(str)(?:ase|asze|aase|asee|asse?e)(?=[\s\d.,-]|$)/gi, (_m, s: string) => `${s}aße`)
}

/** Levenshtein-Abstand mit Abbruch, sobald max überschritten ist */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < rowMin) rowMin = v
    }
    if (rowMin > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

/** Zulässiger Tippfehler-Abstand: kurze Namen gar nicht, mittlere 1, lange 2 */
export function allowedDistance(len: number): number {
  if (len < 7) return 0
  if (len < 13) return 1
  return 2
}

/**
 * Nachschlagewerk für die Zuordnung. Wird je Upload aus den Straßenlisten der
 * betroffenen PLZ und den Ortseinträgen gebaut – nicht ganz Deutschland im
 * Speicher. knownPostalCodes enthält alle PLZ des Verzeichnisses, damit
 * „PLZ gibt es nicht“ sicher erkannt wird.
 */
export class AddressIndex {
  private byPlz = new Map<string, Map<string, string>>()     // PLZ → Schlüssel → Name
  private plzByLocality = new Map<string, Set<string>>()     // Ortsschlüssel → PLZ
  private localitiesOfPlz = new Map<string, Set<string>>()   // PLZ → Ortsschlüssel (nur 'ort')

  constructor(streetsByPlz: Iterable<[string, string[]]>, localities: Iterable<LocalityEntry>, readonly knownPostalCodes: ReadonlySet<string>) {
    for (const [plz, names] of streetsByPlz) {
      const m = new Map<string, string>()
      for (const n of names) {
        const k = streetNameKey(n)
        if (k && !m.has(k)) m.set(k, n)
      }
      this.byPlz.set(plz, m)
    }
    for (const l of localities) {
      let s = this.plzByLocality.get(l.locality_key)
      if (!s) { s = new Set(); this.plzByLocality.set(l.locality_key, s) }
      s.add(l.postal_code)
      if (l.kind === 'ort') {
        let o = this.localitiesOfPlz.get(l.postal_code)
        if (!o) { o = new Set(); this.localitiesOfPlz.set(l.postal_code, o) }
        o.add(l.locality_key)
      }
    }
  }

  hasPostalCode(plz: string): boolean { return this.knownPostalCodes.has(plz) }

  private plzWithStreet(nameKey: string, plzs: Iterable<string>): string[] {
    const out: string[] = []
    for (const p of plzs) if (this.byPlz.get(p)?.has(nameKey)) out.push(p)
    return out.sort()
  }

  /** Eindeutig nächster Schlüssel (Tippfehler); erster Buchstabe muss stimmen */
  private fuzzy(key: string, candidates: Iterable<string>): string | null {
    const max = allowedDistance(key.length)
    if (max === 0) return null
    let best: string | null = null, bestD = max + 1, tie = false
    for (const c of candidates) {
      if (c[0] !== key[0] || c === best) continue
      const d = editDistance(key, c, max)
      if (d < bestD) { best = c; bestD = d; tie = false } else if (d === bestD) tie = true
    }
    return best && !tie && bestD <= max ? best : null
  }

  match(input: MatchInput): MatchResult {
    const plzRaw = (input.postal_code || '').trim()
    const plz = /^\d{5}$/.test(plzRaw) ? plzRaw : /^\d{4}$/.test(plzRaw) ? '0' + plzRaw : ''
    const streetRaw = (input.street || '').trim()
    const streetDisplay = streetRaw ? (stripHouseNumber(streetRaw) || streetRaw) : null
    const result = (status: GeoStatus, postal: string | null, extra: Partial<MatchResult> = {}): MatchResult =>
      ({ status, postal_code: postal, street_name: streetDisplay, candidates: [], ...extra })

    if (plz && !this.knownPostalCodes.has(plz)) return result('plz_unbekannt', plz)
    if (!streetRaw) return result(plz ? 'ohne_strasse' : 'ohne_ort', plz || null)

    const key = normalizeStreetName(streetRaw)
    const fullKey = streetNameKey(streetRaw) // Namen mit Zahl am Ende („Weg 2“, „An der B 5“)
    const typoKey = normalizeStreetName(fixStreetTypos(streetRaw))

    if (plz) {
      const inPlz = this.byPlz.get(plz)
      const hit = inPlz?.has(key) ? key : inPlz?.has(fullKey) ? fullKey : null
      if (hit) return result('exakt', plz, { street_name: inPlz!.get(hit)! })
      if (typoKey !== key && inPlz?.has(typoKey)) return result('schreibweise', plz, { street_name: inPlz.get(typoKey)! })
      const near = inPlz ? this.fuzzy(typoKey, inPlz.keys()) : null
      if (near) return result('schreibweise', plz, { street_name: inPlz!.get(near)! })
      // Liegt die Straße in einer anderen PLZ desselben Orts?
      const locKeys = new Set([...(this.localitiesOfPlz.get(plz) || []), ...localityVariants(input.city)])
      const neighbours = new Set<string>()
      for (const lk of locKeys) for (const p of this.plzByLocality.get(lk) || []) if (p !== plz) neighbours.add(p)
      const other = this.plzWithStreet(key, neighbours)
      if (other.length) return result('plz_pruefen', plz, { candidates: other.slice(0, 10) })
      return result('strasse_unbekannt', plz)
    }

    // Keine PLZ: über Ort + Straße bestimmen
    const locKeys = localityVariants(input.city).filter(k => this.plzByLocality.has(k))
    if (!locKeys.length) return result('ohne_ort', null)
    const plzs = new Set<string>()
    for (const lk of locKeys) for (const p of this.plzByLocality.get(lk)!) plzs.add(p)
    let usedKey = key
    let found = this.plzWithStreet(key, plzs)
    if (!found.length && fullKey !== key) { found = this.plzWithStreet(fullKey, plzs); usedKey = fullKey }
    if (!found.length && typoKey !== key) { found = this.plzWithStreet(typoKey, plzs); usedKey = typoKey }
    if (!found.length) {
      const keys = new Set<string>()
      for (const p of plzs) for (const k of this.byPlz.get(p)?.keys() || []) keys.add(k)
      const near = this.fuzzy(typoKey, keys)
      if (near) { found = this.plzWithStreet(near, plzs); usedKey = near }
    }
    if (!found.length) return result('strasse_unbekannt', null)
    const name = this.byPlz.get(found[0])!.get(usedKey)!
    if (found.length > 1 && input.regionPrefixes?.size) {
      const inRegion = found.filter(p => input.regionPrefixes!.has(p.slice(0, 2)))
      if (inRegion.length === 1) return result('plz_ergaenzt', inRegion[0], { street_name: this.byPlz.get(inRegion[0])!.get(usedKey)! })
    }
    if (found.length > 1) return result('mehrdeutig', null, { street_name: name, candidates: found.slice(0, 10) })
    return result('plz_ergaenzt', found[0], { street_name: name })
  }
}

export interface GeoSummary {
  total: number
  by_status: Record<GeoStatus, number>
  /** Anteil der Adressen mit belastbarer Straße + PLZ (exakt, schreibweise, plz_ergaenzt), in % */
  reliable_pct: number | null
  /** Beispiele je Problemstatus (höchstens 5) für Vorschau und Fehlerbericht */
  examples: Partial<Record<GeoStatus, { street: string | null; postal_code: string | null; city: string | null; candidates: string[] }[]>>
  /** Stand des Straßenverzeichnisses */
  directory_version?: string | null
}

export function summarizeMatches(rows: { input: MatchInput; result: MatchResult }[], directoryVersion: string | null = null): GeoSummary {
  const by_status = Object.fromEntries(GEO_STATUSES.map(k => [k, 0])) as Record<GeoStatus, number>
  const examples: GeoSummary['examples'] = {}
  for (const { input, result } of rows) {
    by_status[result.status]++
    if (!RELIABLE_STATUSES.has(result.status)) {
      const list = examples[result.status] || (examples[result.status] = [])
      if (list.length < 5) list.push({ street: input.street || null, postal_code: input.postal_code || null, city: input.city || null, candidates: result.candidates })
    }
  }
  const total = rows.length
  const reliable = by_status.exakt + by_status.schreibweise + by_status.plz_ergaenzt
  return { total, by_status, reliable_pct: total ? Math.round((reliable / total) * 1000) / 10 : null, examples, directory_version: directoryVersion }
}
