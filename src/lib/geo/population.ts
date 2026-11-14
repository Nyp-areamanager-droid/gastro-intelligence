// =============================================================================
// Einwohner und Haushalte je PLZ – nur aus belegter Quelle
//
// Gültig sind ausschließlich Werte in postal_codes, bei denen
// population_method gesetzt ist. Das setzt nur der Import der amtlichen
// Zensus-2022-Gitterdaten (scripts/zensus-plz-import.ts). Ältere Einträge
// ohne Methode (aus den früher eingebauten, unbelegten Tabellen) werden
// ignoriert. Fehlt ein Wert, bleibt er null und wird als „—“ angezeigt.
// =============================================================================

export const ZENSUS_METHOD = 'zensus2022_gitter100m_plz_osm'

export const POPULATION_SOURCE_TEXT =
  'Zensus 2022 (Statistisches Bundesamt, Stichtag 15.05.2022), 100-m-Gitterzellen den PLZ-Flächen aus OpenStreetMap zugeordnet'

export const MISSING_POPULATION_TEXT = 'Keine belegte Einwohnerzahl für diese PLZ'

/**
 * Unter dieser Einwohnerzahl ist eine PLZ-Summe aus dem Zensus-Gitter
 * unsicher: Der Zensus hält kleine Zellwerte geheim bzw. verrauscht sie.
 * Solche Werte werden angezeigt, aber gekennzeichnet und nicht für
 * Empfehlungen verwendet (gleiche Grenze wie RULES.MIN_POPULATION).
 */
export const MIN_RELIABLE_POPULATION = 1000

export const LIMITED_POPULATION_TEXT =
  'Unter 1.000 Einwohnern: Der Zensus hält kleine Werte geheim bzw. verändert sie leicht. Die Zahl ist deshalb nur eingeschränkt belastbar.'

export const HOUSEHOLDS_NOTE_TEXT =
  'Haushalte fehlen dort, wo die Zensus-Werte für die PLZ lückenhaft sind (meist dünn besiedelte Gebiete). Sie werden nicht geschätzt.'

export function isLimitedPopulation(population: number | null | undefined): boolean {
  return typeof population === 'number' && population > 0 && population < MIN_RELIABLE_POPULATION
}

export interface PostalCodeRecord {
  population?: number | null
  households?: number | null
  population_method?: string | null
  population_reference_date?: string | null
}

export interface VerifiedPopulation {
  population: number | null
  households: number | null
  method: string | null
  reference_date: string | null
}

export function verifiedPopulation(rec: PostalCodeRecord | null | undefined): VerifiedPopulation {
  if (!rec || !rec.population_method) return { population: null, households: null, method: null, reference_date: null }
  const pop = typeof rec.population === 'number' && rec.population > 0 ? rec.population : null
  const hh = typeof rec.households === 'number' && rec.households > 0 ? rec.households : null
  return { population: pop, households: hh, method: rec.population_method, reference_date: rec.population_reference_date ?? null }
}
