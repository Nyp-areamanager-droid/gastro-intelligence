// =============================================================================
// Data Provider Layer
// Austauschbare Datenquellen: OpenPLZ | OSM | Census | Google Places
// =============================================================================

import type {
  OSMPOIResult, PostalCode,
  POIBusiness, POICategory, DataSource
} from '@/types'
import { getStreetDirectory, type StreetDirectoryResult } from '@/lib/geo/street-directory'

const OPENPLZ_BASE = 'https://openplzapi.org/de'
const NOMINATIM_BASE = 'https://nominatim.openstreetmap.org'
const OVERPASS_BASE = 'https://overpass-api.de/api/interpreter'
const OVERPASS_FALLBACK = 'https://overpass.openstreetmap.fr/api/interpreter'

// ── Retry-fähiger Fetch ───────────────────────────────────────────────────────
async function fetchWithRetry(url: string, options: RequestInit = {}, retries = 3): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(timeout)
    if (!res.ok && retries > 0) {
      await new Promise(r => setTimeout(r, 1000))
      return fetchWithRetry(url, options, retries - 1)
    }
    return res
  } catch (err) {
    clearTimeout(timeout)
    if (retries > 0) {
      await new Promise(r => setTimeout(r, 1500))
      return fetchWithRetry(url, options, retries - 1)
    }
    throw err
  }
}

// =============================================================================
// OpenPLZ Provider — amtliches Straßenverzeichnis Deutschland
// https://openplzapi.org
// =============================================================================
export const openplzProvider = {
  name: 'openplz' as DataSource,

  /**
   * Vollständiges Straßenverzeichnis einer PLZ inkl. Status.
   * Nur status 'complete' darf als vollständige Liste verwendet werden.
   */
  async getStreetDirectory(postalCode: string): Promise<StreetDirectoryResult> {
    return getStreetDirectory(postalCode)
  },

  async getPostalCodeInfo(postalCode: string): Promise<Partial<PostalCode> | null> {
    try {
      const url = `${OPENPLZ_BASE}/Localities?postalCode=${postalCode}&pageSize=1`
      const res = await fetchWithRetry(url, {
        headers: { Accept: 'text/json', 'User-Agent': 'GastroIntelligence/1.0' }
      })
      if (!res.ok) return null
      const data = await res.json()
      if (!data?.length) return null
      const loc = data[0]
      return {
        postal_code: postalCode,
        city: loc.name || loc.locality,
        state: loc.federalState?.name,
        district: loc.district?.name,
        municipality: loc.municipality?.name,
        data_source: 'openplz',
        trust_level: 'official',
      }
    } catch {
      return null
    }
  },
}

// =============================================================================
// OSM / Nominatim / Overpass Provider
// =============================================================================
export const osmProvider = {
  name: 'osm' as DataSource,

  async getBoundingBox(postalCode: string, city?: string): Promise<[number,number,number,number] | null> {
    try {
      const q = city
        ? `postalcode=${postalCode}&city=${encodeURIComponent(city)}&country=DE`
        : `postalcode=${postalCode}&country=DE`
      const url = `${NOMINATIM_BASE}/search?${q}&format=json&limit=1`
      const res = await fetchWithRetry(url, {
        headers: { 'User-Agent': 'GastroIntelligence/1.0', 'Accept-Language': 'de' }
      })
      if (!res.ok) return null
      const data = await res.json()
      if (!data?.length) return null
      const bb = data[0].boundingbox as string[]
      // [south, north, west, east]
      return [parseFloat(bb[0]), parseFloat(bb[1]), parseFloat(bb[2]), parseFloat(bb[3])]
    } catch {
      return null
    }
  },

  async getCoordinates(postalCode: string, city?: string): Promise<{lat:number,lng:number}|null> {
    const bb = await this.getBoundingBox(postalCode, city)
    if (!bb) return null
    return {
      lat: (bb[0] + bb[1]) / 2,
      lng: (bb[2] + bb[3]) / 2,
    }
  },

  async getPOIsByPostalCode(postalCode: string, categories: POICategory[]): Promise<OSMPOIResult[]> {
    // Overpass QL für mehrere Kategorien
    const tagMap: Record<POICategory, string[]> = {
      restaurant:   ['amenity=restaurant', 'amenity=fast_food', 'amenity=cafe'],
      competitor:   ['amenity=fast_food', 'amenity=restaurant'],
      hotel:        ['tourism=hotel', 'tourism=motel', 'tourism=hostel'],
      school:       ['amenity=school', 'amenity=kindergarten', 'amenity=university', 'amenity=college'],
      hospital:     ['amenity=hospital', 'amenity=clinic', 'amenity=doctors'],
      authority:    ['amenity=townhall', 'amenity=police', 'amenity=post_office', 'office=government'],
      fitness:      ['leisure=fitness_centre', 'leisure=sports_centre'],
      office:       ['office=company', 'office=it', 'building=office'],
      commercial:   ['landuse=commercial', 'landuse=industrial', 'landuse=retail'],
      supermarket:  ['shop=supermarket', 'shop=convenience'],
      other:        [],
    }

    const tagFilters = categories
      .flatMap(c => tagMap[c] || [])
      .map(t => {
        const [k, v] = t.split('=')
        return `node["${k}"="${v}"](area.searchArea);way["${k}"="${v}"](area.searchArea);`
      })
      .join('\n')

    if (!tagFilters) return []

    const query = `
[out:json][timeout:30];
area["postal_code"="${postalCode}"]->.searchArea;
(
${tagFilters}
);
out center tags;`.trim()

    const results: OSMPOIResult[] = []

    for (const endpoint of [OVERPASS_BASE, OVERPASS_FALLBACK]) {
      try {
        const res = await fetchWithRetry(endpoint, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(query),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        })
        if (!res.ok) continue
        const data = await res.json()

        for (const el of (data.elements || [])) {
          const lat = el.lat ?? el.center?.lat
          const lng = el.lon ?? el.center?.lon
          if (!lat || !lng || !el.tags?.name) continue
          results.push({
            osm_id: el.id,
            name: el.tags.name,
            category: el.tags.amenity || el.tags.tourism || el.tags.shop || el.tags.office || 'other',
            lat, lng,
            tags: el.tags,
          })
        }
        break
      } catch { continue }
    }
    return results
  },

  classifyOSMCategory(tags: Record<string,string>): POICategory {
    const amenity = tags.amenity || ''
    const tourism = tags.tourism || ''
    const shop = tags.shop || ''
    const office = tags.office || ''
    const leisure = tags.leisure || ''

    if (['restaurant','fast_food','cafe','food_court','pizza'].includes(amenity)) return 'restaurant'
    if (['hotel','motel','hostel','guest_house'].includes(tourism)) return 'hotel'
    if (['school','kindergarten','university','college'].includes(amenity)) return 'school'
    if (['hospital','clinic','doctors'].includes(amenity)) return 'hospital'
    if (['townhall','police','post_office'].includes(amenity) || office === 'government') return 'authority'
    if (['fitness_centre','sports_centre'].includes(leisure)) return 'fitness'
    if (['supermarket','convenience'].includes(shop)) return 'supermarket'
    if (office === 'company' || office === 'it') return 'office'
    return 'other'
  },

  isCompetitor(tags: Record<string,string>, deliveryKeywords: string[]): boolean {
    const name = (tags.name || '').toLowerCase()
    const amenity = tags.amenity || ''
    const cuisine = tags.cuisine || ''
    const isFood = ['restaurant','fast_food','cafe','pizza'].includes(amenity)
    if (!isFood) return false
    const kw = ['pizza','burger','döner','sushi','kebab','lieferando','wolt','uber','mcdonalds','kfc','dominos','subway','bk','burger king']
    return kw.some(k => name.includes(k) || cuisine.includes(k)) ||
           deliveryKeywords.some(k => name.includes(k.toLowerCase()))
  },
}

// =============================================================================
// Einwohner und Haushalte
// Früher standen hier fest eingebaute Tabellen (rund 160 PLZ, fast nur NRW)
// mit glatt gerundeten Werten und der Aufschrift „Zensus 2022“, ohne belegte
// Quelle, dazu ein Schätzwert für alle anderen PLZ. Beides ist entfernt.
// Einwohner und Haushalte kommen nur noch aus postal_codes, und nur wenn
// population_method gesetzt ist (Import der Zensus-Gitterdaten über
// scripts/zensus-plz-import.ts). Siehe lib/geo/population.ts.
// =============================================================================

// =============================================================================
// Google Places Provider (optional — nur wenn API Key vorhanden)
// =============================================================================
export const googlePlacesProvider = {
  name: 'google_places' as DataSource,

  isAvailable(apiKey?: string): boolean {
    return !!apiKey && apiKey.length > 10
  },

  async searchNearby(
    lat: number, lng: number, radius: number,
    type: string, apiKey: string
  ): Promise<Partial<POIBusiness>[]> {
    if (!this.isAvailable(apiKey)) return []

    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json?` +
      `location=${lat},${lng}&radius=${radius}&type=${type}&language=de&key=${apiKey}`

    try {
      const res = await fetchWithRetry(url)
      if (!res.ok) return []
      const data = await res.json()
      if (data.status !== 'OK') return []

      return data.results.map((place: Record<string,unknown>) => ({
        google_place_id: place.place_id as string,
        name: place.name as string,
        lat: (place.geometry as Record<string,Record<string,number>>).location.lat,
        lng: (place.geometry as Record<string,Record<string,number>>).location.lng,
        rating: place.rating as number,
        review_count: place.user_ratings_total as number,
        price_level: place.price_level as number,
        is_chain: false,
        data_source: 'google_places' as DataSource,
      }))
    } catch {
      return []
    }
  },
}

// =============================================================================
// Provider Orchestrator — kombiniert alle Quellen
// =============================================================================
export class DataProviderOrchestrator {
  private googleApiKey?: string

  constructor(googleApiKey?: string) {
    this.googleApiKey = googleApiKey
  }

  /**
   * Straßenverzeichnis einer PLZ. `complete` ist nur true, wenn alle Seiten
   * fehlerfrei geladen wurden. Bei false darf die Liste weder gespeichert
   * noch für "Straßen ohne Bestellungen" genutzt werden.
   */
  async getStreets(postalCode: string): Promise<{
    streets: string[]
    complete: boolean
    status: StreetDirectoryResult['status']
    source: DataSource
    count: number
    error?: string
  }> {
    const dir = await openplzProvider.getStreetDirectory(postalCode)
    return {
      streets: dir.streets.map(s => s.name),
      complete: dir.status === 'complete',
      status: dir.status,
      source: 'openplz',
      count: dir.streets.length,
      error: dir.status === 'complete'
        ? undefined
        : dir.status === 'empty'
          ? `Für PLZ ${postalCode} liefert OpenPLZ keine Straßen.`
          : `Straßenverzeichnis für PLZ ${postalCode} unvollständig: ${dir.reason}`,
    }
  }

  async getPostalCodeData(postalCode: string): Promise<{
    info: Partial<PostalCode>
  }> {
    const info = await openplzProvider.getPostalCodeInfo(postalCode)
    return { info: info || { postal_code: postalCode } }
  }

  async getPOIs(postalCode: string, lat: number, lng: number): Promise<POIBusiness[]> {
    const categories: POICategory[] = ['restaurant', 'hotel', 'school', 'hospital', 'authority', 'fitness', 'office']
    const osmResults = await osmProvider.getPOIsByPostalCode(postalCode, categories)

    const pois: POIBusiness[] = osmResults.map(r => ({
      id: '',
      postal_code: postalCode,
      name: r.name,
      category: osmProvider.classifyOSMCategory(r.tags || {}),
      lat: r.lat,
      lng: r.lng,
      osm_id: r.osm_id,
      is_chain: false,
      is_competitor: osmProvider.isCompetitor(r.tags || {}, []),
      data_source: 'osm' as DataSource,
      last_fetched_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    }))

    // Optional: Google Places ergänzen
    if (googlePlacesProvider.isAvailable(this.googleApiKey)) {
      const googleTypes = ['restaurant', 'hotel', 'school', 'hospital']
      for (const type of googleTypes) {
        const googleResults = await googlePlacesProvider.searchNearby(
          lat, lng, 2000, type, this.googleApiKey!
        )
        for (const g of googleResults) {
          if (!pois.find(p => Math.abs(p.lat - (g.lat||0)) < 0.001)) {
            pois.push({
              id: '',
              postal_code: postalCode,
              name: g.name || '',
              category: type as POICategory,
              lat: g.lat || 0,
              lng: g.lng || 0,
              rating: g.rating,
              review_count: g.review_count,
              google_place_id: g.google_place_id,
              is_chain: false,
              is_competitor: type === 'restaurant',
              data_source: 'google_places',
              last_fetched_at: new Date().toISOString(),
              created_at: new Date().toISOString(),
            })
          }
        }
      }
    }

    return pois
  }
}
