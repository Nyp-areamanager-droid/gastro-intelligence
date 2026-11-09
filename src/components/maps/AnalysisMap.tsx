'use client'

import { useEffect, useRef, useState } from 'react'
import { normalizeStreetName, streetNameKey } from '@/lib/geo/street-name'

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

/** Farbe für Straßenklasse A–E aus street_analytics */
function classColor(cls: string | null): string | null {
  if (cls === 'A' || cls === 'B') return '#00d084'  // stark
  if (cls === 'C') return '#f5a623'                  // mittel
  if (cls === 'D') return '#e63027'                  // schwach
  if (cls === 'E') return '#4a5a70'                  // kein Kontakt
  return null
}

/** Farbe einer Straße mit Daten. Klasse E umfasst auch Straßen mit genau
 *  einer Bestellung: die sind schwach (rot), nicht „ohne Bestellung“ (grau). */
function entryColor(e: StreetAnalyticsEntry): string {
  if (e.street_class === 'E' && e.order_count > 0) return '#e63027'
  return classColor(e.street_class) || '#555'
}

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
  center = [51.2217, 6.7762], // Köln als Default
  zoom = 13,
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

  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return

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

      // street_analytics laden (wenn plz + showStreetLayer aktiv)
      // Lokale Variable statt React-State: Die Farben werden weiter unten in
      // derselben Funktion gesetzt. Der State wäre dort noch leer (alter Wert),
      // die Straßen blieben dann ungefärbt.
      const streetLookup = new Map<string, StreetAnalyticsEntry>()
      if (plz && showStreetLayer) {
        try {
          const saRes = await fetch(`/api/analysis/streets?plz=${plz}`)
          if (saRes.ok) {
            const saData = await saRes.json()
            const lookup = streetLookup
            for (const s of (saData.streets || []) as StreetAnalyticsEntry[]) {
              lookup.set(normalizeForLookup(s.street_name), s)
              // Ältere Analysen speicherten den Namen mit Hausnummer
              const legacyKey = normalizeStreetName(s.street_name)
              if (!lookup.has(legacyKey)) lookup.set(legacyKey, s)
            }
            setStreetAnalytics(new Map(lookup))
          }
        } catch {
          // street_analytics-Fehler still ignorieren – Karte bleibt nutzbar
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

      // Eine Straße der Karte gehört nur dann zu den Daten, wenn auch die PLZ
      // passt. Sonst würde z. B. jede „Hauptstraße“ der Karte gefärbt.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const entryFor = (props: any): StreetAnalyticsEntry | undefined => {
        if (plz && props.plz && props.plz !== plz) return undefined
        return streetLookup.get(normalizeForLookup(props.name || ''))
      }

      // ── GeoJSON-Straßen und PLZ-Grenzen (derzeit nur Köln) ────────────
      if (showStreetLayer || showPlzBoundaries) {
        try {
          const geoRes = await fetch('/data/koeln_streets.geojson')
          if (geoRes.ok) {
            const geoData = await geoRes.json()
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            L.geoJSON(geoData as any, {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              filter: (feature: any) => {
                const t = feature.geometry?.type
                const status = feature.properties?.status
                if (t === 'MultiLineString' || t === 'LineString') return !!showStreetLayer
                if (t === 'Polygon' || t === 'MultiPolygon') {
                  // Incomplete ohne Geodaten überspringen
                  if (status === 'incomplete' && !feature.geometry) return false
                  return !!showPlzBoundaries
                }
                return false
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              style: (feature: any) => {
                const t = feature.geometry?.type
                const status = feature.properties?.status
                if (t === 'MultiLineString' || t === 'LineString') {
                  // Straße in street_analytics? → Klassen-Farbe verwenden
                  const analyticsEntry = entryFor(feature.properties || {})
                  if (!analyticsEntry) {
                    // Keine Daten: dünn und gestrichelt, damit es nicht wie
                    // „schwach“ oder „ohne Bestellung“ aussieht
                    return { color: streetColor(feature.properties?.highway || feature.properties?.hw || ''), weight: 1, opacity: 0.45, dashArray: '2 4' }
                  }
                  return { color: entryColor(analyticsEntry), weight: 2.5, opacity: 1 }
                }
                // PLZ-Grenzen
                if (status === 'incomplete') {
                  return { color: '#6b7280', weight: 1.5, opacity: 0.6, fillOpacity: 0.08, dashArray: '4 4' }
                }
                return { color: '#22d3ee', weight: 1.5, opacity: 0.7, fillOpacity: 0.04 }
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onEachFeature: (feature: any, layer: any) => {
                const p = feature.properties || {}
                const t = feature.geometry?.type
                if (t === 'MultiLineString' || t === 'LineString') {
                  // Straße anklicken → Popup
                  const name = p.name || '(unbenannt)'
                  const hw   = p.highway || p.hw || '—'
                  const plzVal = p.plz || '—'

                  // street_analytics-Daten für diese Straße suchen
                  const analyticsEntry = entryFor(p)

                  let popupContent: string
                  if (analyticsEntry) {
                    const classLabel: Record<string, string> = {
                      A: 'A – Sehr stark', B: 'B – Stark',
                      C: 'C – Mittel', D: 'D – Schwach',
                      E: analyticsEntry.order_count > 0 ? 'E – Sehr schwach' : 'E – Ohne Bestellung',
                    }
                    const cls = analyticsEntry.street_class || '—'
                    const clsColor = entryColor(analyticsEntry)
                    const revenue = analyticsEntry.revenue.toLocaleString('de-DE', {
                      minimumFractionDigits: 2, maximumFractionDigits: 2
                    })
                    popupContent =
                      `<b style="color:#111;font-size:13px">${name}</b><br>` +
                      `<span style="color:#555;font-size:11px">PLZ: ${plzVal}</span><br>` +
                      `<div style="margin-top:6px;border-top:1px solid #ddd;padding-top:6px">` +
                      `<span style="color:${clsColor};font-weight:600">Klasse ${cls}</span>` +
                      (cls !== '—' ? ` – ${classLabel[cls] || ''}` : '') +
                      `</div>` +
                      `<table style="margin-top:4px;font-size:12px;border-collapse:collapse">` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Kunden</td>` +
                      `<td style="color:#111;font-weight:500">${analyticsEntry.customer_count}</td></tr>` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Bestellungen</td>` +
                      `<td style="color:#111;font-weight:500">${analyticsEntry.order_count}</td></tr>` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Umsatz</td>` +
                      `<td style="color:#111;font-weight:500">€ ${revenue}</td></tr>` +
                      `<tr><td style="color:#555;padding:1px 8px 1px 0">Ø Bestellungen/Kunde</td>` +
                      `<td style="color:#111;font-weight:500">${analyticsEntry.orders_per_customer.toFixed(1)}</td></tr>` +
                      `</table>`
                  } else {
                    // Keine Daten in street_analytics → kein "0 Bestellungen" zeigen
                    popupContent =
                      `<b style="color:#111">${name}</b><br>` +
                      `<span style="color:#555">PLZ: ${plzVal}</span><br>` +
                      `<span style="color:#555">Typ: ${hw}</span><br>` +
                      `<span style="color:#555">Keine Analysedaten für diese Straße</span>`
                  }

                  layer.bindPopup(popupContent, { maxWidth: 260 })
                  layer.on('mouseover', () => layer.setStyle({ weight: analyticsEntry ? 4 : 3, opacity: 1 }))
                  layer.on('mouseout',  () => {
                    const hasA = !!analyticsEntry
                    layer.setStyle({ weight: hasA ? 2.5 : 1.5, opacity: hasA ? 1 : 0.75 })
                  })
                } else {
                  // PLZ-Grenze
                  const status = p.status || 'partial'
                  const label = status === 'incomplete'
                    ? `⚠️ PLZ ${p.plz} – unvollständig (Overpass-Ausfall)`
                    : `PLZ ${p.plz} · ${p.street_count ?? '?'} Straßen`
                  layer.bindPopup(`<b style="color:#111">${label}</b>`, { maxWidth: 220 })
                }
              },
            }).addTo(map)
          }
        } catch {
          // GeoJSON-Fehler still ignorieren – Karte bleibt nutzbar
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
          { color: '#00d084', label: 'Stark (A/B)' },
          { color: '#f5a623', label: 'Mittel (C)' },
          { color: '#e63027', label: 'Schwach (D, E mit 1 Bestellung)' },
          { color: '#4a5a70', label: 'Ohne Bestellung (E)' },
          { color: '#7c6dfa', label: 'Wettbewerber' },
          { color: '#2e86c1', label: 'B2B-Potenzial' },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full" style={{ background: item.color }} />
            <span className="text-[#8a9bb5]">{item.label}</span>
          </div>
        ))}
        {showStreetLayer && streetAnalytics.size > 0 && (
          <div className="border-t border-[#1f2d45] mt-2 pt-2">
            <div className="text-[#8a9bb5]">{streetAnalytics.size} Straßen mit Daten</div>
            <div className="text-[#4a5a70] text-[10px] mt-0.5">Dünn gestrichelt = keine Daten (nicht „schwach“)</div>
          </div>
        )}
        {(showStreetLayer || showPlzBoundaries) && (
          <>
            <div className="border-t border-[#1f2d45] my-2" />
            {showPlzBoundaries && (
              <>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-3 h-1 rounded" style={{ background: '#22d3ee' }} />
                  <span className="text-[#8a9bb5]">PLZ (erfasst)</span>
                </div>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-3 h-1 rounded border border-dashed border-gray-500" style={{ background: 'transparent' }} />
                  <span className="text-[#8a9bb5]">PLZ (unvollständig)</span>
                </div>
              </>
            )}
            {showStreetLayer && (
              <div className="flex items-center gap-2 mb-1">
                <div className="w-3 h-1 rounded" style={{ background: '#4b6fa8' }} />
                <span className="text-[#8a9bb5]">Straßen</span>
              </div>
            )}
          </>
        )}
      </div>

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
