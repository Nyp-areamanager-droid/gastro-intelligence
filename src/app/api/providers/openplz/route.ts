import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { openplzProvider, censusProvider } from '@/lib/providers'

// GET /api/providers/openplz?plz=51063&refresh=false
export async function GET(req: NextRequest) {
  const plz = req.nextUrl.searchParams.get('plz')
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === 'true'

  if (!plz || !/^\d{5}$/.test(plz)) {
    return NextResponse.json({ error: 'Ungültige PLZ' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Aus DB laden wenn frisch genug (< 30 Tage)
  if (!forceRefresh) {
    const { data: cached } = await supabase
      .from('streets')
      .select('name, data_source, last_fetched_at')
      .eq('postal_code', plz)
      .order('name')
      .limit(1000)

    if (cached && cached.length > 0) {
      const firstFetch = cached[0].last_fetched_at
      const age = Date.now() - new Date(firstFetch).getTime()
      const thirtyDays = 30 * 24 * 60 * 60 * 1000

      if (age < thirtyDays) {
        return NextResponse.json({
          plz,
          streets: cached.map(s => s.name),
          count: cached.length,
          source: cached[0].data_source,
          from_cache: true,
          cached_at: firstFetch,
        })
      }
    }
  }

  // Live aus OpenPLZ
  const start = Date.now()
  const streets = await openplzProvider.getStreetsByPostalCode(plz)
  const plzInfo = await openplzProvider.getPostalCodeInfo(plz)
  const census = censusProvider.getCensusData(plz)
  const duration = Date.now() - start

  if (streets.length === 0) {
    // Refresh-Log
    await supabase.from('data_refresh_logs').insert({
      postal_code: plz,
      data_type: 'streets',
      data_source: 'openplz',
      status: 'failed',
      records_fetched: 0,
      duration_ms: duration,
      error_message: 'Keine Straßen von OpenPLZ zurückgegeben',
    })

    return NextResponse.json({
      plz,
      streets: [],
      count: 0,
      warning: `Keine Straßen für PLZ ${plz} in OpenPLZ gefunden. Die PLZ existiert möglicherweise nicht oder die API ist nicht erreichbar.`,
      census: census || { warning: `Einwohnerzahl für PLZ ${plz} nicht im Zensus 2022 vorhanden.` },
    })
  }

  // Postal Code upserten
  await supabase.from('postal_codes').upsert({
    postal_code: plz,
    city: plzInfo?.city || plz,
    state: plzInfo?.state || null,
    district: plzInfo?.district || null,
    municipality: plzInfo?.municipality || null,
    population: census?.population || null,
    households: census?.households || null,
    population_year: census?.year || null,
    population_source: census ? 'census' : null,
    data_source: 'openplz',
    trust_level: 'official',
    last_fetched_at: new Date().toISOString(),
    needs_refresh: false,
  }, { onConflict: 'postal_code' })

  // Straßen upserten
  const streetRecords = streets.map(s => ({
    postal_code: plz,
    name: s.name,
    name_normalized: s.name.toLowerCase().replace(/\s+/g,'').replace(/straße|strasse/g,'str'),
    data_source: 'openplz' as const,
    last_fetched_at: new Date().toISOString(),
  }))

  await supabase.from('streets')
    .upsert(streetRecords, { onConflict: 'postal_code,name_normalized', ignoreDuplicates: false })

  // Log
  await supabase.from('data_refresh_logs').insert({
    postal_code: plz,
    data_type: 'streets',
    data_source: 'openplz',
    status: 'success',
    records_fetched: streets.length,
    records_inserted: streets.length,
    duration_ms: duration,
  })

  return NextResponse.json({
    plz,
    city: plzInfo?.city,
    state: plzInfo?.state,
    streets: streets.map(s => s.name),
    count: streets.length,
    source: 'openplz',
    from_cache: false,
    census: census || {
      warning: `Einwohnerzahl für PLZ ${plz} nicht im Zensus 2022 vorhanden. Bitte manuell ergänzen oder alternative Quelle nutzen.`,
    },
  })
}
