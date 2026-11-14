'use client'
// Übersicht: Wie läuft der Betrieb, wo liegt Potenzial, was hat sich verändert?
// Alle Zahlen kommen fertig berechnet von /api/overview (lib/insights/overview.ts).
import { useState } from 'react'
import Link from 'next/link'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, Delta, EmptyState, LoadError, Notice, PageHeader, PageSkeleton, SegmentedControl, Stat, InfoTip, fmtDate, fmtEur, fmtInt, fmtNum, fmtPct } from '@/components/ui'
import { RecommendationCard } from '@/components/insights/RecommendationCard'
import { useOverview } from '@/lib/insights/use-overview'
import { RangePicker } from '@/components/insights/RangePicker'
import type { SeriesPoint } from '@/lib/insights/overview'

const ACCENT = '#1F4B99'

function Chart({ data, valueKey, unit }: { data: { label: string; value: number }[]; valueKey: string; unit: string }) {
  return (
    <div className="h-[240px] w-full" role="img" aria-label={`Diagramm: ${valueKey}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#E2E6EB" />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#687380' }} tickLine={false} axisLine={{ stroke: '#C9D0D9' }} interval="preserveStartEnd" minTickGap={24} />
          <YAxis tick={{ fontSize: 12, fill: '#687380' }} tickLine={false} axisLine={false} width={56} tickFormatter={v => Number(v).toLocaleString('de-DE')} />
          <Tooltip cursor={{ fill: '#EEF1F4' }} contentStyle={{ borderRadius: 8, border: '1px solid #E2E6EB', fontSize: 13, boxShadow: '0 8px 28px rgb(23 33 43 / 0.14)' }}
            formatter={(v: number) => [`${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })} ${unit}`, valueKey]} />
          <Bar dataKey="value" fill={ACCENT} radius={[3, 3, 0, 0]} maxBarSize={36} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function DashboardPage() {
  const { data, error, loading, reload, store, setStore, range, setRange } = useOverview()
  const [grain, setGrain] = useState<'daily' | 'weekly' | 'monthly'>('weekly')
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue')

  if (loading && !data) return <PageSkeleton />
  if (error || !data) return <LoadError message={error || 'Keine Antwort'} onRetry={reload} />
  const { overview: o, recommendations, stores } = data

  if (o.empty && !data.range.applied && !range) return (
    <div className="page">
      <PageHeader title="Übersicht" />
      <EmptyState title="Noch keine Bestelldaten" action={{ href: '/uploads', label: 'Erste Datei importieren' }}>
        Importieren Sie einen Export aus Ihrem Kassen- oder Bestellsystem (CSV oder Excel). Danach sehen Sie hier Umsatz, Bestellungen und Ihre Liefergebiete nach Postleitzahl und Straße.
      </EmptyState>
    </div>
  )

  const t = o.totals, c = o.change
  const main = recommendations.filter(r => r.kind !== 'data_gap').slice(0, 3)
  const maxRate = Math.max(0, ...o.plz.map(p => p.orders_per_1000 ?? 0))
  const series: SeriesPoint[] = o.series.available ? o.series[grain] : []
  const declining = o.streets.changes.filter(s => s.previous_orders >= 8 && s.change_pct <= -40).slice(0, 6)

  return (
    <div className="page">
      <PageHeader title="Übersicht"
        lead={o.coverage.start && o.coverage.end
          ? <>Daten vom {fmtDate(o.coverage.start)} bis {fmtDate(o.coverage.end)}{o.coverage.days ? `, ${fmtInt(o.coverage.days)} Tage` : ''}{o.periods.length > 1 ? ` aus ${o.periods.length} Importen` : ''}.</>
          : <>Der Zeitraum Ihrer Daten ist nicht vollständig bekannt. Werte je Tag können deshalb nicht berechnet werden.</>}
        actions={<>
          <RangePicker info={data.range} value={range} onChange={setRange} />
          {stores.length > 1 && (
            <select aria-label="Standort" className="input h-9 w-auto" value={store || ''} onChange={e => setStore(e.target.value || null)}>
              <option value="">Alle Standorte</option>
              {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <Link href="/uploads" className="btn-secondary">Daten importieren</Link>
        </>} />

      {range && !data.range.applied && data.range.reason && <div className="mb-3"><Notice tone="warn" title="Zeitraum nicht anwendbar">{data.range.reason} Gezeigt werden alle Daten.</Notice></div>}
      {data.range.applied && <div className="mb-3"><Notice tone="info">Gezeigt wird nur der gewählte Zeitraum. „Straßen ohne Bestellung“ gilt immer für den gesamten Bestand und wird deshalb hier nicht ausgewiesen.</Notice></div>}
      <div className={`grid grid-cols-2 gap-3 lg:grid-cols-4 ${loading ? 'opacity-60' : ''}`} aria-busy={loading}>
        <Stat label="Umsatz" value={fmtEur(t.revenue)} help="Summe der Spalte Umsatz aller importierten Zeilen."
          sub={c?.comparable ? <>je Tag <Delta value={c.revenue_per_day_pct} /> als im Vorzeitraum</> : o.coverage.days ? `${fmtEur(t.revenue / o.coverage.days)} je Tag` : undefined} />
        <Stat label="Bestellungen" value={fmtInt(t.orders)} help="Summe der Bestellungen aller importierten Zeilen. Fehlt die Spalte, zählt jede Zeile als eine Bestellung."
          sub={c?.comparable ? <>je Tag <Delta value={c.orders_per_day_pct} /></> : o.coverage.days ? `${fmtNum(t.orders / o.coverage.days)} je Tag` : undefined} />
        <Stat label="Bestellwert im Schnitt" value={fmtEur(t.avg_order_value, 2)} help="Umsatz geteilt durch Zahl der Bestellungen."
          sub={c?.comparable ? <><Delta value={c.avg_order_value_pct} /> als im Vorzeitraum</> : undefined} />
        <Stat label="Kunden" value={fmtInt(t.customers)}
          help="Dieselbe Person wird über Kundennummer oder Telefon-Kennzeichen erkannt und einmal gezählt. Datensätze ohne Kennung zählen je als ein Kunde."
          sub={t.repeat_customers_pct !== null ? `${fmtPct(t.repeat_customers_pct)} mit mindestens zwei Bestellungen` : 'Wiederkehrende Kunden nicht bestimmbar'} />
      </div>

      {t.identified_share_pct !== null && t.unidentified_records > 0 && (
        <div className="mt-3">
          <Notice tone="warn">
            {fmtInt(t.unidentified_records)} von {fmtInt(t.records)} Datensätzen haben weder Kundennummer noch Telefon-Kennzeichen.
            Sie zählen je als ein Kunde, die Kundenzahl ist deshalb eher zu hoch. Umsatz und Bestellungen sind davon nicht betroffen.
          </Notice>
        </div>
      )}

      {main.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div><h2 className="section-title">Was jetzt wichtig ist</h2><p className="section-lead">Aus Ihren Zahlen abgeleitet. Jede Empfehlung zeigt, worauf sie beruht.</p></div>
            <Link href="/marketing" className="link shrink-0 text-[13.5px]">Alle {recommendations.length} ansehen</Link>
          </div>
          <div className="grid gap-3 lg:grid-cols-3">{main.map(r => <RecommendationCard key={r.id} rec={r} compact />)}</div>
        </section>
      )}

      <Card className="mt-8" title="Entwicklung"
        lead={o.series.available ? 'Aus dem Bestelldatum jeder einzelnen Bestellung.' : o.periods.length > 1 ? 'Je importiertem Zeitraum, umgerechnet auf einen Tag.' : undefined}
        actions={<div className="flex flex-wrap gap-2">
          <SegmentedControl<'revenue' | 'orders'> label="Kennzahl" value={metric} onChange={setMetric} options={[{ value: 'revenue', label: 'Umsatz' }, { value: 'orders', label: 'Bestellungen' }]} />
          {o.series.available && <SegmentedControl<'daily' | 'weekly' | 'monthly'> label="Zeitraster" value={grain} onChange={setGrain} options={[{ value: 'daily', label: 'Tage' }, { value: 'weekly', label: 'Wochen' }, { value: 'monthly', label: 'Monate' }]} />}
        </div>}>
        {o.series.available
          ? <Chart data={series.map(s => ({ label: s.label, value: metric === 'revenue' ? s.revenue : s.orders }))} valueKey={metric === 'revenue' ? 'Umsatz' : 'Bestellungen'} unit={metric === 'revenue' ? '€' : ''} />
          : o.periods.filter(p => p.days).length > 1
            ? <>
                <Chart data={o.periods.filter(p => p.days).map(p => ({ label: p.label, value: metric === 'revenue' ? p.revenue_per_day! : p.orders_per_day! }))} valueKey={metric === 'revenue' ? 'Umsatz je Tag' : 'Bestellungen je Tag'} unit={metric === 'revenue' ? '€' : ''} />
                <p className="mt-3 text-[12.5px] text-ink-muted">{o.series.reason}</p>
              </>
            : <Notice>{o.series.reason} {o.periods.length < 2 && 'Ein Vergleich von Zeiträumen ist ab dem zweiten Import möglich.'}</Notice>}
      </Card>

      <Card className="mt-4" pad={false} title="Liefergebiete nach Postleitzahl"
        lead="Sortiert nach Umsatz. Einwohnerzahlen nur, wo sie aus dem Zensus 2022 belegt sind."
        actions={<Link href="/plz" className="link text-[13.5px]">Details</Link>}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th>PLZ</th><th className="r">Umsatz</th><th className="r">Anteil</th><th className="r">Bestellungen</th><th className="r">Bestellwert</th><th className="r">Kunden</th><th className="r">Einwohner</th>
              <th>Bestellungen je 1.000 Einwohner<InfoTip label="Bestellungen je 1.000 Einwohner">Bestellungen im gesamten Datenzeitraum, geteilt durch die Einwohnerzahl, mal 1.000. So lassen sich große und kleine Gebiete vergleichen. Ohne belegte Einwohnerzahl bleibt das Feld leer.</InfoTip></th>
              <th className="r">Straßen ohne Bestellung</th>
            </tr></thead>
            <tbody>
              {o.plz.map(p => (
                <tr key={p.postal_code}>
                  <td><Link href={`/streets?plz=${p.postal_code}`} className="link num">{p.postal_code}</Link>{p.city && <span className="ml-2 text-ink-muted">{p.city}</span>}</td>
                  <td className="r">{fmtEur(p.revenue)}</td>
                  <td className="r text-ink-muted">{fmtPct(p.revenue_share_pct)}</td>
                  <td className="r">{fmtInt(p.orders)}</td>
                  <td className="r">{fmtEur(p.avg_order_value, 2)}</td>
                  <td className="r">{fmtInt(p.customers)}</td>
                  <td className="r">{fmtInt(p.population)}</td>
                  <td>
                    {p.orders_per_1000 === null ? <span className="text-ink-muted">—</span> : (
                      <div className="flex items-center gap-2">
                        <span className="num w-12 text-right">{fmtNum(p.orders_per_1000)}</span>
                        <span className="h-2 w-28 overflow-hidden rounded-full bg-sunken" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${maxRate ? Math.max(3, p.orders_per_1000 / maxRate * 100) : 0}%` }} /></span>
                      </div>
                    )}
                  </td>
                  <td className="r">{p.streets_without_orders === null ? <span className="text-ink-muted">—</span> : <>{fmtInt(p.streets_without_orders)} <span className="text-ink-muted">von {fmtInt(p.streets_total)}</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card pad={false} title="Straßen mit dem meisten Umsatz">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Straße</th><th>PLZ</th><th className="r">Umsatz</th><th className="r">Bestellungen</th></tr></thead>
            <tbody>{o.streets.top.slice(0, 8).map(s => (
              <tr key={s.postal_code + s.street_name}><td>{s.street_name}</td><td className="num text-ink-muted">{s.postal_code}</td><td className="r">{fmtEur(s.revenue)}</td><td className="r">{fmtInt(s.orders)}</td></tr>
            ))}</tbody>
          </table></div>
        </Card>
        {c?.comparable && declining.length > 0 ? (
          <Card pad={false} title="Straßen mit Rückgang" lead={`${c.previous.label} gegenüber ${c.current.label}, je 30 Tage.`}>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Straße</th><th>PLZ</th><th className="r">vorher</th><th className="r">zuletzt</th><th className="r">Veränderung</th></tr></thead>
              <tbody>{declining.map(s => (
                <tr key={s.postal_code + s.street_name}><td>{s.street_name}</td><td className="num text-ink-muted">{s.postal_code}</td><td className="r">{fmtNum(s.previous_per_30d)}</td><td className="r">{fmtNum(s.current_per_30d)}</td><td className="r text-bad">{fmtNum(s.change_pct)} %</td></tr>
              ))}</tbody>
            </table></div>
          </Card>
        ) : (
          <Card pad={false} title="Straßen mit wenig Bestellungen" lead="Straßen, aus denen bestellt wurde, aber selten.">
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Straße</th><th>PLZ</th><th className="r">Bestellungen</th><th className="r">Umsatz</th></tr></thead>
              <tbody>{o.streets.lowest_with_orders.slice(0, 8).map(s => (
                <tr key={s.postal_code + s.street_name}><td>{s.street_name}</td><td className="num text-ink-muted">{s.postal_code}</td><td className="r">{fmtInt(s.orders)}</td><td className="r">{fmtEur(s.revenue)}</td></tr>
              ))}</tbody>
            </table></div>
          </Card>
        )}
      </div>
    </div>
  )
}
