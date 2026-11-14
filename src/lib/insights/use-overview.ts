'use client'
// Lädt die Übersicht der eigenen Firma (/api/overview) für alle Auswertungsseiten.
import { useCallback, useEffect, useState } from 'react'
import type { Overview } from './overview'
import type { Recommendation } from './recommendations'

export interface OverviewResponse {
  company: { name: string }
  role: string
  stores: { id: string; name: string; city: string | null; postal_code: string | null; is_active: boolean }[]
  store: string | null
  range: { applied: boolean; reason: string | null; from: string | null; to: string | null; available: { start: string | null; end: string | null } }
  overview: Overview
  recommendations: Recommendation[]
}

export function useOverview() {
  const [store, setStore] = useState<string | null>(null)
  const [range, setRange] = useState<{ from: string; to: string } | null>(null)
  const [data, setData] = useState<OverviewResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const q = new URLSearchParams()
      if (store) q.set('store', store)
      if (range) { q.set('from', range.from); q.set('to', range.to) }
      const res = await fetch('/api/overview' + (q.size ? `?${q}` : ''), { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Der Server hat nicht geantwortet. Bitte später erneut versuchen.')
      setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unbekannter Fehler')
    } finally {
      setLoading(false)
    }
  }, [store, range])
  useEffect(() => { load() }, [load])

  return { data, error, loading, reload: load, store, setStore, range, setRange }
}
