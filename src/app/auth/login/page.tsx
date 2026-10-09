'use client'

import { useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

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
      setError(error.message === 'Invalid login credentials' ? 'E-Mail oder Passwort falsch' : error.message)
    } else {
      router.push('/dashboard')
      router.refresh()
    }
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[#07090f] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        {/* Logo */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-xl bg-brand-red mb-4">
            <span className="text-white text-xl font-bold font-mono">GI</span>
          </div>
          <h1 className="text-2xl font-bold font-head">Gastro Intelligence</h1>
          <p className="text-[#8a9bb5] text-sm mt-1">Area Manager Platform</p>
        </div>

        <div className="card">
          <h2 className="text-lg font-semibold mb-5">Anmelden</h2>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider mb-1.5">E-Mail</label>
              <input
                type="email" value={email} onChange={e => setEmail(e.target.value)}
                className="input" placeholder="name@unternehmen.de" required
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs text-[#8a9bb5] uppercase tracking-wider">Passwort</label>
                <Link href="/auth/forgot-password" className="text-xs text-brand-red hover:underline">Passwort vergessen?</Link>
              </div>
              <input
                type="password" value={password} onChange={e => setPassword(e.target.value)}
                className="input" placeholder="••••••••" required
              />
            </div>

            {error && (
              <div className="bg-red-500/10 border border-red-500/25 rounded-lg p-3 text-red-400 text-sm">
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full py-2.5">
              {loading ? 'Anmelden...' : 'Anmelden'}
            </button>
          </form>

          <div className="mt-4 pt-4 border-t border-[#1f2d45] text-center text-sm text-[#8a9bb5]">
            Noch kein Konto?{' '}
            <Link href="/auth/register" className="text-brand-red hover:underline">Registrieren</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
