// Ohne Node-Module: wird auch im Browser (Dashboard) verwendet
import type { ParsedCustomerRow } from '@/types'
import { computeRFM } from '@/lib/analysis/engine'

/**
 * Fasst Datensätze derselben Person zusammen (z. B. aus zwei Zeiträumen oder
 * aus einem Export mit einer Zeile je Bestellung), damit sie als EIN Kunde
 * zählt. Bestellungen und Umsatz werden addiert und bleiben dadurch exakt.
 *
 * Wiedererkennung NUR über eindeutige Kennungen:
 *   1. Kundennummer aus der Datei
 *   2. Telefonnummer
 * Name, Adresse oder Straße reichen NICHT: Zwei Personen gleichen Namens im
 * selben Haus oder verschiedene Haushalte einer Straße dürfen nicht zu einem
 * Kunden verschmelzen. Ohne Kennung bleibt jeder Datensatz ein eigener Kunde
 * (siehe unidentified_records in den Kennzahlen).
 * Voraggregierte Zeilen (Straße → n Kunden) werden nie zusammengefasst.
 */
export function mergeCustomers(rows: ParsedCustomerRow[], refDate?: Date): ParsedCustomerRow[] {
  const byKey = new Map<string, ParsedCustomerRow[]>()
  const out: ParsedCustomerRow[] = []
  for (const r of rows) {
    const key = r._is_aggregated ? null
      : r.customer_ref ? `ref:${r.customer_ref.trim().toLowerCase()}`
      : r.phone_normalized ? `tel:${r.phone_normalized}`
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
