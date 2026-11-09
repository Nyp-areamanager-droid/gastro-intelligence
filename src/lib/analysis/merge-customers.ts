// Ohne Node-Module: wird auch im Browser (Dashboard) verwendet
import type { ParsedCustomerRow } from '@/types'
import { computeRFM } from '@/lib/analysis/engine'

/**
 * Fasst Datensätze derselben Person aus mehreren Zeiträumen zusammen,
 * damit sie als EIN Kunde zählt. Bestellungen und Umsatz werden addiert.
 * Erkennung: gleiche Telefonnummer, sonst gleicher Name + Adresse.
 * Ohne Telefon und Name wird nichts zusammengefasst (lieber nicht raten).
 * Voraggregierte Zeilen (Straße → n Kunden) werden nie zusammengefasst.
 */
export function mergeCustomers(rows: ParsedCustomerRow[], refDate?: Date): ParsedCustomerRow[] {
  const byKey = new Map<string, ParsedCustomerRow[]>()
  const out: ParsedCustomerRow[] = []
  for (const r of rows) {
    const key = r._is_aggregated ? null
      : r.phone_normalized ? `tel:${r.phone_normalized}`
      : (r.full_name && r.street_normalized) ? `adr:${r.full_name.toLowerCase()}|${r.street_normalized.toLowerCase()}|${(r.house_number || '').toLowerCase()}|${r.postal_code}`
      : null
    if (!key) { out.push(r); continue }
    const list = byKey.get(key)
    if (list) list.push(r); else byKey.set(key, [r])
  }
  const merged: ParsedCustomerRow[] = []
  for (const list of byKey.values()) {
    if (list.length === 1) { out.push(list[0]); continue }
    const latest = [...list].sort((a, b) => (b.last_order_date || '').localeCompare(a.last_order_date || ''))[0]
    const orders = list.reduce((s, r) => s + r.total_orders, 0)
    const revenue = Math.round(list.reduce((s, r) => s + r.total_revenue, 0) * 100) / 100
    merged.push({
      ...latest,
      total_orders: orders,
      total_revenue: revenue,
      avg_order_value: orders > 0 ? revenue / orders : undefined,
      late_deliveries: list.reduce((s, r) => s + (r.late_deliveries || 0), 0),
      is_vip: list.some(r => r.is_vip),
    })
  }
  return out.concat(computeRFM(merged, refDate))
}
