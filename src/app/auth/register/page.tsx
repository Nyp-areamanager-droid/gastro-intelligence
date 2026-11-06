'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { validateRegistrationInput } from '@/lib/auth/registration'
import { completeRegistration } from '@/lib/auth/complete-registration-client'

export default function RegisterPage() {
  const [step, setStep] = useState<1|2>(1)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
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
        setError('Fast geschafft: Bitte bestätige deine E-Mail-Adresse und melde dich dann an.')
        return
      }

      // 3. Firma und Owner-Zuordnung serverseitig anlegen
      const done = await completeRegistration()
      if (!done.ok) throw new Error(done.error)

      router.push('/dashboard')
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-[#07090f] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-brand-red mb-4">
            <span className="text-white text-xl font-bold font-mono">GI</span>
          </div>
          <h1 className="text-2xl font-bold font-head">Gastro Intelligence</h1>
          <p className="text-[#8a9bb5] text-sm mt-1">Kostenlosen Account erstellen</p>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-5">Registrieren</h2>

          <form onSubmit={handleRegister} className="space-y-4">
            <div>
              <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider mb-1.5">Unternehmensname</label>
              <input
                type="text" value={companyName} onChange={e => setCompanyName(e.target.value)}
                className="input" placeholder="Mein Restaurant GmbH" required
              />
            </div>
            <div>
              <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider mb-1.5">E-Mail</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="input" placeholder="name@unternehmen.de" required
              />
            </div>
            <div>
              <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider mb-1.5">Passwort</label>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="input" placeholder="Mindestens 8 Zeichen" minLength={8} required
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
              {loading ? 'Konto wird erstellt...' : 'Kostenlos starten'}
            </button>

            <p className="text-[10px] text-[#4a5a70] text-center">
              Mit der Registrierung akzeptieren Sie unsere AGB und Datenschutzrichtlinie. DSGVO-konform.
            </p>
          </form>

          <div className="mt-4 pt-4 border-t border-[#1f2d45] text-center text-sm text-[#8a9bb5]">
            Bereits registriert?{' '}
            <Link href="/auth/login" className="text-brand-red hover:underline">Anmelden</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
