'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function MarketingPage() {
  const [actions, setActions] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data } = await supabase.from('marketing_actions').select('*').eq('company_id', m.company_id).order('priority')
      setActions(data || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Marketing-Agent</h1>
      <p className="text-[#8a9bb5] text-sm mb-6">KI-generierte Maßnahmen & ROI-Kalkulation</p>
      {actions.length === 0 ? (
        <div className="text-center py-16 text-[#4a5a70]">Noch keine Maßnahmen — bitte zuerst eine Datei hochladen.</div>
      ) : (
        <div className="space-y-3">
          {actions.map(a => (
            <div key={a.id} className="bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold text-sm">{a.title}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">{a.action_type}</span>
              </div>
              <p className="text-xs text-[#8a9bb5] mb-3">{a.description}</p>
              <div className="flex gap-4 text-xs font-mono">
                <span className="text-red-400">Kosten: {Number(a.estimated_cost || 0).toFixed(0)} €</span>
                <span className="text-emerald-400">Potenzial: {Number(a.estimated_potential || 0).toFixed(0)} €</span>
                <span className="text-amber-400">ROI: {Number(a.estimated_roi || 0).toFixed(1)}x</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
