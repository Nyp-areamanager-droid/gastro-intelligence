'use client'
// Wettbewerber und B2B-Ziele – nur in den eigenen PLZ, mit Quelle und Stand.
// Früher zeigten beide Seiten 100 beliebige Einträge aus dem gemeinsamen
// Verzeichnis aller Firmen, ohne Bezug zu den eigenen Liefergebieten.
import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

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
    title: 'B2B-Potenzial',
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
  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin" /></div>

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">{t.title}</h1>
      <p className="text-[#8a9bb5] text-sm mb-3">{t.subtitle}</p>
      <div className="text-xs text-[#8a9bb5] bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-3 mb-6">{t.method}</div>

      {plzList.length === 0 ? (
        <div className="text-center py-16 text-[#4a5a70]">Noch keine eigenen PLZ – bitte zuerst eine Datei hochladen.</div>
      ) : plzList.map(plz => {
        const items = pois.filter(p => p.postal_code === plz)
        const fetched = items.concat().sort((a, b) => (b.last_fetched_at || '').localeCompare(a.last_fetched_at || ''))[0]?.last_fetched_at
        return (
          <section key={plz} className="mb-6">
            <div className="flex items-center gap-3 mb-2 flex-wrap">
              <h2 className="font-semibold">PLZ {plz}</h2>
              {loadedPlz.has(plz)
                ? <span className="text-xs text-[#4a5a70]">{items.length} Einträge · OpenStreetMap{fetched ? ` · Stand ${new Date(fetched).toLocaleDateString('de-DE')}` : ''}</span>
                : <span className="text-xs text-amber-300">Noch keine Daten geladen</span>}
              <button className="btn-ghost text-xs ml-auto" disabled={busy !== null} onClick={() => fetchPlz(plz)}>
                {busy === plz ? 'Lädt …' : loadedPlz.has(plz) ? 'Neu laden' : 'Daten laden'}
              </button>
            </div>
            {messages[plz] && <div className="text-xs text-amber-300 mb-2">{messages[plz]}</div>}
            {loadedPlz.has(plz) && items.length === 0 && <div className="text-xs text-[#4a5a70]">{t.empty}</div>}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {items.map(p => (
                <div key={p.id} className="bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-4">
                  <div className="font-semibold text-sm mb-1">{p.name}</div>
                  <div className="text-xs text-[#8a9bb5]">{CATEGORY_LABELS[p.category] || p.category}</div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
      <p className="text-[11px] text-[#4a5a70] mt-6">Daten © OpenStreetMap-Mitwirkende (ODbL)</p>
    </div>
  )
}
