import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { analyzePLZ, analyzeStreets } from '@/lib/analysis/engine'
import { DataProviderOrchestrator } from '@/lib/providers'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

// GET /api/analysis/plz?plz=51063&upload_id=xxx
export async function GET(req: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nicht authentifiziert' }, { status: 401 })

  const plz = req.nextUrl.searchParams.get('plz')
  const uploadId = req.nextUrl.searchParams.get('upload_id')

  if (!plz) return NextResponse.json({ error: 'PLZ fehlt' }, { status: 400 })

  // Company ID des Users
  const { data: membership } = await supabase
    .from('company_users')
    .select('company_id, companies(google_places_api_key)')
    .eq('user_id', user.id)
    .single()

  if (!membership) return NextResponse.json({ error: 'Kein Unternehmen gefunden' }, { status: 403 })

  const companyId = membership.company_id
  const googleKey = (membership.companies as Record<string,string>)?.google_places_api_key

  // Kunden für diese PLZ – alle, nicht nur die ersten 1.000
  const { data: customers, error: customersError } = await fetchAllRows((from, to) => {
    let q = supabase.from('customers').select('*', { count: 'exact' }).eq('company_id', companyId).eq('postal_code', plz)
    if (uploadId) q = q.eq('upload_id', uploadId)
    return q.order('id').range(from, to)
  })
  if (customersError) {
    return NextResponse.json({ error: 'Kundendaten konnten nicht vollständig geladen werden', plz }, { status: 500 })
  }

  if (!customers?.length) {
    return NextResponse.json({ error: `Keine Kunden für PLZ ${plz}`, plz }, { status: 404 })
  }

  // Straßenverzeichnis live (vollständig oder ausdrücklich unvollständig).
  // Der Straßen-Cache in der Datenbank hat keine Vollständigkeits-Kennung
  // und wird deshalb nicht als Grundlage für "ohne Bestellungen" genutzt.
  const orchestrator = new DataProviderOrchestrator(googleKey)
  const streetDir = await orchestrator.getStreets(plz)
  const directory = { streets: streetDir.streets, complete: streetDir.complete }

  // Bevölkerungsdaten
  const { data: plzData } = await supabase.from('postal_codes').select('population, households, city, state').eq('postal_code', plz).single()

  // Analyse berechnen
  const rows = customers.map(c => ({
    postal_code: c.postal_code,
    street: c.street,
    street_normalized: c.street_normalized,
    city: c.city,
    total_orders: c.total_orders,
    total_revenue: c.total_revenue,
    avg_order_value: c.avg_order_value,
    last_order_date: c.last_order_date,
    is_vip: c.is_vip,
    rfm_segment: c.rfm_segment,
    late_deliveries: c.late_deliveries,
    _row_index: 0,
    _errors: [],
  }))

  const plzAnalysis = analyzePLZ(rows, directory, plzData?.population || null, plzData?.households || null)
  if (!streetDir.complete && streetDir.error) plzAnalysis.warnings.push(`⚠️ ${streetDir.error}`)
  const streetAnalysis = analyzeStreets(rows, directory)

  // POIs aus DB
  const { data: pois } = await supabase.from('poi_businesses').select('*').eq('postal_code', plz)

  // POI-Summary
  const poiSummary = {
    competitors: pois?.filter(p => p.is_competitor).length || 0,
    hotels:      pois?.filter(p => p.category === 'hotel').length || 0,
    schools:     pois?.filter(p => p.category === 'school').length || 0,
    hospitals:   pois?.filter(p => p.category === 'hospital').length || 0,
    offices:     pois?.filter(p => p.category === 'office').length || 0,
    restaurants: pois?.filter(p => p.category === 'restaurant').length || 0,
    total_b2b_targets: pois?.filter(p => ['hotel','school','hospital','authority','office','fitness'].includes(p.category)).length || 0,
  }

  return NextResponse.json({
    plz,
    city: plzData?.city,
    state: plzData?.state,
    analysis: { ...plzAnalysis, poi_summary: poiSummary },
    streets: {
      // complete = false: Verzeichnis fehlt/unvollständig, without_orders ist
      // dann leer und darf nicht als "0 Bestellungen" gelesen werden
      directory: {
        complete: streetDir.complete,
        status: streetDir.status,
        source: streetDir.source,
        count: streetDir.complete ? streetDir.count : null,
        message: streetDir.error || null,
      },
      total: streetAnalysis.length,
      with_orders: streetAnalysis.filter(s => s.order_count > 0),
      without_orders: streetAnalysis.filter(s => s.order_count === 0),
      class_a: streetAnalysis.filter(s => s.street_class === 'A'),
      class_b: streetAnalysis.filter(s => s.street_class === 'B'),
      class_c: streetAnalysis.filter(s => s.street_class === 'C'),
      class_d: streetAnalysis.filter(s => s.street_class === 'D'),
      class_e: streetAnalysis.filter(s => s.street_class === 'E'),
    },
    pois: {
      summary: poiSummary,
      competitors: pois?.filter(p => p.is_competitor) || [],
      b2b_targets: pois?.filter(p => ['hotel','school','hospital','authority','office','fitness'].includes(p.category)) || [],
    },
  })
}
