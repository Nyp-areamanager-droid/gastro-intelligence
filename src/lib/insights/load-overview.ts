// Lädt alle Daten der eigenen Firma und berechnet die Übersicht.
// Gemeinsam genutzt von /api/overview (Anzeige) und /api/export (CSV).
// Gelesen wird mit der Sitzung des Nutzers, die Zugriffsregeln (RLS) gelten.
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { pseudonymizePhone } from '@/lib/privacy/pseudonym'
import { findNearbyPotential, queryBounds, type PlzCandidate } from './nearby'
import { buildOverview, filterByRange, type Overview, type OverviewCustomerRow, type OverviewUpload, type OverviewPostalCode, type OverviewPlzDirectory, type OverviewStreetRow } from './overview'

export type LoadedOverview =
  | { ok: true; company: { name: string }; stores: { id: string; name: string; city: string | null; postal_code: string | null; is_active: boolean }[]; overview: Overview; range: OverviewRange }
  | { ok: false; error: string }

export interface OverviewRange { applied: boolean; reason: string | null; from: string | null; to: string | null; available: { start: string | null; end: string | null } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadOverview(supabase: any, companyId: string, store: string | null, range?: { from: string | null; to: string | null }): Promise<LoadedOverview> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const [{ data: company }, { data: stores }, { data: uploads, error: upErr }] = await Promise.all([
    db.from('companies').select('name').eq('id', companyId).maybeSingle(),
    db.from('stores').select('id, name, city, postal_code, is_active').eq('company_id', companyId).order('name'),
    db.from('uploads').select('id, filename, period_start, period_end, created_at, column_mapping, status, store_id').eq('company_id', companyId).order('created_at'),
  ])
  if (upErr) return { ok: false, error: 'Die Daten konnten nicht geladen werden. Bitte erneut versuchen.' }

  const { data: customers, error } = await fetchAllRows<OverviewCustomerRow>((from, to) => {
    let q = db.from('customers')
      .select('upload_id, customer_ref, phone_normalized, postal_code, street, street_normalized, total_orders, total_revenue, last_order_date, platform', { count: 'exact' })
      .eq('company_id', companyId)
    if (store) q = q.eq('store_id', store)
    return q.order('id').range(from, to)
  })
  if (error) return { ok: false, error: 'Die Kundendaten konnten nicht geladen werden. Bitte erneut versuchen.' }
  const rows = (customers || []).map(c => ({ ...c, total_revenue: Number(c.total_revenue || 0), phone_normalized: pseudonymizePhone(companyId, c.phone_normalized) || null }))

  const plzList = [...new Set(rows.map(r => r.postal_code))]
  let postalCodes: OverviewPostalCode[] = [], directories: OverviewPlzDirectory[] = [], streetRows: OverviewStreetRow[] = []
  if (plzList.length) {
    const [{ data: pcs }, { data: analytics }] = await Promise.all([
      db.from('postal_codes').select('postal_code, city, population, households, population_method, population_reference_date, lat, lng').in('postal_code', plzList),
      db.from('analytics').select('id, postal_code, streets_total, streets_with_orders, streets_without_orders, computed_at').eq('company_id', companyId).in('postal_code', plzList).order('computed_at', { ascending: false }),
    ])
    postalCodes = pcs || []
    // je PLZ die neueste Auswertung
    const latest = new Map<string, { id: string } & OverviewPlzDirectory>()
    for (const a of analytics || []) if (!latest.has(a.postal_code)) latest.set(a.postal_code, a)
    directories = [...latest.values()]
    const ids = directories.filter(d => d.streets_total !== null).map(d => (d as unknown as { id: string }).id)
    if (ids.length && !store) {
      const { data: streets } = await fetchAllRows<OverviewStreetRow>((from, to) =>
        db.from('street_analytics').select('postal_code, street_name, order_count, customer_count, revenue, is_in_official_list', { count: 'exact' })
          .eq('company_id', companyId).in('analytics_id', ids).eq('order_count', 0).eq('is_in_official_list', true).order('id').range(from, to))
      streetRows = streets || []
    }
  }

  const activeUploads = ((uploads || []) as (OverviewUpload & { status: string })[]).filter(u => u.status !== 'replaced')
  const f = filterByRange(rows, activeUploads, range?.from ?? null, range?.to ?? null)
  const overview = buildOverview({
    customers: f.customers,
    uploads: f.uploads,
    postalCodes,
    // „Straßen ohne Bestellung“ gilt für den gesamten Bestand – bei gewähltem Zeitraum nicht zeigen
    directories: f.applied ? [] : directories, streetRows: f.applied ? [] : streetRows,
  })
  // Nachbargebiete ohne Bestellungen (gemeinsame Referenzdaten, nur lesen)
  overview.nearby = null
  const ownPoints = postalCodes.map(p => ({ postal_code: p.postal_code, lat: num((p as { lat?: unknown }).lat), lng: num((p as { lng?: unknown }).lng) }))
  const bounds = queryBounds(ownPoints)
  if (bounds && !overview.empty) {
    const { data: cands, error: cErr } = await fetchAllRows<PlzCandidate>((from, to) =>
      db.from('postal_codes').select('postal_code, city, lat, lng, population, households, population_method', { count: 'exact' })
        .gte('lat', bounds.south).lte('lat', bounds.north).gte('lng', bounds.west).lte('lng', bounds.east)
        .order('postal_code').range(from, to))
    if (!cErr && cands) {
      const served = new Set(overview.plz.map(p => p.postal_code))
      overview.nearby = findNearbyPotential(ownPoints.filter(p => served.has(p.postal_code)),
        cands.map(c => ({ ...c, lat: num(c.lat), lng: num(c.lng) })))
    }
  }
  const allDates = activeUploads.filter(u => rows.some(r => r.upload_id === u.id))
  const starts = allDates.map(u => u.period_start).filter(Boolean).sort() as string[], ends = allDates.map(u => u.period_end).filter(Boolean).sort() as string[]
  const rangeInfo: OverviewRange = { applied: f.applied, reason: f.reason, from: f.from, to: f.to, available: { start: starts[0] || null, end: ends[ends.length - 1] || null } }
  return { ok: true, company: { name: company?.name || '' }, stores: stores || [], overview, range: rangeInfo }
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}
