// Laden der PLZ-Karte aus OpenStreetMap (Overpass) mit Zwischenspeicher.
// Nur serverseitig verwenden.
import { buildPlzMap, overpassQuery, type PlzMap } from '@/lib/geo/plz-geometry'

const ENDPOINTS = [
  process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
]
const THIRTY_DAYS = 60 * 60 * 24 * 30

// Zwischenspeicher im Serverprozess. Zusätzlich speichert Next.js die
// Overpass-Antwort 30 Tage (fetch-Cache), solange sie unter 2 MB liegt.
const memory = new Map<string, { at: number; map: PlzMap }>()
const MEMORY_MAX = 60

export type PlzMapResult =
  | { ok: true; map: PlzMap; cached: boolean }
  | { ok: false; error: string; status: number }

type FetchLike = (url: string, init?: RequestInit & { next?: { revalidate?: number } }) => Promise<Response>

export async function loadPlzMap(plz: string, fetchImpl: FetchLike = fetch as FetchLike): Promise<PlzMapResult> {
  if (!/^\d{5}$/.test(plz)) return { ok: false, error: 'Ungültige PLZ', status: 400 }
  const hit = memory.get(plz)
  if (hit && Date.now() - hit.at < THIRTY_DAYS * 1000) return { ok: true, map: hit.map, cached: true }

  const query = overpassQuery(plz)
  let lastStatus = 0
  for (const endpoint of ENDPOINTS) {
    try {
      const res = await fetchImpl(`${endpoint}?data=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'GastroIntelligencePlatform/1.0 (Straßenkarte je PLZ)' },
        next: { revalidate: THIRTY_DAYS },
      })
      lastStatus = res.status
      if (!res.ok) continue
      const data = await res.json()
      if (data?.remark && /runtime error|timed out|out of memory/i.test(String(data.remark))) { lastStatus = 504; continue }
      const map = buildPlzMap(plz, data?.elements || [], new Date().toISOString())
      memory.set(plz, { at: Date.now(), map })
      if (memory.size > MEMORY_MAX) memory.delete(memory.keys().next().value as string)
      return { ok: true, map, cached: false }
    } catch {
      continue
    }
  }
  return {
    ok: false,
    status: 503,
    error: lastStatus === 429
      ? 'Der Kartendienst (OpenStreetMap) ist gerade ausgelastet. Bitte in ein paar Minuten erneut versuchen.'
      : 'Der Kartendienst (OpenStreetMap) ist gerade nicht erreichbar. Bitte später erneut versuchen.',
  }
}

export function clearPlzMapCache() { memory.clear() }
