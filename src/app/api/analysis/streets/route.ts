import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { rateStreets } from '@/lib/analysis/street-rating'
import { loadPlzMap } from '@/lib/geo/overpass'
import { streetNameKey } from '@/lib/geo/street-name'

/**
 * GET /api/analysis/streets?plz=50670
 *
 * Liefert street_analytics-Einträge für eine PLZ, damit AnalysisMap
 * die Straßen nach ihrer gespeicherten Klasse A–E einfärben kann.
 *
 * Felder je Straße:
 *   street_name, customer_count, order_count, revenue,
 *   avg_order_value, orders_per_customer, street_class, is_in_official_list
 *
 * Zusätzlich je Straße die Ampel (rating, index, expected, reason) aus
 * lib/analysis/street-rating.ts: Vergleich mit den anderen Straßen derselben
 * PLZ, wo möglich je Hausadresse (OpenStreetMap).
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nicht authentifiziert' }, { status: 401 })

  const plz = req.nextUrl.searchParams.get('plz')
  if (!plz || !/^\d{5}$/.test(plz)) return NextResponse.json({ error: 'PLZ fehlt oder ist ungültig' }, { status: 400 })

  // Company ID des Users
  const { data: membership } = await supabase
    .from('company_users')
    .select('company_id')
    .eq('user_id', user.id)
    .single()

  if (!membership) return NextResponse.json({ error: 'Kein Unternehmen gefunden' }, { status: 403 })

  const companyId = membership.company_id

  // Neueste Analyse für diese PLZ+Company holen
  // (mehrere Uploads möglich → neuesten analytics-Eintrag nehmen)
  const { data: analytics } = await supabase
    .from('analytics')
    .select('id, streets_total')
    .eq('company_id', companyId)
    .eq('postal_code', plz)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!analytics) {
    return NextResponse.json({ plz, streets: [] })
  }

  // Straßen-Analytics für diesen analytics-Eintrag – alle Seiten laden,
  // seit alle Straßen einer PLZ gespeichert werden (früher max. 200)
  const { data: streets, error } = await fetchAllRows((from, to) =>
    supabase
      .from('street_analytics')
      .select(
        'street_name, customer_count, order_count, revenue, ' +
        'avg_order_value, orders_per_customer, street_class, is_in_official_list',
        { count: 'exact' }
      )
      .eq('analytics_id', analytics.id)
      .eq('company_id', companyId)
      .order('order_count', { ascending: false })
      .order('id')
      .range(from, to))

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Hausadressen je Straße als Vergleichsgröße (wenn der Kartendienst sie liefert)
  const geo = await loadPlzMap(plz)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const list = (streets || []) as any[]
  const result = rateStreets({
    streets: list.map(s => ({ street_name: s.street_name, order_count: s.order_count, street_class: s.street_class })),
    // Ohne vollständiges Verzeichnis (streets_total = null) kein Vergleich
    directoryComplete: analytics.streets_total !== null && analytics.streets_total !== undefined,
    addressCounts: geo.ok ? geo.map.address_counts : null,
  })

  return NextResponse.json({
    plz,
    analytics_id: analytics.id,
    rating: {
      basis: result.basis,
      plz_average: result.plz_average,
      total_orders: result.total_orders,
      summary: result.summary,
      addresses_source: geo.ok ? geo.map.source : null,
    },
    streets: list.map(s => {
      const r = result.ratings.get(streetNameKey(s.street_name))
      return { ...s, rating: r?.rating ?? 'none', rating_index: r?.index ?? null, rating_expected: r?.expected ?? null, rating_reason: r?.reason ?? 'Nicht bewertbar: keine Daten.' }
    }),
  })
}
