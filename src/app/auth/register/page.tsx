'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { validateRegistrationInput } from '@/lib/auth/registration'
import { completeRegistration } from '@/lib/auth/complete-registration-client'

import { AuthShell, authErrorDE } from '@/components/auth/AuthShell'
import { Notice } from '@/components/ui'

export default function RegisterPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const router = useRouter()
  const supabase = createClient()

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password || !companyName) return
    setLoading(true)
    setError('')

    try {
      const input = validateRegistrationInput({ email, password, companyName })
      if (input.ok === false) throw new Error(input.error)

      // 1. Konto im Browser anlegen: Supabase-Rate-Limits greifen pro Nutzer-IP.
      //    Der Firmenname wird nur als Wunsch in den eigenen Metadaten abgelegt.
      const { data: authData, error: authError } = await supabase.auth.signUp({
        email: input.value.email,
        password: input.value.password,
        options: { data: { company_name: input.value.companyName } },
      })
      if (authError || !authData.user) throw new Error(authError?.message || 'Registrierung fehlgeschlagen')

      // 2. Ohne Sitzung ist die E-Mail-Bestätigung aktiv. Die Firma wird
      //    dann beim ersten Login angelegt.
      if (!authData.session) {
        setInfo('Fast geschafft: Bitte bestätigen Sie Ihre E-Mail-Adresse über den Link in unserer Nachricht und melden Sie sich dann an.')
        return
      }

      // 3. Firma und Owner-Zuordnung serverseitig anlegen
      const done = await completeRegistration()
      if (!done.ok) throw new Error(done.error)

      router.push('/dashboard')
    } catch (err) {
      setError(authErrorDE(err instanceof Error ? err.message : String(err)))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell title="Konto anlegen" lead="Für Ihr Unternehmen. Weitere Nutzer können später hinzukommen."
      footer={<>Schon ein Konto? <Link href="/auth/login" className="link">Anmelden</Link></>}>
      {info ? <Notice tone="good">{info}</Notice> : (
        <form onSubmit={handleRegister} className="space-y-4">
          <div>
            <label htmlFor="company" className="field-label">Name des Unternehmens</label>
            <input id="company" type="text" autoComplete="organization" value={companyName} onChange={e => setCompanyName(e.target.value)} className="input" placeholder="Mein Restaurant GmbH" required />
          </div>
          <div>
            <label htmlFor="email" className="field-label">E-Mail-Adresse</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className="input" placeholder="name@unternehmen.de" required />
          </div>
          <div>
            <label htmlFor="password" className="field-label">Passwort</label>
            <input id="password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className="input" minLength={8} required aria-describedby="pw-help" />
            <p id="pw-help" className="field-help">Mindestens 8 Zeichen.</p>
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <button type="submit" disabled={loading} className="btn-primary h-10 w-full">{loading ? 'Konto wird angelegt …' : 'Konto anlegen'}</button>
        </form>
      )}
    </AuthShell>
  )
}
