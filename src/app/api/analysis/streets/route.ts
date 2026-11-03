import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

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
 * Keine neuen Berechnungen – nur Lesezugriff auf bestehende Daten.
 */
export async function GET(req: NextRequest) {
  const supabase = createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Nicht authentifiziert' }, { status: 401 })

  const plz = req.nextUrl.searchParams.get('plz')
  if (!plz) return NextResponse.json({ error: 'PLZ fehlt' }, { status: 400 })

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
    .select('id')
    .eq('company_id', companyId)
    .eq('postal_code', plz)
    .order('created_at', { ascending: false })
    .limit(1)
    .single()

  if (!analytics) {
    return NextResponse.json({ plz, streets: [] })
  }

  // Straßen-Analytics für diesen analytics-Eintrag
  const { data: streets, error } = await supabase
    .from('street_analytics')
    .select(
      'street_name, customer_count, order_count, revenue, ' +
      'avg_order_value, orders_per_customer, street_class, is_in_official_list'
    )
    .eq('analytics_id', analytics.id)
    .eq('company_id', companyId)
    .order('order_count', { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({
    plz,
    analytics_id: analytics.id,
    streets: streets || [],
  })
}
