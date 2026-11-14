import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveCompanyContext } from '@/lib/auth/company-context'
import { loadOverview } from '@/lib/insights/load-overview'
import { buildRecommendations } from '@/lib/insights/recommendations'

export const dynamic = 'force-dynamic'

/**
 * GET /api/overview[?store=<id>][&from=JJJJ-MM-TT&to=JJJJ-MM-TT]
 * Alle Kennzahlen und Empfehlungen der eigenen Firma, auf dem Server berechnet.
 * Der Browser bekommt nur Summen – keine einzelnen Kundendatensätze.
 * Gelesen wird mit der Sitzung des Nutzers, die Zugriffsregeln (RLS) gelten.
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { companyId, role } = auth.ctx
  const store = req.nextUrl.searchParams.get('store')
  if (store && !/^[0-9a-f-]{36}$/i.test(store)) return NextResponse.json({ error: 'Ungültiger Standort' }, { status: 400 })

  const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
  const loaded = await loadOverview(supabase, companyId, store, { from: iso(req.nextUrl.searchParams.get('from')), to: iso(req.nextUrl.searchParams.get('to')) })
  if (loaded.ok === false) return NextResponse.json({ error: loaded.error }, { status: 500 })
  const { company, stores, overview, range } = loaded
  return NextResponse.json({
    company, role,
    stores, store: store || null, range,
    overview, recommendations: buildRecommendations(overview),
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
