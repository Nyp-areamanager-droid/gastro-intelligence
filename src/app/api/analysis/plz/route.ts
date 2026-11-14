import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { analyzePLZ, analyzeStreets } from '@/lib/analysis/engine'
import { DataProviderOrchestrator } from '@/lib/providers'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveCompanyContext } from '@/lib/auth/company-context'
import { rateLimit, tooManyRequests } from '@/lib/security/rate-limit'
import { verifiedPopulation } from '@/lib/geo/population'
import { mergeCustomers } from '@/lib/analysis/merge-customers'
import { customerRecordToRow } from '@/lib/analysis/customer-record'

// GET /api/analysis/plz?plz=51063&upload_id=xxx
export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { companyId, userId } = auth.ctx

  const plz = req.nextUrl.searchParams.get('plz')
  const uploadId = req.nextUrl.searchParams.get('upload_id')
  if (!plz || !/^\d{5}$/.test(plz)) return NextResponse.json({ error: 'PLZ fehlt oder ist ungültig' }, { status: 400 })
  if (uploadId && !/^[0-9a-f-]{36}$/i.test(uploadId)) return NextResponse.json({ error: 'Ungültiger Import' }, { status: 400 })
  // Jede Anfrage fragt das Straßenverzeichnis ab: bremsen
  const limited = rateLimit(`plz-analyse:${userId}`, 120, 600_000)
  if (!limited.ok) { const t = tooManyRequests(limited); return NextResponse.json(t.body, t.init) }

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
  const orchestrator = new DataProviderOrchestrator()
  const streetDir = await orchestrator.getStreets(plz)
  const directory = { streets: streetDir.streets, complete: streetDir.complete }

  // Einwohner/Haushalte nur mit belegter Herkunft (Zensus-Import), sonst unbekannt
  const { data: plzData } = await supabase.from('postal_codes').select('population, households, city, state, population_method, population_reference_date').eq('postal_code', plz).maybeSingle()
  const { population, households } = verifiedPopulation(plzData)

  // Dieselbe Person aus mehreren Zeilen/Importen zählt einmal (Kundennummer
  // oder Telefon-Kennzeichen) – wie beim Import und in der Übersicht.
  const rows = mergeCustomers(customers.map(c => customerRecordToRow(c, companyId)))

  const plzAnalysis = analyzePLZ(rows, directory, population, households)
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
