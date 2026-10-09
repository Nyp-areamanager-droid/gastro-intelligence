'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { normalizeStreetName } from '@/lib/analysis/engine'

interface StreetRow {
  name: string
  customers: number
  orders: number
  revenue: number
  class: string
  inOfficial: boolean
}

export default function StreetsPage() {
  const [plzList, setPlzList] = useState<string[]>([])
  const [selectedPLZ, setSelectedPLZ] = useState('')
  const [loading, setLoading] = useState(false)
  const [osmLoading, setOsmLoading] = useState(false)
  const [streets, setStreets] = useState<StreetRow[]>([])
  const [filter, setFilter] = useState<'all'|'none'|'weak'|'strong'>('all')
  const [search, setSearch] = useState('')
  const [plzInfo, setPlzInfo] = useState<{
    population: number | null
    households: number | null
    city: string
    customers: number
    orders: number
    revenue: number
    osmStreets: number
    warning?: string
  } | null>(null)
  const supabase = createClient()

  useEffect(() => {
    async function loadPLZ() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: m } = await supabase.from('company_users').select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data: customers } = await supabase.from('customers').select('postal_code').eq('company_id', m.company_id)
      const unique = [...new Set(customers?.map(c => c.postal_code) || [])].sort()
      setPlzList(unique)
      if (unique.length) setSelectedPLZ(unique[0])
    }
    loadPLZ()
  }, [])

  useEffect(() => {
    if (selectedPLZ) loadStreets(selectedPLZ)
  }, [selectedPLZ])

  async function loadStreets(plz: string) {
    setLoading(true)
    setOsmLoading(true)
    setStreets([])
    setPlzInfo(null)

    // PLZ-Analyse via API
    const res = await fetch(`/api/analysis/plz?plz=${plz}`)
    const data = await res.json()

    if (!res.ok) { setLoading(false); setOsmLoading(false); return }

    const analysis = data.analysis
    const withOrders: StreetRow[] = (data.streets?.with_orders || []).map((s: Record<string,unknown>) => ({
      name: s.street_name as string,
      customers: s.customer_count as number,
      orders: s.order_count as number,
      revenue: s.revenue as number,
      class: s.street_class as string,
      inOfficial: s.is_in_official_list as boolean,
    }))

    const withoutOrders: StreetRow[] = (data.streets?.without_orders || []).map((s: Record<string,unknown>) => ({
      name: s.street_name as string,
      customers: 0, orders: 0, revenue: 0,
      class: 'E',
      inOfficial: true,
    }))

    setStreets([...withOrders, ...withoutOrders])
    setPlzInfo({
      population: analysis.population,
      households: analysis.households,
      city: data.city || plz,
      customers: analysis.customer_count,
      orders: analysis.order_count,
      revenue: analysis.revenue,
      osmStreets: analysis.streets_total,
      warning: analysis.warnings?.[0],
    })

    setLoading(false)
    setOsmLoading(false)
  }

  const filtered = streets.filter(s => {
    if (filter === 'none' && s.orders > 0) return false
    if (filter === 'weak' && (s.orders === 0 || s.orders >= 5)) return false
    if (filter === 'strong' && s.orders < 10) return false
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const missing = streets.filter(s => s.orders === 0).length
  const covered = streets.filter(s => s.orders > 0).length
  const mktPct = plzInfo?.population ? (plzInfo.customers / plzInfo.population * 100) : null

  function exportCSV(type: 'all' | 'missing') {
    const rows = type === 'missing' ? streets.filter(s => s.orders === 0) : streets
    const headers = ['PLZ', 'Straße', 'Kunden', 'Bestellungen', 'Umsatz_EUR', 'Klasse', 'Empfehlung']
    const lines = rows.map(s => [
      selectedPLZ, s.name, s.customers, s.orders, s.revenue.toFixed(2), s.class,
      s.orders === 0 ? 'Flyer' : s.orders < 5 ? 'Gutschein' : 'Stammkunden'
    ].join(';'))
    const csv = [headers.join(';'), ...lines].join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `NYP_${selectedPLZ}_${type}_strassen_${new Date().toISOString().split('T')[0]}.csv`
    a.click()
  }

  return (
    <div className="p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold font-head">Reichweite & Lücken</h1>
        <p className="text-[#8a9bb5] text-sm mt-1">Echte Straßen aus OpenPLZ · Wer fehlt? · Flyer-Ziele</p>
      </div>

      {/* PLZ Tabs */}
      <div className="flex gap-2 flex-wrap mb-6">
        {plzList.map(plz => (
          <button
            key={plz}
            onClick={() => setSelectedPLZ(plz)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-all border ${
              selectedPLZ === plz
                ? 'bg-brand-red/10 border-brand-red text-white font-semibold'
                : 'bg-[#111827] border-[#1f2d45] text-[#8a9bb5] hover:text-white'
            }`}
          >
            {plz}
          </button>
        ))}
      </div>

      {/* KPIs */}
      {plzInfo && !loading && (
        <>
          {plzInfo.warning && (
            <div className="bg-amber-500/10 border border-amber-500/25 rounded-lg p-3 mb-4 text-amber-400 text-sm">
              ⚠️ {plzInfo.warning}
            </div>
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-5">
            <KPI label="Straßen in PLZ" value={streets.length} color="#2e86c1" />
            <KPI label="Davon bestellt ✅" value={covered} color="#00d084" />
            <KPI label="Kein Kontakt ❌" value={missing} color="#e63027" />
            <KPI label="Einwohner" value={plzInfo.population ? plzInfo.population.toLocaleString('de-DE') : '—'} color="#f5a623" />
            <KPI label="Marktanteil" value={mktPct ? mktPct.toFixed(2) + '%' : '—'} color={mktPct && mktPct > 2 ? '#00d084' : '#e63027'} />
            <KPI label="Nicht erreicht" value={plzInfo.population ? (plzInfo.population - plzInfo.customers).toLocaleString('de-DE') : '—'} color="#e63027" />
          </div>
        </>
      )}

      {/* Tabelle */}
      <div className="card">
        <div className="flex items-center gap-3 flex-wrap mb-4">
          <div className="card-title mb-0">
            📋 Alle Straßen PLZ {selectedPLZ}
            <span className="badge badge-red ml-2">{missing} ohne Kontakt</span>
            <span className="badge badge-grn ml-1">{covered} bestellt</span>
          </div>
          <div className="ml-auto flex gap-2 flex-wrap">
            {(['all','none','weak','strong'] as const).map(f => (
              <button key={f}
                onClick={() => setFilter(f)}
                className={`text-[10px] px-3 py-1.5 rounded-full border transition-all ${
                  filter === f ? 'bg-brand-red border-brand-red text-white' : 'border-[#1f2d45] text-[#8a9bb5] hover:text-white'
                }`}>
                {f === 'all' ? `Alle (${streets.length})` : f === 'none' ? `❌ Kein Kontakt (${missing})` : f === 'weak' ? '🟡 Schwach' : '🔥 Stark'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2 mb-4">
          <input
            className="input flex-1"
            placeholder="Straße suchen..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button onClick={() => exportCSV('missing')} className="btn-ghost text-xs px-3">⬇ Fehlende CSV</button>
          <button onClick={() => exportCSV('all')} className="btn-ghost text-xs px-3">⬇ Alle CSV</button>
        </div>

        {loading ? (
          <div className="flex items-center gap-3 py-8 justify-center text-[#8a9bb5]">
            <div className="w-5 h-5 border-2 border-brand-blue border-t-transparent rounded-full animate-spin" />
            Lade Straßen aus OpenPLZ API...
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="grid grid-cols-[8px_1fr_60px_65px_75px_85px] gap-3 px-2 py-1.5 text-[9px] text-[#4a5a70] uppercase tracking-wider border-b border-[#1f2d45] mb-1">
              <span></span><span>Straße</span>
              <span className="text-right">Kunden</span><span className="text-right">Bestell.</span>
              <span className="text-right">Umsatz</span><span>Status</span>
            </div>

            <div className="max-h-[560px] overflow-y-auto">
              {filtered.slice(0, 500).map((s, i) => {
                const dotC = s.class === 'A' ? '#00d084' : s.class === 'B' ? '#33e8a0' : s.class === 'C' ? '#f5a623' : s.class === 'D' ? '#2e86c1' : '#e63027'
                const badgeCls = s.class === 'A' || s.class === 'B' ? 'badge-grn' : s.class === 'C' ? 'badge-gold' : s.class === 'D' ? 'badge-blue' : 'badge-red'
                return (
                  <div key={i} className="grid grid-cols-[8px_1fr_60px_65px_75px_85px] gap-3 px-2 py-2 hover:bg-[#1a2233] rounded-md mb-0.5 items-center">
                    <div className="w-2 h-2 rounded-full" style={{ background: dotC }} />
                    <div className="text-xs overflow-hidden text-ellipsis whitespace-nowrap">{s.name}{!s.inOfficial && <span className="text-[9px] text-[#4a5a70] ml-1">(nur Excel)</span>}</div>
                    <div className="text-[10px] font-mono text-right text-[#8a9bb5]">{s.customers || '—'}</div>
                    <div className="text-[10px] font-mono text-right" style={{ color: s.orders > 0 ? '#00d084' : '#4a5a70' }}>{s.orders}</div>
                    <div className="text-[10px] font-mono text-right" style={{ color: s.revenue > 0 ? '#f5a623' : '#4a5a70' }}>{s.revenue > 0 ? s.revenue.toFixed(0) + ' €' : '—'}</div>
                    <span className={`badge ${badgeCls} text-[9px]`}>{s.orders === 0 ? 'Kein Kontakt' : `Klasse ${s.class}`}</span>
                  </div>
                )
              })}
              {filtered.length > 500 && (
                <div className="text-center py-3 text-[#4a5a70] text-xs">+ {filtered.length - 500} weitere (CSV-Export für vollständige Liste)</div>
              )}
            </div>

            <p className="text-[10px] text-[#4a5a70] italic mt-3">
              Straßenquelle: OpenPLZ API (amtliches Bundesstraßenverzeichnis) · Einwohner: Zensus 2022 (Statistisches Bundesamt)
            </p>
          </>
        )}
      </div>
    </div>
  )
}

function KPI({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="kpi-card" style={{'--kc': color} as React.CSSProperties}>
      <div className="absolute top-0 left-0 right-0 h-0.5" style={{ background: color }} />
      <div className="text-[9px] text-[#8a9bb5] uppercase tracking-wider mb-2">{label}</div>
      <div className="text-lg font-bold font-mono" style={{ color }}>{value}</div>
    </div>
  )
}
