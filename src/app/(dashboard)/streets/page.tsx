'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

interface StreetRow {
  name: string
  customers: number
  orders: number
  revenue: number
  streetClass: string
}

export default function StreetsPage() {
  const [plzList, setPlzList] = useState<string[]>([])
  const [selectedPLZ, setSelectedPLZ] = useState('')
  const [loading, setLoading] = useState(false)
  const [streets, setStreets] = useState<StreetRow[]>([])
  const [filter, setFilter] = useState<'all'|'none'|'weak'|'strong'>('all')
  const [search, setSearch] = useState('')
  const [info, setInfo] = useState<{ postal_code: string|null, population: number|null, customer_count: number|null, order_count: number|null, streets_total: number|null, streets_with_orders: number|null } | null>(null)
  const supabase = createClient()

  useEffect(() => {
    async function loadPLZ() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data: analytics } = await supabase.from('analytics').select('postal_code,population,customer_count,order_count,streets_total,streets_with_orders').eq('company_id', m.company_id).order('customer_count', { ascending: false })
      const unique = [...new Map((analytics||[]).map(a => [a.postal_code, a])).values()]
      setPlzList(unique.map(a => a.postal_code))
      if (unique.length) {
        setSelectedPLZ(unique[0].postal_code)
        setInfo(unique[0])
      }
    }
    loadPLZ()
  }, [])

  useEffect(() => {
    if (selectedPLZ) loadStreets(selectedPLZ)
  }, [selectedPLZ])

  async function loadStreets(plz: string) {
    setLoading(true)
    setStreets([])
    const res = await fetch(`/api/analysis/plz?plz=${plz}`)
    if (!res.ok) { setLoading(false); return }
    const data = await res.json()
    const withOrders: StreetRow[] = (data.streets?.with_orders || []).map((s: any) => ({
      name: s.street_name, customers: s.customer_count, orders: s.order_count,
      revenue: s.revenue, streetClass: s.street_class || 'D',
    }))
    const withoutOrders: StreetRow[] = (data.streets?.without_orders || []).map((s: any) => ({
      name: s.street_name, customers: 0, orders: 0, revenue: 0, streetClass: 'E',
    }))
    setStreets([...withOrders, ...withoutOrders])
    if (data.analysis) {
      setInfo({ postal_code: selectedPLZ, population: data.analysis.population, customer_count: data.analysis.customer_count, order_count: data.analysis.order_count, streets_total: data.analysis.streets_total, streets_with_orders: data.analysis.streets_with_orders })
    }
    setLoading(false)
  }

  const filtered = streets.filter(s => {
    if (filter === 'none' && s.orders > 0) return false
    if (filter === 'weak' && (s.orders === 0 || s.orders >= 10)) return false
    if (filter === 'strong' && s.orders < 10) return false
    if (search && !s.name.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const noOrders = streets.filter(s => s.orders === 0).length
  const withOrders = streets.filter(s => s.orders > 0).length
  const mktPct = info?.population && info.customer_count ? (info.customer_count / info.population * 100) : null

  const classColors: Record<string,string> = { A:'#00d084', B:'#33e8a0', C:'#f5a623', D:'#2e86c1', E:'#e63027' }
  const classLabels: Record<string,string> = { A:'Sehr aktiv', B:'Aktiv', C:'Mittel', D:'Schwach', E:'Kein Kontakt' }

  return (
    <div style={{ padding:'28px 32px', maxWidth:'1300px', margin:'0 auto' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      <h1 style={{ fontSize:'24px', fontWeight:700, color:'#fff', margin:'0 0 4px' }}>Reichweite & Straßen</h1>
      <p style={{ fontSize:'13px', color:'#8a9bb5', marginBottom:'24px' }}>Welche Straßen bestellen oft, selten oder gar nicht?</p>

      {/* PLZ Tabs */}
      <div style={{ display:'flex', gap:'8px', flexWrap:'wrap', marginBottom:'24px' }}>
        {plzList.map(plz => (
          <button key={plz} onClick={() => setSelectedPLZ(plz)} style={{
            padding:'8px 16px', borderRadius:'8px', fontSize:'13px', fontWeight:600,
            border: selectedPLZ===plz ? '1px solid #e63027' : '1px solid #1f2d45',
            background: selectedPLZ===plz ? 'rgba(230,48,39,0.12)' : '#111827',
            color: selectedPLZ===plz ? '#fff' : '#8a9bb5', cursor:'pointer',
          }}>
            {plz}
          </button>
        ))}
      </div>

      {/* KPI Karten */}
      {info && (
        <div style={{ display:'grid', gridTemplateColumns:'repeat(6,1fr)', gap:'12px', marginBottom:'24px' }}>
          {[
            { label:'Straßen total', value: streets.length || info.streets_total || 0, color:'#2e86c1' },
            { label:'✅ Mit Bestellungen', value: withOrders, color:'#00d084' },
            { label:'❌ Ohne Kontakt', value: noOrders, color:'#e63027' },
            { label:'👥 Einwohner', value: info.population ? info.population.toLocaleString('de-DE') : '—', color:'#f5a623' },
            { label:'📊 % bestellen bei uns', value: mktPct ? mktPct.toFixed(2)+'%' : '—', color: mktPct && mktPct>2?'#00d084':'#e63027' },
            { label:'🔴 Nicht erreicht', value: info.population && info.customer_count ? (info.population-info.customer_count).toLocaleString('de-DE') : '—', color:'#f87171' },
          ].map((k,i) => (
            <div key={i} style={{ background:'#111827', border:'1px solid #1f2d45', borderTop:`3px solid ${k.color}`, borderRadius:'10px', padding:'16px' }}>
              <div style={{ fontSize:'10px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.7px', marginBottom:'8px' }}>{k.label}</div>
              <div style={{ fontSize:'20px', fontWeight:700, color:k.color, fontFamily:'monospace' }}>{k.value}</div>
            </div>
          ))}
        </div>
      )}

      {/* Filter + Suche */}
      <div style={{ background:'#111827', border:'1px solid #1f2d45', borderRadius:'12px', padding:'20px' }}>
        <div style={{ display:'flex', alignItems:'center', gap:'12px', flexWrap:'wrap', marginBottom:'16px' }}>
          <div style={{ fontSize:'11px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', fontWeight:600 }}>
            📋 Alle Straßen — PLZ {selectedPLZ}
          </div>
          <div style={{ marginLeft:'auto', display:'flex', gap:'8px', flexWrap:'wrap' }}>
            {([
              ['all', `Alle (${streets.length})`],
              ['none', `❌ Ohne Kontakt (${noOrders})`],
              ['weak', '🟡 Selten (1-9)'],
              ['strong', '🔥 Oft (10+)'],
            ] as const).map(([f, label]) => (
              <button key={f} onClick={() => setFilter(f as any)} style={{
                fontSize:'11px', padding:'5px 12px', borderRadius:'20px', cursor:'pointer',
                border: filter===f ? '1px solid #e63027' : '1px solid #1f2d45',
                background: filter===f ? '#e63027' : 'transparent',
                color: filter===f ? '#fff' : '#8a9bb5',
              }}>{label}</button>
            ))}
          </div>
        </div>

        <input
          style={{ width:'100%', background:'#1a2233', border:'1px solid #1f2d45', borderRadius:'8px', padding:'8px 12px', fontSize:'13px', color:'#fff', outline:'none', marginBottom:'16px', boxSizing:'border-box' }}
          placeholder="Straße suchen..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {loading ? (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'40px', color:'#8a9bb5', gap:'12px' }}>
            <div style={{ width:'24px', height:'24px', border:'2px solid #2e86c1', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
            Lade Straßendaten...
          </div>
        ) : (
          <>
            {/* Legende */}
            <div style={{ display:'flex', gap:'16px', marginBottom:'12px', flexWrap:'wrap' }}>
              {Object.entries(classColors).map(([cls, col]) => (
                <div key={cls} style={{ display:'flex', alignItems:'center', gap:'6px', fontSize:'11px', color:'#8a9bb5' }}>
                  <div style={{ width:'8px', height:'8px', borderRadius:'50%', background:col }} />
                  <span style={{ color:col, fontWeight:600 }}>Klasse {cls}</span> — {classLabels[cls]}
                </div>
              ))}
            </div>

            {/* Tabelle Header */}
            <div style={{ display:'grid', gridTemplateColumns:'10px 1fr 70px 80px 80px 110px', gap:'12px', padding:'6px 8px', borderBottom:'1px solid #1f2d45', marginBottom:'4px' }}>
              {['','Straße','Kunden','Bestellungen','Umsatz','Status'].map((h,i) => (
                <div key={i} style={{ fontSize:'10px', color:'#4a5a70', textTransform:'uppercase', letterSpacing:'0.5px', textAlign: i>1?'right':'left' }}>{h}</div>
              ))}
            </div>

            {/* Straßen Liste */}
            <div style={{ maxHeight:'520px', overflowY:'auto' }}>
              {filtered.length === 0 ? (
                <div style={{ textAlign:'center', padding:'32px', color:'#4a5a70' }}>Keine Straßen gefunden</div>
              ) : filtered.slice(0,500).map((s,i) => {
                const col = classColors[s.streetClass] || '#4a5a70'
                return (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:'10px 1fr 70px 80px 80px 110px', gap:'12px', padding:'8px', borderRadius:'6px', marginBottom:'2px', alignItems:'center' }}
                    onMouseEnter={e => (e.currentTarget.style.background='rgba(26,34,51,0.7)')}
                    onMouseLeave={e => (e.currentTarget.style.background='transparent')}>
                    <div style={{ width:'8px', height:'8px', borderRadius:'50%', background:col }} />
                    <div style={{ fontSize:'12px', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</div>
                    <div style={{ fontSize:'12px', fontFamily:'monospace', textAlign:'right', color:'#8a9bb5' }}>{s.customers||'—'}</div>
                    <div style={{ fontSize:'12px', fontFamily:'monospace', textAlign:'right', color: s.orders>0?'#00d084':'#4a5a70', fontWeight: s.orders>9?700:400 }}>{s.orders}</div>
                    <div style={{ fontSize:'12px', fontFamily:'monospace', textAlign:'right', color: s.revenue>0?'#f5a623':'#4a5a70' }}>{s.revenue>0?s.revenue.toFixed(0)+' €':'—'}</div>
                    <div style={{ fontSize:'11px', fontWeight:600, color:col, padding:'3px 8px', background:col+'18', borderRadius:'20px', border:`1px solid ${col}44`, textAlign:'center' }}>
                      {classLabels[s.streetClass] || s.streetClass}
                    </div>
                  </div>
                )
              })}
              {filtered.length > 500 && (
                <div style={{ textAlign:'center', padding:'12px', color:'#4a5a70', fontSize:'12px' }}>+ {filtered.length-500} weitere Straßen</div>
              )}
            </div>

            <p style={{ fontSize:'11px', color:'#4a5a70', marginTop:'16px', fontStyle:'italic' }}>
              Quelle: OpenPLZ API (amtliches Straßenverzeichnis) · Einwohner: Zensus 2022
            </p>
          </>
        )}
      </div>
    </div>
  )
}
