'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data } = await supabase.from('alerts').select('*').eq('company_id', m.company_id).order('created_at', { ascending: false })
      setAlerts(data || [])
      setLoading(false)
    }
    load()
  }, [])

  const colors: Record<string, string> = { critical: 'text-red-400 bg-red-500/10 border-red-500/25', warning: 'text-amber-400 bg-amber-500/10 border-amber-500/25', info: 'text-blue-400 bg-blue-500/10 border-blue-500/25' }

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="p-6 max-w-3xl">
      <h1 className="text-2xl font-bold mb-1">Frühwarnungen</h1>
      <p className="text-[#8a9bb5] text-sm mb-6">Automatische Alerts & Risikosignale</p>
      {alerts.length === 0 ? (
        <div className="text-center py-16 text-[#4a5a70]">✅ Keine Warnungen aktiv.</div>
      ) : (
        <div className="space-y-3">
          {alerts.map(a => (
            <div key={a.id} className={`border rounded-xl p-4 ${colors[a.severity] || colors.info}`}>
              <div className="font-semibold text-sm mb-1">{a.title}</div>
              <div className="text-xs opacity-80">{a.message}</div>
              <div className="text-xs opacity-50 mt-2">{new Date(a.created_at).toLocaleDateString('de-DE')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
