// Der Service-Key-Client darf nur die gemeinsamen Referenzdaten erreichen.
import { describe, it, expect, vi } from 'vitest'

vi.mock('next/headers', () => ({ cookies: () => ({ get: () => undefined, set: () => {} }) }))

describe('Referenzdaten-Client', () => {
  it('kennt nur die vier gemeinsamen Tabellen, kein allgemeiner Service-Client', async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'nur-ein-testwert'
    const real = await import('@/lib/supabase/server')
    const ref = real.createReferenceDataClient()
    for (const t of real.REFERENCE_TABLES) expect(() => ref.from(t)).not.toThrow()
    for (const t of ['customers', 'companies', 'company_users', 'uploads', 'analytics', 'street_analytics', 'stores']) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => ref.from(t as any)).toThrow(/nicht freigegeben/)
    }
    expect([...real.REFERENCE_TABLES]).toEqual(['postal_codes', 'streets', 'poi_businesses', 'data_refresh_logs'])
    expect('createServiceClient' in real).toBe(false)
  })
})
