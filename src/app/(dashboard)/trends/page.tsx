'use client'
// Entwicklung: Zeiträume im Vergleich, Verlauf und Wochentage.
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card, Delta, EmptyState, LoadError, Notice, PageHeader, PageSkeleton, Stat, fmtEur, fmtInt, fmtNum } from '@/components/ui'
import { useOverview } from '@/lib/insights/use-overview'

function Bars({ data, name, unit = '' }: { data: { label: string; value: number }[]; name: string; unit?: string }) {
  return (
    <div className="h-[240px] w-full" role="img" aria-label={`Diagramm: ${name}`}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="#E2E6EB" />
          <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#687380' }} tickLine={false} axisLine={{ stroke: '#C9D0D9' }} interval="preserveStartEnd" minTickGap={20} />
          <YAxis tick={{ fontSize: 12, fill: '#687380' }} tickLine={false} axisLine={false} width={56} tickFormatter={v => Number(v).toLocaleString('de-DE')} />
          <Tooltip cursor={{ fill: '#EEF1F4' }} contentStyle={{ borderRadius: 8, border: '1px solid #E2E6EB', fontSize: 13 }} formatter={(v: number) => [`${Number(v).toLocaleString('de-DE', { maximumFractionDigits: 2 })}${unit}`, name]} />
          <Bar dataKey="value" fill="#1F4B99" radius={[3, 3, 0, 0]} maxBarSize={40} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function TrendsPage() {
  const { data, error, loading, reload } = useOverview()
  if (loading && !data) return <PageSkeleton />
  if (error || !data) return <LoadError message={error || 'Keine Antwort'} onRetry={reload} />
  const o = data.overview, c = o.change
  if (o.empty) return (
    <div className="page"><PageHeader title="Entwicklung" />
      <EmptyState title="Noch keine Daten" action={{ href: '/uploads', label: 'Datei importieren' }}>Die Entwicklung zeigt sich, sobald Daten aus mindestens zwei Zeiträumen vorliegen.</EmptyState></div>
  )
  return (
    <div className="page">
      <PageHeader title="Entwicklung" lead="Wie haben sich Umsatz und Bestellungen verändert? Zeiträume unterschiedlicher Länge werden je Tag verglichen." />

      {c ? (c.comparable ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Umsatz je Tag" value={fmtEur(c.current.revenue_per_day, 2)} sub={<><Delta value={c.revenue_per_day_pct} /> als im Vorzeitraum ({fmtEur(c.previous.revenue_per_day, 2)})</>} help={`${c.current.label} gegenüber ${c.previous.label}. Umsatz des Zeitraums geteilt durch seine Tage.`} />
          <Stat label="Bestellungen je Tag" value={fmtNum(c.current.orders_per_day)} sub={<><Delta value={c.orders_per_day_pct} /> ({fmtNum(c.previous.orders_per_day)})</>} />
          <Stat label="Bestellwert im Schnitt" value={fmtEur(c.current.avg_order_value, 2)} sub={<><Delta value={c.avg_order_value_pct} /> ({fmtEur(c.previous.avg_order_value, 2)})</>} />
        </div>
      ) : <Notice tone="warn" title="Die letzten beiden Zeiträume lassen sich nicht vergleichen">{c.reason}</Notice>)
        : <Notice title="Noch kein Vergleich möglich">{o.periods.length < 2 ? 'Es gibt erst einen importierten Zeitraum. Ergänzen Sie unter „Import“ einen späteren Zeitraum, dann erscheint hier der Vergleich.' : 'Mindestens einer Datei fehlt der Zeitraum. Ohne Anfangs- und Enddatum lässt sich nichts je Tag vergleichen.'}</Notice>}

      <Card className="mt-4" pad={false} title="Importierte Zeiträume">
        <div className="table-wrap"><table className="table">
          <thead><tr><th>Zeitraum</th><th className="r">Tage</th><th className="r">Bestellungen</th><th className="r">Umsatz</th><th className="r">Bestellwert</th><th className="r">Bestellungen je Tag</th><th className="r">Umsatz je Tag</th></tr></thead>
          <tbody>{o.periods.map(p => (
            <tr key={p.upload_id}><td className="num whitespace-nowrap">{p.label}</td><td className="r">{fmtInt(p.days)}</td><td className="r">{fmtInt(p.orders)}</td><td className="r">{fmtEur(p.revenue)}</td><td className="r">{fmtEur(p.avg_order_value, 2)}</td><td className="r">{fmtNum(p.orders_per_day)}</td><td className="r">{fmtEur(p.revenue_per_day, 2)}</td></tr>))}</tbody>
        </table></div>
      </Card>

      {o.series.available ? (
        <>
          <Card className="mt-4" title="Umsatz je Woche" lead="Aus dem Bestelldatum jeder Bestellung."><Bars data={o.series.weekly.map(s => ({ label: s.label, value: s.revenue }))} name="Umsatz" unit=" €" /></Card>
          <Card className="mt-4" title="Bestellungen je Wochentag" lead="Durchschnitt je Tag: Bestellungen an diesem Wochentag geteilt durch die Zahl dieser Wochentage im Zeitraum.">
            <Bars data={o.series.weekdays.map(w => ({ label: w.label, value: w.orders_per_day }))} name="Bestellungen je Tag" />
          </Card>
        </>
      ) : (
        <div className="mt-4"><Notice title="Kein Verlauf nach Tagen, Wochen oder Wochentagen">{o.series.reason}</Notice></div>
      )}

      {c?.comparable && o.streets.changes.length > 0 && (
        <Card className="mt-4" pad={false} title="Straßen mit der größten Veränderung" lead="Bestellungen je 30 Tage, letzter Zeitraum gegenüber dem Vorzeitraum. Bei wenigen Bestellungen sind große Ausschläge normal.">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Straße</th><th>PLZ</th><th className="r">vorher</th><th className="r">zuletzt</th><th className="r">Veränderung</th></tr></thead>
            <tbody>{[...o.streets.changes.slice(0, 6), ...o.streets.changes.slice(-4).reverse().filter(s => s.change_pct > 0)].map(s => (
              <tr key={s.postal_code + s.street_name}><td>{s.street_name}</td><td className="num text-ink-muted">{s.postal_code}</td><td className="r">{fmtNum(s.previous_per_30d)}</td><td className="r">{fmtNum(s.current_per_30d)}</td>
                <td className={`r ${s.change_pct < 0 ? 'text-bad' : 'text-good'}`}>{s.change_pct > 0 ? '+' : ''}{fmtNum(s.change_pct)} %</td></tr>))}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  )
}
