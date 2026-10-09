'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { computeDashboardKPIs, generateRecommendations } from '@/lib/analysis/engine'
import type { DashboardKPIs, Alert, MarketingRecommendation, PLZAnalysisResult } from '@/types'
import Link from 'next/link'
import { getPopulation } from '@/lib/census'

const actionColors: Record<string, string> = { sms: '#e63027', flyer: '#f5a623', b2b_visit: '#00d084', loyalty: '#2e86c1', reactivation: '#ff6b4a', coupon: '#7c6dfa' }

export default function DashboardPage() {
  const [kpis, setKpis] = useState<DashboardKPIs | null>(null)
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [recs, setRecs] = useState<MarketingRecommendation[]>([])
  const [plzData, setPlzData] = useState<PLZAnalysisResult[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: membership } = await supabase.from('company_users').select('company_id').eq('user_id', user.id).single()
      if (!membership) return
      const companyId = membership.company_id
      const { data: customers } = await supabase.from('customers').select('*').eq('company_id', companyId)
      const { data: dbAlerts } = await supabase.from('alerts').select('*').eq('company_id', companyId).eq('is_resolved', false).order('created_at', { ascending: false }).limit(10)
      let { data: analytics } = await supabase.from('analytics').select('*').eq('company_id', companyId).order('computed_at', { ascending: false })
      // Auto-sync Einwohner wenn noch keine Daten
      if (analytics && analytics.some(a => !a.population)) {
        await fetch('/api/sync-population', { method: 'POST' }).catch(() => {})
        const { data: fresh } = await supabase.from('analytics').select('*').eq('company_id', companyId).order('computed_at', { ascending: false })
        if (fresh) analytics = fresh
      }
      if (customers?.length) {
        const rows = customers.map(c => ({
          postal_code: c.postal_code, street: c.street, street_normalized: c.street_normalized,
          city: c.city, total_orders: c.total_orders, total_revenue: c.total_revenue,
          avg_order_value: c.avg_order_value, last_order_date: c.last_order_date,
          is_vip: c.is_vip, rfm_segment: c.rfm_segment, late_deliveries: c.late_deliveries || 0, _row_index: 0, _errors: [],
        }))
        const computed = computeDashboardKPIs(rows)
        setKpis({ ...computed, critical_alerts: dbAlerts?.filter(a => a.severity === 'critical').length || 0 })
        // Deduplizieren nach postal_code (neueste Einträge behalten)
        const seenPlz = new Map<string, any>()
        for (const a of (analytics || [])) {
          if (!seenPlz.has(a.postal_code) || (a.computed_at > (seenPlz.get(a.postal_code)?.computed_at || ''))) {
            seenPlz.set(a.postal_code, a)
          }
        }
        const plzAnalyses = Array.from(seenPlz.values()).map(a => ({
          postal_code: a.postal_code || '', city: '', customer_count: a.customer_count || 0,
          order_count: a.order_count || 0, revenue: a.revenue || 0, avg_order_value: a.avg_order_value || 0,
          orders_per_customer: a.orders_per_customer || 0, population: a.population || getPopulation(a.postal_code || '') || null,
          households: null, population_source: null,
          market_penetration_pct: a.market_penetration_pct || (() => {
            const pop = a.population || getPopulation(a.postal_code || '')
            return pop && a.customer_count ? Math.round(a.customer_count / pop * 10000) / 100 : null
          })(),
          not_reached_residents: a.not_reached_residents || (() => {
            const pop = a.population || getPopulation(a.postal_code || '')
            return pop && a.customer_count ? pop - a.customer_count : null
          })(),
          not_reached_pct: null, streets_total: a.streets_total || 0, streets_with_orders: a.streets_with_orders || 0,
          streets_without_orders: a.streets_without_orders || 0, streets_coverage_pct: a.streets_coverage_pct || 0,
          flyer_potential_eur: null, potential_scenarios: (a.potential_scenarios as PLZAnalysisResult['potential_scenarios']) || [],
          one_time_buyers: a.one_time_buyers || 0, repeat_customers: a.repeat_customers || 0,
          vip_customers: a.vip_customers || 0, warnings: [],
          poi_summary: { competitors:0, hotels:0, schools:0, hospitals:0, offices:0, restaurants:0, total_b2b_targets:0 },
        })) as PLZAnalysisResult[]
        setPlzData(plzAnalyses)
        setRecs(generateRecommendations(computed, plzAnalyses, []))
      }
      setAlerts(dbAlerts || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <div style={{ textAlign:'center' }}>
        <div style={{ width:'40px', height:'40px', border:'3px solid #e63027', borderTopColor:'transparent', borderRadius:'50%', animation:'spin 0.8s linear infinite', margin:'0 auto 16px' }} />
        <div style={{ color:'#8a9bb5', fontSize:'14px' }}>Dashboard wird geladen...</div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    </div>
  )

  if (!kpis) return (
    <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%' }}>
      <div style={{ textAlign:'center', maxWidth:'400px' }}>
        <div style={{ fontSize:'56px', marginBottom:'16px' }}>📊</div>
        <h2 style={{ fontSize:'20px', fontWeight:700, color:'#fff', marginBottom:'8px' }}>Noch keine Daten</h2>
        <p style={{ color:'#8a9bb5', fontSize:'14px', marginBottom:'24px' }}>Laden Sie Ihre erste Excel-Datei hoch um die Analyse zu starten.</p>
        <Link href="/uploads" style={{ background:'#e63027', color:'#fff', padding:'10px 24px', borderRadius:'8px', textDecoration:'none', fontWeight:600, fontSize:'14px' }}>Datei hochladen →</Link>
      </div>
    </div>
  )

  const einmaelKaeuferPct = (100 - kpis.repeat_rate_pct)
  const card = (color: string): React.CSSProperties => ({ background:'#111827', border:'1px solid #1f2d45', borderRadius:'12px', padding:'20px', borderTop:`3px solid ${color}` })

  return (
    <div style={{ padding:'28px 32px', maxWidth:'1300px', margin:'0 auto' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}tr:hover td{background:rgba(26,34,51,0.5)}`}</style>

      <div style={{ marginBottom:'28px' }}>
        <h1 style={{ fontSize:'24px', fontWeight:700, color:'#fff', margin:0 }}>CEO Dashboard</h1>
        <p style={{ fontSize:'13px', color:'#8a9bb5', marginTop:'4px' }}>Gesamtüberblick · Chancen · Risiken</p>
      </div>

      {/* KPI Grid 3x2 */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'16px', marginBottom:'24px' }}>
        {[
          { label:'👥 Kunden gesamt', value: kpis.total_customers.toLocaleString('de-DE'), sub:`${kpis.repeat_rate_pct}% Stammkunden`, color:'#2e86c1' },
          { label:'🛍️ Bestellungen', value: kpis.total_orders.toLocaleString('de-DE'), sub:'Gesamt', color:'#f5a623' },
          { label:'💶 Umsatz', value:`${(kpis.total_revenue/1000).toFixed(1)}k €`, sub:`Ø ${kpis.avg_order_value.toFixed(2)} € pro Bestellung`, color:'#00d084' },
          { label:'⚡ Einmalkäufer', value:`${einmaelKaeuferPct.toFixed(0)}%`, sub:'Ziel: unter 60%', color: einmaelKaeuferPct > 60 ? '#e63027':'#f5a623' },
          { label:'⏱️ Verspätungsrate', value:`${kpis.late_delivery_pct}%`, sub:'Ziel: unter 5%', color: kpis.late_delivery_pct > 10 ? '#e63027':'#00d084' },
          { label:'📍 PLZ-Gebiete', value: kpis.active_plz_count.toString(), sub:`Top: ${kpis.top_plz}`, color:'#7c6dfa' },
        ].map((k,i) => (
          <div key={i} style={card(k.color)}>
            <div style={{ fontSize:'11px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'8px' }}>{k.label}</div>
            <div style={{ fontSize:'28px', fontWeight:700, color:k.color, fontFamily:'monospace', lineHeight:1 }}>{k.value}</div>
            <div style={{ fontSize:'12px', color:'#4a5a70', marginTop:'6px' }}>{k.sub}</div>
          </div>
        ))}
      </div>

      {/* 2-Column */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px', marginBottom:'20px' }}>
        {/* Alerts */}
        <div style={{ background:'#111827', border:'1px solid #1f2d45', borderRadius:'12px', padding:'20px' }}>
          <div style={{ fontSize:'11px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'16px', fontWeight:600 }}>⚠️ Frühwarnungen</div>
          {alerts.length === 0
            ? <div style={{ textAlign:'center', padding:'24px 0', color:'#4a5a70' }}>✅ Alles in Ordnung</div>
            : alerts.slice(0,5).map(a => (
              <div key={a.id} style={{ border:`1px solid ${a.severity==='critical'?'rgba(239,68,68,0.3)':'rgba(245,166,35,0.3)'}`, background: a.severity==='critical'?'rgba(239,68,68,0.07)':'rgba(245,166,35,0.07)', borderRadius:'8px', padding:'12px', marginBottom:'8px' }}>
                <div style={{ fontSize:'12px', fontWeight:600, color: a.severity==='critical'?'#f87171':'#fbbf24' }}>{a.severity==='critical'?'🔴':'🟡'} {a.title}</div>
                <div style={{ fontSize:'11px', color:'#8a9bb5', marginTop:'3px' }}>{a.message}</div>
              </div>
            ))
          }
        </div>

        {/* Maßnahmen */}
        <div style={{ background:'#111827', border:'1px solid #1f2d45', borderRadius:'12px', padding:'20px' }}>
          <div style={{ fontSize:'11px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'16px', fontWeight:600 }}>🎯 Top Maßnahmen (höchster ROI)</div>
          {recs.slice(0,3).map((r,i) => {
            const col = actionColors[r.action_type] || '#8a9bb5'
            return (
              <div key={i} style={{ background:'#1a2233', border:'1px solid #2a3d5a', borderRadius:'10px', padding:'14px', marginBottom:'10px', display:'flex', gap:'14px' }}>
                <div style={{ width:'50px', minWidth:'50px', height:'50px', borderRadius:'10px', background:col+'22', border:`1px solid ${col}44`, display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
                  <div style={{ fontSize:'13px', fontWeight:700, fontFamily:'monospace', color:col }}>{r.roi>=99?'∞':r.roi+'x'}</div>
                  <div style={{ fontSize:'9px', color:'#8a9bb5' }}>ROI</div>
                </div>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:'13px', fontWeight:600, color:'#fff', marginBottom:'4px' }}>{r.title}</div>
                  <div style={{ fontSize:'11px', color:'#8a9bb5', marginBottom:'8px' }}>{r.description}</div>
                  <div style={{ display:'flex', gap:'16px', fontSize:'11px', fontFamily:'monospace' }}>
                    <span style={{ color:'#f87171' }}>{r.estimated_cost.toLocaleString('de-DE')} € Kosten</span>
                    <span style={{ color:'#34d399' }}>{r.estimated_potential.toLocaleString('de-DE')} € Potenzial</span>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* PLZ Tabelle */}
      {plzData.length > 0 && (
        <div style={{ background:'#111827', border:'1px solid #1f2d45', borderRadius:'12px', padding:'20px' }}>
          <div style={{ fontSize:'11px', color:'#8a9bb5', textTransform:'uppercase', letterSpacing:'0.8px', marginBottom:'16px', fontWeight:600 }}>🗺️ Marktdurchdringung je PLZ-Gebiet</div>
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:'13px' }}>
              <thead>
                <tr style={{ borderBottom:'1px solid #1f2d45' }}>
                  {['PLZ','Kunden','Bestellungen','Umsatz','Einwohner','Marktanteil','Nicht erreicht'].map((h,i) => (
                    <th key={h} style={{ textAlign: i===0?'left':'right', fontSize:'11px', color:'#4a5a70', paddingBottom:'10px', fontWeight:600, textTransform:'uppercase', letterSpacing:'0.5px' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {plzData.map(p => {
                  const mc = p.market_penetration_pct === null ? '#4a5a70' : p.market_penetration_pct < 1 ? '#f87171' : p.market_penetration_pct < 3 ? '#fbbf24' : '#34d399'
                  return (
                    <tr key={p.postal_code}>
                      <td style={{ textAlign:'left', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace', color:'#e63027', fontWeight:600 }}>{p.postal_code}</td>
                      <td style={{ textAlign:'right', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace' }}>{p.customer_count}</td>
                      <td style={{ textAlign:'right', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace' }}>{p.order_count}</td>
                      <td style={{ textAlign:'right', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace' }}>{p.revenue.toFixed(0)} €</td>
                      <td style={{ textAlign:'right', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace', color:'#8a9bb5' }}>{p.population ? p.population.toLocaleString('de-DE'):'—'}</td>
                      <td style={{ textAlign:'right', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace', color:mc, fontWeight:700 }}>{p.market_penetration_pct !== null ? `${p.market_penetration_pct.toFixed(2)}%` : '—'}</td>
                      <td style={{ textAlign:'right', padding:'10px 0', borderBottom:'1px solid rgba(31,45,69,0.5)', fontFamily:'monospace', color:'#f87171' }}>{p.not_reached_residents ? p.not_reached_residents.toLocaleString('de-DE'):'—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
