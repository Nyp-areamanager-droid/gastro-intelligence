'use client'
// Empfehlungen: aus den eigenen Zahlen abgeleitet, mit Beleg und Sicherheit.
import { Card, EmptyState, LoadError, PageHeader, PageSkeleton } from '@/components/ui'
import { RecommendationCard } from '@/components/insights/RecommendationCard'
import { useOverview } from '@/lib/insights/use-overview'

export default function RecommendationsPage() {
  const { data, error, loading, reload } = useOverview()
  if (loading && !data) return <PageSkeleton stats={0} blocks={3} />
  if (error || !data) return <LoadError message={error || 'Keine Antwort'} onRetry={reload} />
  const recs = data.recommendations
  if (data.overview.empty) return (
    <div className="page"><PageHeader title="Empfehlungen" />
      <EmptyState title="Noch keine Empfehlungen" action={{ href: '/uploads', label: 'Datei importieren' }}>Empfehlungen entstehen aus Ihren Bestelldaten. Importieren Sie zuerst eine Datei.</EmptyState></div>
  )
  const actions = recs.filter(r => r.kind !== 'data_gap'), gaps = recs.filter(r => r.kind === 'data_gap')

  return (
    <div className="page max-w-[920px]">
      <PageHeader title="Empfehlungen" lead="Jede Empfehlung nennt, was festgestellt wurde, auf welchen Zahlen das beruht, warum es wichtig ist, was Sie tun können und wie sicher die Aussage ist." />
      {actions.length === 0
        ? <Card><p className="text-ink-soft">Aus den vorhandenen Daten ergibt sich im Moment keine Auffälligkeit, die eine Empfehlung rechtfertigt. Das ist kein Fehler: Empfehlungen erscheinen nur, wenn die Zahlen sie tragen.</p></Card>
        : <div className="space-y-3">{actions.map((r, i) => <RecommendationCard key={r.id} rec={r} defaultOpen={i === 0} />)}</div>}
      {gaps.length > 0 && <div className="mt-6 space-y-3"><h2 className="section-title">Datenlage</h2>{gaps.map(r => <RecommendationCard key={r.id} rec={r} />)}</div>}

      <Card className="mt-6" title="So entstehen die Empfehlungen">
        <ul className="list-disc space-y-1.5 pl-5 text-ink-soft">
          <li>Feste Regeln vergleichen Ihre Gebiete, Straßen und Zeiträume miteinander. Es gibt keine Vorhersagen und keine geschätzten Euro-Beträge.</li>
          <li>Einwohnerzahlen stammen aus dem Zensus 2022, Straßen aus OpenStreetMap (OpenPLZ-Datensatz).</li>
          <li>Zeiträume unterschiedlicher Länge werden je Tag verglichen. Jahreszeit, Feiertage und Wetter kennt die Software nicht.</li>
          <li>Fehlt die Grundlage für eine Aussage, erscheint sie nicht. Welche Grundlagen fehlen, steht unter „Datenlage“.</li>
        </ul>
      </Card>
    </div>
  )
}
