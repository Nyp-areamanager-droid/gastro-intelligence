// =============================================================================
// Provider-Routen (OpenPLZ, OSM): Wer darf laden und in die gemeinsamen
// Referenztabellen schreiben? Nur owner, admin, manager. Viewer dürfen nur
// bereits geladene Daten lesen. Läuft ohne Datenbank und ohne Netz.
// =============================================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

type Op = [string, unknown[]]
interface Call { table: string; ops: Op[] }

const st = vi.hoisted(() => ({
  user: null as { id: string } | null,
  role: null as string | null,
  serviceCreated: 0,
  serviceCalls: [] as { table: string; ops: [string, unknown[]][] }[],
  cached: [] as Record<string, unknown>[],
  providerCalls: [] as string[],
}))

function builderFor(table: string, resolve: (c: Call) => { data: unknown; error: unknown }, log?: Call[]) {
  const call: Call = { table, ops: [] }
  log?.push(call)
  const b: Record<string, unknown> = {}
  for (const op of ['select', 'eq', 'neq', 'gt', 'in', 'insert', 'update', 'delete', 'upsert', 'order', 'limit', 'range']) {
    b[op] = (...a: unknown[]) => { call.ops.push([op, a]); return b }
  }
  b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(resolve(call)).then(ok, err)
  return b
}

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: st.user }, error: null }) },
    from: (t: string) => builderFor(t, () => ({
      data: st.role ? [{ company_id: 'A', role: st.role }] : [], error: null,
    })),
  }),
  createReferenceDataClient: () => {
    st.serviceCreated++
    return {
      from: (t: string) => builderFor(t, c => ({
        data: t === 'poi_businesses' && c.ops.some(([o]) => o === 'select') ? st.cached : null, error: null,
      }), st.serviceCalls),
    }
  },
}))

vi.mock('@/lib/providers', () => ({
  osmProvider: {
    getBoundingBox: async () => { st.providerCalls.push('osm-bbox'); return [50.9, 51.0, 6.9, 7.0] },
    getPOIsByPostalCode: async () => {
      st.providerCalls.push('osm-pois')
      return [{ name: 'Hotel X', lat: 50.9, lng: 6.9, osm_id: 1, tags: { tourism: 'hotel' } }]
    },
    classifyOSMCategory: () => 'hotel',
    isCompetitor: () => false,
  },
  openplzProvider: {
    getStreetDirectory: async (plz: string) => {
      st.providerCalls.push('openplz-dir')
      return {
        postalCode: plz, status: 'complete', source: 'openplz',
        streets: [{ name: 'Neusser Str.', key: 'neusserstr', localities: ['Köln'] }],
        totalReported: 1, totalFetched: 1, pagesFetched: 1, fetchedAt: new Date().toISOString(),
      }
    },
    getPostalCodeInfo: async () => { st.providerCalls.push('openplz-info'); return { city: 'Köln', state: 'NRW' } },
  },
}))
vi.mock('@/lib/geo/street-directory', () => ({ invalidateStreetDirectory: () => {} }))

const WRITES = ['insert', 'update', 'delete', 'upsert']
const serviceWrites = () => st.serviceCalls.filter(c => c.ops.some(([o]) => WRITES.includes(o)))
let n = 0
const osmReq = (q = '') => new NextRequest(`http://localhost/api/providers/osm?plz=50733${q}`)
const plzReq = (q = '') => new NextRequest(`http://localhost/api/providers/openplz?plz=50733${q}`)

beforeEach(() => {
  st.user = { id: `u${++n}` } // eigene Nutzer-ID je Test: Rate-Limit stört nicht
  st.role = null; st.serviceCreated = 0; st.serviceCalls = []; st.cached = []; st.providerCalls = []
})

describe('OpenPLZ-Route: Rollen', () => {
  it.each(['owner', 'admin', 'manager'])('%s darf laden und in die Referenztabellen schreiben', async (role) => {
    st.role = role
    const { GET } = await import('@/app/api/providers/openplz/route')
    const res = await GET(plzReq())
    expect(res.status).toBe(200)
    expect((await res.json()).complete).toBe(true)
    expect(st.providerCalls).toContain('openplz-dir')
    expect(serviceWrites().length).toBeGreaterThan(0)
  })

  it('viewer: 403, kein Abruf, kein Service-Key, keine Schreibvorgänge', async () => {
    st.role = 'viewer'
    const { GET } = await import('@/app/api/providers/openplz/route')
    for (const q of ['', '&refresh=true']) {
      const res = await GET(plzReq(q))
      expect(res.status).toBe(403)
    }
    expect(st.providerCalls).toEqual([])
    expect(st.serviceCreated).toBe(0)
    expect(serviceWrites()).toEqual([])
  })

  it('ohne Firma: 403, ohne Login: 401, nichts passiert', async () => {
    const { GET } = await import('@/app/api/providers/openplz/route')
    st.role = null
    expect((await GET(plzReq())).status).toBe(403)
    st.user = null
    expect((await GET(plzReq())).status).toBe(401)
    expect(st.providerCalls).toEqual([])
    expect(st.serviceCreated).toBe(0)
    expect(serviceWrites()).toEqual([])
  })

  it('manager: erzwungenes Neuladen bleibt Inhaber/Admin vorbehalten', async () => {
    st.role = 'manager'
    const { GET } = await import('@/app/api/providers/openplz/route')
    expect((await GET(plzReq('&refresh=true'))).status).toBe(403)
    expect(st.providerCalls).toEqual([])
  })

  it('admin: erzwungenes Neuladen erlaubt', async () => {
    st.role = 'admin'
    const { GET } = await import('@/app/api/providers/openplz/route')
    expect((await GET(plzReq('&refresh=true'))).status).toBe(200)
  })
})

describe('OSM-Route: Rollen', () => {
  it.each(['owner', 'admin', 'manager'])('%s darf laden und schreiben (Cache leer)', async (role) => {
    st.role = role
    const { GET } = await import('@/app/api/providers/osm/route')
    const res = await GET(osmReq())
    expect(res.status).toBe(200)
    expect((await res.json()).count).toBe(1)
    expect(st.providerCalls).toContain('osm-pois')
    expect(serviceWrites().length).toBeGreaterThan(0)
  })

  it('viewer: gespeicherte Daten bleiben lesbar (Karte, POI-Liste)', async () => {
    st.role = 'viewer'
    st.cached = [{ postal_code: '50733', name: 'Hotel Y', category: 'hotel' }]
    const { GET } = await import('@/app/api/providers/osm/route')
    const res = await GET(osmReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(1)
    expect(body.from_cache).toBe(true)
    expect(st.providerCalls).toEqual([])
    expect(serviceWrites()).toEqual([])
  })

  it('viewer: ohne gespeicherte Daten kein Abruf und kein Schreiben, verständlicher Hinweis', async () => {
    st.role = 'viewer'
    const { GET } = await import('@/app/api/providers/osm/route')
    const res = await GET(osmReq())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(0)
    expect(body.read_only).toBe(true)
    expect(String(body.warning)).toMatch(/Schreibrecht/)
    expect(st.providerCalls).toEqual([])
    expect(serviceWrites()).toEqual([])
  })

  it('viewer: auch Teil-Kategorien und refresh ändern daran nichts', async () => {
    st.role = 'viewer'
    const { GET } = await import('@/app/api/providers/osm/route')
    const a = await GET(osmReq('&categories=hotel'))
    expect((await a.json()).read_only).toBe(true)
    const b = await GET(osmReq('&refresh=true'))
    expect(b.status).toBe(403)
    expect(st.providerCalls).toEqual([])
    expect(serviceWrites()).toEqual([])
  })

  it('ohne Firma: 403, ohne Login: 401, nichts passiert', async () => {
    const { GET } = await import('@/app/api/providers/osm/route')
    st.role = null
    expect((await GET(osmReq())).status).toBe(403)
    st.user = null
    expect((await GET(osmReq())).status).toBe(401)
    expect(st.providerCalls).toEqual([])
    expect(st.serviceCreated).toBe(0)
  })

  it('manager: erzwungenes Neuladen bleibt Inhaber/Admin vorbehalten', async () => {
    st.role = 'manager'
    const { GET } = await import('@/app/api/providers/osm/route')
    expect((await GET(osmReq('&refresh=true'))).status).toBe(403)
    expect(st.providerCalls).toEqual([])
  })
})
