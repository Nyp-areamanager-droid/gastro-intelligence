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
  const storageOptions: Record<string, unknown>[] = []
  const storageRemoved: string[] = []
  const client = {
    calls,
    storageRemoved,
    storageUploads,
    storageOptions,
    from(table: string) {
      const call: Call = { table, ops: [] }
      calls.push(call)
      const builder: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'neq', 'is', 'gt', 'in', 'insert', 'update', 'delete', 'upsert', 'order', 'limit', 'range']) {
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
        remove: (paths: string[]) => { storageRemoved.push(...paths); return Promise.resolve({ data: paths.map(name => ({ name })), error: null }) },
        upload: (path: string, _body: unknown, opts: Record<string, unknown>) => { storageUploads.push(path); storageOptions.push(opts); return Promise.resolve({ error: null }) },
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
    // Die Originaldatei wird nicht gespeichert (sie kann Namen und Telefonnummern enthalten)
    expect(state.authClient!.storageUploads).toHaveLength(0)
    // Erst wird geprüft, ob es schon Uploads gibt (Lesen), dann angelegt
    const uploadInsert = state.authClient!.calls.find(c => c.table === 'uploads' && c.ops.some(([op]) => op === 'insert'))!
    const uploadCheck = state.authClient!.calls.find(c => c.table === 'uploads' && c.ops.some(([op]) => op === 'select') && !c.ops.some(([op]) => op === 'insert'))!
    expect(uploadCheck.ops).toContainEqual(['eq', ['company_id', 'A']])
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
        : call.table === 'postal_codes'
          ? { data: [{ postal_code: '50733', population: 24000, households: 13000, population_method: 'zensus2022_gitter100m_plz_osm' }], error: null }
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
    const update = analyticsCalls.find(c => c.ops.some(([op]) => op === 'update'))!
    expect(update.ops.find(([op]) => op === 'update')![1][0]).toEqual({ population: 24000, market_penetration_pct: 0.08, not_reached_residents: 23980 })
    // Referenzdaten werden von dieser Route nicht mehr geschrieben
    expect(state.serviceClient!.calls).toHaveLength(0)
  })

  it('unbelegte Einwohnerzahl (alte Tabelle, ohne Methode) wird entfernt, nicht übernommen', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'manager' }], null, (call) =>
      call.table === 'analytics' && call.ops.some(([op]) => op === 'select')
        ? { data: [{ id: 'an1', postal_code: '50733', population: 24800, customer_count: 20, order_count: 65 }], error: null }
        : call.table === 'postal_codes'
          ? { data: [{ postal_code: '50733', population: 24800, households: 14200, population_method: null }], error: null }
          : { data: null, error: null })
    const { POST } = await import('@/app/api/sync-population/route')
    const res = await POST()
    expect(res.status).toBe(200)
    const update = state.authClient!.calls.find(c => c.table === 'analytics' && c.ops.some(([op]) => op === 'update'))!
    expect(update.ops.find(([op]) => op === 'update')![1][0]).toEqual({ population: null, market_penetration_pct: null, not_reached_residents: null })
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

  it('OpenPLZ-Abruf schreibt nie Einwohnerzahlen (die kommen nur aus dem Zensus-Import)', async () => {
    providerState.census = { population: 24800, households: 14200, year: 2022 }
    const { GET } = await import('@/app/api/providers/openplz/route')
    await GET(new NextRequest('http://localhost/api/providers/openplz?plz=50733'))
    const upsert = state.serviceClient!.calls.find(c => c.table === 'postal_codes')!
    const row = upsert.ops.find(([op]) => op === 'upsert')![1][0] as Record<string, unknown>
    expect('population' in row).toBe(false)
    expect('households' in row).toBe(false)
    expect('population_source' in row).toBe(false)
  })
})

// ── Nr. 10: Upload-Prüfung auf dem Server ────────────────────────────────────

function fileRequest(content: BlobPart[], name: string, type: string, headers: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('file', new File(content, name, { type }))
  return new Request('http://localhost/api/upload', { method: 'POST', body: fd, headers })
}

describe('POST /api/upload – Datei wird vor dem Lesen geprüft', () => {
  beforeEach(() => {
    state.serviceCreated = 0
    state.serviceClient = makeQueryClient(() => ({ data: null, error: null }))
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'manager' }])
  })
  const nothingStored = () => {
    expect(state.authClient!.storageUploads).toHaveLength(0)
    expect(state.authClient!.calls.filter(c => c.ops.some(([op]) => ['insert', 'delete', 'update', 'upsert'].includes(op)))).toHaveLength(0)
    expect(state.serviceClient!.calls).toHaveLength(0)
  }

  it('falsche Endung (.html): 415, nichts gespeichert', async () => {
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(fileRequest(['<script>alert(1)</script>'], 'kunden.html', 'text/html') as any)
    expect(res.status).toBe(415)
    nothingStored()
  })

  it('getarnte Datei (.xlsx, Inhalt ist Text): 415, nichts gespeichert', async () => {
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(fileRequest(['PLZ;Straße\n50733;Neusser Str. 1'], 'kunden.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') as any)
    expect(res.status).toBe(415)
    expect((await res.json()).error).toMatch(/passt nicht zur Endung/)
    nothingStored()
  })

  it('Binärdatei als .csv: 415, nichts gespeichert', async () => {
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(fileRequest([new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03])], 'kunden.csv', 'text/csv') as any)
    expect(res.status).toBe(415)
    nothingStored()
  })

  it('zu groß (Angabe im Kopf der Anfrage): 413, ohne die Datei zu lesen', async () => {
    const { POST } = await import('@/app/api/upload/route')
    const req = { headers: new Headers({ 'content-length': String(50 * 1024 * 1024) }), formData: () => { throw new Error('darf nicht gelesen werden') } }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(req as any)
    expect(res.status).toBe(413)
    nothingStored()
  })

  it('zu groß (Datei selbst): 413, nichts gespeichert', async () => {
    const { POST } = await import('@/app/api/upload/route')
    const big = 'PLZ;Straße\n' + '50733;Neusser Str. 1\n'.repeat(220_000)  // gut 4,4 MB
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(fileRequest([big], 'kunden.csv', 'text/csv') as any)
    expect(res.status).toBe(413)
    nothingStored()
  })

  it('mehr als 100 verschiedene PLZ: 422, nichts gespeichert', async () => {
    const { POST } = await import('@/app/api/upload/route')
    const rows = Array.from({ length: 101 }, (_, i) => `${String(10000 + i * 7)};Hauptstr. 1;Kunde ${i}`).join('\n')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(fileRequest(['PLZ;Straße;Name\n' + rows], 'kunden.csv', 'text/csv') as any)
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/101 verschiedene Postleitzahlen/)
    nothingStored()
  })

  it('gültige CSV: Originaldatei wird nicht gespeichert, Dateityp bestimmt der Server', async () => {
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await POST(fileRequest(['PLZ;Straße\n50733;Neusser Str. 1'], 'kunden.csv', 'text/html') as any)
    expect(state.authClient!.storageUploads).toHaveLength(0)
    const insert = state.authClient!.calls.find(c => c.table === 'uploads' && c.ops.some(([op]) => op === 'insert'))!
    const rec = insert.ops.find(([op]) => op === 'insert')![1][0] as Record<string, unknown>
    expect(rec.file_type).toBe('text/csv')
    expect(rec.storage_path).toBe('nicht-gespeichert')
  })
})

// ── Importvorschau: zeigt alles, speichert nichts ────────────────────────────
describe('POST /api/upload mit preview=1', () => {
  beforeEach(() => {
    state.serviceCreated = 0
    state.serviceClient = makeQueryClient(() => ({ data: null, error: null }))
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'manager' }])
  })
  const previewRequest = (csv: string, extra: Record<string, string> = {}) => {
    const fd = new FormData()
    fd.append('file', new File([csv], 'kunden.csv', { type: 'text/csv' }))
    fd.append('preview', '1')
    for (const [k, v] of Object.entries(extra)) fd.append(k, v)
    return new Request('http://localhost/api/upload', { method: 'POST', body: fd })
  }
  const CSV = 'Telefon;Vorname;Nachname;E-Mail;Straße;PLZ;Bestellungen;Umsatz;Letztes Bestelldatum\n' +
    '0221 1000000;Nina;Weiß;nina@example.org;Aachener Straße 10;50859;5;143,91;13.09.2026\n' +
    '0221 1000001;Yusuf;Kaya;;Hohe Straße 12;50667;2;43,61;26.09.2026\n' +
    '0221 1000002;Eva;Berg;;Ring 4;ABCDE;1;10,00;01.09.2026\n' +
    '0221 1000001;Yusuf;Kaya;;Hohe Straße 12;50667;2;43,61;26.09.2026\n'

  it('liefert Zuordnung, Summen, Zeitraum und Fehlerbericht – und schreibt nichts', async () => {
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await POST(previewRequest(CSV) as any)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.preview).toBe(true)
    expect(body.mapping.postal_code).toBe('PLZ')
    expect(body.counts).toMatchObject({ rows_in_file: 4, rows_valid: 2, rows_skipped: 1, duplicates: 1, postal_codes: 2 })
    expect(body.totals).toEqual({ orders: 7, revenue: 187.52 })
    expect(body.period).toMatchObject({ start: '2026-09-13', end: '2026-09-26', from_file: true })
    expect(body.problems).toEqual([
      { row: 4, reason: 'Ungültige Postleitzahl „ABCDE“ – Zeile nicht übernommen' },
      { row: 5, reason: 'Zeile ist in allen Spalten identisch mit einer früheren Zeile – als doppelt nicht übernommen' },
    ])
    // nichts gespeichert, nichts geschrieben
    expect(state.authClient!.storageUploads).toHaveLength(0)
    expect(state.authClient!.calls.filter(c => c.ops.some(([op]) => ['insert', 'delete', 'update', 'upsert'].includes(op)))).toHaveLength(0)
    expect(state.serviceClient!.calls.filter(c => c.ops.some(([op]) => ['insert', 'delete', 'update', 'upsert'].includes(op)))).toHaveLength(0)
  })

  it('zeigt keine Namen, E-Mails oder Telefonnummern – auch nicht in den Beispielzeilen', async () => {
    const { POST } = await import('@/app/api/upload/route')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await (await POST(previewRequest(CSV) as any)).json()
    expect(body.not_stored).toEqual(['Vorname', 'Nachname', 'E-Mail'])
    expect(body.phone_pseudonymized).toBe(true)
    const sample = JSON.stringify(body.sample)
    for (const secret of ['Nina', 'Kaya', 'example.org', '1000000', '0221']) expect(sample).not.toContain(secret)
    expect(body.sample[0]).toMatchObject({ postal_code: '50859', street: 'Aachener Straße', total_orders: 5, has_phone_mark: true })
  })

  it('Zuordnung des Nutzers hat Vorrang vor der automatischen Erkennung', async () => {
    const { POST } = await import('@/app/api/upload/route')
    const csv = 'Gebiet;Wert;Menge\n50733;100,50;4\n50735;20,00;1\n'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const without = await POST(previewRequest(csv) as any)
    const first = await without.json()
    expect(first).toMatchObject({ preview: true, needs_mapping: true, headers: ['Gebiet', 'Wert', 'Menge'] })   // keine PLZ-Spalte erkannt
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const body = await (await POST(previewRequest(csv, { mapping: JSON.stringify({ postal_code: 'Gebiet', total_revenue: 'Wert', total_orders: 'Menge', hack: 'Gebiet', street: 'GibtEsNicht' }) }) as any)).json()
    expect(body.mapping).toMatchObject({ postal_code: 'Gebiet', total_revenue: 'Wert', total_orders: 'Menge' })
    expect(body.mapping.hack).toBeUndefined(); expect(body.mapping.street).toBeUndefined()
    expect(body.totals).toEqual({ orders: 5, revenue: 120.5 })
  })
})

// ── Daten löschen, Export, Konto ─────────────────────────────────────────────

const jsonReq = (method: string, body?: unknown) => new NextRequest('http://localhost/api/data', { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('DELETE /api/data – alle Daten der eigenen Firma löschen', () => {
  beforeEach(async () => { state.serviceCreated = 0; (await import('@/lib/security/rate-limit')).resetRateLimits() })
  const deletes = () => state.authClient!.calls.filter(c => c.ops.some(([op]) => op === 'delete'))

  it('ohne Anmeldung: 401, nichts gelöscht', async () => {
    state.authClient = makeAuthClient(null, null)
    const { DELETE } = await import('@/app/api/data/route')
    expect((await DELETE(jsonReq('DELETE', { confirm: 'LÖSCHEN' }))).status).toBe(401)
    expect(deletes()).toHaveLength(0)
  })
  it.each(['manager', 'viewer'])('Rolle %s: 403, nichts gelöscht', async role => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role }])
    const { DELETE } = await import('@/app/api/data/route')
    expect((await DELETE(jsonReq('DELETE', { confirm: 'LÖSCHEN' }))).status).toBe(403)
    expect(deletes()).toHaveLength(0)
  })
  it('ohne Bestätigungswort: 400, nichts gelöscht', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'owner' }])
    const { DELETE } = await import('@/app/api/data/route')
    expect((await DELETE(jsonReq('DELETE', { confirm: 'ja' }))).status).toBe(400)
    expect((await DELETE(jsonReq('DELETE'))).status).toBe(400)
    expect(deletes()).toHaveLength(0)
  })
  it('Inhaber: löscht nur in der eigenen Firma, in der richtigen Reihenfolge; fremde Firmen-ID in der Anfrage wird ignoriert', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'owner' }], null,
      call => call.table === 'uploads' && call.ops.some(([op]) => op === 'select') && !call.ops.some(([op]) => op === 'delete')
        ? { data: [{ storage_path: 'A/1_alt.csv' }, { storage_path: 'B/2_fremd.csv' }, { storage_path: 'nicht-gespeichert' }, { storage_path: null }], error: null }
        : { data: null, error: null })
    const { DELETE } = await import('@/app/api/data/route')
    const res = await DELETE(jsonReq('DELETE', { confirm: 'LÖSCHEN', company_id: 'B' }))
    expect(res.status).toBe(200)
    expect(deletes().map(c => c.table)).toEqual(['marketing_actions', 'alerts', 'street_analytics', 'analytics', 'customers', 'uploads'])
    for (const c of deletes()) expect(c.ops).toContainEqual(['eq', ['company_id', 'A']])
    // nur Dateien aus dem eigenen Firmenordner
    expect(state.authClient!.storageRemoved).toEqual(['A/1_alt.csv'])
    expect(state.serviceCreated).toBe(0)
  })
})

describe('GET /api/export', () => {
  beforeEach(async () => { (await import('@/lib/security/rate-limit')).resetRateLimits() })
  it('ohne Anmeldung: 401', async () => {
    state.authClient = makeAuthClient(null, null)
    const { GET } = await import('@/app/api/export/route')
    expect((await GET(new NextRequest('http://localhost/api/export?type=plz'))).status).toBe(401)
  })
  it('unbekannter Typ: 400', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'viewer' }])
    const { GET } = await import('@/app/api/export/route')
    expect((await GET(new NextRequest('http://localhost/api/export?type=kunden'))).status).toBe(400)
  })
  it('Straßen: CSV nur aus der eigenen Firma, Formeln entschärft', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'viewer' }], null, call => {
      if (call.table === 'analytics') return { data: [{ id: 'an1', postal_code: '50733', computed_at: '2026-11-01' }], error: null }
      if (call.table === 'street_analytics') return { data: [{ postal_code: '50733', street_name: '=HYPERLINK("http://evil")', customer_count: 2, order_count: 5, revenue: 120.5, street_class: 'A', is_in_official_list: true }], error: null, count: 1 } as never
      return { data: null, error: null }
    })
    const { GET } = await import('@/app/api/export/route')
    const res = await GET(new NextRequest('http://localhost/api/export?type=strassen'))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="gastro-intelligence-strassen-\d{4}-\d{2}-\d{2}\.csv"/)
    const text = await res.text()
    expect(text).toContain(`50733;"'=HYPERLINK(""http://evil"")";2;5;120,5;A;ja`)
    for (const c of state.authClient!.calls.filter(c => ['analytics', 'street_analytics'].includes(c.table))) expect(c.ops).toContainEqual(['eq', ['company_id', 'A']])
  })
})

describe('GET /api/account', () => {
  it('ohne Anmeldung: 401', async () => {
    state.authClient = makeAuthClient(null, null)
    const { GET } = await import('@/app/api/account/route')
    expect((await GET()).status).toBe(401)
  })
  it('liest nur die eigene Firma', async () => {
    state.authClient = makeAuthClient({ id: 'u1' }, [{ company_id: 'A', role: 'viewer' }])
    const { GET } = await import('@/app/api/account/route')
    const res = await GET()
    expect(res.status).toBe(200)
    for (const c of state.authClient!.calls.filter(c => ['stores', 'uploads', 'customers', 'analytics'].includes(c.table))) expect(c.ops).toContainEqual(['eq', ['company_id', 'A']])
    expect(state.authClient!.calls.find(c => c.table === 'companies')!.ops).toContainEqual(['eq', ['id', 'A']])
  })
})
