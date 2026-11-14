'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

import { AuthShell, authErrorDE } from '@/components/auth/AuthShell'
import { Notice } from '@/components/ui'

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState(false)
  const [ready, setReady] = useState(false)
  const [checked, setChecked] = useState(false)
  const router = useRouter()
  const supabase = createClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true)
      setChecked(true)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        setReady(true)
        setChecked(true)
      }
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < 8) {
      setError('Das Passwort muss mindestens 8 Zeichen haben.')
      return
    }
    if (password !== confirm) {
      setError('Die beiden Passwörter stimmen nicht überein.')
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (error) {
      setError(authErrorDE(error.message))
    } else {
      setSuccess(true)
      setTimeout(() => router.push('/auth/login'), 2000)
    }
  }

  return (
    <AuthShell title="Neues Passwort festlegen" footer={<Link href="/auth/login" className="link">Zurück zur Anmeldung</Link>}>
      {success ? (
        <Notice tone="good" title="Passwort gespeichert">Sie werden zur Anmeldung weitergeleitet.</Notice>
      ) : !checked ? (
        <p className="text-ink-muted" role="status">Link wird geprüft …</p>
      ) : !ready ? (
        <Notice tone="warn" title="Der Link ist ungültig oder abgelaufen" action={<Link href="/auth/forgot-password" className="btn-secondary btn-sm">Neuen Link anfordern</Link>}>
          Links zum Zurücksetzen gelten nur kurze Zeit und nur einmal.
        </Notice>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="field-label">Neues Passwort</label>
            <input id="password" type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} className="input" minLength={8} required aria-describedby="pw-help" />
            <p id="pw-help" className="field-help">Mindestens 8 Zeichen.</p>
          </div>
          <div>
            <label htmlFor="confirm" className="field-label">Passwort wiederholen</label>
            <input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} className="input" required />
          </div>
          {error && <Notice tone="bad">{error}</Notice>}
          <button type="submit" disabled={loading} className="btn-primary h-10 w-full">{loading ? 'Wird gespeichert …' : 'Passwort speichern'}</button>
        </form>
      )}
    </AuthShell>
  )
}
