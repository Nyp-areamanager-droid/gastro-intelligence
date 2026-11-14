// =============================================================================
// Importzeilen geografisch zuordnen (Bindeglied zwischen Import und
// Adresszuordnung). Rein rechnend, ohne Datenbank – damit testbar.
//
//   - Zeilen mit PLZ: Status wird gesetzt, PLZ bleibt unverändert.
//   - Zeilen ohne PLZ: PLZ wird nur bei eindeutigem Ergebnis ergänzt.
//     Sonst wird die Zeile NICHT übernommen und im Fehlerbericht genannt –
//     eine Bestellung ohne verlässliche PLZ darf keine PLZ-Zahl verfälschen.
// =============================================================================

import type { ParsedCustomerRow } from '@/types'
import { GEO_STATUS_TEXT, summarizeMatches, type AddressIndex, type GeoSummary, type MatchInput, type MatchResult } from './address-match'

export interface ImportProblemLike { row: number; reason: string }

export interface AssignResult {
  rows: ParsedCustomerRow[]
  dropped: number
  problems: ImportProblemLike[]
  summary: GeoSummary | null
}

export function assignRows(rows: ParsedCustomerRow[], index: AddressIndex | null, directoryVersion: string | null = null, maxProblems = 500): AssignResult {
  const problems: ImportProblemLike[] = []
  if (!index) {
    // Ohne Verzeichnis: Zeilen ohne PLZ können nicht übernommen werden
    const kept = rows.filter(r => !r._needs_postal_code)
    for (const r of rows) if (r._needs_postal_code && problems.length < maxProblems) problems.push({ row: r._row_index, reason: 'Postleitzahl fehlt – Zeile nicht übernommen (Straßenverzeichnis nicht verfügbar)' })
    return { rows: kept, dropped: rows.length - kept.length, problems, summary: null }
  }
  const matched: { input: MatchInput; result: MatchResult }[] = []
  const kept: ParsedCustomerRow[] = []
  let dropped = 0
  // Erster Durchgang: Zeilen mit PLZ. Ihre gesicherten Leitregionen helfen
  // bei Zeilen ohne PLZ, gleichnamige Orte zu unterscheiden.
  const results = new Map<ParsedCustomerRow, { input: MatchInput; result: MatchResult }>()
  const regions = new Set<string>()
  for (const r of rows) {
    if (r._needs_postal_code) continue
    const input: MatchInput = { postal_code: r.postal_code, city: r.city, street: r.street }
    const result = index.match(input)
    results.set(r, { input, result })
    if (result.status === 'exakt' || result.status === 'schreibweise') regions.add(result.postal_code!.slice(0, 2))
  }
  for (const r of rows) {
    if (!r._needs_postal_code) continue
    const input: MatchInput = { postal_code: null, city: r.city, street: r.street, regionPrefixes: regions }
    results.set(r, { input, result: index.match(input) })
  }
  for (const r of rows) {
    const { input, result } = results.get(r)!
    matched.push({ input: { postal_code: input.postal_code, city: input.city, street: input.street }, result })
    if (r._needs_postal_code) {
      if (result.status === 'plz_ergaenzt' && result.postal_code) {
        kept.push({ ...r, postal_code: result.postal_code, geo_status: result.status, _needs_postal_code: false })
      } else {
        dropped++
        if (problems.length < maxProblems) {
          const why = result.status === 'mehrdeutig'
            ? `Postleitzahl fehlt; „${r.street}“ liegt in ${r.city} in mehreren PLZ (${result.candidates.join(', ')}) – Zeile nicht übernommen`
            : `Postleitzahl fehlt und ließ sich nicht bestimmen (${GEO_STATUS_TEXT[result.status]}) – Zeile nicht übernommen`
          problems.push({ row: r._row_index, reason: why })
        }
      }
      continue
    }
    if (result.status === 'plz_pruefen' && problems.length < maxProblems) {
      problems.push({ row: r._row_index, reason: `„${r.street}“ liegt laut Straßenverzeichnis nicht in PLZ ${r.postal_code}, sondern in ${result.candidates.join(', ')} – übernommen unter ${r.postal_code}, bitte prüfen` })
    } else if (result.status === 'plz_unbekannt' && problems.length < maxProblems) {
      problems.push({ row: r._row_index, reason: `PLZ ${r.postal_code} gibt es laut Verzeichnis nicht – übernommen, bitte prüfen` })
    }
    kept.push({ ...r, geo_status: result.status })
  }
  return { rows: kept, dropped, problems, summary: summarizeMatches(matched, directoryVersion) }
}
