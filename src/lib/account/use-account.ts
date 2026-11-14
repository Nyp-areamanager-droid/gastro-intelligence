'use client'
// Angaben zu Konto, Firma, Standorten und bisherigen Importen (/api/account).
import { useCallback, useEffect, useState } from 'react'

export interface AccountUpload { id: string; filename: string; created_at: string; period_start: string | null; period_end: string | null; row_count: number | null; status: string; import_mode: string | null; store_id: string | null; file_size_bytes: number | null }
export interface Account {
  user: { email: string }
  company: { name: string; plan: string | null; created_at: string | null }
  role: 'owner' | 'admin' | 'manager' | 'viewer'
  members: { total: number; by_role: Record<string, number> }
  stores: { id: string; name: string; city: string | null; postal_code: string | null; is_active: boolean }[]
  uploads: AccountUpload[]
  usage: { records: number; postal_codes: number; imports: number }
}
export const ROLE_LABELS: Record<string, { label: string; can: string }> = {
  owner: { label: 'Inhaber', can: 'Alles, einschließlich Nutzer verwalten und Daten löschen' },
  admin: { label: 'Administrator', can: 'Alles, einschließlich Nutzer verwalten und Daten löschen' },
  manager: { label: 'Manager', can: 'Auswertungen ansehen und Daten importieren' },
  viewer: { label: 'Betrachter', can: 'Auswertungen ansehen, nichts ändern' },
}

export function useAccount() {
  const [data, setData] = useState<Account | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await fetch('/api/account', { cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || 'Der Server hat nicht geantwortet. Bitte später erneut versuchen.')
      setData(body)
    } catch (e) { setError(e instanceof Error ? e.message : 'Unbekannter Fehler') } finally { setLoading(false) }
  }, [])
  useEffect(() => { load() }, [load])
  return { data, error, loading, reload: load }
}
