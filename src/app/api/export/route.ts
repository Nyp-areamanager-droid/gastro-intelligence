import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveCompanyContext } from '@/lib/auth/company-context'
import { loadOverview } from '@/lib/insights/load-overview'
import { buildRecommendations } from '@/lib/insights/recommendations'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { rateLimit, tooManyRequests } from '@/lib/security/rate-limit'
import { toCsv, type CsvValue } from '@/lib/export/csv'

export const dynamic = 'force-dynamic'

/**
 * GET /api/export?type=plz|strassen|empfehlungen
 * Auswertungen der eigenen Firma als CSV. Enthält nur Summen je Gebiet bzw.
 * Straße – keine einzelnen Kundendatensätze. Jede Rolle, die lesen darf, darf
 * exportieren; gelesen wird mit der Sitzung des Nutzers (RLS).
 */
export async function GET(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { companyId, userId } = auth.ctx
  const limited = rateLimit(`export:${userId}`, 30, 600_000)
  if (!limited.ok) { const t = tooManyRequests(limited); return NextResponse.json(t.body, t.init) }

  const type = req.nextUrl.searchParams.get('type')
  let header: string[], rows: CsvValue[][], name: string

  if (type === 'strassen') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = supabase as any
    const { data: analytics } = await db.from('analytics').select('id, postal_code, computed_at').eq('company_id', companyId).order('computed_at', { ascending: false })
    const latest = new Map<string, string>()
    for (const a of analytics || []) if (!latest.has(a.postal_code)) latest.set(a.postal_code, a.id)
    const ids = [...latest.values()]
    type Row = { postal_code: string; street_name: string; customer_count: number; order_count: number; revenue: number; street_class: string | null; is_in_official_list: boolean | null }
    let data: Row[] = []
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50)
      const res = await fetchAllRows<Row>((from, to) =>
        db.from('street_analytics').select('postal_code, street_name, customer_count, order_count, revenue, street_class, is_in_official_list', { count: 'exact' })
          .eq('company_id', companyId).in('analytics_id', part).order('id').range(from, to))
      if (res.error) return NextResponse.json({ error: 'Die Straßendaten konnten nicht geladen werden.' }, { status: 500 })
      data = data.concat(res.data || [])
    }
    data.sort((a, b) => a.postal_code.localeCompare(b.postal_code) || Number(b.revenue) - Number(a.revenue))
    header = ['PLZ', 'Straße', 'Kunden', 'Bestellungen', 'Umsatz in Euro', 'Volumenklasse', 'Im Straßenverzeichnis']
    rows = data.map(s => [s.postal_code, s.street_name, s.customer_count, s.order_count, Math.round(Number(s.revenue) * 100) / 100, s.street_class, s.is_in_official_list === null ? '' : s.is_in_official_list ? 'ja' : 'nein'])
    name = 'strassen'
  } else if (type === 'plz' || type === 'empfehlungen') {
    const loaded = await loadOverview(supabase, companyId, null)
    if (loaded.ok === false) return NextResponse.json({ error: loaded.error }, { status: 500 })
    const o = loaded.overview
    if (type === 'plz') {
      header = ['PLZ', 'Ort', 'Kunden', 'Bestellungen', 'Umsatz in Euro', 'Umsatzanteil in %', 'Bestellwert in Euro', 'Einwohner (Zensus 2022)', 'Haushalte (Zensus 2022)', 'Bestellungen je 1.000 Einwohner', 'Straßen gesamt', 'Straßen ohne Bestellung']
      rows = o.plz.map(p => [p.postal_code, p.city, p.customers, p.orders, p.revenue, p.revenue_share_pct, p.avg_order_value, p.population, p.households, p.orders_per_1000, p.streets_total, p.streets_without_orders])
      name = 'postleitzahlen'
    } else {
      header = ['Priorität', 'Titel', 'Feststellung', 'Zahlen dahinter', 'Bedeutung', 'Mögliche Maßnahme', 'Sicherheit', 'Begründung der Sicherheit', 'Postleitzahlen']
      rows = buildRecommendations(o).map(r => [r.priority, r.title, r.finding, r.evidence.join(' | '), r.relevance, r.action, r.confidence.level, r.confidence.reason, r.postal_codes.join(', ')])
      name = 'empfehlungen'
    }
  } else {
    return NextResponse.json({ error: 'Unbekannter Export. Möglich: plz, strassen, empfehlungen.' }, { status: 400 })
  }

  const day = new Date().toISOString().slice(0, 10)
  return new NextResponse(toCsv(header, rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="gastro-intelligence-${name}-${day}.csv"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
