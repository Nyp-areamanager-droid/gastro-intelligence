'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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

    if (password.length < 6) {
      setError('Passwort muss mindestens 6 Zeichen haben')
      return
    }
    if (password !== confirm) {
      setError('Passwörter stimmen nicht überein')
      return
    }

    setLoading(true)
    const { error } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (error) {
      setError(error.message)
    } else {
      setSuccess(true)
      setTimeout(() => router.push('/auth/login'), 2000)
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
          <p className="text-[#8a9bb5] text-sm mt-1">Area Manager Platform</p>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-5">Neues Passwort setzen</h2>

          {success ? (
            <div className="bg-emerald-500/10 border border-emerald-500/25 rounded-lg p-3 text-emerald-400 text-sm">
              Passwort erfolgreich geändert. Du wirst zum Login weitergeleitet...
            </div>
          ) : !checked ? (
            <p className="text-[#8a9bb5] text-sm">Link wird geprüft...</p>
          ) : !ready ? (
            <div className="space-y-4">
              <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-red-400 text-sm">
                Dieser Link ist ungültig oder abgelaufen.
              </div>
              <Link href="/auth/forgot-password" className="btn-primary w-full py-2.5 block text-center">
                Neuen Link anfordern
              </Link>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider mb-1.5">Neues Passwort</label>
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  className="input" placeholder="••••••••" required
                />
              </div>
              <div>
                <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider mb-1.5">Passwort bestätigen</label>
                <input
                  type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                  className="input" placeholder="••••••••" required
                />
              </div>

              {error && (
                <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-red-400 text-sm">
                  {error}
                </div>
              )}

              <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
                {loading ? 'Speichern...' : 'Passwort speichern'}
              </button>
            </form>
          )}

          <div className="mt-4 pt-4 border-t border-[#1f2d45] text-center text-sm text-[#8a9bb5]">
            <Link href="/auth/login" className="text-brand-red hover:underline">Zurück zum Login</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
