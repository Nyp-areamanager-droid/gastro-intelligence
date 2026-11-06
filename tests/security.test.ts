// =============================================================================
// Phase 0 – Sicherheit: Firmenprüfung, Upload-Route, sync-population,
// Registrierung. Läuft ohne Datenbank (Supabase-Clients sind Attrappen).
// =============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import {
  resolveCompanyContext, hasRole, canWriteCompanyData, sanitizeStorageFileName,
} from '@/lib/auth/company-context'
import { validateRegistrationInput, validateCompanyName, buildCompanySlug } from '@/lib/auth/registration'

// ── Attrappen ────────────────────────────────────────────────────────────────

type Call = { table: string; ops: [string, unknown[]][] }

/** Kette wie im Supabase-Client: from().select().eq()...  – zeichnet alles auf */
function makeQueryClient(resolver: (call: Call) => { data: unknown; error: unknown }) {
  const calls: Call[] = []
  const storageUploads: string[] = []
  const client = {
    calls,
    storageUploads,
    from(table: string) {
      const call: Call = { table, ops: [] }
      calls.push(call)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'gt', 'in', 'insert', 'update', 'delete', 'upsert', 'order', 'limit']) {
        builder[op] = (...args: unknown[]) => { call.ops.push([op, args]); return builder }
      }
      const finish = () => Promise.resolve(resolver(call))
      builder.single = () => { call.ops.push(['single', []]); return finish() }
      builder.maybeSingle = () => { call.ops.push(['maybeSingle', []]); return finish() }
      builder.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        finish().then(onOk, onErr)
      return builder
    },
    storage: {
      from: () => ({
        upload: (path: string) => { storageUploads.push(path); return Promise.resolve({ error: null }) },
      }),
    },
  }
  return client
}

/**
 * Sitzungs-Client: Mitgliedschaften für company_users, für alle anderen
 * Tabellen die Antwort aus `other` (Standard: leer). Seit Phase 0+ schreibt der
 * Server Firmendaten mit DIESEM Client (RLS), nicht mit dem Service-Key.
 */
function makeAuthClient(
  user: { id: string } | null,
  memberships: { company_id: string; role: string }[] | null,
  membershipError: unknown = null,
  other: (call: Call) => { data: unknown; error: unknown } = () => ({ data: null, error: null }),
) {
  const client = makeQueryClient((call) =>
    call.table === 'company_users' && !call.ops.some(([op]) => op === 'insert' || op === 'delete')
      ? { data: memberships, error: membershipError }
      : other(call))
  const rpcCalls: { fn: string; args: Record<string, unknown> }[] = []
  return Object.assign(client, {
    rpcCalls,
    rpcResult: { data: { status: 'created', company_id: 'firma-neu' } as unknown, error: null as unknown },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args })
      return Promise.resolve((client as unknown as { rpcResult: unknown }).rpcResult)
    },
    auth: { getUser: () => Promise.resolve({ data: { user }, error: null }) },
  })
}

// ── resolveCompanyContext ────────────────────────────────────────────────────

describe('resolveCompanyContext', () => {
  it('lehnt ohne Sitzung mit 401 ab', async () => {
    const r = await resolveCompanyContext(makeAuthClient(null, []))
    expect(r).toEqual({ ok: false, status: 401, error: 'Nicht authentifiziert' })
  })

  it('lehnt ohne Firmenzugehörigkeit mit 403 ab', async () => {
    const r = await resolveCompanyContext(makeAuthClient({ id: 'u1' }, []))
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(403)
  })

  it('lehnt bei mehreren Firmen mit 409 ab statt zufällig zu wählen', async () => {
    const r = await resolveCompanyContext(makeAuthClient({ id: 'u1' }, [
      { company_id: 'A', role: 'owner' }, { company_id: 'B', role: 'viewer' },
    ]))
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(409)
  })

  it('meldet Datenbankfehler als 500, nicht als "kein Zugriff"', async () => {
    const r = await resolveCompanyContext(makeAuthClient({ id: 'u1' }, null, { message: 'boom' }))
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.status).toBe(500)
  })

  it('liefert Nutzer, Firma und Rolle aus der Sitzung', async () => {
    const client = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'admin' }])
    const r = await resolveCompanyContext(client)
    expect(r).toEqual({ ok: true, ctx: { userId: 'u1', companyId: 'A', role: 'admin' } })
    // Abfrage muss auf den eingeloggten Nutzer gefiltert sein
    expect(client.calls[0].table).toBe('company_users')
    expect(client.calls[0].ops).toContainEqual(['eq', ['user_id', 'u1']])
  })

  it('hasRole prüft die erlaubten Rollen', () => {
    const ctx = { userId: 'u1', companyId: 'A', role: 'manager' as const }
    expect(hasRole(ctx, ['owner', 'admin'])).toBe(false)
    expect(hasRole(ctx, ['owner', 'admin', 'manager'])).toBe(true)
  })
})

// ── Dateinamen im Storage ────────────────────────────────────────────────────

describe('sanitizeStorageFileName', () => {
  it('verhindert Ordnerwechsel aus dem eigenen Firmenordner', () => {
    expect(sanitizeStorageFileName('../andere-firma/kunden.xlsx')).toBe('kunden.xlsx')
    expect(sanitizeStorageFileName('..\\..\\x.csv')).toBe('x.csv')
  })
  it('ersetzt Leer- und Sonderzeichen', () => {
    expect(sanitizeStorageFileName('Kunden Nippes (Okt).xlsx')).toBe('Kunden_Nippes_Okt_.xlsx')
  })
  it('liefert einen Ersatznamen für leere Namen', () => {
    expect(sanitizeStorageFileName('')).toBe('upload')
    expect(sanitizeStorageFileName('..')).toBe('upload')
  })
})

// ── Registrierung ────────────────────────────────────────────────────────────

describe('validateCompanyName', () => {
  it('bereinigt Leerzeichen und prüft die Länge', () => {
    expect(validateCompanyName('  Muster   GmbH ')).toEqual({ ok: true, value: 'Muster GmbH' })
    expect(validateCompanyName('x').ok).toBe(false)
    expect(validateCompanyName(undefined).ok).toBe(false)
    expect(validateCompanyName('a'.repeat(101)).ok).toBe(false)
  })
})

describe('validateRegistrationInput', () => {
  it('akzeptiert gültige Eingaben und normalisiert die E-Mail', () => {
    const r = validateRegistrationInput({ email: ' Max@Firma.DE ', password: 'geheim123', companyName: ' Muster GmbH ' })
    expect(r).toEqual({ ok: true, value: { email: 'max@firma.de', password: 'geheim123', companyName: 'Muster GmbH' } })
  })
  it('lehnt ungültige E-Mail, kurzes Passwort und leeren Firmennamen ab', () => {
    expect(validateRegistrationInput({ email: 'kein-at', password: 'geheim123', companyName: 'AB' }).ok).toBe(false)
    expect(validateRegistrationInput({ email: 'a@b.de', password: 'kurz', companyName: 'AB' }).ok).toBe(false)
    expect(validateRegistrationInput({ email: 'a@b.de', password: 'geheim123', companyName: ' ' }).ok).toBe(false)
  })
  it('ignoriert eingeschmuggelte Felder wie user_id oder company_id', () => {
    const r = validateRegistrationInput({ email: 'a@b.de', password: 'geheim123', companyName: 'Firma', user_id: 'x', company_id: 'y' })
    expect(r.ok && Object.keys(r.value).sort()).toEqual(['companyName', 'email', 'password'])
  })
  it('baut den Slug wie bisher', () => {
    expect(buildCompanySlug('Müller & Söhne GmbH', 123)).toBe('m-ller-s-hne-gmbh-123')
  })
})

// ── API-Routen mit Attrappen ─────────────────────────────────────────────────

const state: {
  authClient: ReturnType<typeof makeAuthClient> | null
  serviceClient: ReturnType<typeof makeQueryClient> | null
  serviceCreated: number
} = { authClient: null, serviceClient: null, serviceCreated: 0 }

// Externe Datenquellen (OSM, OpenPLZ, Zensus) als steuerbare Attrappen
const providerState: {
  osmResults: { osm_id: number; name: string; lat: number; lng: number; tags: Record<string, string> }[]
  census: { population: number; households: number; year: number } | null
} = { osmResults: [], census: null }

vi.mock('@/lib/providers', () => ({
  osmProvider: {
    getBoundingBox: async () => [50.9, 51.0, 6.9, 7.0],
    getPOIsByPostalCode: async () => providerState.osmResults,
    classifyOSMCategory: (tags: Record<string, string>) => (tags.tourism === 'hotel' ? 'hotel' : 'restaurant'),
    isCompetitor: () => false,
  },
  openplzProvider: {
    getStreetsByPostalCode: async () => [{ name: 'Neusser Str.' }],
    getStreetDirectory: async (plz: string) => ({
      postalCode: plz, status: 'complete', source: 'openplz',
      streets: [{ name: 'Neusser Str.', key: 'neusserstr', localities: ['Köln'] }],
      totalReported: 1, totalFetched: 1, pagesFetched: 1, fetchedAt: new Date().toISOString(),
    }),
    getPostalCodeInfo: async () => ({ city: 'Köln', state: 'NRW' }),
  },
  censusProvider: { getCensusData: () => providerState.census },
  DataProviderOrchestrator: class {},
}))

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabaseClient: () => state.authClient,
  createReferenceDataClient: () => { state.serviceCreated++; return state.serviceClient },
}))

function uploadRequest(fields: Record<string, string>) {
  const fd = new FormData()
  fd.append('file', new File(['PLZ;Straße\n50733;Neusser Str. 1'], 'kunden.csv', { type: 'text/csv' }))
  for (const [k, v] of Object.entries(fields)) fd.append(k, v)
  return new Request('http://localhost/api/upload', { method: 'POST', body: fd })
}

describe('POST /api/upload – Mandantentrennung', () => {
  beforeEach(() => {
    state.serviceCreated = 0
    state.serviceClient = makeQueryClient(() => ({ data: null, error: null }))
  })

  it('ohne Sitzung: 401, Service-Key wird gar nicht erst erzeugt', async () => {
    state.authClient = makeAuthClient(null, [])
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(uploadRequest({ company_id: 'A' }) as any)
    expect(res.status).toBe(401)
    expect(state.serviceCreated).toBe(0)
  })

  it('fremde company_id im Formular: 403, nichts wird gespeichert', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'owner' }])
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(uploadRequest({ company_id: 'FREMDE-FIRMA', user_id: 'u1' }) as any)
    expect(res.status).toBe(403)
    expect(state.authClient!.storageUploads).toHaveLength(0)
    expect(state.authClient!.calls.filter(c => c.ops.some(([op]) => op === 'insert' || op === 'delete'))).toHaveLength(0)
    expect(state.serviceClient!.calls).toHaveLength(0)
  })

  it('Filiale einer fremden Firma: 403, nichts wird gespeichert', async () => {
    // stores-Abfrage findet nichts für (store_id, company A)
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'owner' }])
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(uploadRequest({ company_id: 'A', store_id: 'filiale-von-B' }) as any)
    expect(res.status).toBe(403)
    const storeCall = state.authClient!.calls.find(c => c.table === 'stores')!
    expect(storeCall.ops).toContainEqual(['eq', ['company_id', 'A']])
    expect(state.authClient!.storageUploads).toHaveLength(0)
  })

  it('eigene Firma: Datei und Upload-Eintrag mit der Sitzung, Ordner und user_id aus der Sitzung', async () => {
    // uploads-Insert liefert keinen Datensatz -> Route bricht nach Storage-Upload kontrolliert ab
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'manager' }])
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(uploadRequest({ user_id: 'jemand-anderes' }) as any)
    expect(state.authClient!.storageUploads).toHaveLength(1)
    expect(state.authClient!.storageUploads[0]).toMatch(/^A\/\d+_kunden\.csv$/)
    const uploadInsert = state.authClient!.calls.find(c => c.table === 'uploads')!
    const inserted = uploadInsert.ops.find(([op]) => op === 'insert')![1][0] as Record<string, unknown>
    expect(inserted.company_id).toBe('A')
    expect(inserted.uploaded_by).toBe('u1')
    // Mit dem Service-Key wurde dabei keine Firmentabelle angefasst
    expect(state.serviceClient!.calls.filter(c => !['postal_codes', 'streets'].includes(c.table))).toHaveLength(0)
  })
})

describe('POST /api/sync-population – nur eigene Firma', () => {
  it('ohne Sitzung: 401', async () => {
    state.authClient = makeAuthClient(null, [])
    state.serviceCreated = 0
    const { POST } = await import('@/app/api/sync-population/route')
    const res = await POST()
    expect(res.status).toBe(401)
    expect(state.serviceCreated).toBe(0)
  })

  it('liest und ändert nur Analysen der eigenen Firma', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'manager' }], null, (call) =>
      call.table === 'analytics' && call.ops.some(([op]) => op === 'select')
        ? { data: [{ id: 'an1', postal_code: '50733', population: null, customer_count: 20, order_count: 65 }], error: null }
        : { data: null, error: null })
    state.serviceClient = makeQueryClient(() => ({ data: null, error: null }))
    const { POST } = await import('@/app/api/sync-population/route')
    const res = await POST()
    expect(res.status).toBe(200)
    // Analysen der Firma: nur mit der Sitzung, nie mit dem Service-Key
    expect(state.serviceClient!.calls.some(c => c.table === 'analytics')).toBe(false)
    const analyticsCalls = state.authClient!.calls.filter(c => c.table === 'analytics')
    expect(analyticsCalls.length).toBe(2) // ein select, ein update
    for (const c of analyticsCalls) expect(c.ops).toContainEqual(['eq', ['company_id', 'A']])
  })
})

// ── Rollen: viewer darf nichts verändern ─────────────────────────────────────

describe('Rollen – nur owner, admin, manager dürfen Daten schreiben', () => {
  beforeEach(() => {
    state.serviceCreated = 0
    state.serviceClient = makeQueryClient(() => ({ data: null, error: null }))
  })

  it('canWriteCompanyData: viewer nein, manager/admin/owner ja', () => {
    const ctx = (role: 'owner' | 'admin' | 'manager' | 'viewer') => ({ userId: 'u', companyId: 'A', role })
    expect(canWriteCompanyData(ctx('viewer'))).toBe(false)
    expect(canWriteCompanyData(ctx('manager'))).toBe(true)
    expect(canWriteCompanyData(ctx('admin'))).toBe(true)
    expect(canWriteCompanyData(ctx('owner'))).toBe(true)
  })

  it('viewer: Upload wird mit 403 abgelehnt, Service-Key wird nicht erzeugt', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'viewer' }])
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(uploadRequest({}) as any)
    expect(res.status).toBe(403)
    expect(state.serviceCreated).toBe(0)
  })

  it('viewer: sync-population ändert nichts (403)', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'viewer' }])
    const { POST } = await import('@/app/api/sync-population/route')
    const res = await POST()
    expect(res.status).toBe(403)
    expect(state.serviceCreated).toBe(0)
  })

  it('viewer: erzwungenes Neuladen der Referenzdaten wird abgelehnt', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'manager' }])
    const osm = await import('@/app/api/providers/osm/route')
    const res = await osm.GET(new NextRequest('http://localhost/api/providers/osm?plz=50733&refresh=true'))
    expect(res.status).toBe(403)
    const openplz = await import('@/app/api/providers/openplz/route')
    const res2 = await openplz.GET(new NextRequest('http://localhost/api/providers/openplz?plz=50733&refresh=true'))
    expect(res2.status).toBe(403)
  })

  it('ohne Login: Provider-Routen antworten 401', async () => {
    state.authClient = makeAuthClient(null, [])
    const osm = await import('@/app/api/providers/osm/route')
    const res = await osm.GET(new NextRequest('http://localhost/api/providers/osm?plz=50733'))
    expect(res.status).toBe(401)
  })
})

// ── Registrierung abschließen ────────────────────────────────────────────────

describe('POST /api/auth/complete-registration', () => {
  function authWithUser(user: unknown, memberships: { company_id: string; role: string }[] | null = [], membershipError: unknown = null) {
    const client = makeAuthClient(null, memberships, membershipError)
    return Object.assign(client, {
      auth: { getUser: () => Promise.resolve({ data: { user }, error: null }) },
    })
  }
  beforeEach(() => { state.serviceCreated = 0 })

  it('ohne Sitzung: 401, nichts wird angelegt', async () => {
    const c = authWithUser(null); state.authClient = c
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(res.status).toBe(401)
    expect(c.rpcCalls).toHaveLength(0)
    expect(state.serviceCreated).toBe(0)
  })

  it('Nutzer hat schon eine Firma: nichts passiert (idempotent)', async () => {
    const c = authWithUser({ id: 'u1', user_metadata: { company_name: 'Firma' } }, [{ company_id: 'A', role: 'owner' }]); state.authClient = c
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(await res.json()).toEqual({ status: 'already_registered' })
    expect(c.rpcCalls).toHaveLength(0)
  })

  it('legt die Firma über register_company mit der Sitzung an, ohne Service-Key', async () => {
    const c = authWithUser({ id: 'neu-1', user_metadata: { company_name: '  Muster   GmbH ' } }); state.authClient = c
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(await res.json()).toEqual({ status: 'created' })
    expect(c.rpcCalls).toHaveLength(1)
    expect(c.rpcCalls[0].fn).toBe('register_company')
    expect(c.rpcCalls[0].args.p_name).toBe('Muster GmbH')
    expect(String(c.rpcCalls[0].args.p_slug)).toMatch(/^muster-gmbh-\d+$/)
    // keine Nutzer-ID im Aufruf: die Datenbank nimmt sie aus der Sitzung
    expect(Object.keys(c.rpcCalls[0].args).sort()).toEqual(['p_name', 'p_slug'])
    expect(c.calls.some(x => x.ops.some(([op]) => op === 'insert'))).toBe(false)
    expect(state.serviceCreated).toBe(0)
  })

  it('ohne gültigen Firmennamen: 400, nichts wird angelegt', async () => {
    const c = authWithUser({ id: 'u1', user_metadata: { company_name: 'x' } }); state.authClient = c
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(res.status).toBe(400)
    expect(c.rpcCalls).toHaveLength(0)
  })

  it('Datenbankfehler bei der Prüfung: 500, keine Firma', async () => {
    const c = authWithUser({ id: 'u1', user_metadata: { company_name: 'Firma' } }, null, { message: 'down' }); state.authClient = c
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(res.status).toBe(500)
    expect(c.rpcCalls).toHaveLength(0)
  })

  it('register_company schlägt fehl: 500', async () => {
    const c = authWithUser({ id: 'u1', user_metadata: { company_name: 'Firma' } }); state.authClient = c
    c.rpcResult = { data: null, error: { message: 'function not found' } }
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(res.status).toBe(500)
  })

  it('gleichzeitiger zweiter Aufruf: Datenbank meldet already_registered, Route gibt das weiter', async () => {
    const c = authWithUser({ id: 'u1', user_metadata: { company_name: 'Firma' } }); state.authClient = c
    c.rpcResult = { data: { status: 'already_registered', company_id: 'firma-alt' }, error: null }
    const { POST } = await import('@/app/api/auth/complete-registration/route')
    const res = await POST()
    expect(await res.json()).toEqual({ status: 'already_registered' })
  })
})

// ── Provider-Routen: kein Überschreiben gemeinsamer Daten ────────────────────

describe('Provider-Routen – gemeinsame Referenzdaten', () => {
  beforeEach(() => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'viewer' }])
    state.serviceClient = makeQueryClient(() => ({ data: [], error: null }))
    providerState.osmResults = []
    providerState.census = null
  })

  it('OSM liefert nichts (Dienst down): vorhandene POIs bleiben erhalten', async () => {
    providerState.osmResults = []
    const { GET } = await import('@/app/api/providers/osm/route')
    await GET(new NextRequest('http://localhost/api/providers/osm?plz=50733'))
    expect(state.serviceClient!.calls.some(c => c.table === 'poi_businesses' && c.ops.some(([op]) => op === 'delete'))).toBe(false)
  })

  it('OSM-Teilabfrage (nur hotel): andere Kategorien werden nicht gelöscht', async () => {
    providerState.osmResults = [{ osm_id: 1, name: 'Hotel X', lat: 50.9, lng: 6.9, tags: { tourism: 'hotel' } }]
    const { GET } = await import('@/app/api/providers/osm/route')
    await GET(new NextRequest('http://localhost/api/providers/osm?plz=50733&categories=hotel'))
    expect(state.serviceClient!.calls.some(c => c.table === 'poi_businesses' && c.ops.some(([op]) => op === 'delete'))).toBe(false)
  })

  it('OSM-Vollabfrage mit Ergebnis: Bestand wird ersetzt', async () => {
    providerState.osmResults = [{ osm_id: 1, name: 'Pizza X', lat: 50.9, lng: 6.9, tags: { amenity: 'fast_food' } }]
    const { GET } = await import('@/app/api/providers/osm/route')
    await GET(new NextRequest('http://localhost/api/providers/osm?plz=50733'))
    const poiCalls = state.serviceClient!.calls.filter(c => c.table === 'poi_businesses')
    expect(poiCalls.some(c => c.ops.some(([op]) => op === 'delete'))).toBe(true)
    expect(poiCalls.some(c => c.ops.some(([op]) => op === 'insert'))).toBe(true)
  })

  it('OpenPLZ ohne Zensuswert: Einwohnerzahl wird nicht mit null überschrieben', async () => {
    providerState.census = null
    const { GET } = await import('@/app/api/providers/openplz/route')
    await GET(new NextRequest('http://localhost/api/providers/openplz?plz=50733'))
    const upsert = state.serviceClient!.calls.find(c => c.table === 'postal_codes')!
    const row = upsert.ops.find(([op]) => op === 'upsert')![1][0] as Record<string, unknown>
    expect('population' in row).toBe(false)
    expect('households' in row).toBe(false)
  })

  it('OpenPLZ mit Zensuswert: Einwohnerzahl wird gespeichert', async () => {
    providerState.census = { population: 24800, households: 14200, year: 2022 }
    const { GET } = await import('@/app/api/providers/openplz/route')
    await GET(new NextRequest('http://localhost/api/providers/openplz?plz=50733'))
    const upsert = state.serviceClient!.calls.find(c => c.table === 'postal_codes')!
    const row = upsert.ops.find(([op]) => op === 'upsert')![1][0] as Record<string, unknown>
    expect(row.population).toBe(24800)
  })
})
