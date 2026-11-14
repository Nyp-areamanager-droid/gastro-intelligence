import type { ParsedCustomerRow } from '@/types'
import { pseudonymizePhone } from '@/lib/privacy/pseudonym'

/** Gespeicherter Kundendatensatz → Analyse-Zeile */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function customerRecordToRow(c: any, companyId: string): ParsedCustomerRow {
  return {
    _row_index: 0, _errors: [],
    customer_ref: c.customer_ref || undefined,
    // Altbestand kann noch Klartext-Nummern enthalten (bis Migration 007):
    // für den Vergleich mit neuen Zeilen auf dasselbe Kennzeichen bringen
    phone_normalized: pseudonymizePhone(companyId, c.phone_normalized),
    street: c.street || undefined, street_normalized: c.street_normalized || undefined, house_number: c.house_number || undefined,
    postal_code: c.postal_code, city: c.city || undefined,
    total_orders: c.total_orders ?? 1, total_revenue: Number(c.total_revenue ?? 0),
    avg_order_value: c.avg_order_value ?? undefined, last_order_date: c.last_order_date || undefined,
    rfm_segment: c.rfm_segment || undefined, rfm_score: c.rfm_score || undefined,
    is_vip: !!c.is_vip, platform: c.platform || undefined, late_deliveries: c.late_deliveries || 0,
  } as ParsedCustomerRow
}
