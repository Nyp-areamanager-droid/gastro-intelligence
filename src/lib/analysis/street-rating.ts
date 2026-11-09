// =============================================================================
// Rot-Orange-Grün: Straßen im Vergleich zu ihrer eigenen PLZ
//
// Branchenunabhängig: Verglichen wird jede Straße nur mit den anderen
// Straßen DERSELBEN PLZ in DENSELBEN Daten. Zeitraum, Branche und Größe des
// Unternehmens kürzen sich dadurch heraus.
//
// Vergleichsgröße (Exposition):
//   - Hausadressen der Straße laut OpenStreetMap, wenn für mindestens 80 %
//     der Straßen Adressen bekannt sind (lange Straßen haben mehr Adressen
//     und sollen nicht automatisch „gut“ wirken). Hausadressen ≠ Haushalte.
//   - sonst: jede Straße zählt gleich.
//
// Rechnung je Straße:
//   PLZ-Durchschnitt R = Bestellungen aller bewerteten Straßen / Exposition
//   erwartet E        = R × Exposition der Straße
//   Index I           = tatsächliche Bestellungen / E
//   Grün I ≥ 1 · Orange 0,5 ≤ I < 1 · Rot I < 0,5
//
// Nie rot wegen fehlender Daten. Grau („nicht bewertbar“), wenn:
//   - das Straßenverzeichnis der PLZ unvollständig ist,
//   - die PLZ weniger als MIN_PLZ_ORDERS Bestellungen hat,
//   - für die Straße erwartet weniger als MIN_EXPECTED Bestellungen sind
//     (zu klein für eine sichere Aussage; Ausnahme: deutlich überdurchschnittlich),
//   - bei Adress-Vergleich die Adressen der Straße unbekannt sind.
//
// Die Klassen A–E bleiben unverändert erhalten: Sie beschreiben das absolute
// Volumen, die Ampel die Leistung im Vergleich.
// =============================================================================

import { streetNameKey } from '@/lib/geo/street-name'

export type Rating = 'green' | 'orange' | 'red' | 'none'
export type RatingBasis = 'addresses' | 'streets'

export const MIN_PLZ_ORDERS = 30
export const MIN_EXPECTED = 3
export const ADDRESS_COVERAGE = 0.8

export interface RatingInput {
  street_name: string
  order_count: number
  street_class?: string | null
}

export interface StreetRating {
  key: string
  rating: Rating
  index: number | null
  expected: number | null
  exposure: number | null
  reason: string
}

export interface RatingResult {
  basis: RatingBasis | null
  plz_average: number | null
  total_orders: number
  ratings: Map<string, StreetRating>
  summary: string
}

const fmt = (n: number, d = 1) => n.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d })

export function rateStreets(params: {
  streets: RatingInput[]
  directoryComplete: boolean
  addressCounts?: Record<string, number> | null
}): RatingResult {
  const { streets, directoryComplete, addressCounts } = params
  const rows = streets.map(s => ({ ...s, key: streetNameKey(s.street_name) })).filter(s => s.key)
  const totalOrders = rows.reduce((sum, s) => sum + s.order_count, 0)
  const ratings = new Map<string, StreetRating>()
  const none = (key: string, reason: string, exposure: number | null = null): StreetRating =>
    ({ key, rating: 'none', index: null, expected: null, exposure, reason })

  if (!directoryComplete) {
    const reason = 'Nicht bewertbar: Das Straßenverzeichnis dieser PLZ ist unvollständig, ein fairer Vergleich ist nicht möglich.'
    for (const s of rows) ratings.set(s.key, none(s.key, reason))
    return { basis: null, plz_average: null, total_orders: totalOrders, ratings, summary: reason }
  }
  if (totalOrders < MIN_PLZ_ORDERS) {
    const reason = `Nicht bewertbar: In dieser PLZ gibt es ${totalOrders} Bestellungen. Für einen Vergleich sind mindestens ${MIN_PLZ_ORDERS} nötig.`
    for (const s of rows) ratings.set(s.key, none(s.key, reason))
    return { basis: null, plz_average: null, total_orders: totalOrders, ratings, summary: reason }
  }

  const withAddr = addressCounts ? rows.filter(s => (addressCounts[s.key] || 0) > 0).length : 0
  const basis: RatingBasis = addressCounts && rows.length > 0 && withAddr / rows.length >= ADDRESS_COVERAGE ? 'addresses' : 'streets'
  const exposureOf = (key: string) => basis === 'addresses' ? (addressCounts![key] || 0) : 1

  const rated = rows.filter(s => exposureOf(s.key) > 0)
  const sumExposure = rated.reduce((sum, s) => sum + exposureOf(s.key), 0)
  const ratedOrders = rated.reduce((sum, s) => sum + s.order_count, 0)
  const R = sumExposure > 0 ? ratedOrders / sumExposure : 0
  const unit = basis === 'addresses' ? 'je Hausadresse' : 'je Straße'

  for (const s of rows) {
    const exposure = exposureOf(s.key)
    if (exposure <= 0) {
      ratings.set(s.key, none(s.key, 'Nicht bewertbar: Für diese Straße sind in OpenStreetMap keine Hausadressen erfasst.'))
      continue
    }
    const E = R * exposure
    const I = E > 0 ? s.order_count / E : 0
    const calc = `${s.order_count} Bestellungen, erwartet ${fmt(E)} beim PLZ-Durchschnitt (${fmt(R, 2)} ${unit}${basis === 'addresses' ? `, ${exposure} Adressen` : ''}) → ${fmt(I, 2)}-fach`
    let rating: Rating
    let reason: string
    if (E < MIN_EXPECTED) {
      if (s.order_count >= MIN_EXPECTED && I >= 1) { rating = 'green'; reason = `Überdurchschnittlich: ${calc}.` }
      else { rating = 'none'; reason = `Nicht bewertbar: zu klein für eine sichere Aussage (erwartet weniger als ${MIN_EXPECTED} Bestellungen). ${calc}.` }
    } else if (I >= 1) { rating = 'green'; reason = `Mindestens Durchschnitt: ${calc}.` }
    else if (I >= 0.5) { rating = 'orange'; reason = `Unter Durchschnitt: ${calc}.` }
    else { rating = 'red'; reason = `Deutlich unter Durchschnitt: ${calc}.` }
    ratings.set(s.key, {
      key: s.key, rating, exposure,
      index: rating === 'none' ? null : Math.round(I * 100) / 100,
      expected: Math.round(E * 10) / 10,
      reason,
    })
  }

  const summary = basis === 'addresses'
    ? `Vergleich mit dem Durchschnitt dieser PLZ: ${fmt(R, 2)} Bestellungen je Hausadresse (Adressen laut OpenStreetMap).`
    : `Vergleich mit dem Durchschnitt dieser PLZ: ${fmt(R, 1)} Bestellungen je Straße. Hausadressen waren nicht für genug Straßen bekannt.`
  return { basis, plz_average: R, total_orders: totalOrders, ratings, summary }
}

export const RATING_COLORS: Record<Rating, string> = { green: '#00d084', orange: '#f5a623', red: '#e63027', none: '#64748b' }
export const RATING_LABELS: Record<Rating, string> = { green: 'Grün', orange: 'Orange', red: 'Rot', none: 'Nicht bewertbar' }
