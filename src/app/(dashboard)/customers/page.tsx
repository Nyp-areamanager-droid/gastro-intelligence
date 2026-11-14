'use client'
// Kunden: Bindung und Kundengruppen – nur als Summen, ohne einzelne Personen.
import { Card, EmptyState, LoadError, Notice, PageHeader, PageSkeleton, Stat, fmtEur, fmtInt, fmtNum, fmtPct } from '@/components/ui'
import { useOverview } from '@/lib/insights/use-overview'

export default function CustomersPage() {
  const { data, error, loading, reload } = useOverview()
  if (loading && !data) return <PageSkeleton />
  if (error || !data) return <LoadError message={error || 'Keine Antwort'} onRetry={reload} />
  const o = data.overview, t = o.totals
  if (o.empty) return (
    <div className="page"><PageHeader title="Kunden" />
      <EmptyState title="Noch keine Kundendaten" action={{ href: '/uploads', label: 'Datei importieren' }}>Nach dem ersten Import sehen Sie hier, wie viele Kunden wiederkommen.</EmptyState></div>
  )
  const total = o.segments?.reduce((s, x) => s + x.customers, 0) || 0

  return (
    <div className="page">
      <PageHeader title="Kunden" lead="Wie viele Kunden kommen wieder? Gezeigt werden nur Summen. Namen, Telefonnummern und E-Mail-Adressen speichert die Plattform nicht." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Kunden" value={fmtInt(t.customers)} sub={`aus ${fmtInt(t.records)} Datensätzen`} help="Dieselbe Person wird über Kundennummer oder Telefon-Kennzeichen erkannt und nur einmal gezählt." />
        <Stat label="Mit mindestens zwei Bestellungen" value={fmtPct(t.repeat_customers_pct)} sub={t.repeat_customers_pct === null ? 'nicht bestimmbar' : 'im gesamten Datenzeitraum'} />
        <Stat label="Mit genau einer Bestellung" value={fmtPct(t.one_time_customers_pct)} sub={t.one_time_customers_pct === null ? 'nicht bestimmbar' : undefined} />
        <Stat label="Bestellungen je Kunde" value={fmtNum(t.orders_per_customer, 2)} sub={t.orders_per_customer === null ? 'nicht bestimmbar' : undefined} />
      </div>

      {t.identified_share_pct !== null && t.identified_share_pct < 100 && (
        <div className="mt-3"><Notice tone={t.identified_share_pct < 80 ? 'warn' : 'info'} title={`${fmtPct(100 - t.identified_share_pct)} der Datensätze ohne Kennung`}>
          {fmtInt(t.unidentified_records)} Datensätze haben weder Kundennummer noch Telefon-Kennzeichen. Jeder zählt als eigener Kunde.
          {t.identified_share_pct < 80 ? ' Weil das mehr als ein Fünftel ist, werden Anteile wiederkehrender Kunden nicht berechnet – sie wären zu niedrig.' : ''}
        </Notice></div>
      )}

      <Card className="mt-4" pad={false} title="Kundengruppen" lead="Eingeteilt nach Zahl der Bestellungen und Abstand der letzten Bestellung zum Ende des Datenzeitraums.">
        {o.segments ? (
          <>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Gruppe</th><th>So ist sie abgegrenzt</th><th className="r">Kunden</th><th>Anteil</th><th className="r">Bestellungen</th><th className="r">Umsatz</th></tr></thead>
              <tbody>{o.segments.map(s => (
                <tr key={s.key}>
                  <td className="font-medium whitespace-nowrap">{s.label}</td>
                  <td className="text-ink-soft min-w-[240px]">{s.explanation}</td>
                  <td className="r">{fmtInt(s.customers)}</td>
                  <td><div className="flex items-center gap-2"><span className="num w-12 text-right">{fmtPct(total ? s.customers / total * 100 : 0, 0)}</span>
                    <span className="h-2 w-24 overflow-hidden rounded-full bg-sunken" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${total ? s.customers / total * 100 : 0}%` }} /></span></div></td>
                  <td className="r">{fmtInt(s.orders)}</td>
                  <td className="r">{fmtEur(s.revenue)}</td>
                </tr>))}</tbody>
            </table></div>
            {o.segments_note && <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted sm:px-5">{o.segments_note} Die Grenzen (30 und 60 Tage, 2 und 4 Bestellungen) sind feste Regeln, keine Vorhersage.</p>}
          </>
        ) : <div className="card-pad"><Notice title="Kundengruppen lassen sich mit diesen Daten nicht bilden">{o.segments_note}</Notice></div>}
      </Card>

      {o.platforms.length > 0 && (
        <Card className="mt-4" pad={false} title="Bestellwege" lead="Aus der Spalte „Plattform“ Ihrer Dateien.">
          <div className="table-wrap"><table className="table">
            <thead><tr><th>Bestellweg</th><th className="r">Bestellungen</th><th>Anteil</th></tr></thead>
            <tbody>{o.platforms.map(p => (
              <tr key={p.name}><td>{p.name}</td><td className="r">{fmtInt(p.orders)}</td>
                <td><div className="flex items-center gap-2"><span className="num w-14 text-right">{fmtPct(p.share_pct)}</span><span className="h-2 w-40 overflow-hidden rounded-full bg-sunken" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${p.share_pct}%` }} /></span></div></td></tr>))}</tbody>
          </table></div>
        </Card>
      )}
    </div>
  )
}
