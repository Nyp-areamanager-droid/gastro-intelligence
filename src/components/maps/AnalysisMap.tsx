'use client'

import { useEffect, useRef, useState } from 'react'
import { normalizeStreetName, streetNameKey } from '@/lib/geo/street-name'
import { RATING_COLORS, RATING_LABELS, type Rating } from '@/lib/analysis/street-rating'

const escapeHtml = (t: string) => t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

// Typen nur im Client
interface MapMarkerData {
  id: string
  lat: number
  lng: number
  type: string
  label: string
  color: string
  popup?: string
}

interface StreetAnalyticsEntry {
  street_name: string
  customer_count: number
  order_count: number
  revenue: number
  avg_order_value: number
  orders_per_customer: number
  street_class: 'A' | 'B' | 'C' | 'D' | 'E' | null
  is_in_official_list: boolean | null
  rating?: Rating
  rating_reason?: string
}

interface MapProps {
  center?: [number, number]
  zoom?: number
  markers?: MapMarkerData[]
  plz?: string
  companyId?: string          // Optional: aktiviert street_analytics-Färbung
  showStreets?: boolean
  showCompetitors?: boolean
  showB2B?: boolean
  showStreetLayer?: boolean   // Neue Option: Straßen-GeoJSON einblenden
  showPlzBoundaries?: boolean // Neue Option: PLZ-Grenzen einblenden
}

// Gleicher Vergleichsschlüssel wie Straßenverzeichnis (Kartennamen haben
// keine Hausnummer, "Weg 2" bleibt "weg2")
const normalizeForLookup = streetNameKey

// Straßenfarbe je highway-Typ (identisch mit Vorschaukarte)
function streetColor(highway: string): string {
  if (highway === 'motorway' || highway === 'motorway_link') return '#f97316'
  if (highway === 'trunk' || highway === 'trunk_link') return '#f59e0b'
  if (highway === 'primary' || highway === 'primary_link') return '#eab308'
  if (highway === 'secondary' || highway === 'secondary_link') return '#3b82f6'
  if (highway === 'tertiary' || highway === 'tertiary_link') return '#6366f1'
  if (highway === 'residential') return '#4b6fa8'
  if (highway === 'service') return '#374f70'
  return '#334155'
}

const CATEGORY_COLORS: Record<string, string> = {
  customer:    '#00d084',
  strong:      '#00d084',
  medium:      '#f5a623',
  weak:        '#e63027',
  none:        '#4a5a70',
  competitor:  '#7c6dfa',
  hotel:       '#2e86c1',
  school:      '#f5c518',
  hospital:    '#e63027',
  authority:   '#00b4d8',
  office:      '#2e86c1',
  fitness:     '#00d084',
  b2b:         '#2e86c1',
}

const CATEGORY_ICONS: Record<string, string> = {
  competitor: '🍕',
  hotel:      '🏨',
  school:     '🏫',
  hospital:   '🏥',
  authority:  '🏛️',
  office:     '🏢',
  fitness:    '💪',
  customer:   '👤',
}

export function AnalysisMap({
  center = [51.1634, 10.4477], // Mitte Deutschlands; mit PLZ wird auf deren Fläche gezoomt
  zoom = 6,
  markers = [],
  plz,
  companyId,
  showStreets = true,
  showCompetitors = true,
  showB2B = true,
  showStreetLayer = false,
  showPlzBoundaries = false,
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [poiData, setPoiData] = useState<Record<string, unknown>[]>([])
  const [streetAnalytics, setStreetAnalytics] = useState<Map<string, StreetAnalyticsEntry>>(new Map())
  const [error, setError] = useState<string>('')
  const [mapNotice, setMapNotice] = useState<string>('')
  const [ratingSummary, setRatingSummary] = useState<string>('')

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return
    setMapNotice('')
    setRatingSummary('')

    // Leaflet dynamisch laden (kein SSR)
    async function initMap() {
      const L = (await import('leaflet')).default
      // CSS wird über globale styles geladen

      // Fix für Default-Icons
      delete (L.Icon.Default.prototype as unknown as Record<string,unknown>)._getIconUrl
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon-2x.png',
        iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-icon.png',
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
      })

      const map = L.map(mapRef.current!, { center, zoom, zoomControl: true })
      mapInstanceRef.current = map

      // OpenStreetMap Tiles
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map)

      // Straßendaten mit Ampel laden (wenn plz + showStreetLayer aktiv).
      // Lokale Variable statt React-State: Die Farben werden weiter unten in
      // derselben Funktion gesetzt; der State wäre dort noch leer.
      const streetLookup = new Map<string, StreetAnalyticsEntry>()
      if (plz && showStreetLayer) {
        try {
          const saRes = await fetch(`/api/analysis/streets?plz=${plz}`)
          if (saRes.ok) {
            const saData = await saRes.json()
            for (const s of (saData.streets || []) as StreetAnalyticsEntry[]) {
              streetLookup.set(normalizeForLookup(s.street_name), s)
              // Ältere Analysen speicherten den Namen mit Hausnummer
              const legacyKey = normalizeStreetName(s.street_name)
              if (!streetLookup.has(legacyKey)) streetLookup.set(legacyKey, s)
            }
            setStreetAnalytics(new Map(streetLookup))
            if (saData.rating?.summary) setRatingSummary(saData.rating.summary)
          }
        } catch {
          // Straßendaten-Fehler: Karte bleibt nutzbar, Straßen ohne Farbe
        }
      }

      // POIs laden
      if (plz) {
        try {
          const res = await fetch(`/api/providers/osm?plz=${plz}`)
          if (res.ok) {
            const data = await res.json()
            const pois = data.pois || []
            setPoiData(pois)

            for (const poi of pois) {
              if (!showCompetitors && poi.is_competitor) continue
              if (!showB2B && !poi.is_competitor) continue

              const color = poi.is_competitor ? CATEGORY_COLORS.competitor : CATEGORY_COLORS.b2b
              const icon = CATEGORY_ICONS[poi.category] || '📍'

              const divIcon = L.divIcon({
                html: `<div style="
                  background:${color};color:white;width:28px;height:28px;
                  border-radius:50%;display:flex;align-items:center;justify-content:center;
                  font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,0.4);
                  border:2px solid rgba(255,255,255,0.3);">${icon}</div>`,
                className: '',
                iconSize: [28, 28],
                iconAnchor: [14, 14],
              })

              L.marker([poi.lat, poi.lng], { icon: divIcon })
                .bindPopup(`<b>${poi.name}</b><br>${poi.category}${poi.is_competitor ? '<br><b style="color:#7c6dfa">⚡ Wettbewerber</b>' : ''}`)
                .addTo(map)
            }
          }
        } catch {}
      }

      // ── PLZ-Fläche und Straßen aus OpenStreetMap (jede deutsche PLZ) ─────
      // Straßen, die über die PLZ-Grenze hinausgehen, liefert der Server
      // bereits an der Grenze abgeschnitten (partial = true).
      if (plz && (showStreetLayer || showPlzBoundaries)) {
        try {
          const geoRes = await fetch(`/api/geo/plz-map?plz=${plz}`)
          const geo = await geoRes.json().catch(() => null)
          if (!geoRes.ok || !geo) {
            setMapNotice(geo?.error || 'Die Straßenkarte konnte nicht geladen werden.')
          } else if (geo.status !== 'ok') {
            setMapNotice(`Für PLZ ${plz} ist in OpenStreetMap keine PLZ-Fläche erfasst. Die Karte zeigt deshalb keine Straßen. Die Tabelle ist davon nicht betroffen.`)
          } else {
            const [w, so, e, n] = geo.bbox
            map.fitBounds([[so, w], [n, e]], { padding: [12, 12] })

            if (showPlzBoundaries && geo.boundary) {
              L.geoJSON(geo.boundary, { style: { color: '#22d3ee', weight: 1.5, opacity: 0.8, fillOpacity: 0.04 } })
                .bindPopup(`<b style="color:#111">PLZ ${plz}</b><br><span style="color:#555">${geo.streets.length} benannte Straßen laut OpenStreetMap</span>`)
                .addTo(map)
            }

            if (showStreetLayer) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              L.geoJSON({ type: 'FeatureCollection', features: geo.streets } as any, {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                style: (feature: any) => {
                  const entry = streetLookup.get(feature.properties?.key || normalizeForLookup(feature.properties?.name || ''))
                  if (!entry) {
                    // Keine Daten: dünn und gestrichelt, damit es nicht wie
                    // „schwach“ aussieht
                    return { color: streetColor(feature.properties?.highway || ''), weight: 1, opacity: 0.45, dashArray: '2 4' }
                  }
                  const rating = (entry.rating || 'none') as Rating
                  return rating === 'none'
                    ? { color: RATING_COLORS.none, weight: 2, opacity: 0.8, dashArray: '6 4' }
                    : { color: RATING_COLORS[rating], weight: 3, opacity: 1 }
                },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                onEachFeature: (feature: any, layer: any) => {
                  const p = feature.properties || {}
                  const name = escapeHtml(p.name || '(unbenannt)')
                  const entry = streetLookup.get(p.key || normalizeForLookup(p.name || ''))
                  const partialNote = p.partial
                    ? `<div style="color:#92400e;font-size:11px;margin-top:4px">Die Straße verläuft auch durch andere PLZ. Gezeigt und bewertet wird nur der Abschnitt in PLZ ${plz}.</div>`
                    : ''
                  let html: string
                  if (entry) {
                    const rating = (entry.rating || 'none') as Rating
                    const revenue = entry.revenue.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    html =
                      `<b style="color:#111;font-size:13px">${name}</b><br>` +
                      `<span style="color:#555;font-size:11px">PLZ ${plz}</span>` +
                      `<div style="margin-top:6px;border-top:1px solid #ddd;padding-top:6px">` +
                      `<span style="color:${RATING_COLORS[rating]};font-weight:700">Ampel: ${RATING_LABELS[rating]}</span>` +
                      `<div style="color:#333;font-size:11px;margin-top:2px">${escapeHtml(entry.rating_reason || '')}</div>` +
                      `<div style="color:#555;font-size:11px;margin-top:4px">Volumen: Klasse ${entry.street_class || '—'}</div>` +
                      `</div>` +
                      `<table style="margin-top:4px;font-size:12px;border-collapse:collapse">` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Kunden</td><td style="color:#111;font-weight:500">${entry.customer_count}</td></tr>` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Bestellungen</td><td style="color:#111;font-weight:500">${entry.order_count}</td></tr>` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Umsatz</td><td style="color:#111;font-weight:500">${revenue} €</td></tr>` +
                      `</table>` + partialNote
                  } else {
                    html =
                      `<b style="color:#111">${name}</b><br>` +
                      `<span style="color:#555;font-size:11px">PLZ ${plz}</span><br>` +
                      `<span style="color:#555">Keine Daten für diese Straße (nicht „0 Bestellungen“).</span>` + partialNote
                  }
                  layer.bindPopup(html, { maxWidth: 280 })
                },
              }).addTo(map)
            }
          }
        } catch {
          setMapNotice('Die Straßenkarte konnte nicht geladen werden.')
        }
      }
      // ── Ende GeoJSON ───────────────────────────────────────────────────

      // Übergebene Marker
      for (const m of markers) {
        const divIcon = L.divIcon({
          html: `<div style="
            background:${m.color};color:white;width:24px;height:24px;
            border-radius:50%;display:flex;align-items:center;justify-content:center;
            font-size:11px;box-shadow:0 2px 8px rgba(0,0,0,0.4);">●</div>`,
          className: '',
          iconSize: [24, 24],
          iconAnchor: [12, 12],
        })
        L.marker([m.lat, m.lng], { icon: divIcon })
          .bindPopup(m.popup || m.label)
          .addTo(map)
      }

      setLoading(false)
    }

    initMap().catch(e => { setError(String(e)); setLoading(false) })

    return () => {
      if (mapInstanceRef.current) {
        (mapInstanceRef.current as { remove: () => void }).remove()
        mapInstanceRef.current = null
      }
    }
    // Neu aufbauen, wenn eine andere PLZ gewählt wird
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plz])

  return (
    <div className="relative w-full h-full min-h-[500px] rounded-xl overflow-hidden border border-[#1f2d45]">
      {loading && (
        <div className="absolute inset-0 bg-[#111827] flex items-center justify-center z-10">
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-brand-red border-t-transparent rounded-full animate-spin mx-auto mb-3" />
            <div className="text-[#8a9bb5] text-sm">Karte lädt...</div>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 bg-[#111827] flex items-center justify-center z-10">
          <div className="text-red-400 text-sm">{error}</div>
        </div>
      )}

      {/* Legende */}
      <div className="absolute bottom-4 right-4 z-[500] bg-[#111827]/95 backdrop-blur border border-[#1f2d45] rounded-lg p-3 text-xs">
        <div className="font-semibold mb-2 text-white">Legende</div>
        {[
          { color: RATING_COLORS.green, label: 'Grün: mindestens PLZ-Durchschnitt' },
          { color: RATING_COLORS.orange, label: 'Orange: halber bis knapp Durchschnitt' },
          { color: RATING_COLORS.red, label: 'Rot: unter halbem Durchschnitt' },
          { color: RATING_COLORS.none, label: 'Grau gestrichelt: nicht bewertbar' },
          { color: '#7c6dfa', label: 'Wettbewerber (Gastronomie)' },
          { color: '#2e86c1', label: 'B2B-Potenzial' },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full" style={{ background: item.color }} />
            <span className="text-[#8a9bb5]">{item.label}</span>
          </div>
        ))}
        {showStreetLayer && (
          <div className="border-t border-[#1f2d45] mt-2 pt-2 max-w-[240px]">
            {streetAnalytics.size > 0 && <div className="text-[#8a9bb5]">{streetAnalytics.size} Straßen mit Daten</div>}
            <div className="text-[#4a5a70] text-[10px] mt-0.5">Dünn gestrichelt = keine Daten (nicht „schwach“)</div>
            {ratingSummary && <div className="text-[#4a5a70] text-[10px] mt-1">{ratingSummary}</div>}
            <div className="text-[#4a5a70] text-[10px] mt-1">Straßen und PLZ-Flächen: © OpenStreetMap-Mitwirkende (ODbL)</div>
          </div>
        )}
      </div>

      {mapNotice && (
        <div role="status" className="absolute top-4 left-14 right-4 z-[500] bg-[#111827]/95 border border-amber-500/40 rounded-lg p-3 text-xs text-amber-200">
          {mapNotice}
        </div>
      )}

      {/* POI-Zusammenfassung */}
      {poiData.length > 0 && (
        <div className="absolute top-4 right-4 z-[500] bg-[#111827]/95 backdrop-blur border border-[#1f2d45] rounded-lg p-3 text-xs">
          <div className="font-semibold mb-1 text-white">POIs geladen</div>
          <div className="text-[#8a9bb5]">{poiData.length} Standorte</div>
          <div className="text-[#7c6dfa]">{(poiData as Array<Record<string,unknown>>).filter(p => p.is_competitor).length} Wettbewerber</div>
        </div>
      )}

      <div ref={mapRef} className="w-full h-full" />
    </div>
  )
}
