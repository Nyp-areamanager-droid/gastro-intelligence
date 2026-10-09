'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { getPopulation } from '@/lib/census'

export default function PlzPage() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: m } = await supabase.from('company_users').select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data: rows } = await supabase.from('analytics').select('*').eq('company_id', m.company_id).order('revenue', { ascending: false })

      // Deduplizieren nach PLZ
      const seen = new Map<string, any>()
      for (const r of (rows || [])) {
        if (!seen.has(r.postal_code)) seen.set(r.postal_code, r)
      }
      const deduped = Array.from(seen.values()).map(r => {
        const pop = r.population || getPopulation(r.postal_code)
        const customers = r.customer_count || 0
        const penetration = pop && customers ? Math.round(customers / pop * 10000) / 100 : null
        const notReached = pop && customers ? pop - customers : null
        return { ...r, _pop: pop, _penetration: penetration, _notReached: notReached }
      })
      setData(deduped)
      setLoading(false)
    }
    load()
  }, [])

  const th: React.CSSProperties = { textAlign: 'right', fontSize: '11px', color: '#4a5a70', paddingBottom: '12px', borderBottom: '1px solid #1f2d45', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px', padding: '0 8px 12px', whiteSpace: 'nowrap' }
  const thL: React.CSSProperties = { ...th, textAlign: 'left' }
  const td: React.CSSProperties = { textAlign: 'right', padding: '11px 8px', borderBottom: '1px solid rgba(31,45,69,0.4)', fontSize: '13px' }
  const tdL: React.CSSProperties = { ...td, textAlign: 'left', color: '#e63027', fontWeight: 700, fontFamily: 'monospace' }

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <div style={{ width:'36px', height:'36px', border:'3px solid #e63027', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite' }} />
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )

  const totalPop = data.reduce((s,r) => s + (r._pop || 0), 0)
  const totalCustomers = data.reduce((s,r) => s + (r.customer_count || 0), 0)
  const totalNotReached = data.reduce((s,r) => s + (r._notReached || 0), 0)
  const avgPct = data.filter(r => r._penetration).length
    ? data.filter(r => r._penetration).reduce((s,r) => s + r._penetration, 0) / data.filter(r => r._penetration).length
    : null

  return (
    <div style={{ padding:'28px 32px', maxWidth:'1300px', margin:'0 auto' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <h1 style={{ fontSize:'24px', fontWeight:700, color:'#fff', margin:'0 0 4px' }}>PLZ & Einwohner</h1>
      <p style={{ fontSize:'13px', color:'#8a9bb5', marginBottom:'28px' }}>Wie viel % der Einwohner bestellen bei euch?</p>

      {data.length === 0 ? (
        <div style={{ textAlign:'center', padding:'64px', color:'#4a5a70' }}>Noch keine Daten — bitte zuerst eine Datei hochladen.</div>
      ) : (<>
        {/* KPI Cards */}
        <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:'16px', marginBottom:'28px' }}>
          {[
            { label:'📍 PLZ-Gebiete', value: data.length, color:'#2e86c1' },
            { label:'👥 Kunden', value: totalCustomers.toLocaleString('de-DE'), color:'#00d084' },
            { label:'🏘️ Einwohner', value: totalPop > 0 ? totalPop.toLocaleString('de-DE') : '—', color:'#f5a623' },
            { label:'📊 Ø Marktanteil', value: avgPct ? avgPct.toFixed(2)+'%' : '—', color: avgPct && avgPct>2 ? '#00d084':'#e63027' },
            { label:'🔴 Nicht erreicht', value: totalNotReached > 0 ? totalNotReached.toLocaleString('de-DE') : '—', color:'#f87171' },
          ].map((k,i) => (
            <div key={i} style={{ background:'#111827', border:'1px solid #1f2d45', borderTop:`3px solid ${k.color}`, borderRadius:'12px', padding:'20px' }}>
              <div style={{ fontSize:'10px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'8px' }}>{k.label}</div>
              <div style={{ fontSize:'26px', fontWeight:700, color:k.color, fontFamily:'monospace' }}>{k.value}</div>
            </div>
          ))}
        </div>

        {/* Tabelle */}
        <div style={{ background:'#111827', border:'1px solid #1f2d45', borderRadius:'12px', padding:'24px', overflowX:'auto' }}>
          <div style={{ fontSize:'11px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'20px', fontWeight:600 }}>
            🗺️ Detailübersicht je PLZ
          </div>
          <table style={{ width:'100%', borderCollapse:'collapse' }}>
            <thead>
              <tr>
                <th style={thL}>PLZ</th>
                <th style={th}>Kunden</th>
                <th style={th}>Bestellungen</th>
                <th style={th}>Umsatz</th>
                <th style={th}>Einwohner</th>
                <th style={th}>Bestellen bei uns %</th>
                <th style={th}>Nicht erreicht</th>
                <th style={th}>Straßen</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r,i) => {
                const pct = r._penetration
                const pctColor = pct === null ? '#4a5a70' : pct < 1 ? '#f87171' : pct < 3 ? '#fbbf24' : '#34d399'
                return (
                  <tr key={i}>
                    <td style={tdL}>{r.postal_code || '—'}</td>
                    <td style={{ ...td, fontFamily:'monospace' }}>{(r.customer_count||0).toLocaleString('de-DE')}</td>
                    <td style={{ ...td, fontFamily:'monospace' }}>{(r.order_count||0).toLocaleString('de-DE')}</td>
                    <td style={{ ...td, fontFamily:'monospace' }}>{r.revenue ? `${Number(r.revenue).toFixed(0)} €` : '—'}</td>
                    <td style={{ ...td, color:'#f5a623', fontFamily:'monospace' }}>
                      {r._pop ? r._pop.toLocaleString('de-DE') : <span style={{color:'#4a5a70',fontSize:'11px'}}>k.A.</span>}
                    </td>
                    <td style={{ ...td, fontFamily:'monospace' }}>
                      {pct !== null
                        ? <span style={{ color:pctColor, fontWeight:700 }}>{pct.toFixed(2)}%</span>
                        : <span style={{color:'#4a5a70',fontSize:'11px'}}>—</span>}
                    </td>
                    <td style={{ ...td, color:'#f87171', fontFamily:'monospace' }}>
                      {r._notReached !== null ? r._notReached.toLocaleString('de-DE') : '—'}
                    </td>
                    <td style={{ ...td, color:'#8a9bb5' }}>
                      {r.streets_with_orders || r.streets_total
                        ? `${r.streets_with_orders||0}/${r.streets_total||0}`
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          <p style={{ fontSize:'11px', color:'#4a5a70', marginTop:'16px', fontStyle:'italic' }}>
            Einwohner: Zensus 2022 · Marktanteil = Kunden ÷ Einwohner × 100
          </p>
        </div>
      </>)}
    </div>
  )
}
