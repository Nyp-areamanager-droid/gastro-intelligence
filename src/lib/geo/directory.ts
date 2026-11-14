// =============================================================================
// Deutschlandweites Straßenverzeichnis aus der Datenbank laden
//
// Quelle: Tabellen street_directory (Straßennamen je PLZ) und plz_localities
// (Orte/Stadtteile je PLZ), Migration 009, befüllt mit
// scripts/geodaten/laden.ts. Gelesen wird mit der Sitzung des angemeldeten
// Nutzers (RLS: nur Lesen, nur angemeldet) – kein Service-Key.
//
// Ist Migration 009 nicht eingespielt oder das Verzeichnis leer, liefert
// loadAddressIndex null. Der Import arbeitet dann wie bisher (Live-Abruf
// je PLZ bei OpenPLZ) und meldet, dass keine Adressprüfung möglich war.
// =============================================================================

import { AddressIndex, localityVariants, type LocalityEntry } from './address-match'

/** Minimale Abfrage-Schnittstelle (Supabase-Client oder Test-Attrappe) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from: (table: string) => any }

const CHUNK = 100
/** Obergrenze für nachgeladene Nachbar-PLZ (Großstädte: Berlin hat rund 190 PLZ) */
export const MAX_DIRECTORY_PLZ = 800

export interface LoadedDirectory {
  index: AddressIndex
  /** Straßenlisten der geladenen PLZ (vollständig laut Verzeichnis) */
  streets: Map<string, string[]>
  version: string | null
}

async function selectIn<T>(db: Db, table: string, columns: string, column: string, values: string[]): Promise<T[] | null> {
  const out: T[] = []
  for (let i = 0; i < values.length; i += CHUNK) {
    const part = values.slice(i, i + CHUNK)
    // Höchstens 1000 Zeilen je Antwort: bei plz_localities je Abschnitt blättern
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from(table).select(columns).in(column, part).order(column).range(from, from + 999)
      if (error) return null
      out.push(...(data as T[]))
      if (!data || data.length < 1000) break
    }
  }
  return out
}

/**
 * Lädt alles, was die Zuordnung für diese Eingaben braucht:
 *  - Straßen der angegebenen PLZ
 *  - Ortseinträge dieser PLZ und der angegebenen Orte
 *  - Straßen aller PLZ dieser Orte (für „PLZ fehlt“ und „andere PLZ im Ort“)
 */
export async function loadAddressIndex(db: Db, inputs: { postal_code?: string | null; city?: string | null }[]): Promise<LoadedDirectory | null> {
  const givenPlz = [...new Set(inputs.map(i => (i.postal_code || '').trim()).filter(p => /^\d{5}$/.test(p)))]
  const cityKeys = [...new Set(inputs.flatMap(i => localityVariants(i.city)))]

  // Ist das Verzeichnis überhaupt da?
  const probe = await db.from('street_directory').select('postal_code, version').limit(1)
  if (probe.error || !probe.data?.length) return null
  const version: string | null = probe.data[0].version ?? null

  const locOfPlz = (await selectIn<LocalityEntry>(db, 'plz_localities', 'postal_code, locality, locality_key, kind', 'postal_code', givenPlz)) ?? []
  const ortKeys = [...new Set(locOfPlz.filter(l => l.kind === 'ort').map(l => l.locality_key))]
  const locByKey = (await selectIn<LocalityEntry>(db, 'plz_localities', 'postal_code, locality, locality_key, kind', 'locality_key', [...new Set([...ortKeys, ...cityKeys])])) ?? []
  const localities = [...locOfPlz, ...locByKey]

  const wanted = new Set(givenPlz)
  for (const l of locByKey) { if (wanted.size >= MAX_DIRECTORY_PLZ) break; wanted.add(l.postal_code) }
  const rows = await selectIn<{ postal_code: string; streets: string[] }>(db, 'street_directory', 'postal_code, streets', 'postal_code', [...wanted])
  if (!rows) return null
  const streets = new Map(rows.map(r => [r.postal_code, r.streets || []]))
  // Bekannte PLZ: mit Straßenliste oder als PLZ-Fläche in postal_codes
  // (17 PLZ haben eine Fläche, aber keine Straßen, z. B. Großkunden-PLZ).
  const known = new Set(streets.keys())
  const missing = givenPlz.filter(p => !known.has(p))
  if (missing.length) {
    const ref = await selectIn<{ postal_code: string }>(db, 'postal_codes', 'postal_code, reference_version', 'postal_code', missing)
    for (const r of ref || []) if ((r as { reference_version?: string | null }).reference_version) known.add(r.postal_code)
  }
  return { index: new AddressIndex(streets, localities, known), streets, version }
}

/** Gibt es ein befülltes Straßenverzeichnis (Migration 009 + geladene Daten)? */
export async function directoryAvailable(db: Db): Promise<boolean> {
  const { data, error } = await db.from('street_directory').select('postal_code').limit(1)
  return !error && !!data?.length
}

/** Straßenlisten für weitere PLZ (z. B. aus früheren Importen) */
export async function loadStreetsForPlz(db: Db, plzs: string[]): Promise<Map<string, string[]>> {
  const rows = plzs.length ? await selectIn<{ postal_code: string; streets: string[] }>(db, 'street_directory', 'postal_code, streets', 'postal_code', plzs) : []
  return new Map((rows || []).map(r => [r.postal_code, r.streets || []]))
}
