import { createServerClient } from '@supabase/ssr'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import type { Database } from './database.types'

export function createServerSupabaseClient() {
  const cookieStore = cookies()
  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://placeholder.supabase.co',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'placeholder-key',
    {
      cookies: {
        get(name: string) { return cookieStore.get(name)?.value },
        set(name: string, value: string, options: Record<string, unknown>) {
          try { cookieStore.set({ name, value, ...options }) } catch {}
        },
        remove(name: string, options: Record<string, unknown>) {
          try { cookieStore.set({ name, value: '', ...options }) } catch {}
        },
      },
    }
  )
}

/**
 * Gemeinsame Referenzdaten (PLZ, Straßenverzeichnis, POI, Abruf-Protokoll)
 * gehören keiner Firma und dürfen von Nutzern nur gelesen werden. Geschrieben
 * werden sie ausschließlich über diesen Client mit dem Service-Key.
 *
 * Der Client kennt NUR diese vier Tabellen. Firmendaten (Kunden, Analysen,
 * Uploads, Mitglieder, Storage) schreibt der Server immer mit der Sitzung des
 * Nutzers über createServerSupabaseClient(), damit die RLS-Regeln greifen.
 * Ein Service-Client für Firmendaten wird bewusst nicht angeboten.
 */
export const REFERENCE_TABLES = ['postal_codes', 'streets', 'poi_businesses', 'data_refresh_logs'] as const
export type ReferenceTable = typeof REFERENCE_TABLES[number]

export function createReferenceDataClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variable')
  }
  const service = createSupabaseClient<Database>(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
  return {
    from<T extends ReferenceTable>(table: T) {
      if (!(REFERENCE_TABLES as readonly string[]).includes(table)) {
        throw new Error(`Referenzdaten-Client: Tabelle ${String(table)} ist nicht freigegeben`)
      }
      return service.from(table)
    },
  }
}
