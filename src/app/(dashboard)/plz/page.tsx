'use client'
// Postleitzahlen: alle Liefergebiete im Vergleich, mit belegten Einwohnerzahlen.
import Link from 'next/link'
import { Card, EmptyState, InfoTip, LoadError, Notice, PageHeader, PageSkeleton, Stat, fmtEur, fmtInt, fmtNum, fmtPct } from '@/components/ui'
import { useOverview } from '@/lib/insights/use-overview'
import { HOUSEHOLDS_NOTE_TEXT, LIMITED_POPULATION_TEXT, POPULATION_SOURCE_TEXT, isLimitedPopulation } from '@/lib/geo/population'

export default function PlzPage() {
  const { data, error, loading, reload } = useOverview()
  if (loading && !data) return <PageSkeleton />
  if (error || !data) return <LoadError message={error || 'Keine Antwort'} onRetry={reload} />
  const o = data.overview
  if (o.empty) return (
    <div className="page"><PageHeader title="Postleitzahlen" />
      <EmptyState title="Noch keine Liefergebiete" action={{ href: '/uploads', label: 'Datei importieren' }}>Nach dem ersten Import sehen Sie hier jede Postleitzahl mit Umsatz, Bestellungen und – wo belegt – Einwohnern.</EmptyState></div>
  )
  const withPop = o.plz.filter(p => p.population !== null)
  const pop = withPop.reduce((s, p) => s + p.population!, 0), ordersWithPop = withPop.reduce((s, p) => s + p.orders, 0), customersWithPop = withPop.reduce((s, p) => s + p.customers, 0)
  const maxRate = Math.max(0, ...o.plz.map(p => p.orders_per_1000 ?? 0))

  return (
    <div className="page">
      <PageHeader title="Postleitzahlen" lead="Ihre Liefergebiete im Vergleich. Gemessen an der Einwohnerzahl zeigt sich, wo Sie stark sind und wo noch viele Haushalte nicht bestellen." />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Liefergebiete" value={fmtInt(o.plz.length)} sub="Postleitzahlen mit Bestellungen" />
        <Stat label="Einwohner in diesen Gebieten" value={withPop.length ? fmtInt(pop) : '—'} sub={`belegt für ${withPop.length} von ${o.plz.length} Postleitzahlen`} help={POPULATION_SOURCE_TEXT} />
        <Stat label="Bestellungen je 1.000 Einwohner" value={pop ? fmtNum(ordersWithPop / pop * 1000) : '—'} sub={o.coverage.days ? `im Datenzeitraum von ${fmtInt(o.coverage.days)} Tagen` : 'im gesamten Datenzeitraum'}
          help="Nur über die Postleitzahlen mit belegter Einwohnerzahl gerechnet: Bestellungen dieser Gebiete geteilt durch ihre Einwohner, mal 1.000." />
        <Stat label="Kunden je 100 Einwohner" value={pop ? fmtNum(customersWithPop / pop * 100, 2) : '—'} sub="nur Gebiete mit belegter Einwohnerzahl"
          help="Kunden geteilt durch Einwohner, mal 100. Ein Kunde ist oft ein Haushalt mit mehreren Personen – der Wert ist deshalb eine Untergrenze dafür, wie viele Menschen Sie erreichen." />
      </div>

      {withPop.length < o.plz.length && (
        <div className="mt-3"><Notice title={`Für ${o.plz.length - withPop.length} Postleitzahlen fehlt eine belegte Einwohnerzahl`}>
          Einwohner und Haushalte werden nur aus dem Zensus 2022 übernommen, nie geschätzt. Für Gebiete ohne Zahl bleiben die Spalten leer. Der Zensus-Import wird einmalig vom Betreiber der Plattform eingespielt.
        </Notice></div>
      )}

      <Card className="mt-4" pad={false} title="Alle Postleitzahlen" lead="Sortiert nach Umsatz. Ein Klick auf die Postleitzahl öffnet die Karte.">
        <div className="table-wrap">
          <table className="table">
            <thead><tr>
              <th>PLZ</th><th className="r">Umsatz</th><th className="r">Bestellungen</th><th className="r">Bestellwert</th><th className="r">Kunden</th><th className="r">Einwohner</th><th className="r">Haushalte</th>
              <th>Bestellungen je 1.000 Einwohner</th>
              <th className="r">je 30 Tage<InfoTip label="je 30 Tage">Bestellungen je 1.000 Einwohner, umgerechnet auf 30 Tage. So bleibt der Wert vergleichbar, wenn später weitere Zeiträume dazukommen.</InfoTip></th>
              <th className="r">Kunden je 100 Einw.</th><th className="r">Straßen mit Bestellung</th>
            </tr></thead>
            <tbody>
              {o.plz.map(p => (
                <tr key={p.postal_code}>
                  <td><Link href={`/streets?plz=${p.postal_code}`} className="link num">{p.postal_code}</Link>{p.city && <span className="ml-2 text-ink-muted">{p.city}</span>}</td>
                  <td className="r">{fmtEur(p.revenue)} <span className="text-ink-muted">({fmtPct(p.revenue_share_pct, 0)})</span></td>
                  <td className="r">{fmtInt(p.orders)}</td>
                  <td className="r">{fmtEur(p.avg_order_value, 2)}</td>
                  <td className="r">{fmtInt(p.customers)}</td>
                  <td className="r">{fmtInt(p.population)}{isLimitedPopulation(p.population) && <span className="text-warn" title={LIMITED_POPULATION_TEXT}> *</span>}</td>
                  <td className="r">{fmtInt(p.households)}</td>
                  <td>{p.orders_per_1000 === null ? <span className="text-ink-muted">—</span> : (
                    <div className="flex items-center gap-2"><span className="num w-12 text-right">{fmtNum(p.orders_per_1000)}</span>
                      <span className="h-2 w-24 overflow-hidden rounded-full bg-sunken" aria-hidden><span className="block h-full rounded-full bg-accent" style={{ width: `${maxRate ? Math.max(3, p.orders_per_1000 / maxRate * 100) : 0}%` }} /></span></div>)}</td>
                  <td className="r">{fmtNum(p.orders_per_1000_30d)}</td>
                  <td className="r">{fmtNum(p.customers_per_100, 2)}</td>
                  <td className="r">{p.streets_total === null ? <span className="text-ink-muted">—</span> : <>{fmtInt(p.streets_with_orders)} <span className="text-ink-muted">von {fmtInt(p.streets_total)}</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted sm:px-5">
          Einwohner und Haushalte: {POPULATION_SOURCE_TEXT}. „—“ bedeutet: keine belegte Angabe, es wird nichts geschätzt. {HOUSEHOLDS_NOTE_TEXT}
          {o.plz.some(p => isLimitedPopulation(p.population)) && <> * {LIMITED_POPULATION_TEXT}</>}{' '}
          Straßen: Straßenverzeichnis aus OpenStreetMap (OpenPLZ-Datensatz, © OpenStreetMap-Mitwirkende, ODbL), nur wenn es für die PLZ vorliegt.
        </p>
      </Card>

      {o.nearby && (
        <Card className="mt-4" pad={false} title="Nachbargebiete ohne Bestellungen"
          lead={`Postleitzahlen bis ${fmtNum(o.nearby.max_km)} km neben Ihren Liefergebieten mit mindestens 1.000 Einwohnern, aus denen bisher nichts bestellt wurde. Ob Sie dorthin liefern können, entscheiden Sie.`}>
          {o.nearby.items.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>PLZ</th><th className="r">Einwohner</th><th className="r">Haushalte</th><th className="r">Entfernung</th><th>nächste eigene PLZ</th></tr></thead>
                <tbody>{o.nearby.items.map(n => (
                  <tr key={n.postal_code}>
                    <td><span className="num">{n.postal_code}</span>{n.city && <span className="ml-2 text-ink-muted">{n.city}</span>}</td>
                    <td className="r">{fmtInt(n.population)}</td>
                    <td className="r">{fmtInt(n.households)}</td>
                    <td className="r">{fmtNum(n.distance_km)} km</td>
                    <td className="num">{n.nearest_own_plz}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : <p className="px-4 pb-4 text-ink-muted sm:px-5">In der Nähe gibt es keine Postleitzahl mit belegter Einwohnerzahl, aus der noch nicht bestellt wurde.</p>}
          <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted sm:px-5">
            Entfernung zwischen den Mittelpunkten der PLZ-Flächen (OpenStreetMap), nicht die Fahrstrecke. Einwohner und Haushalte: Zensus 2022.
          </p>
        </Card>
      )}
    </div>
  )
}
