'use client'
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'

export default function CompetitorsPage() {
  const [items, setItems] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const supabase = createClient()

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('poi_businesses').select('*').eq('is_competitor', true).limit(100)
      setItems(data || [])
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="flex items-center justify-center h-full"><div className="w-8 h-8 border-2 border-red-500 border-t-transparent rounded-full animate-spin"/></div>

  return (
    <div className="p-6 max-w-4xl">
      <h1 className="text-2xl font-bold mb-1">Wettbewerber</h1>
      <p className="text-[#8a9bb5] text-sm mb-6">Konkurrenz in deinen Liefergebieten</p>
      {items.length === 0 ? (
        <div className="text-center py-16 text-[#4a5a70]">Noch keine Wettbewerber-Daten.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {items.map(p => (
            <div key={p.id} className="bg-[#1a2233] border border-[#2a3d5a] rounded-xl p-4">
              <div className="font-semibold text-sm mb-1">{p.name}</div>
              <div className="text-xs text-[#8a9bb5]">{p.subcategory || p.category} · PLZ {p.postal_code}</div>
              {p.rating && <div className="text-xs text-amber-400 mt-1">⭐ {p.rating}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
