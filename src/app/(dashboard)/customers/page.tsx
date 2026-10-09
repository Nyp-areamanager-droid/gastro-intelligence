'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function CustomersPage() {
  const [customers, setCustomers] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      const { data: m } = await supabase.from('company_users').select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data } = await supabase.from('customers').select('*').eq('company_id', m.company_id).order('total_revenue', { ascending: false }).limit(200)
      setCustomers(data || [])
      setLoading(false)
    }
    load()
  }, [])

  const filtered = customers.filter(c =>
    !search || (c.postal_code?.includes(search) || c.street?.toLowerCase().includes(search.toLowerCase()))
  )

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-1">Kunden-Agent</h1>
      <p className="text-[#8a9bb5] text-sm mb-4">Kundendaten & RFM-Segmentierung</p>
      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="PLZ oder Straße suchen..." className="mb-4 w-full max-w-sm px-3 py-2 rounded-lg bg-[#1a2233] border border-[#2a3d5a] text-sm text-white placeholder-[#4a5a70] outline-none focus:border-red-500"/>
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-[#4a5a70]">Noch keine Kunden — bitte zuerst eine Datei hochladen.</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-[#4a5a70] text-xs uppercase border-b border-[#1f2d45]">
              <th className="pb-2 text-left">PLZ</th>
              <th className="pb-2 text-left">Straße</th>
              <th className="pb-2 text-right">Bestellungen</th>
              <th className="pb-2 text-right">Umsatz</th>
              <th className="pb-2 text-center">Segment</th>
              <th className="pb-2 text-center">VIP</th>
            </tr></thead>
            <tbody>
              {filtered.map(c => (
                <tr key={c.id} className="border-b border-[#1f2d45]/50 hover:bg-[#1a2233]/50">
                  <td className="py-2 font-mono text-red-400">{c.postal_code}</td>
                  <td className="py-2 text-[#8a9bb5]">{c.street || '—'}</td>
                  <td className="py-2 text-right font-mono">{c.total_orders}</td>
                  <td className="py-2 text-right font-mono">{Number(c.total_revenue).toFixed(0)} €</td>
                  <td className="py-2 text-center"><span className="text-xs px-2 py-0.5 rounded-full bg-[#2a3d5a] text-[#8a9bb5]">{c.rfm_segment || '—'}</span></td>
                  <td className="py-2 text-center">{c.is_vip ? '⭐' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
