// =============================================================================
// Alle Zeilen einer Supabase-Abfrage laden
//
// Supabase (PostgREST) liefert pro Anfrage höchstens "max rows" Zeilen,
// Standard 1.000, im Projekt einstellbar. Ohne Paging werden größere
// Ergebnisse ohne Fehlermeldung abgeschnitten.
//
// Ablauf: Erste Seite mit count: 'exact' anfordern → Gesamtzahl bekannt.
// Dann so lange weiterblättern, bis alle Zeilen da sind. Das Ende wird an der
// Gesamtzahl erkannt, nicht an einer "kurzen Seite". So funktioniert es auch,
// wenn "max rows" im Projekt kleiner als die angefragte Seitengröße ist.
//
// Wichtig: Die Abfrage braucht eine stabile Sortierung (z. B. .order('id')),
// sonst können sich Seiten überschneiden.
// =============================================================================

export interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
  count?: number | null
}

/**
 * @param buildPage Baut die Abfrage für einen Bereich [from, to] (inklusive).
 *                  Muss .range(from, to) und eine feste Sortierung enthalten
 *                  und beim ersten Aufruf (from === 0) count: 'exact' setzen.
 */
export async function fetchAllRows<T>(
  buildPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
  maxRows = 200_000,
): Promise<{ data: T[]; error: { message: string } | null; complete: boolean }> {
  const all: T[] = []
  let total: number | null = null

  while (all.length < maxRows) {
    const from = all.length
    const { data, error, count } = await buildPage(from, from + pageSize - 1)
    if (error) return { data: all, error, complete: false }
    if (typeof count === 'number') total = count
    const rows = data || []
    all.push(...rows)

    if (rows.length === 0) break
    if (total !== null && all.length >= total) break
    // Ohne Gesamtzahl: Ende nur bei leerer Seite sicher erkennbar
  }

  const complete = total !== null ? all.length >= total : true
  if (all.length >= maxRows && (total === null || total > maxRows)) {
    return { data: all, error: { message: `Mehr als ${maxRows} Zeilen – Abfrage abgebrochen` }, complete: false }
  }
  return { data: all, error: null, complete }
}
