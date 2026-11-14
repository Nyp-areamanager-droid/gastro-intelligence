// =============================================================================
// Übersicht (Dashboard): alle Kennzahlen aus dem Datenbestand einer Firma.
//
// Reine Rechenfunktionen ohne Datenbank und ohne Netzwerk – damit jede Zahl
// nachrechenbar und testbar ist. Grundsätze:
//   - Jede Kennzahl nennt, woraus sie berechnet ist (Feld „basis“/„note“).
//   - Fehlt die Datengrundlage, ist der Wert null (Anzeige „—“), nie 0 und
//     nie ein Schätzwert.
//   - Zeiträume unterschiedlicher Länge werden je Tag verglichen.
// =============================================================================
import { mergeCustomers } from '@/lib/analysis/merge-customers'
import type { ParsedCustomerRow } from '@/types'

export interface OverviewCustomerRow {
  upload_id: string | null
  customer_ref?: string | null
  phone_normalized?: string | null
  postal_code: string
  street?: string | null
  street_normalized?: string | null
  total_orders: number
  total_revenue: number
  last_order_date?: string | null
  platform?: string | null
}
export interface OverviewUpload {
  id: string
  filename: string
  period_start: string | null
  period_end: string | null
  created_at: string
  /** Spaltenzuordnung des Imports: daraus ergibt sich, ob eine Zeile = eine Bestellung ist */
  column_mapping?: Record<string, string> | null
}
export interface OverviewPostalCode {
  postal_code: string
  city?: string | null
  population: number | null
  households: number | null
  /** nur mit gesetzter Methode gilt die Zahl als belegt */
  population_method: string | null
  population_reference_date?: string | null
}
export interface OverviewStreetRow {
  postal_code: string
  street_name: string
  order_count: number
  customer_count: number
  revenue: number
  is_in_official_list: boolean | null
}
export interface OverviewPlzDirectory { postal_code: string; streets_total: number | null; streets_with_orders: number | null; streets_without_orders: number | null }

export interface PeriodSummary {
  upload_id: string
  label: string
  start: string | null
  end: string | null
  days: number | null
  records: number
  orders: number
  revenue: number
  avg_order_value: number | null
  orders_per_day: number | null
  revenue_per_day: number | null
  /** true, wenn in dieser Datei jede Zeile eine einzelne Bestellung mit Datum ist */
  order_level: boolean
}
export interface SeriesPoint { key: string; label: string; orders: number; revenue: number }
export interface WeekdayStat { weekday: number; label: string; orders: number; occurrences: number; orders_per_day: number }
export interface PlzSummary {
  postal_code: string
  city: string | null
  customers: number
  orders: number
  revenue: number
  avg_order_value: number | null
  revenue_share_pct: number
  population: number | null
  households: number | null
  population_reference_date: string | null
  /** Bestellungen je 1.000 Einwohner im gesamten Datenzeitraum */
  orders_per_1000: number | null
  /** dasselbe, umgerechnet auf 30 Tage (nur wenn der Datenzeitraum bekannt ist) */
  orders_per_1000_30d: number | null
  /** Kunden je 100 Einwohner */
  customers_per_100: number | null
  streets_total: number | null
  streets_with_orders: number | null
  streets_without_orders: number | null
}
export interface StreetSummary { postal_code: string; street_name: string; orders: number; customers: number; revenue: number }
export interface PeriodChange {
  current: PeriodSummary
  previous: PeriodSummary
  comparable: boolean
  reason: string | null
  revenue_per_day_pct: number | null
  orders_per_day_pct: number | null
  avg_order_value_pct: number | null
}
export interface StreetChange { postal_code: string; street_name: string; previous_orders: number; current_orders: number; previous_per_30d: number; current_per_30d: number; change_pct: number }

export interface Overview {
  generated_at: string
  /** Nachbar-PLZ ohne Bestellungen mit belegter Einwohnerzahl (lib/insights/nearby.ts); null = nicht berechnet */
  nearby?: import('./nearby').NearbyResult | null
  empty: boolean
  totals: {
    customers: number
    /** importierte Datensätze (Zeilen) */
    records: number
    orders: number
    revenue: number
    avg_order_value: number | null
    plz_count: number
    street_count: number
    /** Datensätze ohne Kundennummer und ohne Telefon-Kennzeichen */
    unidentified_records: number
    identified_share_pct: number | null
    /** Anteil der Kunden mit mindestens zwei Bestellungen; null, wenn Kunden nicht wiedererkennbar sind */
    repeat_customers_pct: number | null
    one_time_customers_pct: number | null
    orders_per_customer: number | null
  }
  coverage: { start: string | null; end: string | null; days: number | null; note: string }
  periods: PeriodSummary[]
  change: PeriodChange | null
  series: { available: boolean; reason: string | null; daily: SeriesPoint[]; weekly: SeriesPoint[]; monthly: SeriesPoint[]; weekdays: WeekdayStat[] }
  plz: PlzSummary[]
  streets: { top: StreetSummary[]; lowest_with_orders: StreetSummary[]; without_orders: { postal_code: string; street_name: string }[]; changes: StreetChange[] }
  platforms: { name: string; orders: number; share_pct: number }[]
  segments: { key: string; label: string; customers: number; orders: number; revenue: number; explanation: string }[] | null
  segments_note: string | null
}

const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d
const isIso = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s)
const toUtc = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
export const daysInclusive = (start: string, end: string) => Math.round((toUtc(end) - toUtc(start)) / 86400000) + 1
const pct = (cur: number, prev: number) => prev > 0 ? round((cur - prev) / prev * 100, 1) : null
const fmtDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`

/** ISO-Kalenderwoche als „2026-W45“ */
export function isoWeek(iso: string): string {
  const d = new Date(toUtc(iso)); const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const week = 1 + Math.round(((d.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

/** Eine Zeile = eine Bestellung? Dann gab es beim Import keine Spalte „Bestellungen“, aber ein Datum. */
export function isOrderLevel(mapping: Record<string, string> | null | undefined): boolean {
  if (!mapping) return false
  return !mapping.total_orders && !mapping.customer_count && !!mapping.last_order_date
}

export interface RangeFilterResult {
  applied: boolean
  /** Warum der Filter nicht angewendet werden kann (dann gelten alle Daten) */
  reason: string | null
  from: string | null
  to: string | null
  customers: OverviewCustomerRow[]
  uploads: OverviewUpload[]
}

/**
 * Zeitraumfilter. Nur möglich, wenn JEDE Zeile eine einzelne Bestellung mit
 * Datum ist. Bei Summen je Kunde oder Straße („5 Bestellungen, letzte am …“)
 * ist nicht bekannt, wann die einzelnen Bestellungen waren – dann wird nicht
 * gefiltert, statt eine falsche Zahl zu zeigen.
 * Die Zeiträume der Importe werden auf den gewählten Bereich zugeschnitten,
 * damit Werte je Tag stimmen.
 */
export function filterByRange(customers: OverviewCustomerRow[], uploads: OverviewUpload[], from: string | null, to: string | null): RangeFilterResult {
  const none = (reason: string | null): RangeFilterResult => ({ applied: false, reason, from: null, to: null, customers, uploads })
  if (!from && !to) return none(null)
  if ((from && !isIso(from)) || (to && !isIso(to)) || (from && to && from > to)) return none('Der gewählte Zeitraum ist ungültig.')
  const used = new Set(customers.map(c => c.upload_id))
  const relevant = uploads.filter(u => used.has(u.id))
  if (!relevant.length || relevant.some(u => !isOrderLevel(u.column_mapping)) || customers.some(c => !isIso(c.last_order_date) || c.total_orders !== 1)) {
    return none('Ein Zeitraum lässt sich nur wählen, wenn alle Importe eine Zeile je Bestellung mit Bestelldatum enthalten.')
  }
  const lo = from || '0000-00-00', hi = to || '9999-99-99'
  const rows = customers.filter(c => { const d = c.last_order_date!.slice(0, 10); return d >= lo && d <= hi })
  const clipped = relevant.map(u => {
    const s = isIso(u.period_start) ? u.period_start!.slice(0, 10) : null, e = isIso(u.period_end) ? u.period_end!.slice(0, 10) : null
    if (!s || !e) return u
    const ns = s < lo ? lo : s, ne = e > hi ? hi : e
    return ns <= ne ? { ...u, period_start: ns, period_end: ne } : null
  }).filter((u): u is OverviewUpload => u !== null)
  return { applied: true, reason: null, from, to, customers: rows, uploads: clipped }
}

export function buildOverview(input: {
  customers: OverviewCustomerRow[]
  uploads: OverviewUpload[]
  postalCodes: OverviewPostalCode[]
  directories: OverviewPlzDirectory[]
  streetRows: OverviewStreetRow[]
  now?: Date
}): Overview {
  const now = input.now ?? new Date()
  const rows = input.customers
  const uploadsById = new Map(input.uploads.map(u => [u.id, u]))

  // ── Zeiträume (je Datei) ────────────────────────────────────────────────────
  const byUpload = new Map<string, OverviewCustomerRow[]>()
  for (const r of rows) {
    const k = r.upload_id || '—'
    const l = byUpload.get(k); if (l) l.push(r); else byUpload.set(k, [r])
  }
  const periods: PeriodSummary[] = [...byUpload.entries()].map(([id, list]) => {
    const u = uploadsById.get(id)
    const start = isIso(u?.period_start) ? u!.period_start!.slice(0, 10) : null
    const end = isIso(u?.period_end) ? u!.period_end!.slice(0, 10) : null
    const days = start && end && end >= start ? daysInclusive(start, end) : null
    const orders = list.reduce((s, r) => s + r.total_orders, 0)
    const revenue = round(list.reduce((s, r) => s + Number(r.total_revenue || 0), 0))
    return {
      upload_id: id,
      label: start && end ? `${fmtDate(start)} – ${fmtDate(end)}` : (u?.filename || 'Ohne Zeitraum'),
      start, end, days, records: list.length, orders, revenue,
      avg_order_value: orders > 0 ? round(revenue / orders) : null,
      orders_per_day: days ? round(orders / days, 2) : null,
      revenue_per_day: days ? round(revenue / days, 2) : null,
      order_level: isOrderLevel(u?.column_mapping),
    }
  }).sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999') || a.label.localeCompare(b.label))

  // ── Gesamtzeitraum ──────────────────────────────────────────────────────────
  const dated = periods.filter(p => p.start && p.end)
  let coverage: Overview['coverage']
  if (dated.length === periods.length && periods.length > 0) {
    const overlaps = dated.some((p, i) => i > 0 && p.start! <= dated[i - 1].end!)
    const start = dated[0].start!, end = dated.map(p => p.end!).sort().slice(-1)[0]
    coverage = overlaps
      ? { start, end, days: daysInclusive(start, end), note: 'Die Zeiträume der Dateien überschneiden sich. Die Tage sind vom ersten bis zum letzten Datum gezählt.' }
      : { start, end, days: dated.reduce((s, p) => s + p.days!, 0), note: 'Summe der Tage aller importierten Zeiträume.' }
  } else {
    coverage = { start: null, end: null, days: null, note: 'Mindestens eine Datei hat keinen Zeitraum. Werte je Tag oder je 30 Tage lassen sich deshalb nicht berechnen.' }
  }

  // ── Kunden (dieselbe Person nur einmal) ─────────────────────────────────────
  const merged = mergeCustomers(rows.map(r => ({
    _row_index: 0, _errors: [],
    customer_ref: r.customer_ref || undefined, phone_normalized: r.phone_normalized || undefined,
    postal_code: r.postal_code, street: r.street || undefined, street_normalized: r.street_normalized || undefined,
    total_orders: r.total_orders, total_revenue: Number(r.total_revenue || 0), last_order_date: r.last_order_date || undefined,
    platform: r.platform || undefined,
  })) as ParsedCustomerRow[], now)
  const totalOrders = rows.reduce((s, r) => s + r.total_orders, 0)
  const totalRevenue = round(rows.reduce((s, r) => s + Number(r.total_revenue || 0), 0))
  const unidentified = rows.filter(r => !r.customer_ref && !r.phone_normalized).length
  const identifiedShare = rows.length ? round((rows.length - unidentified) / rows.length * 100, 1) : null
  // Stammkunden-Anteil nur, wenn die meisten Datensätze eine Kennung haben –
  // sonst würde dieselbe Person mehrfach als „Einmalkunde“ zählen
  const retentionKnown = identifiedShare !== null && identifiedShare >= 80
  const repeat = merged.filter(m => m.total_orders >= 2).length

  // ── PLZ ─────────────────────────────────────────────────────────────────────
  const pcByPlz = new Map(input.postalCodes.map(p => [p.postal_code, p]))
  const dirByPlz = new Map(input.directories.map(d => [d.postal_code, d]))
  const plzAgg = new Map<string, { orders: number; revenue: number; customers: number }>()
  for (const r of rows) {
    const a = plzAgg.get(r.postal_code) || { orders: 0, revenue: 0, customers: 0 }
    a.orders += r.total_orders; a.revenue += Number(r.total_revenue || 0); plzAgg.set(r.postal_code, a)
  }
  for (const m of merged) { const a = plzAgg.get(m.postal_code!); if (a) a.customers += 1 }
  const plz: PlzSummary[] = [...plzAgg.entries()].map(([code, a]) => {
    const pc = pcByPlz.get(code); const verified = pc && pc.population_method && pc.population && pc.population > 0 ? pc : null
    const dir = dirByPlz.get(code)
    return {
      postal_code: code, city: pc?.city || null,
      customers: a.customers, orders: a.orders, revenue: round(a.revenue),
      avg_order_value: a.orders > 0 ? round(a.revenue / a.orders) : null,
      revenue_share_pct: totalRevenue > 0 ? round(a.revenue / totalRevenue * 100, 1) : 0,
      population: verified ? verified.population : null,
      households: verified && verified.households ? verified.households : null,
      population_reference_date: verified?.population_reference_date || null,
      orders_per_1000: verified ? round(a.orders / verified.population! * 1000, 1) : null,
      orders_per_1000_30d: verified && coverage.days ? round(a.orders / verified.population! * 1000 / coverage.days * 30, 1) : null,
      customers_per_100: verified ? round(a.customers / verified.population! * 100, 2) : null,
      streets_total: dir?.streets_total ?? null, streets_with_orders: dir?.streets_with_orders ?? null, streets_without_orders: dir?.streets_without_orders ?? null,
    }
  }).sort((a, b) => b.revenue - a.revenue)

  // ── Straßen ─────────────────────────────────────────────────────────────────
  const streetAgg = new Map<string, StreetSummary & { key: string }>()
  const streetByUpload = new Map<string, Map<string, number>>()
  for (const r of rows) {
    if (!r.street) continue
    const key = `${r.postal_code}|${(r.street_normalized || r.street).toLowerCase()}`
    const s = streetAgg.get(key) || { key, postal_code: r.postal_code, street_name: r.street, orders: 0, customers: 0, revenue: 0 }
    s.orders += r.total_orders; s.revenue = round(s.revenue + Number(r.total_revenue || 0)); streetAgg.set(key, s)
    const u = r.upload_id || '—'
    const m = streetByUpload.get(u) || new Map<string, number>(); m.set(key, (m.get(key) || 0) + r.total_orders); streetByUpload.set(u, m)
  }
  for (const m of merged) {
    if (!m.street) continue
    const s = streetAgg.get(`${m.postal_code}|${(m.street_normalized || m.street).toLowerCase()}`); if (s) s.customers += 1
  }
  const streetList = [...streetAgg.values()]
  const strip = ({ key: _k, ...s }: StreetSummary & { key: string }): StreetSummary => s
  const top = [...streetList].sort((a, b) => b.revenue - a.revenue).slice(0, 10).map(strip)
  const lowest = [...streetList].sort((a, b) => a.orders - b.orders || a.revenue - b.revenue).slice(0, 10).map(strip)
  const withoutOrders = input.streetRows.filter(s => s.order_count === 0 && s.is_in_official_list === true)
    .map(s => ({ postal_code: s.postal_code, street_name: s.street_name }))
    .sort((a, b) => a.postal_code.localeCompare(b.postal_code) || a.street_name.localeCompare(b.street_name, 'de'))

  // ── Vergleich der letzten beiden Zeiträume ──────────────────────────────────
  let change: PeriodChange | null = null
  let streetChanges: StreetChange[] = []
  if (dated.length >= 2 && dated.length === periods.length) {
    const current = dated[dated.length - 1], previous = dated[dated.length - 2]
    let reason: string | null = null
    if (current.start! <= previous.end!) reason = 'Die beiden Zeiträume überschneiden sich.'
    else if (current.days! < 14 || previous.days! < 14) reason = 'Mindestens einer der beiden Zeiträume ist kürzer als 14 Tage.'
    const comparable = reason === null
    change = {
      current, previous, comparable, reason,
      revenue_per_day_pct: comparable ? pct(current.revenue_per_day!, previous.revenue_per_day!) : null,
      orders_per_day_pct: comparable ? pct(current.orders_per_day!, previous.orders_per_day!) : null,
      avg_order_value_pct: comparable && current.avg_order_value !== null && previous.avg_order_value !== null ? pct(current.avg_order_value, previous.avg_order_value) : null,
    }
    if (comparable) {
      const cur = streetByUpload.get(current.upload_id) || new Map(), prev = streetByUpload.get(previous.upload_id) || new Map()
      for (const [key, prevOrders] of prev) {
        const curOrders = cur.get(key) || 0
        const p30 = prevOrders / previous.days! * 30, c30 = curOrders / current.days! * 30
        const s = streetAgg.get(key)!
        streetChanges.push({ postal_code: s.postal_code, street_name: s.street_name, previous_orders: prevOrders, current_orders: curOrders, previous_per_30d: round(p30, 1), current_per_30d: round(c30, 1), change_pct: round((c30 - p30) / p30 * 100, 1) })
      }
      streetChanges = streetChanges.sort((a, b) => (a.current_per_30d - a.previous_per_30d) - (b.current_per_30d - b.previous_per_30d))
    }
  }

  // ── Verlauf nach Tagen/Wochen/Monaten (nur bei einer Zeile je Bestellung) ────
  const orderLevelUploads = new Set(periods.filter(p => p.order_level).map(p => p.upload_id))
  const allOrderLevel = periods.length > 0 && periods.every(p => p.order_level)
  const series: Overview['series'] = { available: false, reason: null, daily: [], weekly: [], monthly: [], weekdays: [] }
  if (!allOrderLevel) {
    series.reason = orderLevelUploads.size > 0
      ? 'Nur ein Teil Ihrer Dateien enthält eine Zeile je Bestellung mit Datum. Ein Verlauf nach Tagen wäre unvollständig.'
      : 'Ihre Dateien enthalten je Kunde eine Summe und nur das letzte Bestelldatum. Ein Verlauf nach Tagen, Wochen oder Wochentagen lässt sich daraus nicht berechnen. Dafür braucht es einen Export mit einer Zeile je Bestellung und Bestelldatum.'
  } else {
    const withDate = rows.filter(r => isIso(r.last_order_date))
    if (withDate.length < rows.length * 0.95) {
      series.reason = 'Bei mehr als 5 % der Bestellungen fehlt das Datum. Ein Verlauf wäre unvollständig.'
    } else {
      const add = (map: Map<string, SeriesPoint>, key: string, label: string, r: OverviewCustomerRow) => {
        const p = map.get(key) || { key, label, orders: 0, revenue: 0 }
        p.orders += r.total_orders; p.revenue = round(p.revenue + Number(r.total_revenue || 0)); map.set(key, p)
      }
      const daily = new Map<string, SeriesPoint>(), weekly = new Map<string, SeriesPoint>(), monthly = new Map<string, SeriesPoint>()
      const wd = new Map<number, number>()
      for (const r of withDate) {
        const d = r.last_order_date!.slice(0, 10)
        add(daily, d, fmtDate(d), r)
        const w = isoWeek(d); add(weekly, w, `KW ${w.slice(6)}/${w.slice(0, 4)}`, r)
        add(monthly, d.slice(0, 7), `${d.slice(5, 7)}/${d.slice(0, 4)}`, r)
        const day = new Date(toUtc(d)).getUTCDay(); wd.set(day, (wd.get(day) || 0) + r.total_orders)
      }
      const sorted = (m: Map<string, SeriesPoint>) => [...m.values()].sort((a, b) => a.key.localeCompare(b.key))
      series.available = true
      series.daily = sorted(daily); series.weekly = sorted(weekly); series.monthly = sorted(monthly)
      // Wie oft kam jeder Wochentag im Zeitraum vor? (vom ersten bis zum letzten Bestelltag)
      const first = series.daily[0].key, last = series.daily[series.daily.length - 1].key
      const occ = new Map<number, number>()
      for (let t = toUtc(first); t <= toUtc(last); t += 86400000) { const day = new Date(t).getUTCDay(); occ.set(day, (occ.get(day) || 0) + 1) }
      series.weekdays = [1, 2, 3, 4, 5, 6, 0].map(day => ({
        weekday: day, label: WEEKDAYS[day], orders: wd.get(day) || 0, occurrences: occ.get(day) || 0,
        orders_per_day: occ.get(day) ? round((wd.get(day) || 0) / occ.get(day)!, 1) : 0,
      }))
    }
  }

  // ── Plattformen ─────────────────────────────────────────────────────────────
  const platformOrders = new Map<string, number>()
  let withPlatform = 0
  for (const r of rows) { const p = (r.platform || '').trim(); if (p) { withPlatform += r.total_orders; platformOrders.set(p, (platformOrders.get(p) || 0) + r.total_orders) } }
  const platforms = totalOrders > 0 && withPlatform / totalOrders >= 0.8
    ? [...platformOrders.entries()].map(([name, orders]) => ({ name, orders, share_pct: round(orders / totalOrders * 100, 1) })).sort((a, b) => b.orders - a.orders)
    : []

  // ── Kundengruppen nach Häufigkeit und letzter Bestellung ───────────────────
  // Nur, wenn Kunden wiedererkennbar sind UND ein letztes Bestelldatum vorliegt.
  let segments: Overview['segments'] = null
  let segmentsNote: string | null = null
  const withLast = merged.filter(m => isIso(m.last_order_date))
  if (!retentionKnown) segmentsNote = 'Zu viele Datensätze ohne Kundennummer oder Telefon-Kennzeichen: Kunden lassen sich nicht zuverlässig wiedererkennen.'
  else if (withLast.length < merged.length * 0.9 || !coverage.end) segmentsNote = 'Für eine Einteilung nach letzter Bestellung fehlt bei zu vielen Kunden das Bestelldatum oder der Zeitraum der Dateien.'
  else {
    // Stichtag = Ende des Datenzeitraums (nicht „heute“), sonst gelten nach
    // jedem Tag ohne neuen Import mehr Kunden als inaktiv
    const ref = coverage.end
    const def: [string, string, string, (o: number, d: number) => boolean][] = [
      ['stamm', 'Stammkunden', 'mindestens 4 Bestellungen, letzte vor höchstens 30 Tagen', (o, d) => o >= 4 && d <= 30],
      ['wiederkehrend', 'Wiederkehrende Kunden', '2 bis 3 Bestellungen, letzte vor höchstens 60 Tagen', (o, d) => o >= 2 && o <= 3 && d <= 60],
      ['neu', 'Neue Kunden', 'genau 1 Bestellung, vor höchstens 30 Tagen', (o, d) => o === 1 && d <= 30],
      ['einmal', 'Einmalkunden', 'genau 1 Bestellung, vor mehr als 30 Tagen', (o, d) => o === 1 && d > 30],
      ['ruhend', 'Ruhende Kunden', 'mindestens 2 Bestellungen, aber keine in den letzten 60 Tagen (bzw. 30 Tagen ab 4 Bestellungen)', () => true],
    ]
    const buckets = def.map(([key, label, explanation]) => ({ key, label, customers: 0, orders: 0, revenue: 0, explanation }))
    for (const m of withLast) {
      const d = daysInclusive(m.last_order_date!.slice(0, 10), ref) - 1
      const i = def.findIndex(x => x[3](m.total_orders, d))
      buckets[i].customers++; buckets[i].orders += m.total_orders; buckets[i].revenue = round(buckets[i].revenue + m.total_revenue)
    }
    segments = buckets
    segmentsNote = `Stichtag ist das Ende des Datenzeitraums (${fmtDate(ref)}). ${merged.length - withLast.length > 0 ? `${merged.length - withLast.length} Kunden ohne Bestelldatum sind nicht eingeteilt.` : ''}`.trim()
  }

  return {
    generated_at: now.toISOString(),
    empty: rows.length === 0,
    totals: {
      customers: merged.length, records: rows.length, orders: totalOrders, revenue: totalRevenue,
      avg_order_value: totalOrders > 0 ? round(totalRevenue / totalOrders) : null,
      plz_count: plzAgg.size, street_count: streetAgg.size,
      unidentified_records: unidentified, identified_share_pct: identifiedShare,
      repeat_customers_pct: retentionKnown && merged.length ? round(repeat / merged.length * 100, 1) : null,
      one_time_customers_pct: retentionKnown && merged.length ? round((merged.length - repeat) / merged.length * 100, 1) : null,
      orders_per_customer: retentionKnown && merged.length ? round(totalOrders / merged.length, 2) : null,
    },
    coverage, periods, change, series, plz,
    streets: { top, lowest_with_orders: lowest, without_orders: withoutOrders, changes: streetChanges },
    platforms, segments, segments_note: segmentsNote,
  }
}
