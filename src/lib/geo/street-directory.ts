// =============================================================================
// Straßenverzeichnis je PLZ (OpenPLZ) – mit Vollständigkeitsprüfung
//
// Grundsatz: Eine Straßenliste gilt nur dann als vollständig, wenn ALLE
// Seiten fehlerfrei geladen wurden und die Anzahl zur Gesamtzahl passt,
// die OpenPLZ im Header x-total-count meldet. Alles andere ist
// "incomplete" und darf nie zu "0 Bestellungen" (Klasse E) führen und nie
// als vollständige Liste gespeichert werden.
//
// Fakten zur OpenPLZ-API (geprüft im Quellcode github.com/openpotato/openplzapi,
// DEController.GetStreetsAsync, Stand Feb. 2026):
//   - pageSize: 1 bis 50 (Range(1, 50)), größere Werte → HTTP 400
//   - postalCode wird als regulärer Ausdruck ausgewertet → hier verankert ^…$
//   - Sortierung: Name, PLZ, Ort  (stabil für Paging)
//   - Header: x-page, x-page-size, x-total-pages, x-total-count
//     (x-total-pages ist bei glatten Teilern um 1 zu hoch, daher zählt
//      x-total-count)
// =============================================================================

import { streetNameKey } from './street-name'

export const OPENPLZ_BASE = 'https://openplzapi.org/de'
export const OPENPLZ_MAX_PAGE_SIZE = 50
/** Schutz vor Endlosschleifen: 200 × 50 = 10.000 Einträge pro PLZ */
export const OPENPLZ_MAX_PAGES = 200

export interface DirectoryStreet {
  /** Name, wie die Quelle ihn schreibt (für die Anzeige) */
  name: string
  /** Vergleichsschlüssel aus streetNameKey (ohne Hausnummern-Abschnitt) */
  key: string
  /** Orte innerhalb der PLZ, in denen die Straße vorkommt */
  localities: string[]
}

export type StreetDirectoryStatus = 'complete' | 'incomplete' | 'empty'

export interface StreetDirectoryResult {
  postalCode: string
  status: StreetDirectoryStatus
  /** Nur bei status 'complete' als vollständig zu verwenden */
  streets: DirectoryStreet[]
  source: 'openplz'
  /** Gesamtzahl laut Quelle (vor Zusammenfassung von Duplikaten) */
  totalReported: number | null
  /** Tatsächlich geladene Einträge (vor Zusammenfassung) */
  totalFetched: number
  pagesFetched: number
  /** Grund, falls nicht vollständig */
  reason?: string
  fetchedAt: string
}

interface RawStreet {
  name?: string
  postalCode?: string
  locality?: string
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504])

async function fetchPage(url: string, fetchImpl: FetchLike, retries = 2): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20000)
    try {
      const res = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'GastroIntelligence/1.0' },
        signal: controller.signal,
      })
      clearTimeout(timer)
      // 4xx (außer 408/425/429) sind Anfragefehler: Wiederholen hilft nicht
      if (res.ok || !RETRYABLE.has(res.status) || attempt === retries) return res
    } catch (err) {
      clearTimeout(timer)
      lastError = err
      if (attempt === retries) throw err
    }
    await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
  }
  throw lastError ?? new Error('Abruf fehlgeschlagen')
}

/** Fasst Einträge mit gleichem Vergleichsschlüssel zusammen. */
export function mergeDirectoryEntries(raw: RawStreet[]): DirectoryStreet[] {
  const byKey = new Map<string, DirectoryStreet>()
  for (const item of raw) {
    const name = (item.name || '').trim()
    const key = streetNameKey(name)
    if (!key) continue
    const existing = byKey.get(key)
    const locality = (item.locality || '').trim()
    if (existing) {
      if (locality && !existing.localities.includes(locality)) existing.localities.push(locality)
    } else {
      byKey.set(key, { name, key, localities: locality ? [locality] : [] })
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

/**
 * Lädt alle Straßen einer PLZ aus OpenPLZ, Seite für Seite.
 * Wirft nie: Fehler werden als status 'incomplete' mit Grund zurückgegeben.
 */
export async function fetchStreetDirectory(
  postalCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<StreetDirectoryResult> {
  const base = {
    postalCode,
    source: 'openplz' as const,
    fetchedAt: new Date().toISOString(),
  }
  const incomplete = (reason: string, raw: RawStreet[], pages: number, total: number | null): StreetDirectoryResult => ({
    ...base,
    status: 'incomplete',
    streets: mergeDirectoryEntries(raw),
    totalReported: total,
    totalFetched: raw.length,
    pagesFetched: pages,
    reason,
  })

  if (!/^\d{5}$/.test(postalCode)) {
    return incomplete('Ungültige PLZ', [], 0, null)
  }

  const raw: RawStreet[] = []
  let received = 0 // alle gelieferten Einträge, für den Abgleich mit x-total-count
  let totalReported: number | null = null
  let page = 1

  while (page <= OPENPLZ_MAX_PAGES) {
    const url =
      `${OPENPLZ_BASE}/Streets?postalCode=${encodeURIComponent(`^${postalCode}$`)}` +
      `&page=${page}&pageSize=${OPENPLZ_MAX_PAGE_SIZE}`

    let res: Response
    try {
      res = await fetchPage(url, fetchImpl)
    } catch (err) {
      return incomplete(`Seite ${page} nicht erreichbar: ${err instanceof Error ? err.message : 'Netzwerkfehler'}`, raw, page - 1, totalReported)
    }
    if (!res.ok) {
      return incomplete(`Seite ${page}: HTTP ${res.status}`, raw, page - 1, totalReported)
    }

    let data: unknown
    try {
      data = await res.json()
    } catch {
      return incomplete(`Seite ${page}: Antwort nicht lesbar`, raw, page - 1, totalReported)
    }
    if (!Array.isArray(data)) {
      return incomplete(`Seite ${page}: unerwartetes Antwortformat`, raw, page - 1, totalReported)
    }

    const headerTotal = Number(res.headers.get('x-total-count'))
    if (Number.isFinite(headerTotal) && res.headers.get('x-total-count') !== null) {
      if (totalReported !== null && headerTotal !== totalReported) {
        return incomplete('Gesamtzahl hat sich während des Ladens geändert', raw, page, headerTotal)
      }
      totalReported = headerTotal
    }

    received += data.length
    // Nur Einträge genau dieser PLZ übernehmen (Absicherung zusätzlich zum ^…$)
    for (const item of data as RawStreet[]) {
      if (!item?.postalCode || item.postalCode === postalCode) raw.push(item)
    }

    if (totalReported !== null) {
      if (totalReported === 0) {
        return { ...base, status: 'empty', streets: [], totalReported: 0, totalFetched: 0, pagesFetched: page }
      }
      if (received >= totalReported) break
      if (data.length === 0) {
        return incomplete(`Nur ${received} von ${totalReported} Straßen geliefert`, raw, page, totalReported)
      }
    } else {
      // Ohne Gesamtzahl: Ende erst bei einer nicht vollen Seite
      if (data.length < OPENPLZ_MAX_PAGE_SIZE) break
    }
    page++
  }

  if (page > OPENPLZ_MAX_PAGES) {
    return incomplete(`Mehr als ${OPENPLZ_MAX_PAGES} Seiten – Abruf abgebrochen`, raw, OPENPLZ_MAX_PAGES, totalReported)
  }
  if (totalReported !== null && received !== totalReported) {
    return incomplete(`${received} statt ${totalReported} Straßen geliefert`, raw, page, totalReported)
  }
  if (raw.length === 0) {
    return { ...base, status: 'empty', streets: [], totalReported, totalFetched: 0, pagesFetched: page }
  }

  return {
    ...base,
    status: 'complete',
    streets: mergeDirectoryEntries(raw),
    totalReported,
    totalFetched: raw.length,
    pagesFetched: page,
  }
}

// ── Kurzzeit-Cache im Serverprozess ──────────────────────────────────────────
// Nur vollständige Ergebnisse, 6 Stunden. Spart wiederholte Abrufe, wenn die
// Straßenseite mehrfach geöffnet wird. Kein Ersatz für einen dauerhaften
// Referenzbestand (siehe Konzept NRW-Pilot).
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
const memoryCache = new Map<string, { at: number; result: StreetDirectoryResult }>()

export async function getStreetDirectory(
  postalCode: string,
  fetchImpl: FetchLike = fetch,
): Promise<StreetDirectoryResult> {
  const hit = memoryCache.get(postalCode)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result
  const result = await fetchStreetDirectory(postalCode, fetchImpl)
  if (result.status === 'complete') memoryCache.set(postalCode, { at: Date.now(), result })
  return result
}

export function invalidateStreetDirectory(postalCode: string): void {
  memoryCache.delete(postalCode)
}

export function clearStreetDirectoryCache(): void {
  memoryCache.clear()
}
