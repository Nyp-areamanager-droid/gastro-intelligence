// =============================================================================
// Analysis Engine — Gastro Intelligence Platform
// Berechnet alle KPIs, RFM, PLZ-Analyse, Straßenanalyse, Empfehlungen
// =============================================================================

import type {
  ParsedCustomerRow, PLZAnalysisResult, StreetAnalysisResult,
  RFMAnalysis, MarketingRecommendation, PotentialScenario,
  StreetClass, RFMSegment, ActionType, DashboardKPIs, Alert,
} from '@/types'
import { normalizeStreetName, stripHouseNumber, streetNameKey, resolveStreetKey } from '@/lib/geo/street-name'

// ── Normalisierung ────────────────────────────────────────────────────────────

export function normalizePhone(raw: string): string {
  let p = raw.replace(/[^\d+]/g, '')
  if (p.startsWith('00')) p = '+' + p.slice(2)
  if (p.startsWith('0')) p = '+49' + p.slice(1)
  if (!p.startsWith('+')) p = '+49' + p
  return p
}

// Straßennamen-Normalisierung liegt zentral in lib/geo/street-name.ts
export { normalizeStreetName }

export function extractHouseNumber(raw: string): { street: string; houseNumber: string } {
  const match = raw.trim().match(/^(.+?)\s+(\d+\s*[a-zA-Z]?(?:\s*[-/]\s*\d+\s*[a-zA-Z]?)?)$/)
  if (match) return { street: match[1].trim(), houseNumber: match[2].trim() }
  return { street: raw.trim(), houseNumber: '' }
}

export function normalizeCity(raw: string): string {
  const lower = raw.toLowerCase().trim()
  const mappings: Record<string, string> = {
    cologne: 'Köln', keln: 'Köln', koeln: 'Köln',
    muenchen: 'München', munich: 'München',
    frankfurt: 'Frankfurt am Main',
    duesseldorf: 'Düsseldorf',
    nuernberg: 'Nürnberg',
  }
  for (const [key, val] of Object.entries(mappings)) {
    if (lower.includes(key)) return val
  }
  return raw.trim().replace(/\b\w/g, c => c.toUpperCase())
}

export function validatePLZ(plz: string): boolean {
  return /^\d{5}$/.test(plz.trim())
}

// ── Zahlen im deutschen und englischen Format ────────────────────────────────
// "143,91" → 143.91 · "1.234,56" → 1234.56 · "1,234.56" → 1234.56 · "12 €" → 12
// Ein einzelnes Komma gilt als Dezimalkomma (deutsche Exporte), ein einzelner
// Punkt als Dezimalpunkt. Kommt beides vor, ist das letzte Zeichen das Dezimalzeichen.
export function parseLocaleNumber(raw: unknown): number {
  if (typeof raw === 'number') return raw
  let s = String(raw ?? '').replace(/[€\s\u00a0]/g, '').replace(/EUR/i, '')
  if (!s) return NaN
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.')
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '')
  } else if (lastComma >= 0) {
    s = (s.match(/,/g)!.length > 1) ? s.replace(/,/g, '') : s.replace(',', '.')
  } else if ((s.match(/\./g) ?? []).length > 1) {
    s = s.replace(/\./g, '')
  }
  return /^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN
}

// ── Spaltenerkennung ──────────────────────────────────────────────────────────

export function detectColumns(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {}
  const lower = (h: string) => h.toLowerCase().trim()

  const rules: [string, string[]][] = [
    ['phone',         ['telefon','phone','mobile','handy','rufnummer','mobilnummer','tel.']],
    ['first_name',    ['vorname','firstname','first name','given name']],
    ['last_name',     ['nachname','lastname','last name','surname','familienname']],
    ['street',        ['straße','strasse','street','adresse','adress','road']],
    ['house_number',  ['hausnummer','hnr','house number','nr.','number']],
    ['postal_code',   ['plz','postleitzahl','zip','postal','postcode']],
    ['city',          ['ort','stadt','city','place','location']],
    ['total_orders',  ['bestellungen','orders','anzahl','total orders','gesamtbestellungen','gesamtzahl']],
    ['total_revenue', ['umsatz','revenue','gesamtbestellwert','total','betrag','wert']],
    ['avg_order_value',['durchschnitt','average','bon','avg','ø','ø bestellwert','ø umsatz','mittlerer bestellwert']],
    ['last_order_date',['datum','date','letzte','letzter','last order','bestelldatum']],
    ['platform',      ['plattform','platform','kanal','source','quelle']],
    ['store',         ['filiale','store','standort','branch','niederlassung']],
    ['late_deliveries',['verspät','late','eta','lieferzeit']],
    ['is_vip',        ['vip','premium','loyal','stammkunde']],
    // Aggregierte CSV: Anzahl eindeutiger Kunden je Straße/PLZ
    ['customer_count',['kunden','kundenanzahl','unique kunden','unique customers','anzahl kunden','eindeutige kunden']],
    // Spalten, die bewusst KEINEM Feld zugeordnet werden (sonst würde z. B.
    // „Kundennummer“ als Kundenanzahl gelesen)
    ['_ignore',       ['kundennummer','kunden-nr','kundennr','customer id','bestellnummer','order id','bestell-nr']],
  ]

  // Jede Spalte bekommt das Feld mit dem GENAUESTEN (längsten) passenden
  // Stichwort. Früher gewann das erste Feld der Liste: „Standort“ enthält „ort“
  // und wurde zur Stadt, „Kundenanzahl“ enthält „anzahl“ und wurde zu den
  // Bestellungen, „Ø Bestellwert“ enthält „wert“ und wurde zum Umsatz.
  const candidates = headers.map((h, index) => {
    const l = lower(h)
    const matches: { field: string; len: number }[] = []
    for (const [field, keywords] of rules) {
      const best = Math.max(0, ...keywords.filter(k => l.includes(k)).map(k => k.length))
      if (best > 0) matches.push({ field, len: best })
    }
    matches.sort((a, b) => b.len - a.len)
    return { h, index, matches }
  }).filter(c => c.matches.length > 0)

  // Spalten mit dem eindeutigsten Treffer zuerst vergeben, bei Gleichstand die
  // weiter links stehende Spalte
  candidates.sort((a, b) => b.matches[0].len - a.matches[0].len || a.index - b.index)
  for (const c of candidates) {
    const free = c.matches.find(m => !map[m.field])
    if (free) map[free.field] = c.h
  }
  delete map['_ignore']
  return map
}

// ── Datenbereinigung & Parsing ────────────────────────────────────────────────

export function parseAndCleanRows(
  rawRows: Record<string, unknown>[],
  columnMapping: Record<string, string>
): { rows: ParsedCustomerRow[]; duplicates: number; errors: number; invalid_values: number } {
  const seen = new Set<string>()
  const result: ParsedCustomerRow[] = []
  let duplicates = 0
  let errors = 0
  // Zeilen mit unlesbaren Zahlen (z. B. Umsatz „abc“): werden übernommen, der
  // Wert zählt als 0 bzw. 1 Bestellung – aber das wird jetzt gemeldet
  let invalidValues = 0

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i]
    const get = (field: string) => {
      const v = row[columnMapping[field]]
      if (v instanceof Date) return isNaN(v.getTime()) ? '' : v.toISOString().slice(0, 10)
      return String(v ?? '').trim()
    }

    const parsed: ParsedCustomerRow = {
      _row_index: i + 2,
      _errors: [],
      total_orders: 1,
      total_revenue: 0,
    }

    // Telefon
    const phoneRaw = get('phone')
    if (phoneRaw) {
      parsed.phone_raw = phoneRaw
      parsed.phone_normalized = normalizePhone(phoneRaw)
    }

    // Name
    parsed.first_name = get('first_name') || undefined
    parsed.last_name = get('last_name') || undefined
    parsed.full_name = [parsed.first_name, parsed.last_name].filter(Boolean).join(' ') || undefined

    // Adresse
    const streetRaw = get('street')
    if (streetRaw) {
      const { street, houseNumber } = extractHouseNumber(streetRaw)
      parsed.street = street
      parsed.street_normalized = normalizeStreetName(street)
      parsed.house_number = houseNumber || get('house_number') || undefined
    }

    // PLZ
    // Excel speichert PLZ oft als Zahl: 01067 wird zu 1067. Nur bei echten
    // Zahlenzellen mit 4 Stellen wird die führende Null ergänzt.
    const plzCell = row[columnMapping['postal_code']]
    const plzRaw = (typeof plzCell === 'number' && Number.isInteger(plzCell) && plzCell >= 1000 && plzCell <= 9999)
      ? String(plzCell).padStart(5, '0')
      : get('postal_code').replace(/\D/g, '')
    if (plzRaw && validatePLZ(plzRaw)) {
      parsed.postal_code = plzRaw
    } else {
      parsed._errors.push(`Ungültige PLZ: "${get('postal_code')}"`)
      errors++
      continue
    }

    // Stadt
    const cityRaw = get('city')
    parsed.city = cityRaw ? normalizeCity(cityRaw) : undefined

    // Bestellstatistiken
    const ordersRaw = parseLocaleNumber(get('total_orders'))
    parsed.total_orders = isNaN(ordersRaw) || ordersRaw < 1 ? 1 : Math.round(ordersRaw)
    let invalid = columnMapping['total_orders'] !== undefined && get('total_orders') !== '' && isNaN(ordersRaw)

    const revenueRaw = parseLocaleNumber(get('total_revenue'))
    parsed.total_revenue = isNaN(revenueRaw) ? 0 : Math.round(revenueRaw * 100) / 100
    if (columnMapping['total_revenue'] !== undefined && get('total_revenue') !== '' && isNaN(revenueRaw)) invalid = true
    if (invalid) {
      parsed._errors.push('Unlesbarer Zahlenwert bei Bestellungen oder Umsatz')
      invalidValues++
    }

    const bonRaw = parseLocaleNumber(get('avg_order_value'))
    parsed.avg_order_value = isNaN(bonRaw)
      ? (parsed.total_orders > 0 ? parsed.total_revenue / parsed.total_orders : undefined)
      : bonRaw

    // Datum
    const dateRaw = get('last_order_date')
    if (dateRaw) parsed.last_order_date = parseDateString(dateRaw)

    // Platform
    parsed.platform = get('platform') || undefined

    // Sonstige
    const lateRaw = parseInt(get('late_deliveries'))
    parsed.late_deliveries = isNaN(lateRaw) ? 0 : lateRaw

    const vipRaw = get('is_vip').toLowerCase()
    parsed.is_vip = ['true','1','yes','ja','vip','x'].includes(vipRaw)

    // ── Aggregierter Modus erkennen ───────────────────────────────────────────
    // Wenn eine customer_count-Spalte vorhanden ist, handelt es sich um eine
    // voraggregierte CSV (Straße → n Kunden, m Bestellungen). In diesem Modus
    // gilt jede Zeile als genau ein Aggregat-Eintrag, KEIN Einzelkunde.
    const customerCountRaw = columnMapping['customer_count']
      ? parseLocaleNumber(get('customer_count'))
      : NaN
    if (!isNaN(customerCountRaw) && customerCountRaw >= 1) {
      parsed._is_aggregated = true
      parsed._aggregated_customer_count = Math.round(customerCountRaw)
    }

    // Duplikat-Check: nur für Einzelkunden (phone + normalized_street + plz).
    // Aggregierte Zeilen werden nie als Duplikate gewertet — sie kommen aus
    // einem bereits deduplizierten Export und werden in analyzeStreets summiert.
    if (!parsed._is_aggregated) {
      const dupKey = `${parsed.phone_normalized || ''}|${parsed.street_normalized || ''}|${parsed.postal_code}`
      if (seen.has(dupKey) && parsed.phone_normalized) {
        duplicates++
        continue
      }
      seen.add(dupKey)
    }

    result.push(parsed)
  }

  return { rows: result, duplicates, errors, invalid_values: invalidValues }
}

function parseDateString(raw: string): string | undefined {
  // Unterstützt: DD.MM.YYYY, YYYY-MM-DD, MM/DD/YYYY
  const cleaned = raw.trim()
  const patterns = [
    /^(\d{2})\.(\d{2})\.(\d{4})$/, // DE
    /^(\d{4})-(\d{2})-(\d{2})$/,   // ISO
    /^(\d{2})\/(\d{2})\/(\d{4})$/,  // US
  ]
  for (const pat of patterns) {
    const m = cleaned.match(pat)
    if (m) {
      try {
        const date = pat === patterns[0]
          ? new Date(`${m[3]}-${m[2]}-${m[1]}`)
          : pat === patterns[2]
          ? new Date(`${m[3]}-${m[1]}-${m[2]}`)
          : new Date(cleaned)
        if (!isNaN(date.getTime())) return date.toISOString().split('T')[0]
      } catch { continue }
    }
  }
  // Excel-Seriennummer
  const serial = parseFloat(cleaned)
  if (!isNaN(serial) && serial > 40000) {
    const date = new Date((serial - 25569) * 86400 * 1000)
    return date.toISOString().split('T')[0]
  }
  return undefined
}

// ── RFM Analyse ───────────────────────────────────────────────────────────────

export function computeRFM(rows: ParsedCustomerRow[], refDate?: Date): ParsedCustomerRow[] {
  const today = refDate ?? new Date()

  return rows.map(row => {
    const recencyDays = row.last_order_date
      ? Math.floor((today.getTime() - new Date(row.last_order_date).getTime()) / 86400000)
      : 365

    const rScore = recencyDays <= 30 ? 5 : recencyDays <= 60 ? 4 : recencyDays <= 90 ? 3 : recencyDays <= 180 ? 2 : 1
    const fScore = row.total_orders >= 10 ? 5 : row.total_orders >= 5 ? 4 : row.total_orders >= 3 ? 3 : row.total_orders >= 2 ? 2 : 1
    const mScore = row.total_revenue >= 500 ? 5 : row.total_revenue >= 200 ? 4 : row.total_revenue >= 100 ? 3 : row.total_revenue >= 50 ? 2 : 1

    const rfmScore = Math.round((rScore + fScore + mScore) / 3)

    let segment: RFMSegment
    if (rScore >= 4 && fScore >= 4 && mScore >= 4) segment = 'vip'
    else if (rScore >= 3 && fScore >= 3) segment = 'loyal'
    else if (rScore >= 3 && fScore <= 2) segment = 'potential'
    else if (rScore <= 2 && fScore >= 3) segment = 'at_risk'
    else if (rScore === 1) segment = 'lost'
    else segment = 'new'

    return { ...row, rfm_score: rfmScore, rfm_segment: segment }
  })
}

export function aggregateRFMSegments(rows: ParsedCustomerRow[]): RFMAnalysis[] {
  const segments: RFMSegment[] = ['vip','loyal','potential','at_risk','lost','new']
  const actions: Record<RFMSegment, string> = {
    vip: 'Exklusive Treueaktion + persönlicher Kontakt',
    loyal: 'Stammkunden-Programm + Upselling',
    potential: 'Reaktivierung mit Gutschein',
    at_risk: 'Sofortige Reaktivierungskampagne',
    lost: 'Win-Back Kampagne mit 20% Rabatt',
    new: 'Willkommens-Sequence + zweite Bestellung fördern',
  }

  return segments.map(seg => {
    const group = rows.filter(r => r.rfm_segment === seg)
    return {
      segment: seg,
      count: group.length,
      pct: rows.length > 0 ? Math.round(group.length / rows.length * 1000) / 10 : 0,
      avg_revenue: group.length > 0 ? Math.round(group.reduce((s,r) => s + r.total_revenue, 0) / group.length * 100) / 100 : 0,
      avg_orders: group.length > 0 ? Math.round(group.reduce((s,r) => s + r.total_orders, 0) / group.length * 10) / 10 : 0,
      recommended_action: actions[seg],
    }
  })
}

// ── PLZ-Analyse ───────────────────────────────────────────────────────────────

/**
 * Straßenverzeichnis einer PLZ für die Analyse.
 * complete = false heißt: Liste fehlt oder ist unvollständig. Dann gibt es
 * keine Aussage über Straßen ohne Bestellungen (keine Klasse E, keine
 * Abdeckungsquote).
 */
export interface StreetDirectory {
  streets: string[]
  complete: boolean
}

export const NO_STREET_DIRECTORY: StreetDirectory = { streets: [], complete: false }

export function analyzePLZ(
  rows: ParsedCustomerRow[],
  directory: StreetDirectory,
  population: number | null,
  households: number | null,
): PLZAnalysisResult {
  const postalCode = rows[0]?.postal_code || ''
  // Aggregierte CSV: _aggregated_customer_count summieren; sonst Anzahl Zeilen
  const isAggregated = rows.some(r => r._is_aggregated)
  const customerCount = isAggregated
    ? rows.reduce((s, r) => s + (r._aggregated_customer_count ?? 1), 0)
    : rows.length
  const orderCount = rows.reduce((s, r) => s + r.total_orders, 0)
  const revenue = rows.reduce((s, r) => s + r.total_revenue, 0)
  const avgOrderValue = orderCount > 0 ? revenue / orderCount : 0
  const ordersPerCustomer = customerCount > 0 ? orderCount / customerCount : 0

  // Marktdurchdringung
  const marketPenetrationPct = population ? (customerCount / population) * 100 : null
  const notReachedResidents = population ? population - customerCount : null
  const notReachedPct = population ? ((population - customerCount) / population) * 100 : null

  // Straßen – nur mit vollständigem Verzeichnis aussagekräftig
  const officialNorm = [...new Set(directory.streets.map(s => streetNameKey(s)).filter(Boolean))]
  const officialSet = new Set(officialNorm)
  const customerStreets = new Set(rows.map(r => resolveStreetKey(r.street || '', officialSet)).filter(Boolean))
  const hasDirectory = directory.complete && officialNorm.length > 0
  const streetsWithOrders = hasDirectory ? officialNorm.filter(n => customerStreets.has(n)).length : null
  const streetsWithoutOrders = hasDirectory ? officialNorm.length - streetsWithOrders! : null
  const streetsCovPct = hasDirectory ? (streetsWithOrders! / officialNorm.length) * 100 : null

  // Flyer-Potenzial: (nicht erreichte EW) × 3% Konversion × Ø Bon × 3 Monate
  const flyerPotential = notReachedResidents
    ? Math.round(notReachedResidents * 0.03 * avgOrderValue * 3)
    : null

  // Potenzial-Szenarien
  const scenarios: PotentialScenario[] = [5, 10, 15, 20].map(targetPct => {
    const targetCustomers = population ? Math.round(population * targetPct / 100) : 0
    const additionalCustomers = Math.max(0, targetCustomers - customerCount)
    const additionalOrders = Math.round(additionalCustomers * ordersPerCustomer)
    return {
      target_penetration_pct: targetPct,
      additional_customers: additionalCustomers,
      additional_orders: additionalOrders,
      additional_revenue: Math.round(additionalOrders * avgOrderValue),
    }
  })

  // Kunden-Segmente
  const oneTimeBuyers = rows.filter(r => r.total_orders === 1).length
  const repeatCustomers = rows.filter(r => r.total_orders >= 3).length
  const vipCustomers = rows.filter(r => r.is_vip || r.rfm_segment === 'vip').length

  // Warnungen
  const warnings: string[] = []
  if (!population) warnings.push(`⚠️ Einwohnerzahl für PLZ ${postalCode} nicht verfügbar. Marktdurchdringung kann nicht berechnet werden.`)
  if (oneTimeBuyers / customerCount > 0.7) warnings.push('⚠️ Über 70% Einmalkäufer — Kundenbindung kritisch')
  if (!hasDirectory) {
    warnings.push(`⚠️ Straßenverzeichnis für PLZ ${postalCode} fehlt oder ist unvollständig. Straßen ohne Bestellungen werden nicht ausgewiesen.`)
  } else if (streetsWithoutOrders! > streetsWithOrders!) {
    warnings.push(`⚠️ Nur ${Math.round(streetsCovPct!)}% der Straßen erreicht`)
  }

  return {
    postal_code: postalCode,
    city: rows[0]?.city || '',
    customer_count: customerCount,
    order_count: orderCount,
    revenue: Math.round(revenue * 100) / 100,
    avg_order_value: Math.round(avgOrderValue * 100) / 100,
    orders_per_customer: Math.round(ordersPerCustomer * 100) / 100,
    population,
    households,
    population_source: population ? 'census' : null,
    market_penetration_pct: marketPenetrationPct ? Math.round(marketPenetrationPct * 100) / 100 : null,
    not_reached_residents: notReachedResidents,
    not_reached_pct: notReachedPct ? Math.round(notReachedPct * 10) / 10 : null,
    streets_total: hasDirectory ? officialNorm.length : null,
    streets_with_orders: streetsWithOrders,
    streets_without_orders: streetsWithoutOrders,
    streets_coverage_pct: streetsCovPct === null ? null : Math.round(streetsCovPct * 10) / 10,
    flyer_potential_eur: flyerPotential,
    potential_scenarios: scenarios,
    one_time_buyers: oneTimeBuyers,
    repeat_customers: repeatCustomers,
    vip_customers: vipCustomers,
    warnings,
    poi_summary: { competitors:0, hotels:0, schools:0, hospitals:0, offices:0, restaurants:0, total_b2b_targets:0 },
  }
}

// ── Straßen-Analyse ───────────────────────────────────────────────────────────

export function analyzeStreets(
  rows: ParsedCustomerRow[],
  directory: StreetDirectory,
): StreetAnalysisResult[] {
  // Verzeichnis: Schlüssel → amtlicher/Quell-Name
  const directoryByKey = new Map<string, string>()
  for (const name of directory.streets) {
    const key = streetNameKey(name)
    if (key && !directoryByKey.has(key)) directoryByKey.set(key, name)
  }

  // Gruppen: PLZ + Straßenschlüssel → Kunden-Rows.
  // Verschiedene Schreibweisen derselben Straße landen in einer Gruppe,
  // gleichnamige Straßen in verschiedenen PLZ bleiben getrennt.
  const groups = new Map<string, { postalCode: string; key: string; rows: ParsedCustomerRow[]; spellings: Map<string, number> }>()
  const directoryKeys = new Set(directoryByKey.keys())
  for (const row of rows) {
    if (!row.street) continue
    const key = resolveStreetKey(row.street, directoryKeys)
    if (!key) continue
    const postalCode = row.postal_code || ''
    const groupKey = `${postalCode}|${key}`
    let g = groups.get(groupKey)
    if (!g) {
      g = { postalCode, key, rows: [], spellings: new Map() }
      groups.set(groupKey, g)
    }
    g.rows.push(row)
    const spelling = stripHouseNumber(row.street)
    g.spellings.set(spelling, (g.spellings.get(spelling) || 0) + 1)
  }

  const results: StreetAnalysisResult[] = []
  const keysWithCustomers = new Set<string>()

  // Straßen aus Kundendaten
  for (const g of groups.values()) {
    keysWithCustomers.add(g.key)
    const orderCount = g.rows.reduce((s, r) => s + r.total_orders, 0)
    const revenue = g.rows.reduce((s, r) => s + r.total_revenue, 0)

    // ── Kundenzahl: aggregiert vs. Einzelkunden ──────────────────────────────
    // Aggregierte CSV: Jede Zeile liefert _aggregated_customer_count (die Anzahl
    // eindeutiger Kunden laut Export). Mehrere Zeilen zur selben Straße werden
    // addiert — das ist nur erlaubt, weil der Export bereits dedupliziert ist.
    // Einzelkunden-CSV: Anzahl der Datensätze = Kundenzahl.
    const isAggregated = g.rows.some(r => r._is_aggregated)
    const customerCount = isAggregated
      ? g.rows.reduce((s, r) => s + (r._aggregated_customer_count ?? 1), 0)
      : g.rows.length

    const avgVal = orderCount > 0 ? revenue / orderCount : 0
    const bpk = customerCount > 0 ? orderCount / customerCount : 0

    // Anzeigename: Name aus dem Verzeichnis, sonst häufigste Schreibweise
    const officialName = directoryByKey.get(g.key)
    const mostCommon = [...g.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'de'))[0][0]

    results.push({
      street_name: officialName || mostCommon,
      postal_code: g.postalCode,
      customer_count: customerCount,
      order_count: orderCount,
      revenue: Math.round(revenue * 100) / 100,
      avg_order_value: Math.round(avgVal * 100) / 100,
      orders_per_customer: Math.round(bpk * 100) / 100,
      street_class: classifyStreet(customerCount, orderCount),
      // Ohne vollständiges Verzeichnis ist "nicht enthalten" keine Aussage
      is_in_official_list: directory.complete ? directoryByKey.has(g.key) : null,
      recommendation: getStreetRecommendation(customerCount, orderCount),
    })
  }

  // Straßen ohne Kunden: NUR bei vollständigem Verzeichnis.
  // Fehlt das Verzeichnis oder ist es unvollständig, wird keine Straße als
  // "0 Bestellungen" ausgewiesen.
  if (directory.complete) {
    const plz = rows[0]?.postal_code || ''
    for (const [key, name] of directoryByKey) {
      if (keysWithCustomers.has(key)) continue
      results.push({
        street_name: name,
        postal_code: plz,
        customer_count: 0,
        order_count: 0,
        revenue: 0,
        avg_order_value: 0,
        orders_per_customer: 0,
        street_class: 'E',
        is_in_official_list: true,
        recommendation: 'Flyer-Aktion — kein einziger Kontakt',
      })
    }
  }

  return results.sort((a, b) => b.order_count - a.order_count || a.street_name.localeCompare(b.street_name, 'de'))
}

function classifyStreet(customers: number, orders: number): StreetClass {
  if (orders >= 20 || customers >= 10) return 'A'
  if (orders >= 10 || customers >= 5)  return 'B'
  if (orders >= 5  || customers >= 3)  return 'C'
  if (orders >= 2  || customers >= 2)  return 'D'
  return 'E'
}

function getStreetRecommendation(customers: number, orders: number): string {
  if (orders === 0)   return '❌ Flyer-Aktion — kein Kontakt'
  if (orders === 1)   return '🟡 Gutschein — nur 1 Bestellung'
  if (orders < 5)     return '🔵 Reaktivierung — schwache Bestellrate'
  if (orders < 15)    return '🟢 Stammkunden-Pflege'
  return '⭐ Loyal-Programm — Top-Straße'
}

// ── Dashboard KPIs ────────────────────────────────────────────────────────────

export function computeDashboardKPIs(rows: ParsedCustomerRow[]): DashboardKPIs {
  const total = rows.length
  const totalOrders = rows.reduce((s, r) => s + r.total_orders, 0)
  const totalRevenue = rows.reduce((s, r) => s + r.total_revenue, 0)
  const repeatCustomers = rows.filter(r => r.total_orders >= 2).length
  const vipCustomers = rows.filter(r => r.is_vip || r.rfm_segment === 'vip').length
  const lateTotal = rows.reduce((s, r) => s + (r.late_deliveries || 0), 0)
  const plzCounts = new Map<string, number>()
  const streetCounts = new Map<string, number>()

  for (const r of rows) {
    plzCounts.set(r.postal_code, (plzCounts.get(r.postal_code) || 0) + r.total_orders)
    if (r.street) streetCounts.set(r.street, (streetCounts.get(r.street) || 0) + r.total_orders)
  }

  const topPLZ = [...plzCounts.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || ''
  const topStreet = [...streetCounts.entries()].sort((a,b) => b[1]-a[1])[0]?.[0] || ''

  return {
    total_customers: total,
    total_orders: totalOrders,
    total_revenue: Math.round(totalRevenue * 100) / 100,
    avg_order_value: totalOrders > 0 ? Math.round(totalRevenue / totalOrders * 100) / 100 : 0,
    repeat_rate_pct: total > 0 ? Math.round(repeatCustomers / total * 1000) / 10 : 0,
    vip_rate_pct: total > 0 ? Math.round(vipCustomers / total * 1000) / 10 : 0,
    late_delivery_pct: totalOrders > 0 ? Math.round(lateTotal / totalOrders * 1000) / 10 : 0,
    active_plz_count: plzCounts.size,
    top_plz: topPLZ,
    top_street: topStreet,
    critical_alerts: 0, // Wird separat berechnet
  }
}

// ── Frühwarnungen ─────────────────────────────────────────────────────────────

export function generateAlerts(
  current: DashboardKPIs,
  prev?: Partial<DashboardKPIs>
): Omit<Alert, 'id' | 'company_id' | 'created_at'>[] {
  const alerts: Omit<Alert, 'id' | 'company_id' | 'created_at'>[] = []

  const add = (
    severity: Alert['severity'],
    category: string,
    title: string,
    message: string,
    metric?: number,
    threshold?: number,
    change?: number
  ) => alerts.push({ severity, category, title, message,
    metric_value: metric, threshold_value: threshold, change_pct: change,
    is_resolved: false })

  // Einmalkäufer-Rate
  // Anteil der Kunden mit genau einer Bestellung (= 100 % minus Stammkunden).
  // Früher: (Kunden − Bestellungen) / Kunden – fast immer negativ, die Warnung
  // erschien dadurch nie.
  const oneTimePct = current.total_customers > 0 ? 100 - current.repeat_rate_pct : 0

  if (oneTimePct > 70) add('critical', 'customers',
    'Kritisch: Einmalkäufer-Rate',
    `${oneTimePct.toFixed(1)}% aller Kunden haben nur einmal bestellt. Kundenbindung funktioniert nicht.`,
    oneTimePct, 60)
  else if (oneTimePct > 60) add('warning', 'customers',
    'Warnung: Einmalkäufer-Rate',
    `${oneTimePct.toFixed(1)}% Einmalkäufer — Ziel ist unter 60%.`,
    oneTimePct, 60)

  // Verspätungsrate
  if (current.late_delivery_pct > 15) add('critical', 'delivery',
    'Kritisch: Verspätungsrate',
    `${current.late_delivery_pct}% der Bestellungen wurden zu spät geliefert. Direkte Kundenverlustgefahr.`,
    current.late_delivery_pct, 5)
  else if (current.late_delivery_pct > 5) add('warning', 'delivery',
    'Warnung: Verspätungsrate',
    `${current.late_delivery_pct}% Verspätungen — Ziel ist unter 5%.`,
    current.late_delivery_pct, 5)

  // VIP-Rate
  if (current.vip_rate_pct < 1) add('critical', 'vip',
    'Kritisch: VIP-Programm inaktiv',
    `Nur ${current.vip_rate_pct}% VIP-Nutzer. Das Treueprogramm ist faktisch unbekannt.`,
    current.vip_rate_pct, 5)
  else if (current.vip_rate_pct < 5) add('warning', 'vip',
    'Warnung: VIP-Quote unter Ziel',
    `${current.vip_rate_pct}% VIP-Nutzer — Ziel: 5%.`,
    current.vip_rate_pct, 5)

  // Umsatz-Rückgang vs. Vorperiode
  if (prev?.total_revenue && current.total_revenue < prev.total_revenue) {
    const change = (current.total_revenue - prev.total_revenue) / prev.total_revenue * 100
    if (change < -20) add('critical', 'revenue',
      'Kritisch: Umsatzrückgang',
      `Umsatz um ${Math.abs(change).toFixed(1)}% gefallen. Sofortmaßnahmen erforderlich.`,
      current.total_revenue, prev.total_revenue, change)
    else if (change < -10) add('warning', 'revenue',
      'Warnung: Umsatzrückgang',
      `Umsatz um ${Math.abs(change).toFixed(1)}% gesunken.`,
      current.total_revenue, prev.total_revenue, change)
  }

  // Durchschnittsbon
  if (current.avg_order_value > 0 && current.avg_order_value < 15) add('warning', 'revenue',
    'Warnung: Niedriger Durchschnittsbon',
    `Ø Bon ${current.avg_order_value.toFixed(2)} € — Upselling-Potenzial nicht ausgeschöpft.`,
    current.avg_order_value, 20)

  return alerts
}

// ── Empfehlungsengine ─────────────────────────────────────────────────────────

export function generateRecommendations(
  kpis: DashboardKPIs,
  plzAnalyses: PLZAnalysisResult[],
  streetResults: StreetAnalysisResult[],
): MarketingRecommendation[] {
  const recs: MarketingRecommendation[] = []
  const bon = kpis.avg_order_value || 19.5

  // ROI = Potenzial / Kosten. Ohne Kosten gibt es keinen sinnvollen Faktor (null),
  // früher stand dort pauschal 99 und die Oberfläche zeigte „∞“.
  const roiOf = (potential: number, cost: number): number | null =>
    cost > 0 ? Math.round(potential / cost * 10) / 10 : null

  // 1. SMS Reaktivierung – tatsächliche Zahl der Einmalkäufer statt Schätzung 70 %
  const oneTimeBuyers = Math.round(kpis.total_customers * (100 - kpis.repeat_rate_pct) / 100)
  if (oneTimeBuyers > 0) {
    const cost = Math.round(oneTimeBuyers * 0.08)
    const potential = Math.round(oneTimeBuyers * 0.10 * bon * 3)
    recs.push({
      action_type: 'sms', title: 'SMS-Reaktivierung Einmalkäufer',
      description: `5 EUR Gutschein per WhatsApp an ${oneTimeBuyers} Einmalkäufer. Nur Direktbestellung — nicht über Plattformen.`,
      target: `${oneTimeBuyers} Einmalkäufer`,
      estimated_cost: cost, estimated_potential: potential,
      roi: roiOf(potential, cost),
      priority: 1, timeframe: 'Woche 1',
    })
  }

  // 2. Flyer — schwächste PLZ
  const weakPLZ = plzAnalyses
    .filter(p => p.market_penetration_pct !== null && p.market_penetration_pct < 1)
    .sort((a, b) => (a.market_penetration_pct || 0) - (b.market_penetration_pct || 0))[0]
  if (weakPLZ) {
    const fc = 380
    const fp = Math.round((weakPLZ.population || 5000) * 0.025 * bon * 3)
    recs.push({
      action_type: 'flyer', title: `Flyer-Offensive PLZ ${weakPLZ.postal_code}`,
      // Straßenzahl nur nennen, wenn das Verzeichnis vollständig war (sonst null)
      description: (typeof weakPLZ.not_reached_residents === 'number'
        ? `${weakPLZ.not_reached_residents.toLocaleString('de-DE')} Einwohner bisher ohne Bestellung.`
        : 'Geringe Marktdurchdringung.') +
        (typeof weakPLZ.streets_without_orders === 'number' ? ` ${weakPLZ.streets_without_orders} Straßen ohne Bestellung.` : ''),
      target: `PLZ ${weakPLZ.postal_code} — ${weakPLZ.city}`,
      estimated_cost: fc, estimated_potential: fp,
      roi: roiOf(fp, fc), priority: 1, timeframe: 'Woche 1–2',
    })
  }

  // 3. B2B Akquise
  const b2bStreets = streetResults.filter(s => s.avg_order_value > 25 && s.order_count >= 2)
  if (b2bStreets.length > 0) {
    const topB2B = b2bStreets.slice(0, 3).map(s => s.street_name).join(', ')
    recs.push({
      action_type: 'b2b_visit', title: 'B2B-Akquise Firmenkunden',
      description: `Hoher Ø Bon deutet auf Gruppenbestellungen hin. Direkte Firmenansprache ohne Flyerkosten.`,
      target: topB2B, estimated_cost: 0, estimated_potential: 4800,
      roi: null, priority: 1, timeframe: 'Woche 2',
    })
  }

  // 4. App-Migration Plattformkunden
  recs.push({
    action_type: 'app_campaign', title: 'Plattformkunden → Direktbestellung',
    description: 'QR-Code auf Verpackung: "Direkt bestellen = 5% Rabatt". Plattformgebühren (~30%) einsparen.',
    target: 'Alle Lieferando/Wolt-Kunden',
    estimated_cost: 0, estimated_potential: Math.round(kpis.total_revenue * 0.05),
    roi: null, priority: 2, timeframe: 'Sofort',
  })

  // 5. Straßen-spezifische Aktionen
  const missedStreets = streetResults.filter(s => s.street_class === 'E' && s.is_in_official_list).slice(0, 5)
  if (missedStreets.length > 0) {
    recs.push({
      action_type: 'flyer', title: `Flyer: ${missedStreets.length} unerreichte Top-Straßen`,
      description: missedStreets.map(s => s.street_name).join(', '),
      target: 'Straßen ohne einzigen Kontakt',
      estimated_cost: Math.round(missedStreets.length * 45),
      estimated_potential: Math.round(missedStreets.length * 50 * 0.025 * bon * 3),
      roi: roiOf(Math.round(missedStreets.length * 50 * 0.025 * bon * 3), Math.round(missedStreets.length * 45)),
      priority: 2, timeframe: 'Woche 2–3',
    })
  }

  // 6. VIP-Programm
  if (kpis.vip_rate_pct < 2) {
    recs.push({
      action_type: 'loyalty', title: 'VIP-Programm aktivieren',
      description: `Nur ${kpis.vip_rate_pct}% VIP-Nutzer. Stempelkarte auf Verpackung drucken.`,
      target: 'Alle Stammkunden',
      estimated_cost: 50, estimated_potential: 2100,
      roi: roiOf(2100, 50), priority: 3, timeframe: 'Woche 3',
    })
  }

  // Ohne Kosten (roi null) zuerst, sonst höherer ROI zuerst
  const roiRank = (r: number | null) => r === null ? Number.POSITIVE_INFINITY : r
  return recs.sort((a, b) => a.priority - b.priority || roiRank(b.roi) - roiRank(a.roi))
}

// ── App-Migration Szenarien ───────────────────────────────────────────────────

export function computeAppMigrationScenarios(
  totalRevenue: number,
  platformFeeRate = 0.30,
  avgOrderValue = 19.5
) {
  return [5, 10, 20, 30].map(pct => {
    const migratedRevenue = totalRevenue * pct / 100
    const savedFees = Math.round(migratedRevenue * platformFeeRate)
    const additionalMargin = Math.round(savedFees * 0.6) // 60% davon als DB
    return {
      migration_pct: pct,
      migrated_revenue: Math.round(migratedRevenue),
      saved_fees: savedFees,
      additional_margin: additionalMargin,
    }
  })
}
