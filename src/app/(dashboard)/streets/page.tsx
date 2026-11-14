'use client'
// Karte und Straßen einer Postleitzahl: Wo wird oft, selten oder gar nicht bestellt?
import { Suspense, useEffect, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { RATING_COLORS, RATING_LABELS, type Rating } from '@/lib/analysis/street-rating'
import { streetNameKey } from '@/lib/geo/street-name'
import { Card, EmptyState, Notice, PageHeader, PageSkeleton, SegmentedControl, Spinner, Stat, fmtEur, fmtInt, fmtNum } from '@/components/ui'
import type { MapStreet } from '@/components/maps/AnalysisMap'

// Leaflet läuft nur im Browser
const AnalysisMap = dynamic(() => import('@/components/maps/AnalysisMap').then(m => ({ default: m.AnalysisMap })), {
  ssr: false, loading: () => <div className="flex h-[420px] items-center justify-center sm:h-[520px]"><Spinner label="Karte wird geladen" /></div>,
})

interface StreetRow { name: string; customers: number; orders: number; revenue: number; streetClass: string; rating: Rating; ratingReason: string }
type Filter = 'all' | 'none' | 'red' | 'orange' | 'green'
interface PlzInfo { postal_code: string; population: number | null; customer_count: number | null; order_count: number | null }

function StreetsView() {
  const params = useSearchParams()
  const [plzList, setPlzList] = useState<PlzInfo[] | null>(null)
  const [selectedPLZ, setSelectedPLZ] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [streets, setStreets] = useState<StreetRow[]>([])
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [population, setPopulation] = useState<number | null>(null)
  // Ohne vollständiges Straßenverzeichnis keine Aussage über Straßen ohne Bestellung
  const [directory, setDirectory] = useState<{ complete: boolean; message: string | null } | null>(null)
  const [ratingSummary, setRatingSummary] = useState('')
  const [selectedStreet, setSelectedStreet] = useState<string | null>(null)

  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) { setPlzList([]); return }
      const { data: analytics } = await supabase.from('analytics').select('postal_code,population,customer_count,order_count,computed_at').eq('company_id', m.company_id).order('computed_at', { ascending: false })
      const unique = new Map<string, PlzInfo>()
      for (const a of analytics || []) if (a.postal_code && !unique.has(a.postal_code)) unique.set(a.postal_code, a as PlzInfo)
      const list = [...unique.values()].sort((a, b) => (b.order_count || 0) - (a.order_count || 0))
      setPlzList(list)
      const wanted = params.get('plz')
      if (list.length) setSelectedPLZ(wanted && unique.has(wanted) ? wanted : list[0].postal_code)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!selectedPLZ) return
    let cancelled = false
    setLoading(true); setLoadError(''); setStreets([]); setDirectory(null); setRatingSummary(''); setSelectedStreet(null); setPopulation(null)
    ;(async () => {
      const q = encodeURIComponent(selectedPLZ)
      const [res, ratingRes] = await Promise.all([fetch(`/api/analysis/plz?plz=${q}`).catch(() => null), fetch(`/api/analysis/streets?plz=${q}`).catch(() => null)])
      if (cancelled) return
      if (!res || !res.ok) { setLoadError('Die Straßendaten konnten nicht geladen werden. Bitte später erneut versuchen.'); setLoading(false); return }
      const data = await res.json()
      const ratingData = ratingRes && ratingRes.ok ? await ratingRes.json().catch(() => null) : null
      const ratingByKey = new Map<string, { rating: Rating; reason: string }>()
      for (const r of (ratingData?.streets || [])) ratingByKey.set(streetNameKey(r.street_name), { rating: r.rating, reason: r.rating_reason })
      const ratingOf = (name: string) => ratingByKey.get(streetNameKey(name)) || { rating: 'none' as Rating, reason: 'Nicht bewertbar: keine Daten.' }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const row = (s: any, zero: boolean): StreetRow => ({
        name: s.street_name, customers: zero ? 0 : s.customer_count, orders: zero ? 0 : s.order_count, revenue: zero ? 0 : Number(s.revenue),
        streetClass: zero ? 'E' : (s.street_class || '—'), rating: ratingOf(s.street_name).rating, ratingReason: ratingOf(s.street_name).reason,
      })
      if (cancelled) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setStreets([...(data.streets?.with_orders || []).map((s: any) => row(s, false)), ...(data.streets?.without_orders || []).map((s: any) => row(s, true))])
      setDirectory(data.streets?.directory || null)
      setRatingSummary(ratingData?.rating?.summary || '')
      setPopulation(data.analysis?.population ?? null)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [selectedPLZ])

  const mapStreets: MapStreet[] = useMemo(() => streets.map(s => ({ street_name: s.name, customer_count: s.customers, order_count: s.orders, revenue: s.revenue, street_class: s.streetClass, rating: s.rating, rating_reason: s.ratingReason })), [streets])
  const counts = useMemo(() => ({ none: streets.filter(s => s.orders === 0).length, red: streets.filter(s => s.rating === 'red').length, orange: streets.filter(s => s.rating === 'orange').length, green: streets.filter(s => s.rating === 'green').length }), [streets])
  const filtered = streets.filter(s => {
    if (filter === 'none' && s.orders > 0) return false
    if ((filter === 'red' || filter === 'orange' || filter === 'green') && s.rating !== filter) return false
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })
  const totalOrders = streets.reduce((s, x) => s + x.orders, 0), totalRevenue = streets.reduce((s, x) => s + x.revenue, 0)
  const withOrders = streets.length - counts.none

  if (plzList === null) return <PageSkeleton />
  if (plzList.length === 0) return (
    <div className="page"><PageHeader title="Karte und Straßen" />
      <EmptyState title="Noch keine Liefergebiete" action={{ href: '/uploads', label: 'Datei importieren' }}>Sobald Sie Bestelldaten importiert haben, sehen Sie hier jede Postleitzahl mit ihren Straßen auf der Karte.</EmptyState>
    </div>
  )

  return (
    <div className="page">
      <PageHeader title="Karte und Straßen" lead="Aus welchen Straßen wird oft bestellt, aus welchen selten und aus welchen gar nicht? Jede Straße wird mit dem Durchschnitt ihrer Postleitzahl verglichen."
        actions={
          <label className="flex items-center gap-2 text-[13px] text-ink-muted">Postleitzahl
            <select className="input h-9 w-auto num" value={selectedPLZ} onChange={e => setSelectedPLZ(e.target.value)}>
              {plzList.map(p => <option key={p.postal_code} value={p.postal_code}>{p.postal_code} · {fmtInt(p.order_count)} Bestellungen</option>)}
            </select>
          </label>} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Bestellungen" value={fmtInt(totalOrders)} sub={`${fmtEur(totalRevenue)} Umsatz`} />
        <Stat label="Straßen mit Bestellung" value={fmtInt(withOrders)} sub={directory?.complete ? `von ${fmtInt(streets.length)} Straßen im Verzeichnis` : 'Verzeichnis unvollständig'}
          help="Straßen dieser PLZ, aus denen im Datenzeitraum mindestens eine Bestellung kam." />
        <Stat label="Straßen ohne Bestellung" value={directory?.complete ? fmtInt(counts.none) : '—'} sub={directory?.complete ? 'laut Straßenverzeichnis (OpenStreetMap)' : 'nur mit vollständigem Verzeichnis bestimmbar'}
          help="Nur wenn das Straßenverzeichnis (OpenPLZ) vollständig vorliegt. Sonst bleibt das Feld leer – es wird nie „0“ angenommen." />
        <Stat label="Einwohner" value={fmtInt(population)} sub={population ? `${fmtNum(totalOrders / population * 1000)} Bestellungen je 1.000` : 'keine belegte Zahl (Zensus 2022)'}
          help="Einwohnerzahl nur aus dem Zensus 2022. Ohne belegte Zahl bleibt das Feld leer." />
      </div>

      {directory && !directory.complete && (
        <div className="mt-3"><Notice tone="warn" title="Straßenverzeichnis fehlt oder ist unvollständig">
          Angezeigt werden nur Straßen mit Bestellungen. Straßen ohne Bestellung lassen sich erst benennen, wenn die vollständige Liste vorliegt.{directory.message ? ` ${directory.message}` : ''}
        </Notice></div>
      )}
      {loadError && <div className="mt-3"><Notice tone="bad">{loadError}</Notice></div>}

      <Card className="mt-4 overflow-hidden" pad={false} title={`Karte der PLZ ${selectedPLZ}`} lead="Eine Straße anklicken zeigt ihre Zahlen und die Begründung der Bewertung.">
        <div className="pt-3"><AnalysisMap plz={selectedPLZ || undefined} streets={loading ? undefined : mapStreets} selectedStreet={selectedStreet} onSelectStreet={setSelectedStreet} /></div>
      </Card>

      <Card className="mt-4" pad={false} title={`Straßen in ${selectedPLZ}`} lead={ratingSummary || 'Bewertung: Vergleich jeder Straße mit dem Durchschnitt dieser Postleitzahl.'}
        actions={
          <div className="relative w-full sm:w-64">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden />
            <input className="input h-9 pl-9" placeholder="Straße suchen" aria-label="Straße suchen" value={search} onChange={e => setSearch(e.target.value)} />
          </div>}>
        <div className="px-4 pb-3 sm:px-5">
          <SegmentedControl<Filter> label="Straßen filtern" value={filter} onChange={setFilter} options={[
            { value: 'all', label: `Alle (${streets.length})` }, { value: 'green', label: `Grün (${counts.green})` }, { value: 'orange', label: `Orange (${counts.orange})` },
            { value: 'red', label: `Rot (${counts.red})` }, { value: 'none', label: `Ohne Bestellung (${directory?.complete ? counts.none : '—'})` }]} />
        </div>
        {loading ? <div className="flex justify-center py-12"><Spinner label="Straßen werden geladen" /></div> : (
          <div className="table-wrap max-h-[560px] overflow-y-auto">
            <table className="table">
              <thead className="sticky top-0 z-10"><tr><th>Straße</th><th>Bewertung</th><th className="r">Bestellungen</th><th className="r">Kunden</th><th className="r">Umsatz</th></tr></thead>
              <tbody>
                {filtered.length === 0 && <tr><td colSpan={5} className="py-10 text-center text-ink-muted">Keine Straße passt zu Suche und Filter.</td></tr>}
                {filtered.slice(0, 500).map(s => {
                  const open = selectedStreet !== null && streetNameKey(selectedStreet) === streetNameKey(s.name)
                  return (
                    <tr key={s.name} onClick={() => setSelectedStreet(open ? null : s.name)} className="cursor-pointer" aria-selected={open}>
                      <td className={open ? 'bg-accent-soft/60' : ''}>
                        <button type="button" className="text-left font-medium text-ink hover:text-accent">{s.name}</button>
                        {open && <div className="mt-1 max-w-[70ch] text-[12.5px] font-normal text-ink-soft">{s.ratingReason}</div>}
                      </td>
                      <td className={open ? 'bg-accent-soft/60' : ''}><span className="inline-flex items-center gap-2 whitespace-nowrap"><span className="dot" style={{ background: RATING_COLORS[s.rating] }} aria-hidden />{RATING_LABELS[s.rating]}</span></td>
                      <td className={`r ${open ? 'bg-accent-soft/60' : ''}`}>{fmtInt(s.orders)}</td>
                      <td className={`r ${open ? 'bg-accent-soft/60' : ''}`}>{s.customers ? fmtInt(s.customers) : '—'}</td>
                      <td className={`r ${open ? 'bg-accent-soft/60' : ''}`}>{s.revenue > 0 ? fmtEur(s.revenue) : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {filtered.length > 500 && <div className="py-3 text-center text-[12.5px] text-ink-muted">{fmtInt(filtered.length - 500)} weitere Straßen – bitte die Suche eingrenzen.</div>}
          </div>
        )}
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted sm:px-5">
          Grün: mindestens Durchschnitt. Orange: halber bis knapp Durchschnitt. Rot: unter dem halben Durchschnitt. Fehlen Daten, gilt eine Straße als „nicht bewertbar“ und wird nie rot.
          Straßenverzeichnis: OpenPLZ. Karte und Hausadressen: © OpenStreetMap-Mitwirkende (ODbL).
        </p>
      </Card>
    </div>
  )
}

export default function StreetsPage() {
  return <Suspense fallback={<PageSkeleton />}><StreetsView /></Suspense>
}
