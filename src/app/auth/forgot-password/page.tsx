'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import Link from 'next/link'

import { AuthShell, authErrorDE } from '@/components/auth/AuthShell'
import { Notice } from '@/components/ui'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const supabase = createClient()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/reset-password`,
    })

    if (error) {
      setError(authErrorDE(error.message))
    } else {
      setSent(true)
    }
    setLoading(false)
  }

  return (
    <AuthShell title="Passwort vergessen" lead="Wir schicken Ihnen einen Link, über den Sie ein neues Passwort festlegen."
      footer={<Link href="/auth/login" className="link">Zurück zur Anmeldung</Link>}>
      {sent ? (
        <Notice tone="good" title="Nachricht ist unterwegs">Wenn es zu {email} ein Konto gibt, erhalten Sie in wenigen Minuten eine E-Mail mit dem Link. Bitte sehen Sie auch im Spam-Ordner nach.</Notice>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="email" className="field-label">E-Mail-Adresse</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} className="input" placeholder="name@unternehmen.de" required />
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <button type="submit" disabled={loading} className="btn-primary h-10 w-full">{loading ? 'Wird gesendet …' : 'Link senden'}</button>
        </form>
      )}
    </AuthShell>
  )
}
