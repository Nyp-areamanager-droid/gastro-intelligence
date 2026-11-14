'use client'
// Rahmen aller angemeldeten Seiten: Seitenleiste (Desktop) bzw. ausklappbares
// Menü (Smartphone), Firmenname, Abmelden.
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { BellRing, Building2, FileUp, LayoutDashboard, Lightbulb, LogOut, Map, MapPinned, Menu, Settings, Store, TrendingUp, Users, X, type LucideIcon } from 'lucide-react'

const NAV: { group: string; items: { label: string; href: string; icon: LucideIcon }[] }[] = [
  { group: 'Auswertung', items: [
    { label: 'Übersicht', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Karte und Straßen', href: '/streets', icon: Map },
    { label: 'Postleitzahlen', href: '/plz', icon: MapPinned },
    { label: 'Kunden', href: '/customers', icon: Users },
    { label: 'Entwicklung', href: '/trends', icon: TrendingUp },
  ] },
  { group: 'Handeln', items: [
    { label: 'Empfehlungen', href: '/marketing', icon: Lightbulb },
    { label: 'Hinweise', href: '/alerts', icon: BellRing },
  ] },
  { group: 'Umfeld', items: [
    { label: 'Wettbewerber', href: '/competitors', icon: Store },
    { label: 'Firmenkunden', href: '/b2b', icon: Building2 },
  ] },
  { group: 'Daten', items: [
    { label: 'Import', href: '/uploads', icon: FileUp },
    { label: 'Einstellungen', href: '/settings', icon: Settings },
  ] },
]

function Brand() {
  return (
    <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="Gastro Intelligence – zur Übersicht">
      <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-[9px] bg-accent text-white">
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none"><path d="M9 1.5c-3 0-5.25 2.3-5.25 5.2 0 3.7 4.2 8.3 4.9 9a.5.5 0 0 0 .7 0c.7-.7 4.9-5.3 4.9-9C14.25 3.8 12 1.5 9 1.5Z" stroke="currentColor" strokeWidth="1.5" /><path d="M6.6 7.4h4.8M6.6 5.4h4.8M9 5.4v4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">Gastro Intelligence</span>
    </Link>
  )
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [company, setCompany] = useState('')

  useEffect(() => { setOpen(false) }, [pathname])
  useEffect(() => {
    let alive = true
    const supabase = createClient()
    ;(async () => {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data } = await (supabase.from('company_users') as any).select('companies(name)').eq('user_id', user.id).limit(1).maybeSingle()
      if (alive && data?.companies?.name) setCompany(data.companies.name)
    })()
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [open])

  async function handleLogout() {
    await createClient().auth.signOut()
    router.push('/auth/login'); router.refresh()
  }

  const nav = (
    <nav aria-label="Hauptnavigation" className="flex-1 overflow-y-auto px-3 py-3">
      {NAV.map(g => (
        <div key={g.group} className="mb-4">
          <div className="px-2.5 pb-1 text-[12px] font-medium text-ink-muted">{g.group}</div>
          <ul>
            {g.items.map(item => {
              const active = pathname === item.href || pathname.startsWith(item.href + '/')
              const Icon = item.icon
              return (
                <li key={item.href}>
                  <Link href={item.href} aria-current={active ? 'page' : undefined}
                    className={`flex h-9 items-center gap-2.5 rounded-control px-2.5 text-[14px] transition-colors ${active ? 'bg-accent-soft font-medium text-accent' : 'text-ink-soft hover:bg-sunken hover:text-ink'}`}>
                    <Icon size={17} strokeWidth={1.8} aria-hidden />{item.label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
  const foot = (
    <div className="border-t border-line p-3">
      {company && <div className="truncate px-2.5 pb-2 text-[13px] text-ink-soft" title={company}>{company}</div>}
      <button onClick={handleLogout} className="flex h-9 w-full items-center gap-2.5 rounded-control px-2.5 text-[14px] text-ink-soft hover:bg-sunken hover:text-ink">
        <LogOut size={17} strokeWidth={1.8} aria-hidden />Abmelden
      </button>
    </div>
  )

  return (
    <div className="min-h-screen lg:flex">
      <a href="#inhalt" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-control focus:bg-surface focus:px-3 focus:py-2 focus:shadow-pop">Zum Inhalt springen</a>

      {/* Desktop */}
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-line bg-surface lg:flex">
        <div className="flex h-14 items-center px-4"><Brand /></div>
        {nav}{foot}
      </aside>

      {/* Smartphone und Tablet */}
      <div className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-line bg-surface px-4 lg:hidden">
        <Brand />
        <button type="button" onClick={() => setOpen(true)} aria-label="Menü öffnen" aria-expanded={open} className="btn-ghost h-10 w-10 px-0"><Menu size={20} aria-hidden /></button>
      </div>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden" role="dialog" aria-modal="true" aria-label="Menü">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[280px] max-w-[85vw] flex-col bg-surface shadow-pop">
            <div className="flex h-14 items-center justify-between px-4">
              <Brand />
              <button type="button" onClick={() => setOpen(false)} aria-label="Menü schließen" className="btn-ghost h-10 w-10 px-0"><X size={20} aria-hidden /></button>
            </div>
            {nav}{foot}
          </div>
        </div>
      )}

      <main id="inhalt" className="min-w-0 flex-1">{children}</main>
    </div>
  )
}
