// =============================================================================
// Handlungsempfehlungen aus der Übersicht – feste, nachvollziehbare Regeln.
//
// Keine Prognosen, keine geschätzten Euro-Beträge, keine „KI“. Jede Empfehlung
// beantwortet fünf Fragen:
//   1. finding    – Was wurde festgestellt?
//   2. evidence   – Auf welchen Zahlen beruht das?
//   3. relevance  – Warum ist das wirtschaftlich wichtig?
//   4. action     – Welche Maßnahme könnte sinnvoll sein?
//   5. confidence – Wie sicher ist die Aussage (hoch/mittel/niedrig) und warum?
// Alle Schwellen stehen unten als benannte Konstanten.
// =============================================================================
import type { Overview, PlzSummary } from './overview'

export type Confidence = 'hoch' | 'mittel' | 'niedrig'
export type RecommendationKind =
  | 'plz_low_reach' | 'plz_high_reach' | 'streets_without_orders' | 'revenue_drop' | 'revenue_rise'
  | 'order_value_change' | 'streets_declining' | 'weak_weekday' | 'one_time_customers' | 'platform_share' | 'data_gap' | 'nearby_potential'

export interface Recommendation {
  id: string
  kind: RecommendationKind
  /** 1 = zuerst ansehen, 3 = Hinweis */
  priority: 1 | 2 | 3
  title: string
  finding: string
  evidence: string[]
  relevance: string
  action: string
  confidence: { level: Confidence; reason: string }
  postal_codes: string[]
  streets: string[]
}

export const RULES = {
  MIN_PLZ_WITH_POPULATION: 3,     // so viele eigene PLZ mit belegter Einwohnerzahl braucht der Vergleich
  MIN_POPULATION: 1000,
  LOW_REACH_FACTOR: 0.5,          // unter der Hälfte des Mittelwerts (Median) der eigenen Gebiete
  HIGH_REACH_FACTOR: 1.5,
  MIN_PLZ_ORDERS: 30,
  REVENUE_CHANGE_PCT: 10,         // Veränderung des Umsatzes je Tag gegenüber dem Vorzeitraum
  REVENUE_CHANGE_STRONG_PCT: 20,
  ORDER_VALUE_CHANGE_PCT: 8,
  STREET_MIN_PREVIOUS_ORDERS: 8,
  STREET_DROP_PCT: 40,
  WEEKDAY_MIN_DAYS: 42,           // mindestens 6 Wochen Daten
  WEEKDAY_WEAK_FACTOR: 0.75,
  ONE_TIME_SHARE_PCT: 60,
  ONE_TIME_MIN_CUSTOMERS: 50,
  ONE_TIME_MIN_DAYS: 60,
  PLATFORM_SHARE_PCT: 30,
  UNIDENTIFIED_SHARE_PCT: 20,
} as const

const de = (n: number, digits = 0) => n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const eur = (n: number) => `${de(n, 2)} €`
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const OWN_CHANNEL = /(website|webseite|homepage|app|telefon|direkt|eigen|shop|abhol|laden|theke|filiale)/i

export function buildRecommendations(o: Overview): Recommendation[] {
  const out: Recommendation[] = []
  if (o.empty) return out
  const days = o.coverage.days

  // ── 1./2. Gebiete im Vergleich: Bestellungen je 1.000 Einwohner ─────────────
  const withPop = o.plz.filter(p => p.population !== null && p.population >= RULES.MIN_POPULATION && p.orders_per_1000 !== null)
  if (withPop.length >= RULES.MIN_PLZ_WITH_POPULATION) {
    const med = median(withPop.map(p => p.orders_per_1000!))
    const conf = (p: PlzSummary): Recommendation['confidence'] =>
      withPop.length >= 5 && p.orders >= RULES.MIN_PLZ_ORDERS
        ? { level: 'hoch', reason: `Vergleich über ${withPop.length} eigene Gebiete mit Einwohnerzahlen aus dem Zensus 2022.` }
        : { level: 'mittel', reason: `Vergleich über nur ${withPop.length} eigene Gebiete${p.orders < RULES.MIN_PLZ_ORDERS ? ` und weniger als ${RULES.MIN_PLZ_ORDERS} Bestellungen in diesem Gebiet` : ''}. Lieferzeiten und Entfernung zum Standort sind nicht berücksichtigt.` }
    const ev = (p: PlzSummary) => [
      `PLZ ${p.postal_code}: ${de(p.population!)} Einwohner (Zensus 2022), ${de(p.orders)} Bestellungen, das sind ${de(p.orders_per_1000!, 1)} je 1.000 Einwohner.`,
      `Mittelwert (Median) Ihrer ${withPop.length} Gebiete mit Einwohnerzahl: ${de(med, 1)} Bestellungen je 1.000 Einwohner.`,
    ]
    for (const p of withPop.filter(p => p.orders_per_1000! < med * RULES.LOW_REACH_FACTOR).sort((a, b) => b.population! - a.population!).slice(0, 3)) {
      out.push({
        id: `plz_low_reach:${p.postal_code}`, kind: 'plz_low_reach', priority: 1,
        title: `PLZ ${p.postal_code}: viele Einwohner, wenige Bestellungen`,
        finding: `In ${p.postal_code}${p.city ? ' ' + p.city : ''} bestellen gemessen an der Einwohnerzahl deutlich weniger Menschen als in Ihren anderen Gebieten.`,
        evidence: ev(p),
        relevance: 'Das Gebiet wird bereits beliefert. Jede zusätzliche Bestellung dort nutzt vorhandene Wege und Kapazität.',
        action: `Prüfen, woran es liegt (Lieferzeit, Mindestbestellwert, Bekanntheit). Dann gezielt in ${p.postal_code} werben, zum Beispiel mit Handzetteln in den Straßen ohne Bestellung (siehe Karte).`,
        confidence: conf(p), postal_codes: [p.postal_code], streets: [],
      })
    }
    for (const p of withPop.filter(p => p.orders_per_1000! > med * RULES.HIGH_REACH_FACTOR && p.orders >= RULES.MIN_PLZ_ORDERS).sort((a, b) => b.orders_per_1000! - a.orders_per_1000!).slice(0, 2)) {
      out.push({
        id: `plz_high_reach:${p.postal_code}`, kind: 'plz_high_reach', priority: 3,
        title: `PLZ ${p.postal_code}: besonders hohe Bestelldichte`,
        finding: `In ${p.postal_code}${p.city ? ' ' + p.city : ''} wird gemessen an der Einwohnerzahl deutlich häufiger bestellt als in Ihren anderen Gebieten.`,
        evidence: ev(p),
        relevance: 'Das Gebiet zeigt, was erreichbar ist. Es eignet sich als Maßstab für ähnliche Nachbargebiete.',
        action: 'Festhalten, was hier anders ist (Nähe zum Standort, Lieferzeit, Werbung), und auf ein vergleichbares Nachbargebiet übertragen.',
        confidence: conf(p), postal_codes: [p.postal_code], streets: [],
      })
    }
  }

  // ── 3. Straßen ohne Bestellung (nur bei vollständigem Straßenverzeichnis) ───
  const noOrders = new Map<string, string[]>()
  for (const s of o.streets.without_orders) { const l = noOrders.get(s.postal_code); if (l) l.push(s.street_name); else noOrders.set(s.postal_code, [s.street_name]) }
  for (const p of o.plz.filter(p => noOrders.has(p.postal_code) && p.orders >= RULES.MIN_PLZ_ORDERS && p.streets_total).sort((a, b) => b.orders - a.orders).slice(0, 3)) {
    const list = noOrders.get(p.postal_code)!
    out.push({
      id: `streets_without_orders:${p.postal_code}`, kind: 'streets_without_orders', priority: 2,
      title: `PLZ ${p.postal_code}: ${list.length} Straßen ohne Bestellung`,
      finding: `In ${p.postal_code} gibt es Straßen, aus denen im Datenzeitraum keine einzige Bestellung kam, obwohl Sie das Gebiet beliefern.`,
      evidence: [
        `Amtliches Straßenverzeichnis (OpenPLZ): ${de(p.streets_total!)} Straßen, davon ${de(list.length)} ohne Bestellung.`,
        `Beispiele: ${list.slice(0, 8).join(', ')}${list.length > 8 ? ' …' : ''}`,
      ],
      relevance: 'In einem bereits belieferten Gebiet sind das die nächstliegenden neuen Kunden.',
      action: 'Auf der Karte prüfen, welche dieser Straßen Wohnstraßen mit vielen Hausadressen sind, und dort gezielt Handzettel verteilen.',
      confidence: { level: 'mittel', reason: 'Das Straßenverzeichnis ist vollständig. Ob in einer Straße viele Menschen wohnen, sagt es nicht – das zeigt die Zahl der Hausadressen auf der Karte.' },
      postal_codes: [p.postal_code], streets: list.slice(0, 8),
    })
  }

  // ── 4. Umsatz und Bestellwert gegenüber dem Vorzeitraum ─────────────────────
  const c = o.change
  if (c && c.comparable && c.revenue_per_day_pct !== null) {
    const lengthDiff = Math.abs(c.current.days! - c.previous.days!) / Math.max(c.current.days!, c.previous.days!)
    const confidence: Recommendation['confidence'] = lengthDiff <= 0.25 && c.current.orders >= 100 && c.previous.orders >= 100
      ? { level: 'hoch', reason: 'Beide Zeiträume sind ähnlich lang und enthalten jeweils mindestens 100 Bestellungen. Jahreszeit, Feiertage und Wetter sind nicht berücksichtigt.' }
      : { level: 'mittel', reason: 'Die Zeiträume sind unterschiedlich lang oder enthalten wenige Bestellungen. Verglichen wird je Tag. Jahreszeit, Feiertage und Wetter sind nicht berücksichtigt.' }
    const evidence = [
      `${c.previous.label}: ${eur(c.previous.revenue)} in ${c.previous.days} Tagen = ${eur(c.previous.revenue_per_day!)} je Tag, ${de(c.previous.orders_per_day!, 1)} Bestellungen je Tag.`,
      `${c.current.label}: ${eur(c.current.revenue)} in ${c.current.days} Tagen = ${eur(c.current.revenue_per_day!)} je Tag, ${de(c.current.orders_per_day!, 1)} Bestellungen je Tag.`,
    ]
    if (c.revenue_per_day_pct <= -RULES.REVENUE_CHANGE_PCT) {
      const moreFromOrders = (c.orders_per_day_pct ?? 0) < (c.avg_order_value_pct ?? 0)
      out.push({
        id: 'revenue_drop', kind: 'revenue_drop', priority: c.revenue_per_day_pct <= -RULES.REVENUE_CHANGE_STRONG_PCT ? 1 : 2,
        title: `Umsatz je Tag um ${de(Math.abs(c.revenue_per_day_pct), 1)} % gesunken`,
        finding: `Im letzten Zeitraum lag der Umsatz je Tag ${de(Math.abs(c.revenue_per_day_pct), 1)} % unter dem Vorzeitraum.`,
        evidence: [...evidence, `Bestellungen je Tag: ${fmtPct(c.orders_per_day_pct)}. Durchschnittlicher Bestellwert: ${fmtPct(c.avg_order_value_pct)}.`],
        relevance: 'Ein Rückgang in dieser Höhe wirkt sich direkt auf den Deckungsbeitrag aus, weil die festen Kosten gleich bleiben.',
        action: moreFromOrders
          ? 'Der Rückgang kommt vor allem von weniger Bestellungen. Prüfen, welche Gebiete und Straßen nachgelassen haben (siehe „Straßen mit Rückgang“), und ob es Lieferprobleme oder neue Wettbewerber gab.'
          : 'Der Rückgang kommt vor allem vom niedrigeren Bestellwert. Prüfen, ob Rabatte, Mindestbestellwert oder das Angebot geändert wurden.',
        confidence, postal_codes: [], streets: [],
      })
    } else if (c.revenue_per_day_pct >= RULES.REVENUE_CHANGE_PCT) {
      out.push({
        id: 'revenue_rise', kind: 'revenue_rise', priority: 3,
        title: `Umsatz je Tag um ${de(c.revenue_per_day_pct, 1)} % gestiegen`,
        finding: `Im letzten Zeitraum lag der Umsatz je Tag ${de(c.revenue_per_day_pct, 1)} % über dem Vorzeitraum.`,
        evidence: [...evidence, `Bestellungen je Tag: ${fmtPct(c.orders_per_day_pct)}. Durchschnittlicher Bestellwert: ${fmtPct(c.avg_order_value_pct)}.`],
        relevance: 'Wer weiß, woher der Zuwachs kommt, kann ihn wiederholen.',
        action: 'Festhalten, was sich geändert hat (Aktion, Wetter, neue Gebiete), damit sich der Effekt gezielt wiederholen lässt.',
        confidence, postal_codes: [], streets: [],
      })
    }
    if (c.avg_order_value_pct !== null && Math.abs(c.avg_order_value_pct) >= RULES.ORDER_VALUE_CHANGE_PCT) {
      const down = c.avg_order_value_pct < 0
      out.push({
        id: 'order_value_change', kind: 'order_value_change', priority: down ? 2 : 3,
        title: `Durchschnittlicher Bestellwert ${down ? 'gesunken' : 'gestiegen'} (${fmtPct(c.avg_order_value_pct)})`,
        finding: `Der durchschnittliche Bestellwert hat sich gegenüber dem Vorzeitraum deutlich verändert.`,
        evidence: [`${c.previous.label}: ${eur(c.previous.avg_order_value!)} je Bestellung (${de(c.previous.orders)} Bestellungen).`, `${c.current.label}: ${eur(c.current.avg_order_value!)} je Bestellung (${de(c.current.orders)} Bestellungen).`],
        relevance: 'Der Bestellwert bestimmt, wie viel von jeder Lieferfahrt übrig bleibt.',
        action: down ? 'Prüfen, ob Rabattaktionen, ein niedrigerer Mindestbestellwert oder weniger Beilagen und Getränke dahinterstehen.' : 'Prüfen, ob eine Preisänderung oder ein neues Angebot dahintersteht, und ob die Zahl der Bestellungen stabil geblieben ist.',
        confidence, postal_codes: [], streets: [],
      })
    }

    // ── 5. Straßen mit Rückgang ───────────────────────────────────────────────
    const declining = o.streets.changes.filter(s => s.previous_orders >= RULES.STREET_MIN_PREVIOUS_ORDERS && s.change_pct <= -RULES.STREET_DROP_PCT).slice(0, 5)
    if (declining.length) {
      out.push({
        id: 'streets_declining', kind: 'streets_declining', priority: 2,
        title: `${declining.length} ${declining.length === 1 ? 'Straße' : 'Straßen'} mit deutlich weniger Bestellungen`,
        finding: 'In diesen Straßen wurde im letzten Zeitraum deutlich seltener bestellt als davor.',
        evidence: declining.map(s => `${s.street_name} (${s.postal_code}): von ${de(s.previous_per_30d, 1)} auf ${de(s.current_per_30d, 1)} Bestellungen je 30 Tage (${fmtPct(s.change_pct)}).`),
        relevance: 'Das sind Straßen mit Kunden, die Sie schon hatten. Bestehende Kunden zurückzuholen kostet in der Regel weniger als neue zu gewinnen.',
        action: 'Prüfen, ob es dort Lieferprobleme gab oder ein Wettbewerber neu geöffnet hat. Gegebenenfalls einen Gutschein in diesen Straßen verteilen.',
        confidence: { level: 'niedrig', reason: `Je Straße sind es wenige Bestellungen (ab ${RULES.STREET_MIN_PREVIOUS_ORDERS} im Vorzeitraum). Schon wenige Stammkunden, die umziehen oder im Urlaub sind, erzeugen solche Ausschläge.` },
        postal_codes: [...new Set(declining.map(s => s.postal_code))], streets: declining.map(s => s.street_name),
      })
    }
  }

  // ── 6. Schwache Wochentage (nur mit einer Zeile je Bestellung) ──────────────
  if (o.series.available && o.series.daily.length) {
    const span = o.series.weekdays.reduce((s, w) => s + w.occurrences, 0)
    const active = o.series.weekdays.filter(w => w.orders > 0)
    if (span >= RULES.WEEKDAY_MIN_DAYS && active.length >= 4) {
      const mean = active.reduce((s, w) => s + w.orders_per_day, 0) / active.length
      const weak = active.filter(w => w.orders_per_day < mean * RULES.WEEKDAY_WEAK_FACTOR)
      const closed = o.series.weekdays.filter(w => w.orders === 0)
      if (weak.length) {
        out.push({
          id: 'weak_weekday', kind: 'weak_weekday', priority: 2,
          title: `${weak.map(w => w.label).join(' und ')}: deutlich weniger Bestellungen`,
          finding: `An ${weak.length === 1 ? 'diesem Wochentag' : 'diesen Wochentagen'} gehen deutlich weniger Bestellungen ein als im Schnitt der übrigen Öffnungstage.`,
          evidence: [
            ...weak.map(w => `${w.label}: ${de(w.orders_per_day, 1)} Bestellungen je Tag (${w.occurrences} ${w.label}e im Zeitraum).`),
            `Durchschnitt der ${active.length} Wochentage mit Bestellungen: ${de(mean, 1)} je Tag.`,
            ...(closed.length ? [`Ohne Bestellungen (vermutlich Ruhetag): ${closed.map(w => w.label).join(', ')}.`] : []),
          ],
          relevance: 'Personal und Küche sind an diesen Tagen ähnlich besetzt, bringen aber weniger Umsatz.',
          action: 'Ein Angebot nur für diese Tage testen (zum Beispiel ein Wochentagsmenü) und nach vier Wochen mit denselben Zahlen vergleichen. Alternativ die Besetzung anpassen.',
          confidence: span >= 84 ? { level: 'hoch', reason: `Grundlage sind ${span} Tage mit Bestelldatum je Bestellung.` } : { level: 'mittel', reason: `Grundlage sind ${span} Tage. Einzelne Feiertage oder Aktionen können das Bild verzerren.` },
          postal_codes: [], streets: [],
        })
      }
    }
  }

  // ── 7. Einmalkunden ─────────────────────────────────────────────────────────
  const t = o.totals
  if (t.one_time_customers_pct !== null && t.customers >= RULES.ONE_TIME_MIN_CUSTOMERS && days !== null && days >= RULES.ONE_TIME_MIN_DAYS && t.one_time_customers_pct >= RULES.ONE_TIME_SHARE_PCT) {
    out.push({
      id: 'one_time_customers', kind: 'one_time_customers', priority: 2,
      title: `${de(t.one_time_customers_pct, 1)} % der Kunden haben nur einmal bestellt`,
      finding: 'Die Mehrheit Ihrer Kunden hat im Datenzeitraum genau eine Bestellung aufgegeben.',
      evidence: [`${de(t.customers)} Kunden in ${days} Tagen, davon ${de(Math.round(t.customers * t.one_time_customers_pct / 100))} mit genau einer Bestellung.`, `${de(t.identified_share_pct!, 1)} % der Datensätze haben eine Kundennummer oder ein Telefon-Kennzeichen und lassen sich wiedererkennen.`],
      relevance: 'Eine zweite Bestellung kostet keine neue Werbung. Sie ist der günstigste Weg zu mehr Umsatz.',
      action: 'Der ersten Lieferung einen Gutschein für die zweite Bestellung beilegen und nach einem Monat prüfen, ob der Anteil sinkt.',
      confidence: { level: 'mittel', reason: 'Kunden, die erst kurz vor Ende des Zeitraums zum ersten Mal bestellt haben, zählen ebenfalls als Einmalkunden. Bei kurzen Zeiträumen wirkt der Anteil dadurch höher.' },
      postal_codes: [], streets: [],
    })
  }

  // ── 8. Bestellwege ──────────────────────────────────────────────────────────
  const external = o.platforms.filter(p => !OWN_CHANNEL.test(p.name) && p.share_pct >= RULES.PLATFORM_SHARE_PCT)
  if (external.length) {
    out.push({
      id: 'platform_share', kind: 'platform_share', priority: 3,
      title: `${external.map(p => `${de(p.share_pct, 1)} % über ${p.name}`).join(', ')}`,
      finding: 'Ein großer Teil der Bestellungen kommt über fremde Bestellplattformen.',
      evidence: o.platforms.map(p => `${p.name}: ${de(p.orders)} Bestellungen (${de(p.share_pct, 1)} %).`),
      relevance: 'Plattformen berechnen in der Regel eine Provision je Bestellung. Wie hoch sie bei Ihnen ist, steht in Ihrem Vertrag – die Software kennt sie nicht.',
      action: 'Mit Ihrer tatsächlichen Provision nachrechnen, was eine Verlagerung auf den eigenen Bestellweg bringen würde, und Stammkunden zum Beispiel per Beileger darauf hinweisen.',
      confidence: { level: 'mittel', reason: 'Die Anteile stammen aus der Spalte „Plattform“ Ihrer Dateien. Ob ein Bestellweg fremd oder eigen ist, erkennt die Software nur am Namen.' },
      postal_codes: [], streets: [],
    })
  }

  // ── 9. Lücken in der Datenlage ──────────────────────────────────────────────
  const gaps: string[] = []
  const noPop = o.plz.filter(p => p.population === null)
  if (noPop.length) gaps.push(`Für ${noPop.length} von ${o.plz.length} PLZ fehlt eine belegte Einwohnerzahl (${noPop.slice(0, 6).map(p => p.postal_code).join(', ')}${noPop.length > 6 ? ' …' : ''}). Dort gibt es keine Aussage je 1.000 Einwohner.`)
  const noDir = o.plz.filter(p => p.streets_total === null)
  if (noDir.length) gaps.push(`Für ${noDir.length} PLZ liegt kein vollständiges Straßenverzeichnis vor. Straßen ohne Bestellung lassen sich dort nicht benennen.`)
  if (t.identified_share_pct !== null && 100 - t.identified_share_pct > RULES.UNIDENTIFIED_SHARE_PCT) gaps.push(`${de(100 - t.identified_share_pct, 1)} % der Datensätze haben weder Kundennummer noch Telefon-Kennzeichen. Stammkunden lassen sich deshalb nicht zuverlässig erkennen.`)
  if (!o.series.available && o.series.reason) gaps.push(o.series.reason)
  if (o.periods.length < 2) gaps.push('Es gibt erst einen Zeitraum. Ein Vergleich mit dem Vorzeitraum ist ab dem zweiten Import möglich.')
  else if (o.change && !o.change.comparable && o.change.reason) gaps.push(`Kein Vergleich mit dem Vorzeitraum: ${o.change.reason}`)
  if (gaps.length) {
    out.push({
      id: 'data_gap', kind: 'data_gap', priority: 3,
      title: 'Mit vollständigeren Daten wären mehr Aussagen möglich',
      finding: 'Einige Auswertungen fehlen, weil die Grundlage dafür nicht vorliegt.',
      evidence: gaps,
      relevance: 'Fehlende Grundlagen werden nicht geschätzt. Die betroffenen Kennzahlen bleiben leer.',
      action: 'Wenn Ihr Kassensystem es anbietet: einen Export mit einer Zeile je Bestellung, Bestelldatum und Kundennummer verwenden und regelmäßig (zum Beispiel monatlich) importieren.',
      confidence: { level: 'hoch', reason: 'Das ist eine Feststellung über die vorhandenen Daten, keine Schätzung.' },
      postal_codes: [], streets: [],
    })
  }

  // Nachbargebiete ohne Bestellungen (nur mit belegter Einwohnerzahl ≥ 1.000)
  if (o.nearby?.items.length) {
    const top = o.nearby.items.slice(0, 3)
    out.push({
      id: 'nearby_potential', kind: 'nearby_potential', priority: 2,
      title: top.length === 1 ? `Nachbargebiet ${top[0].postal_code} ohne Bestellungen` : `${top.length} Nachbargebiete ohne Bestellungen`,
      finding: `Direkt neben Ihrem Liefergebiet liegen Postleitzahlen mit zusammen ${de(top.reduce((s2, x) => s2 + x.population, 0))} Einwohnern, aus denen bisher keine Bestellung kam.`,
      evidence: top.map(x => `PLZ ${x.postal_code}${x.city ? ` (${x.city})` : ''}: ${de(x.population)} Einwohner${x.households ? `, ${de(x.households)} Haushalte` : ''} (Zensus 2022), ${de(x.distance_km, 1)} km vom Mittelpunkt Ihrer PLZ ${x.nearest_own_plz}, 0 Bestellungen.`),
      relevance: 'Gebiete neben bestehenden Lieferzonen lassen sich meist ohne neue Fahrer und mit kurzen Wegen erschließen. Jede Bestellung dort ist zusätzlicher Umsatz.',
      action: `Prüfen, ob diese Postleitzahlen in Ihrem Lieferradius liegen (Fahrzeit, Mindestbestellwert, Lieferplattform). Wenn ja: mit einer kleinen Flyer- oder Gutschein-Aktion testen und nach vier Wochen hier nachsehen, ob Bestellungen kommen.`,
      confidence: { level: 'mittel', reason: `Einwohnerzahlen sind amtlich (Zensus 2022, Stichtag 15.05.2022). Als Nachbarschaft gilt ein Abstand der PLZ-Mittelpunkte bis ${de(o.nearby.max_km, 1)} km – ob dort geliefert werden kann, weiß nur der Betrieb.` },
      postal_codes: top.map(x => x.postal_code), streets: [],
    })
  }

  const rank: Record<Confidence, number> = { hoch: 0, mittel: 1, niedrig: 2 }
  return out.sort((a, b) => a.priority - b.priority || rank[a.confidence.level] - rank[b.confidence.level])
}

function fmtPct(v: number | null): string {
  if (v === null) return '—'
  return `${v > 0 ? '+' : ''}${v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}
