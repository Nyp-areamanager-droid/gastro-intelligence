// Einfache Bremse gegen Missbrauch teurer Routen (Kartendienste, Import).
// Zählt Aufrufe je Schlüssel (Nutzer + Route) in einem Zeitfenster.
//
// Grenze dieser Lösung: Der Zähler lebt im Speicher EINES Serverprozesses.
// Auf Vercel laufen mehrere Prozesse nebeneinander und werden oft neu
// gestartet – die Bremse wirkt dort also nur grob. Für eine harte Grenze
// braucht es einen gemeinsamen Speicher (Datenbank oder Redis); das ist als
// späterer Schritt im Übernahmeplan vermerkt.
const buckets = new Map<string, { count: number; resetAt: number }>()
const MAX_KEYS = 5000

export interface RateLimitResult { ok: boolean; retryAfterSeconds: number }

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    if (buckets.size >= MAX_KEYS) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k)
      if (buckets.size >= MAX_KEYS) buckets.clear()
    }
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true, retryAfterSeconds: 0 }
  }
  b.count++
  if (b.count > limit) return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
  return { ok: true, retryAfterSeconds: 0 }
}

export function resetRateLimits() { buckets.clear() }

/** Fertige Antwort „zu viele Anfragen“ als einfache Daten (Route baut daraus die Antwort). */
export function tooManyRequests(r: RateLimitResult) {
  return {
    body: { error: `Zu viele Anfragen in kurzer Zeit. Bitte in ${r.retryAfterSeconds} Sekunden erneut versuchen.` },
    init: { status: 429, headers: { 'Retry-After': String(r.retryAfterSeconds) } },
  }
}
