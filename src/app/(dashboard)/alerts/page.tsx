'use client'
// Hinweise: Auffälligkeiten, die beim Import festgestellt wurden.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { EmptyState, Notice, PageHeader, PageSkeleton, fmtDate } from '@/components/ui'

interface AlertRow { id: string; severity: string; category: string; title: string; message: string; created_at: string }

export default function AlertsPage() {
  const [alerts, setAlerts] = useState<AlertRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    (async () => {
      const supabase = createClient()
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: m } = await (supabase.from('company_users') as any).select('company_id').eq('user_id', user.id).single()
      if (!m) { setAlerts([]); return }
      const { data, error } = await supabase.from('alerts').select('id, severity, category, title, message, created_at').eq('company_id', m.company_id).eq('is_resolved', false).order('created_at', { ascending: false })
      if (error) { setFailed(true); return }
      // Gleiche Meldung nur einmal (die neueste)
      const seen = new Set<string>()
      setAlerts(((data || []) as AlertRow[]).filter(a => { const k = `${a.category}|${a.title}`; if (seen.has(k)) return false; seen.add(k); return true }))
    })()
  }, [])

  if (failed) return <div className="page"><Notice tone="bad" title="Die Hinweise konnten nicht geladen werden">Bitte die Seite neu laden.</Notice></div>
  if (alerts === null) return <PageSkeleton stats={0} blocks={2} />
  return (
    <div className="page max-w-[920px]">
      <PageHeader title="Hinweise" lead={<>Auffälligkeiten aus dem letzten Import. Was Sie daraus machen können, steht unter <Link href="/marketing" className="link">Empfehlungen</Link>.</>} />
      {alerts.length === 0
        ? <EmptyState title="Keine offenen Hinweise">Beim letzten Import ist nichts aufgefallen, das eine Warnung auslöst.</EmptyState>
        : <div className="space-y-3">{alerts.map(a => (
            <Notice key={a.id} tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'info'} title={a.title.replace(/^(Kritisch|Warnung):\s*/, '')}>
              {a.message}<div className="mt-1 text-[12px] text-ink-muted">Festgestellt am {fmtDate(a.created_at)}</div>
            </Notice>))}</div>}
    </div>
  )
}
