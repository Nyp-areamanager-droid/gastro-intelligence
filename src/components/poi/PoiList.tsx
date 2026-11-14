'use client'
// Wettbewerber und B2B-Ziele – nur in den eigenen PLZ, mit Quelle und Stand.
// Früher zeigten beide Seiten 100 beliebige Einträge aus dem gemeinsamen
// Verzeichnis aller Firmen, ohne Bezug zu den eigenen Liefergebieten.
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { Card, EmptyState, Notice, PageHeader, PageSkeleton } from '@/components/ui'

type Mode = 'competitor' | 'b2b'

export const B2B_CATEGORIES = ['hotel', 'school', 'hospital', 'office', 'authority']
const CATEGORY_LABELS: Record<string, string> = {
  restaurant: 'Gastronomie', hotel: 'Hotel', school: 'Schule/Kita/Hochschule', hospital: 'Klinik/Arztpraxis',
  office: 'Büro/Firma', authority: 'Behörde', fitness: 'Fitness', supermarket: 'Supermarkt', other: 'Sonstiges',
}

const TEXT: Record<Mode, { title: string; subtitle: string; method: string; empty: string }> = {
  competitor: {
    title: 'Wettbewerber',
    subtitle: 'Gastronomie-Betriebe in Ihren Postleitzahlen',
    method: 'Erkennung: Restaurants und Imbisse laut OpenStreetMap, deren Name oder Küche Stichworte wie Pizza, Burger, Döner, Sushi enthält. Das passt nur für Lieferdienste der Gastronomie. Für andere Branchen (z. B. Getränke- oder Lebensmittellieferung, Onlinehandel) gibt es noch keine Wettbewerber-Erkennung. Lieferplattformen und reine Lieferküchen ohne Eintrag in OpenStreetMap fehlen.',
    empty: 'In OpenStreetMap ist für diese PLZ kein passender Betrieb erfasst.',
  },
  b2b: {
    title: 'Firmenkunden',
    subtitle: 'Hotels, Schulen, Kliniken, Behörden und Büros in Ihren Postleitzahlen',
    method: 'Quelle: Einträge in OpenStreetMap. Wie vollständig sie sind, hängt davon ab, wie gut die Gegend dort erfasst ist; Firmen ohne Eintrag fehlen. Es gibt keine Angaben zu Mitarbeiterzahlen oder Bedarf.',
    empty: 'In OpenStreetMap ist für diese PLZ kein passender Eintrag erfasst.',
  },
}

interface Poi { id: string; postal_code: string; name: string; category: string; is_competitor: boolean; last_fetched_at: string | null; data_source: string }

export function PoiList({ mode }: { mode: Mode }) {
  const supabase = createClient()
  const [plzList, setPlzList] = useState<string[]>([])
  const [pois, setPois] = useState<Poi[]>([])
  const [loadedPlz, setLoadedPlz] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [messages, setMessages] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) { setLoading(false); return }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
    if (!m) { setLoading(false); return }
    const { data: analytics } = await supabase.from('analytics').select('postal_code, customer_count').eq('company_id', m.company_id).order('customer_count', { ascending: false })
    const plz = [...new Set((analytics || []).map(a => a.postal_code as string))]
    setPlzList(plz)
    if (plz.length) {
      const { data } = await fetchAllRows((from, to) =>
        supabase.from('poi_businesses').select('id, postal_code, name, category, is_competitor, last_fetched_at, data_source', { count: 'exact' })
          .in('postal_code', plz).order('id').range(from, to))
      const all = (data || []) as Poi[]
      // „geladen“ = für diese PLZ gibt es überhaupt Einträge (alle Kategorien)
      setLoadedPlz(new Set(all.map(p => p.postal_code)))
      setPois(all.filter(p => mode === 'competitor' ? p.is_competitor : B2B_CATEGORIES.includes(p.category)))
    }
    setLoading(false)
  }, [mode])

  useEffect(() => { load() }, [load])

  async function fetchPlz(plz: string) {
    setBusy(plz)
    try {
      const res = await fetch(`/api/providers/osm?plz=${plz}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) setMessages(m => ({ ...m, [plz]: data.error || 'Laden fehlgeschlagen.' }))
      else if (!data.count) setMessages(m => ({ ...m, [plz]: data.warning || 'OpenStreetMap hat nichts geliefert (keine Einträge oder Dienst nicht erreichbar). Bitte später erneut versuchen.' }))
      else setMessages(m => ({ ...m, [plz]: '' }))
      await load()
    } finally {
      setBusy(null)
    }
  }

  const t = TEXT[mode]
  if (loading) return <PageSkeleton stats={0} blocks={2} />

  return (
    <div className="page max-w-[980px]">
      <PageHeader title={t.title} lead={t.subtitle} />
      <Notice tone="info" title="So entsteht diese Liste">{t.method}</Notice>

      {plzList.length === 0 ? (
        <div className="mt-6"><EmptyState title="Noch keine eigenen Liefergebiete" action={{ href: '/uploads', label: 'Datei importieren' }}>Die Liste zeigt Einträge in den Postleitzahlen, aus denen bei Ihnen bestellt wurde.</EmptyState></div>
      ) : plzList.map(plz => {
        const items = pois.filter(p => p.postal_code === plz)
        const fetched = items.concat().sort((a, b) => (b.last_fetched_at || '').localeCompare(a.last_fetched_at || ''))[0]?.last_fetched_at
        return (
          <Card key={plz} className="mt-4" pad={false}
            title={<>PLZ <span className="num">{plz}</span></>}
            lead={loadedPlz.has(plz)
              ? `${items.length} ${items.length === 1 ? 'Eintrag' : 'Einträge'} · OpenStreetMap${fetched ? ` · Stand ${new Date(fetched).toLocaleDateString('de-DE')}` : ''}`
              : 'Für diese Postleitzahl wurden noch keine Daten abgerufen.'}
            actions={<button className="btn-secondary btn-sm" disabled={busy !== null} onClick={() => fetchPlz(plz)}>
              {busy === plz ? 'Wird abgerufen …' : loadedPlz.has(plz) ? 'Aktualisieren' : 'Daten abrufen'}
            </button>}>
            {messages[plz] && <div className="px-4 pb-3 sm:px-5"><Notice tone="warn">{messages[plz]}</Notice></div>}
            {loadedPlz.has(plz) && items.length === 0 && <p className="px-4 pb-4 text-ink-soft sm:px-5">{t.empty}</p>}
            {items.length > 0 && (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Name</th><th>Art</th></tr></thead>
                  <tbody>{items.map(p => <tr key={p.id}><td className="font-medium">{p.name}</td><td className="text-ink-soft">{CATEGORY_LABELS[p.category] || p.category}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </Card>
        )
      })}
      <p className="mt-6 text-[12.5px] text-ink-muted">Daten © OpenStreetMap-Mitwirkende (ODbL)</p>
    </div>
  )
}
