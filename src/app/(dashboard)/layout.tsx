'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'

const navItems = [
  { label: 'Dashboard',        href: '/dashboard',  icon: '📊' },
  { label: 'PLZ & Einwohner', href: '/plz',         icon: '🗺️' },
  { label: 'Straßen',          href: '/streets',    icon: '🏘️' },
  { label: 'Kunden',           href: '/customers',  icon: '👥' },
  { label: 'Marketing',        href: '/marketing',  icon: '🎯' },
  { label: 'B2B',              href: '/b2b',        icon: '🤝' },
  { label: 'Wettbewerber',     href: '/competitors',icon: '🏪' },
  { label: 'Trends',           href: '/trends',     icon: '📈' },
  { label: 'Frühwarnungen',    href: '/alerts',     icon: '⚠️' },
  { label: 'Upload',           href: '/uploads',    icon: '📤' },
  { label: 'Einstellungen',    href: '/settings',   icon: '⚙️' },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const supabase = createClient()

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/auth/login')
  }

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#07090f', color: '#e8edf5', fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Sidebar */}
      <aside style={{
        width: '220px',
        minWidth: '220px',
        background: '#0d1117',
        borderRight: '1px solid #1f2d45',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}>
        {/* Logo */}
        <div style={{ padding: '20px 16px', borderBottom: '1px solid #1f2d45', display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: '10px',
            background: '#e63027', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontWeight: 700, fontSize: '13px', flexShrink: 0
          }}>GI</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: '14px', color: '#fff' }}>Gastro Intel</div>
            <div style={{ fontSize: '11px', color: '#4a5a70' }}>Area Manager</div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {navItems.map(item => {
            const isActive = pathname === item.href
            return (
              <Link key={item.href} href={item.href} style={{
                display: 'flex', alignItems: 'center', gap: '10px',
                padding: '9px 16px', fontSize: '13px', textDecoration: 'none',
                borderLeft: isActive ? '2px solid #e63027' : '2px solid transparent',
                background: isActive ? 'rgba(230,48,39,0.1)' : 'transparent',
                color: isActive ? '#fff' : '#8a9bb5',
                fontWeight: isActive ? 600 : 400,
                transition: 'all 0.15s',
              }}>
                <span style={{ fontSize: '14px' }}>{item.icon}</span>
                {item.label}
              </Link>
            )
          })}
        </nav>

        {/* Logout */}
        <div style={{ padding: '12px', borderTop: '1px solid #1f2d45' }}>
          <button onClick={handleLogout} style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            color: '#8a9bb5', background: 'none', border: 'none',
            cursor: 'pointer', fontSize: '13px', padding: '8px 12px',
            borderRadius: '8px', width: '100%',
          }}>
            🚪 Abmelden
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <main style={{ flex: 1, overflowY: 'auto', background: '#07090f' }}>
        {children}
      </main>
    </div>
  )
}
