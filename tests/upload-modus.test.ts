// Upload-Route: dieselbe Datei, Ersetzen, Ergänzen – nichts darf doppelt zählen
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'crypto'

type Call = { table: string; ops: [string, unknown[]][] }
const state: {
  calls: Call[]; storage: string[]
  existingUploads: Record<string, unknown>[]
  existingCustomers: Record<string, unknown>[]
  failCustomerInsert: boolean
} = { calls: [], storage: [], existingUploads: [], existingCustomers: [], failCustomerInsert: false }

function client() {
  return {
    from(table: string) {
      const call: Call = { table, ops: [] }
      state.calls.push(call)
      const b: Record<string, unknown> = {}
      for (const op of ['select', 'eq', 'neq', 'is', 'in', 'gt', 'insert', 'update', 'delete', 'upsert', 'order', 'limit', 'range']) {
        b[op] = (...args: unknown[]) => { call.ops.push([op, args]); return b }
      }
      const has = (o: string) => call.ops.some(([x]) => x === o)
      const result = () => {
        if (table === 'company_users') return { data: [{ company_id: 'A', role: 'manager' }], error: null }
        if (table === 'uploads' && has('insert')) return { data: { id: 'neu' }, error: null }
        if (table === 'uploads' && has('select')) return { data: state.existingUploads, error: null }
        if (table === 'customers' && has('insert')) return { data: null, error: state.failCustomerInsert ? { message: 'kaputt' } : null }
        if (table === 'customers' && has('select')) return { data: state.existingCustomers, error: null, count: state.existingCustomers.length }
        if (table === 'analytics' && has('insert')) return { data: { id: 'an1' }, error: null }
        if (table === 'companies') return { data: { google_places_api_key: null }, error: null }
        return { data: null, error: null }
      }
      b.single = () => Promise.resolve(result())
      b.maybeSingle = () => Promise.resolve(result())
      b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, err)
      return b
    },
    storage: { from: () => ({ upload: (p: string) => { state.storage.push(p); return Promise.resolve({ error: null }) } }) },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u1' } }, error: null }) },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createReferenceDataClient: () => client(),
  createServerSupabaseClient: () => client(),
}))
vi.mock('@/lib/providers', async (orig) => {
  const actual = await orig<typeof import('@/lib/providers')>()
  class Orchestrator {
    async getStreets() { return { streets: [], complete: false, status: 'incomplete', source: 'openplz', count: 0 } }
    async getPostalCodeData(plz: string) { return { info: { postal_code: plz }, census: null } }
  }
  return { ...actual, DataProviderOrchestrator: Orchestrator }
})

const CSV = 'PLZ;Straße;Telefon;Bestellungen;Umsatz;Letzte Bestellung\n01067;Prager Str. 1;0351 1;2;30,00;10.11.2026\n80331;Marienplatz 2;089 2;1;12,50;12.11.2026'
const HASH = createHash('sha256').update(CSV).digest('hex')

function req(mode?: string, extra: Record<string, string> = {}) {
  const fd = new FormData()
  fd.append('file', new File([CSV], 'november.csv', { type: 'text/csv' }))
  if (mode) fd.append('mode', mode)
  for (const [k, v] of Object.entries(extra)) fd.append(k, v)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { headers: new Headers(), formData: async () => fd } as any
}
const old = (p: Record<string, unknown> = {}) => ({ id: 'alt', filename: 'oktober.xlsx', created_at: '2026-11-01T09:00:00Z', file_hash: 'anders', period_start: '2026-10-01', period_end: '2026-10-31', ...p })
const writes = (table: string) => state.calls.filter(c => c.table === table && c.ops.some(([o]) => ['insert', 'delete', 'update', 'upsert'].includes(o)))

beforeEach(() => {
  state.calls = []; state.storage = []; state.existingUploads = []; state.existingCustomers = []; state.failCustomerInsert = false
})

describe('Upload-Route mit vorhandenen Daten', () => {
  it('dieselbe Datei noch einmal: 409, nichts gespeichert, Hinweis verständlich', async () => {
    state.existingUploads = [old({ file_hash: HASH, filename: 'november.csv' })]
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req())
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe('duplicate_file')
    expect(body.error).toContain('bereits am 01.11.2026 hochgeladen')
    expect(state.storage).toHaveLength(0)
    expect(writes('customers')).toHaveLength(0)
    expect(writes('uploads')).toHaveLength(0)
  })

  it('neue Datei ohne Auswahl: 409 „bitte wählen“, nichts gespeichert', async () => {
    state.existingUploads = [old()]
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req())
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('choose_mode')
    expect(state.storage).toHaveLength(0)
    expect(writes('customers')).toHaveLength(0)
  })

  it('Daten ersetzen: erst neue Kunden speichern, dann alte löschen, alter Upload „replaced“', async () => {
    state.existingUploads = [old()]
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req('replace'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.import_mode).toBe('replace')
    const idxInsert = state.calls.findIndex(c => c.table === 'customers' && c.ops.some(([o]) => o === 'insert'))
    const idxDelete = state.calls.findIndex(c => c.table === 'customers' && c.ops.some(([o]) => o === 'delete'))
    expect(idxInsert).toBeGreaterThan(-1)
    expect(idxDelete).toBeGreaterThan(idxInsert)
    expect(state.calls[idxDelete].ops).toContainEqual(['in', ['upload_id', ['alt']]])
    expect(state.calls[idxDelete].ops).toContainEqual(['eq', ['company_id', 'A']])
    const marked = state.calls.find(c => c.table === 'uploads' && c.ops.some(([o, a]) => o === 'update' && (a[0] as { status?: string }).status === 'replaced'))
    expect(marked).toBeDefined()
    expect(body.totals).toEqual({ customers: 2, orders: 3, revenue: 42.5 })
  })

  it('Ergänzen mit späterem Zeitraum: gespeichert, nichts gelöscht', async () => {
    state.existingUploads = [old()]
    state.existingCustomers = [{ postal_code: '01067', street_normalized: 'prager straße', phone_normalized: '+493511', total_orders: 4, total_revenue: 60, house_number: '1', full_name: null }]
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req('append'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.import_mode).toBe('append')
    expect(state.calls.some(c => c.table === 'customers' && c.ops.some(([o]) => o === 'delete'))).toBe(false)
    // gleiche Telefonnummer in beiden Zeiträumen → ein Kunde: 2 statt 3 Kunden, Bestellungen 4+2+1
    expect(body.totals).toEqual({ customers: 2, orders: 7, revenue: 102.5 })
  })

  it('Ergänzen mit überlappendem Zeitraum: 409, nichts gespeichert', async () => {
    state.existingUploads = [old({ period_end: '2026-11-11' })]
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req('append'))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('append_overlap')
    expect(state.storage).toHaveLength(0)
  })

  it('Ergänzen mit denselben Zeilen (z. B. als CSV statt Excel): 409', async () => {
    state.existingUploads = [old()]
    state.existingCustomers = [
      { postal_code: '01067', street_normalized: 'pragerstr', house_number: '1', phone_normalized: '+493511', total_orders: 2, total_revenue: 30 },
      { postal_code: '80331', street_normalized: 'marienplatz', house_number: '2', phone_normalized: '+49892', total_orders: 1, total_revenue: 12.5 },
    ]
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req('append'))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.code).toBe('append_same_data')
    expect(body.error).toContain('100 %')
    expect(state.storage).toHaveLength(0)
  })

  it('Fehler beim Speichern: neue Zeilen werden entfernt, alte Daten bleiben', async () => {
    state.existingUploads = [old()]
    state.failCustomerInsert = true
    const { POST } = await import('@/app/api/upload/route')
    const res = await POST(req('replace'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('bisherigen Daten sind unverändert')
    const deletes = state.calls.filter(c => c.table === 'customers' && c.ops.some(([o]) => o === 'delete'))
    expect(deletes).toHaveLength(1)
    expect(deletes[0].ops).toContainEqual(['eq', ['upload_id', 'neu']])
    expect(state.calls.some(c => c.table === 'uploads' && c.ops.some(([o, a]) => o === 'update' && (a[0] as { status?: string }).status === 'replaced'))).toBe(false)
  })
})
