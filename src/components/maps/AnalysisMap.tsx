'use client'

import { useEffect, useRef, useState } from 'react'

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

interface MapProps {
  center?: [number, number]
  zoom?: number
  markers?: MapMarkerData[]
  plz?: string
  showStreets?: boolean
  showCompetitors?: boolean
  showB2B?: boolean
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
  showStreets = true,
  showCompetitors = true,
  showB2B = true,
}: MapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const mapInstanceRef = useRef<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [poiData, setPoiData] = useState<Record<string, unknown>[]>([])
  const [streetData, setStreetData] = useState<Record<string, unknown>[]>([])
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
  }, [])

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
          { color: '#e63027', label: 'Schwach (D)' },
          { color: '#4a5a70', label: 'Kein Kontakt (E)' },
          { color: '#7c6dfa', label: 'Wettbewerber' },
          { color: '#2e86c1', label: 'B2B-Potenzial' },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-2 mb-1">
            <div className="w-3 h-3 rounded-full" style={{ background: item.color }} />
            <span className="text-[#8a9bb5]">{item.label}</span>
          </div>
        ))}
      </div>

      {/* POI-Zusammenfassung */}
      {poiData.length > 0 && (
        <div className="absolute top-4 right-4 z-[500] bg-[#111827]/95 backdrop-blur border border-[#1f2d45] rounded-lg p-3 text-xs">
          <div className="font-semibold mb-1 text-white">POIs geladen</div>
          <div className="text-[#8a9bb5]">{poiData.length} Standorte</div>
          <div className="text-[#7c6dfa]">{poiData.filter((p: Record<string,unknown>) => p.is_competitor).length} Wettbewerber</div>
        </div>
      )}

      <div ref={mapRef} className="w-full h-full" />
    </div>
  )
}
