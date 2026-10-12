import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { osmProvider } from '@/lib/providers'
import type { POICategory } from '@/types'

// GET /api/providers/osm?plz=51063&categories=restaurant,hotel,school
export async function GET(req: NextRequest) {
  const plz = req.nextUrl.searchParams.get('plz')
  const categoriesParam = req.nextUrl.searchParams.get('categories') || 'restaurant,hotel,school,hospital,authority,fitness,office'
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === 'true'

  if (!plz || !/^\d{5}$/.test(plz)) {
    return NextResponse.json({ error: 'Ungültige PLZ' }, { status: 400 })
  }

  const categories = categoriesParam.split(',').filter(Boolean) as POICategory[]
  const supabase = createServiceClient()

  // Cache-Check (7 Tage)
  if (!forceRefresh) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    const { data: cached } = await supabase
      .from('poi_businesses')
      .select('*')
      .eq('postal_code', plz)
      .gt('last_fetched_at', sevenDaysAgo)

    if (cached && cached.length > 0) {
      return NextResponse.json({
        plz, pois: cached, count: cached.length,
        from_cache: true, categories_loaded: Array.from(new Set(cached.map(p => p.category as string))),
      })
    }
  }

  // Bounding Box
  const bbox = await osmProvider.getBoundingBox(plz)
  if (!bbox) {
    return NextResponse.json({
      plz, pois: [], count: 0,
      warning: `Kein Bounding Box für PLZ ${plz} gefunden. OSM-Daten können nicht geladen werden.`,
    })
  }

  const start = Date.now()
  const osmResults = await osmProvider.getPOIsByPostalCode(plz, categories)
  const duration = Date.now() - start

  // Klassifizieren + Wettbewerber markieren
  const deliveryKeywords = ['pizza', 'burger', 'döner', 'sushi', 'kebab', 'lieferdienst', 'dominos', 'mcdonalds', 'kfc']

  const poiRecords = osmResults.map(r => ({
    postal_code: plz,
    name: r.name,
    category: osmProvider.classifyOSMCategory(r.tags || {}),
    lat: r.lat,
    lng: r.lng,
    osm_id: r.osm_id,
    is_chain: false,
    is_competitor: osmProvider.isCompetitor(r.tags || {}, deliveryKeywords),
    data_source: 'osm' as const,
    last_fetched_at: new Date().toISOString(),
  }))

  // In DB speichern (alte löschen, neue einfügen)
  await supabase.from('poi_businesses').delete().eq('postal_code', plz).eq('data_source', 'osm')
  if (poiRecords.length > 0) {
    await supabase.from('poi_businesses').insert(poiRecords)
  }

  // Log
  await supabase.from('data_refresh_logs').insert({
    postal_code: plz,
    data_type: 'poi',
    data_source: 'osm',
    status: osmResults.length > 0 ? 'success' : 'partial',
    records_fetched: osmResults.length,
    duration_ms: duration,
  })

  // POI-Zusammenfassung
  const summary = {
    competitors:  poiRecords.filter(p => p.is_competitor).length,
    restaurants:  poiRecords.filter(p => p.category === 'restaurant').length,
    hotels:       poiRecords.filter(p => p.category === 'hotel').length,
    schools:      poiRecords.filter(p => p.category === 'school').length,
    hospitals:    poiRecords.filter(p => p.category === 'hospital').length,
    authorities:  poiRecords.filter(p => p.category === 'authority').length,
    offices:      poiRecords.filter(p => p.category === 'office').length,
    fitness:      poiRecords.filter(p => p.category === 'fitness').length,
    total_b2b:    poiRecords.filter(p => ['hotel','school','hospital','authority','office','fitness'].includes(p.category)).length,
  }

  return NextResponse.json({
    plz, pois: poiRecords, count: poiRecords.length,
    from_cache: false, summary,
    bbox: { south: bbox[0], north: bbox[1], west: bbox[2], east: bbox[3] },
  })
}
