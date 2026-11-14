'use client'
// Karte einer Postleitzahl: Fläche, Straßen (eingefärbt), Wettbewerber, Firmenkunden.
// Datenquelle für Geometrie: OpenStreetMap über /api/geo/plz-map. Straßen, die
// über die PLZ-Grenze hinausgehen, kommen vom Server bereits abgeschnitten.
//
// Aufbau: (1) Karte einmal anlegen, (2) Daten je PLZ laden, (3) Ebenen neu
// zeichnen, wenn sich Daten, Darstellung oder Auswahl ändern.
import { useEffect, useMemo, useRef, useState } from 'react'
import { normalizeStreetName, streetNameKey } from '@/lib/geo/street-name'
import { RATING_COLORS, RATING_LABELS, type Rating } from '@/lib/analysis/street-rating'
import { escapeHtml, poiPopupHtml } from '@/lib/security/html'
import { SegmentedControl, Spinner } from '@/components/ui'
import { INTENSITY, intensityBreaks, intensityStep } from '@/lib/geo/map-scale'

export interface MapStreet {
  street_name: string
  customer_count: number
  order_count: number
  revenue: number
  street_class?: string | null
  rating?: Rating
  rating_reason?: string
}
export type MapMode = 'rating' | 'orders' | 'revenue'

interface MapProps {
  plz?: string
  /** Straßenzahlen der Seite. Fehlen sie, lädt die Karte sie selbst. */
  streets?: MapStreet[]
  selectedStreet?: string | null
  onSelectStreet?: (name: string) => void
  showCompetitors?: boolean
  showB2B?: boolean
}

interface GeoData {
  status: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  boundary: any
  bbox: [number, number, number, number] | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  streets: any[]
  address_counts: Record<string, number>
  address_total: number
  source: { attribution: string; fetched_at: string }
  cached?: boolean
}
interface Poi { id?: string; name: string; category: string; is_competitor: boolean; lat: number; lng: number }

const COLOR_ZERO = '#B4BCC6', COLOR_NODATA = '#9AA3AE', COLOR_COMPETITOR = '#6D4FD8', COLOR_B2B = '#2F7FC1', COLOR_BOUNDARY = '#17212B'

export function AnalysisMap({ plz, streets, selectedStreet, onSelectStreet, showCompetitors = true, showB2B = true }: MapProps) {
  const boxRef = useRef<HTMLDivElement>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const L = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const map = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const layers = useRef<{ boundary: any; streets: any; pois: any } | null>(null)
  const onSelectRef = useRef(onSelectStreet); onSelectRef.current = onSelectStreet

  const [ready, setReady] = useState(false)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const [geo, setGeo] = useState<GeoData | null>(null)
  const [pois, setPois] = useState<Poi[]>([])
  const [ownStreets, setOwnStreets] = useState<MapStreet[] | null>(null)
  const [mode, setMode] = useState<MapMode>('rating')
  const [show, setShow] = useState({ boundary: true, competitors: showCompetitors, b2b: showB2B })

  const streetData = useMemo(() => streets ?? ownStreets ?? [], [streets, ownStreets])
  const lookup = useMemo(() => {
    const m = new Map<string, MapStreet>()
    for (const s of streetData) {
      m.set(streetNameKey(s.street_name), s)
      const legacy = normalizeStreetName(s.street_name)       // ältere Analysen: Name mit Hausnummer
      if (!m.has(legacy)) m.set(legacy, s)
    }
    return m
  }, [streetData])
  const breaks = useMemo(() => intensityBreaks(streetData.map(s => mode === 'revenue' ? Number(s.revenue) : s.order_count)), [streetData, mode])

  // ── 1. Karte einmal anlegen ─────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const leaflet = (await import('leaflet')).default
      // Schutz gegen doppeltes Anlegen (wenn die Seite zweimal kurz
      // hintereinander eingehängt wird, meldete Leaflet früher
      // „Map container is already initialized“)
      if (cancelled || !boxRef.current || map.current) return
      L.current = leaflet
      const m = leaflet.map(boxRef.current, { center: [51.1634, 10.4477], zoom: 6, zoomControl: true, attributionControl: true })
      leaflet.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>-Mitwirkende', maxZoom: 19 }).addTo(m)
      layers.current = { boundary: leaflet.layerGroup().addTo(m), streets: leaflet.layerGroup().addTo(m), pois: leaflet.layerGroup().addTo(m) }
      map.current = m
      setReady(true)
    })()
    return () => {
      cancelled = true
      if (map.current) { map.current.remove(); map.current = null; layers.current = null }
      setReady(false)
    }
  }, [])

  // ── 2. Daten je PLZ laden ───────────────────────────────────────────────────
  useEffect(() => {
    if (!plz) return
    let cancelled = false
    setLoading(true); setNotice(''); setGeo(null); setPois([]); setOwnStreets(null)
    ;(async () => {
      const q = encodeURIComponent(plz)
      const [geoRes, poiRes, streetRes] = await Promise.all([
        fetch(`/api/geo/plz-map?plz=${q}`).catch(() => null),
        fetch(`/api/providers/osm?plz=${q}`).catch(() => null),
        streets ? Promise.resolve(null) : fetch(`/api/analysis/streets?plz=${q}`).catch(() => null),
      ])
      if (cancelled) return
      const g = geoRes ? await geoRes.json().catch(() => null) : null
      if (!geoRes || !geoRes.ok || !g) setNotice(g?.error || 'Die Straßenkarte konnte gerade nicht geladen werden. Die Tabelle darunter ist davon nicht betroffen.')
      else if (g.status !== 'ok') setNotice(`Für PLZ ${plz} ist in OpenStreetMap keine Fläche erfasst. Die Karte zeigt deshalb keine Straßen. Die Tabelle ist davon nicht betroffen.`)
      else setGeo(g)
      if (poiRes && poiRes.ok) { const p = await poiRes.json().catch(() => null); if (!cancelled) setPois(p?.pois || []) }
      if (streetRes && streetRes.ok) { const s = await streetRes.json().catch(() => null); if (!cancelled) setOwnStreets(s?.streets || []) }
      if (!cancelled) setLoading(false)
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plz])

  // ── 3a. Ausschnitt auf die PLZ ──────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !map.current || !geo?.bbox) return
    const [w, s, e, n] = geo.bbox
    map.current.invalidateSize()
    map.current.fitBounds([[s, w], [n, e]], { padding: [16, 16] })
  }, [ready, geo])

  // ── 3b. Ebenen zeichnen ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!ready || !layers.current || !L.current) return
    const leaflet = L.current, lg = layers.current
    lg.boundary.clearLayers(); lg.streets.clearLayers(); lg.pois.clearLayers()
    if (!geo) return
    const selectedKey = selectedStreet ? streetNameKey(selectedStreet) : null

    if (show.boundary && geo.boundary) {
      leaflet.geoJSON(geo.boundary, { style: { color: COLOR_BOUNDARY, weight: 1.5, opacity: 0.7, dashArray: '5 4', fillColor: '#1F4B99', fillOpacity: 0.03 }, interactive: false }).addTo(lg.boundary)
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const styleOf = (feature: any) => {
      const key = feature.properties?.key || streetNameKey(feature.properties?.name || '')
      const entry = lookup.get(key)
      const selected = selectedKey !== null && key === selectedKey
      // Keine Zahlen zu dieser Straße: dünn gestrichelt (nicht „schwach“)
      if (!entry) return { color: COLOR_NODATA, weight: selected ? 5 : 1.25, opacity: selected ? 1 : 0.7, dashArray: '2 5' }
      if (mode === 'rating') {
        const rating = (entry.rating || 'none') as Rating
        return rating === 'none'
          ? { color: RATING_COLORS.none, weight: selected ? 6 : 2.5, opacity: 0.9, dashArray: '7 5' }
          : { color: RATING_COLORS[rating], weight: selected ? 7 : 3.5, opacity: 1 }
      }
      const value = mode === 'revenue' ? Number(entry.revenue) : entry.order_count
      if (!(value > 0)) return { color: COLOR_ZERO, weight: selected ? 6 : 2.5, opacity: 1 }
      return { color: INTENSITY[intensityStep(value, breaks)], weight: selected ? 7 : 3.5, opacity: 1 }
    }
    // weißer Unterzug, damit die Farben auf der Karte lesbar bleiben
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    leaflet.geoJSON({ type: 'FeatureCollection', features: geo.streets } as any, { style: (f: any) => ({ color: '#FFFFFF', weight: (styleOf(f).weight as number) + 2.5, opacity: lookup.has(f.properties?.key) ? 0.9 : 0 }), interactive: false }).addTo(lg.streets)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    leaflet.geoJSON({ type: 'FeatureCollection', features: geo.streets } as any, {
      style: styleOf,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      onEachFeature: (feature: any, layer: any) => {
        const p = feature.properties || {}
        const key = p.key || streetNameKey(p.name || '')
        const entry = lookup.get(key)
        const addresses = geo.address_counts?.[key]
        const row = (label: string, value: string) => `<tr><td style="color:#687380;padding:1px 12px 1px 0">${label}</td><td style="text-align:right;font-variant-numeric:tabular-nums">${value}</td></tr>`
        let html = `<div style="font-weight:600;font-size:14px">${escapeHtml(p.name || '(ohne Namen)')}</div><div style="color:#687380;font-size:12px">PLZ ${escapeHtml(plz)}</div>`
        if (entry) {
          const rating = (entry.rating || 'none') as Rating
          html += `<table style="margin-top:8px;font-size:13px;border-collapse:collapse;width:100%">` +
            row('Bestellungen', escapeHtml(Number(entry.order_count).toLocaleString('de-DE'))) +
            row('Umsatz', escapeHtml(Number(entry.revenue).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) + ' €') +
            row('Kunden', escapeHtml(Number(entry.customer_count).toLocaleString('de-DE'))) +
            (addresses ? row('Hausadressen', escapeHtml(addresses.toLocaleString('de-DE'))) : '') + `</table>` +
            `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #E2E6EB;font-size:12.5px"><span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${RATING_COLORS[rating]};margin-right:6px"></span><b>${RATING_LABELS[rating]}</b>` +
            `<div style="color:#45515E;margin-top:3px">${escapeHtml(entry.rating_reason || '')}</div></div>`
        } else {
          html += `<div style="margin-top:8px;color:#45515E;font-size:12.5px">Zu dieser Straße liegen keine Zahlen vor. Das heißt nicht „0 Bestellungen“.</div>` + (addresses ? `<div style="margin-top:4px;color:#687380;font-size:12.5px">${escapeHtml(addresses.toLocaleString('de-DE'))} Hausadressen laut OpenStreetMap</div>` : '')
        }
        if (p.partial) html += `<div style="margin-top:8px;color:#A85C08;font-size:12px">Die Straße verläuft auch durch andere PLZ. Gezeigt und bewertet wird nur der Abschnitt in ${escapeHtml(plz)}.</div>`
        layer.bindPopup(html, { maxWidth: 290 })
        layer.on('click', () => onSelectRef.current?.(p.name || ''))
      },
    }).addTo(lg.streets)

    for (const poi of pois) {
      if (poi.is_competitor ? !show.competitors : !show.b2b) continue
      leaflet.circleMarker([poi.lat, poi.lng], { radius: 6, color: '#FFFFFF', weight: 2, fillColor: poi.is_competitor ? COLOR_COMPETITOR : COLOR_B2B, fillOpacity: 1 })
        .bindPopup(poiPopupHtml(poi)).addTo(lg.pois)
    }
  }, [ready, geo, pois, lookup, mode, breaks, show, selectedStreet, plz])

  const competitors = pois.filter(p => p.is_competitor).length, b2b = pois.length - competitors
  const fmt = (n: number) => mode === 'revenue' ? Math.round(n).toLocaleString('de-DE') + ' €' : Math.round(n).toLocaleString('de-DE')
  const toggle = (key: keyof typeof show, label: string, color: string, count?: number) => (
    <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-ink-soft">
      <input type="checkbox" checked={show[key]} onChange={e => setShow(s => ({ ...s, [key]: e.target.checked }))} className="h-4 w-4 accent-[#1F4B99]" />
      <span className="dot" style={{ background: color }} aria-hidden />{label}{count !== undefined && <span className="num text-ink-muted">({count})</span>}
    </label>
  )

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-4 pb-3 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-ink-muted">Straßen einfärben nach</span>
          <SegmentedControl<MapMode> label="Straßen einfärben nach" value={mode} onChange={setMode} options={[{ value: 'rating', label: 'Bewertung' }, { value: 'orders', label: 'Bestellungen' }, { value: 'revenue', label: 'Umsatz' }]} />
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {toggle('boundary', 'PLZ-Grenze', COLOR_BOUNDARY)}
          {toggle('competitors', 'Wettbewerber', COLOR_COMPETITOR, competitors)}
          {toggle('b2b', 'Firmenkunden', COLOR_B2B, b2b)}
        </div>
      </div>

      <div className="relative">
        <div ref={boxRef} className="h-[420px] w-full sm:h-[520px]" style={{ borderRadius: 0 }} aria-label={plz ? `Karte der PLZ ${plz}` : 'Karte'} />
        {(loading || !ready) && <div className="absolute inset-0 z-[500] flex items-center justify-center bg-surface/70"><Spinner label="Karte wird geladen" /></div>}
        {notice && <div role="status" className="notice notice-warn absolute left-3 right-3 top-3 z-[500] shadow-raise sm:left-14">{notice}</div>}
      </div>

      <div className="flex flex-wrap items-start gap-x-8 gap-y-3 border-t border-line px-4 py-3 text-[12.5px] text-ink-soft sm:px-5">
        {mode === 'rating' ? (
          <ul className="flex flex-wrap gap-x-5 gap-y-1.5">
            {([['green', 'mindestens Durchschnitt der PLZ'], ['orange', 'halber bis knapp Durchschnitt'], ['red', 'unter dem halben Durchschnitt'], ['none', 'zu wenig Daten für einen Vergleich']] as [Rating, string][]).map(([r, text]) => (
              <li key={r} className="inline-flex items-center gap-2"><span className="h-1 w-5 rounded-full" style={{ background: RATING_COLORS[r] }} aria-hidden /><b className="font-medium text-ink">{RATING_LABELS[r]}</b> {text}</li>
            ))}
          </ul>
        ) : (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <span className="inline-flex items-center gap-2"><span className="h-1 w-5 rounded-full" style={{ background: COLOR_ZERO }} aria-hidden />keine {mode === 'revenue' ? 'Umsätze' : 'Bestellungen'}</span>
            {breaks.length > 0 && INTENSITY.map((color, i) => (
              <span key={color} className="num inline-flex items-center gap-2"><span className="h-1 w-5 rounded-full" style={{ background: color }} aria-hidden />
                {i === 0 ? `unter ${fmt(breaks[0])}` : i === INTENSITY.length - 1 ? `ab ${fmt(breaks[i - 1])}` : `${fmt(breaks[i - 1])} bis unter ${fmt(breaks[i])}`}</span>
            ))}
            <span className="text-ink-muted">Je Stufe etwa gleich viele Straßen.</span>
          </div>
        )}
        <span className="inline-flex items-center gap-2"><span className="w-5 border-t-2 border-dotted" style={{ borderColor: COLOR_NODATA }} aria-hidden />keine Zahlen (nicht „schwach“)</span>
      </div>
      {geo && (
        <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted sm:px-5">
          Straßen, PLZ-Fläche und Hausadressen: {geo.source.attribution} (ODbL), abgerufen am {new Date(geo.source.fetched_at).toLocaleDateString('de-DE')}.
          {' '}{geo.streets.length.toLocaleString('de-DE')} benannte Straßen, {geo.address_total.toLocaleString('de-DE')} Hausadressen. Hausadressen sind keine Haushalte.
        </p>
      )}
    </div>
  )
}
