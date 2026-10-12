'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts'

export default function TrendsPage() {
  const [data, setData] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data: rows } = await supabase.from('analytics').select('postal_code,revenue,customer_count,order_count,computed_at').eq('company_id', m.company_id).order('computed_at')
      setData(rows || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Trends</h1>
      <p className="text-[#8a9bb5] text-sm mb-6">Umsatz- & Kundenentwicklung</p>
      {data.length === 0 ? (
        <div className="text-center py-16 text-[#4a5a70]">Noch keine Daten — bitte zuerst eine Datei hochladen.</div>
      ) : (
        <div className="bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-4">
          <ResponsiveContainer width="100%" height={300}>
            <AreaChart data={data}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1f2d45"/>
              <XAxis dataKey="postal_code" stroke="#4a5a70" tick={{ fontSize: 11 }}/>
              <YAxis stroke="#4a5a70" tick={{ fontSize: 11 }}/>
              <Tooltip contentStyle={{ background: '#0d1117', border: '1px solid #1f2d45', borderRadius: 8 }}/>
              <Area type="monotone" dataKey="revenue" stroke="#e63027" fill="#e63027" fillOpacity={0.1} name="Umsatz (€)"/>
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}
