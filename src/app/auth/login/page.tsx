'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { completeRegistration } from '@/lib/auth/complete-registration-client'

import { AuthShell, authErrorDE } from '@/components/auth/AuthShell'
import { Notice } from '@/components/ui'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const router = useRouter()
  const supabase = createClient()

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      setError(authErrorDE(error.message))
    } else {
      // Holt eine Firmenanlage nach, falls sie bei der Registrierung noch
      // nicht möglich war (E-Mail-Bestätigung) oder abgebrochen ist.
      // Für bestehende Nutzer passiert nichts. Konten ohne hinterlegten
      // Firmennamen (400) werden nicht ausgesperrt, nur technische Fehler
      // halten den Login an, damit sie nicht unbemerkt bleiben.
      const done = await completeRegistration()
      if (!done.ok && done.status !== 400) {
        setError(done.error || 'Unternehmen konnte nicht eingerichtet werden')
        setLoading(false)
        return
      }
      router.push('/dashboard')
      router.refresh()
    }
    setLoading(false)
  }

  return (
    <AuthShell title="Anmelden" footer={<>Noch kein Konto? <Link href="/auth/register" className="link">Registrieren</Link></>}>
      <form onSubmit={handleLogin} className="space-y-4" noValidate={false}>
        <div>
          <label htmlFor="email" className="field-label">E-Mail-Adresse</label>
          <input id="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className="input" placeholder="name@unternehmen.de" required />
        </div>
        <div>
          <div className="flex items-baseline justify-between">
            <label htmlFor="password" className="field-label">Passwort</label>
            <Link href="/auth/forgot-password" className="link text-[13px]">Passwort vergessen?</Link>
          </div>
          <input id="password" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} className="input" required />
        </div>
        {error && <Notice tone="bad">{error}</Notice>}
        <button type="submit" disabled={loading} className="btn-primary h-10 w-full">{loading ? 'Anmeldung läuft …' : 'Anmelden'}</button>
      </form>
    </AuthShell>
  )
}
