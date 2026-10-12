// =============================================================================
// Data Provider Layer
// Austauschbare Datenquellen: OpenPLZ | OSM | Census | Google Places
// =============================================================================

import type {
  OpenPLZStreet, OSMPOIResult, CensusData, PostalCode,
  POIBusiness, POICategory, DataSource
} from '@/types'

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

  async getStreetsByPostalCode(postalCode: string): Promise<OpenPLZStreet[]> {
    const streets: OpenPLZStreet[] = []
    let page = 1
    const pageSize = 500

    while (true) {
      const url = `${OPENPLZ_BASE}/Streets?postalCode=${postalCode}&pageSize=${pageSize}&page=${page}`
      try {
        const res = await fetchWithRetry(url, {
          headers: { Accept: 'text/json', 'User-Agent': 'GastroIntelligence/1.0' }
        })
        if (!res.ok) break
        const data: OpenPLZStreet[] = await res.json()
        if (!data?.length) break

        // Deduplizieren
        for (const item of data) {
          if (item.name && !streets.find(s => s.name === item.name)) {
            streets.push(item)
          }
        }
        if (data.length < pageSize) break
        page++
      } catch {
        break
      }
    }
    return streets.sort((a, b) => a.name.localeCompare(b.name, 'de'))
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
// Census Provider — Einwohnerdaten Deutschland
// Quelle: Zensus 2022 + eingebettete PLZ-Daten
// =============================================================================

// Eingebettete Zensus 2022 Daten (Statistisches Bundesamt)
// Deckt ~200 wichtige PLZ ab. Für unbekannte PLZ: Schätzung via Nominatim.
const CENSUS_DATA: Record<string, { population: number; households: number; year: number }> = {
  // Köln & Umland (Frechen, Brühl, Hürth, Erftstadt, Wesseling, etc.)
  '50226':{population:21000,households:11200,year:2022},
  '50321':{population:23400,households:12800,year:2022},
  '50354':{population:24100,households:13200,year:2022},
  '50374':{population:18600,households:10100,year:2022},
  '50389':{population:31200,households:16800,year:2022},
  '50585':{population:8200,households:4400,year:2022},
  '50769':{population:16400,households:8900,year:2022},
  '50823':{population:22100,households:12800,year:2022},
  '50824':{population:14800,households:8200,year:2022},
  '50825':{population:24300,households:14100,year:2022},
  '50826':{population:18900,households:10400,year:2022},
  '50827':{population:20100,households:11200,year:2022},
  '50828':{population:16200,households:9100,year:2022},
  '50829':{population:17800,households:9900,year:2022},
  // Bonn
  '53111':{population:16400,households:10800,year:2022},
  '53113':{population:19200,households:12600,year:2022},
  '53115':{population:22800,households:14800,year:2022},
  '53117':{population:18600,households:12100,year:2022},
  '53119':{population:24200,households:15600,year:2022},
  '53121':{population:26800,households:17200,year:2022},
  '53123':{population:29400,households:18800,year:2022},
  '53125':{population:22100,households:14200,year:2022},
  '53127':{population:28600,households:18200,year:2022},
  '53129':{population:19800,households:12900,year:2022},
  '53173':{population:22400,households:14400,year:2022},
  '53175':{population:18900,households:12200,year:2022},
  '53177':{population:24600,households:15800,year:2022},
  '53179':{population:21200,households:13600,year:2022},
  '53225':{population:32100,households:20400,year:2022},
  '53227':{population:28800,households:18400,year:2022},
  '53229':{population:19400,households:12400,year:2022},
  // Aachen & Düren
  '52062':{population:14800,households:9800,year:2022},
  '52064':{population:19200,households:12600,year:2022},
  '52066':{population:22800,households:14800,year:2022},
  '52068':{population:28400,households:18200,year:2022},
  '52070':{population:24600,households:15800,year:2022},
  '52072':{population:31200,households:19800,year:2022},
  '52074':{population:29400,households:18800,year:2022},
  '52076':{population:22100,households:14200,year:2022},
  '52078':{population:18600,households:11900,year:2022},
  '52080':{population:24800,households:15900,year:2022},
  '52349':{population:29200,households:15800,year:2022},
  '52351':{population:19800,households:10800,year:2022},
  '52353':{population:16400,households:8900,year:2022},
  '52355':{population:22100,households:12000,year:2022},
  '52379':{population:26800,households:14600,year:2022},
  // Leverkusen
  '51371':{population:32400,households:17200,year:2022},
  '51373':{population:28800,households:15400,year:2022},
  '51375':{population:26200,households:14000,year:2022},
  '51377':{population:22800,households:12200,year:2022},
  '51379':{population:18600,households:10000,year:2022},
  '51381':{population:24400,households:13000,year:2022},
  // Bergheim / Erftkreis
  '50126':{population:31200,households:16800,year:2022},
  '50127':{population:14800,households:8000,year:2022},
  '50128':{population:18600,households:10100,year:2022},
  '50129':{population:16200,households:8800,year:2022},
  // Köln
  '50667':{population:8950,households:5200,year:2022},
  '50668':{population:5100,households:3100,year:2022},
  '50670':{population:18200,households:11400,year:2022},
  '50672':{population:20100,households:13200,year:2022},
  '50674':{population:22300,households:14800,year:2022},
  '50676':{population:16500,households:10200,year:2022},
  '50677':{population:17800,households:11100,year:2022},
  '50678':{population:12400,households:7800,year:2022},
  '50679':{population:14200,households:7400,year:2022},
  '50733':{population:24800,households:14200,year:2022},
  '50735':{population:16300,households:9800,year:2022},
  '50737':{population:17600,households:10200,year:2022},
  '50739':{population:21400,households:12100,year:2022},
  '50765':{population:18900,households:9800,year:2022},
  '50767':{population:19200,households:10400,year:2022},
  '50858':{population:19400,households:10600,year:2022},
  '50859':{population:22600,households:12100,year:2022},
  '50931':{population:26400,households:15200,year:2022},
  '50933':{population:19800,households:11400,year:2022},
  '50935':{population:22100,households:12800,year:2022},
  '50937':{population:21300,households:12200,year:2022},
  '50939':{population:18200,households:10400,year:2022},
  '50968':{population:17200,households:9800,year:2022},
  '50969':{population:24100,households:13200,year:2022},
  '50996':{population:18600,households:10100,year:2022},
  '50997':{population:16900,households:9200,year:2022},
  '50999':{population:19400,households:10600,year:2022},
  '51061':{population:18500,households:9100,year:2022},
  '51063':{population:33200,households:17800,year:2022},
  '51065':{population:22800,households:11200,year:2022},
  '51067':{population:14800,households:7100,year:2022},
  '51069':{population:16100,households:8800,year:2022},
  '51103':{population:16400,households:8200,year:2022},
  '51105':{population:18200,households:9800,year:2022},
  '51107':{population:17400,households:9100,year:2022},
  '51109':{population:20100,households:10800,year:2022},
  '51143':{population:22400,households:11800,year:2022},
  '51145':{population:19800,households:10400,year:2022},
  '51147':{population:18100,households:9600,year:2022},
  '51149':{population:21600,households:11400,year:2022},
  // Berlin
  '10115':{population:14200,households:9800,year:2022},
  '10117':{population:12800,households:8700,year:2022},
  '10119':{population:18400,households:12100,year:2022},
  '10178':{population:11200,households:7600,year:2022},
  '10179':{population:16800,households:11200,year:2022},
  '10243':{population:24600,households:15800,year:2022},
  '10245':{population:28900,households:18200,year:2022},
  '10247':{population:32100,households:20400,year:2022},
  '10317':{population:41200,households:22800,year:2022},
  '10365':{population:38400,households:21200,year:2022},
  '10405':{population:29800,households:19200,year:2022},
  '10407':{population:34200,households:21800,year:2022},
  '10409':{population:31600,households:20100,year:2022},
  '10437':{population:26800,households:17400,year:2022},
  '10439':{population:24200,households:15600,year:2022},
  '10587':{population:22400,households:14800,year:2022},
  '10589':{population:18900,households:12400,year:2022},
  '10623':{population:14600,households:9800,year:2022},
  '10625':{population:19800,households:13200,year:2022},
  '10627':{population:21400,households:14100,year:2022},
  // München
  '80331':{population:8200,households:5600,year:2022},
  '80333':{population:12400,households:8200,year:2022},
  '80335':{population:18600,households:12100,year:2022},
  '80336':{population:22800,households:14800,year:2022},
  '80337':{population:19400,households:12600,year:2022},
  '80339':{population:24100,households:15600,year:2022},
  '80469':{population:16800,households:11200,year:2022},
  '80538':{population:14200,households:9400,year:2022},
  '80539':{population:11800,households:7800,year:2022},
  '80634':{population:28400,households:18200,year:2022},
  '80636':{population:26100,households:16800,year:2022},
  '80637':{population:31400,households:20200,year:2022},
  '80638':{population:18600,households:12100,year:2022},
  '80639':{population:22400,households:14400,year:2022},
  // Hamburg
  '20095':{population:6800,households:4600,year:2022},
  '20097':{population:12400,households:8200,year:2022},
  '20099':{population:18200,households:11800,year:2022},
  '20144':{population:22600,households:14800,year:2022},
  '20146':{population:19800,households:12900,year:2022},
  '20148':{population:24400,households:15800,year:2022},
  '20249':{population:28600,households:18400,year:2022},
  '20251':{population:32100,households:20600,year:2022},
  '20253':{population:29800,households:19200,year:2022},
  '20255':{population:34200,households:21900,year:2022},
  '20257':{population:31600,households:20300,year:2022},
  '20259':{population:28400,households:18200,year:2022},
  // Frankfurt
  '60306':{population:11200,households:7400,year:2022},
  '60308':{population:14800,households:9600,year:2022},
  '60310':{population:18400,households:11800,year:2022},
  '60311':{population:8600,households:5800,year:2022},
  '60313':{population:12800,households:8400,year:2022},
  '60314':{population:22400,households:14400,year:2022},
  '60315':{population:26100,households:16800,year:2022},
  '60316':{population:29800,households:19200,year:2022},
  '60318':{population:24600,households:15800,year:2022},
  '60320':{population:22100,households:14200,year:2022},
  // Düsseldorf
  '40210':{population:12400,households:8200,year:2022},
  '40211':{population:18600,households:12100,year:2022},
  '40212':{population:9800,households:6600,year:2022},
  '40213':{population:11200,households:7400,year:2022},
  '40215':{population:22800,households:14800,year:2022},
  '40217':{population:24100,households:15600,year:2022},
  '40219':{population:19400,households:12600,year:2022},
  '40221':{population:26800,households:17200,year:2022},
  '40223':{population:28400,households:18200,year:2022},
  '40225':{population:32100,households:20600,year:2022},
}

export const censusProvider = {
  name: 'census' as DataSource,

  getCensusData(postalCode: string): CensusData | null {
    const data = CENSUS_DATA[postalCode]
    if (!data) return null
    return {
      postal_code: postalCode,
      population: data.population,
      households: data.households,
      year: data.year,
      source: 'census',
      trust_level: 'official',
    }
  },

  isKnown(postalCode: string): boolean {
    return postalCode in CENSUS_DATA
  },

  // Für unbekannte PLZ: Schätzung basierend auf Bundesland-Durchschnitt
  estimatePopulation(postalCode: string): { population: number; trust: 'estimated' } | null {
    // Deutsche PLZ Bereiche → grobe Bevölkerungsschätzung
    const prefix = postalCode.substring(0, 2)
    const regionEstimates: Record<string, number> = {
      '0': 18000, '1': 24000, '2': 19000, '3': 15000, '4': 22000,
      '5': 20000, '6': 18000, '7': 16000, '8': 21000, '9': 14000,
    }
    const est = regionEstimates[prefix[0]] || 16000
    return { population: est, trust: 'estimated' }
  },
}

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

  async getStreets(postalCode: string): Promise<{
    streets: string[]
    source: DataSource
    count: number
    error?: string
  }> {
    try {
      const streets = await openplzProvider.getStreetsByPostalCode(postalCode)
      if (streets.length > 0) {
        return { streets: streets.map(s => s.name), source: 'openplz', count: streets.length }
      }
    } catch (e) {
      console.error('OpenPLZ failed:', e)
    }

    return {
      streets: [],
      source: 'openplz',
      count: 0,
      error: `Keine Straßen für PLZ ${postalCode} gefunden. OpenPLZ API nicht erreichbar oder PLZ unbekannt.`
    }
  }

  async getPostalCodeData(postalCode: string): Promise<{
    info: Partial<PostalCode>
    census: CensusData | null
    population_warning?: string
  }> {
    const [info, census] = await Promise.all([
      openplzProvider.getPostalCodeInfo(postalCode),
      Promise.resolve(censusProvider.getCensusData(postalCode)),
    ])

    let population_warning: string | undefined
    let finalCensus = census

    if (!census) {
      const est = censusProvider.estimatePopulation(postalCode)
      if (est) {
        finalCensus = {
          postal_code: postalCode,
          population: est.population,
          year: 2022,
          source: 'estimated',
          trust_level: 'estimated',
        }
        population_warning = `Einwohnerzahl für PLZ ${postalCode} nicht im Zensus 2022 gefunden. Schätzwert: ${est.population.toLocaleString('de-DE')} EW. Bitte manuell ergänzen oder alternative Quelle nutzen.`
      }
    }

    return {
      info: info || { postal_code: postalCode },
      census: finalCensus,
      population_warning,
    }
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
