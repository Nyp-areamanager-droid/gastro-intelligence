'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function SettingsPage() {
  const [company, setCompany] = useState<any>(null)
  const [user, setUser] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser()
      setUser(user)
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) return
      const { data: c } = await supabase.from('companies').select('*').eq('id', m.company_id).single()
      setCompany(c)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="p-6 max-w-xl">
      <h1 className="text-2xl font-bold mb-1">Einstellungen</h1>
      <p className="text-[#8a9bb5] text-sm mb-6">Account & Unternehmenseinstellungen</p>
      <div className="space-y-4">
        <div className="bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-4">
          <div className="text-xs text-[#4a5a70] uppercase tracking-wider mb-3">Account</div>
          <div className="text-sm text-[#8a9bb5]">E-Mail: <span className="text-white">{user?.email}</span></div>
        </div>
        <div className="bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-4">
          <div className="text-xs text-[#4a5a70] uppercase tracking-wider mb-3">Unternehmen</div>
          <div className="text-sm text-[#8a9bb5]">Name: <span className="text-white">{company?.name}</span></div>
          <div className="text-sm text-[#8a9bb5] mt-1">Plan: <span className="text-amber-400">{company?.plan}</span></div>
        </div>
      </div>
    </div>
  )
}
