// Browser-Seite: Firmenanlage nach Registrierung oder Login anstoßen.
// Die Route ist idempotent, ein wiederholter Aufruf schadet nicht.

export interface CompleteRegistrationResult {
  ok: boolean
  status: number
  error?: string
}

export async function completeRegistration(): Promise<CompleteRegistrationResult> {
  try {
    const res = await fetch('/api/auth/complete-registration', { method: 'POST' })
    if (res.ok) return { ok: true, status: res.status }
    const body = await res.json().catch(() => ({}))
    return { ok: false, status: res.status, error: body.error || 'Unternehmen konnte nicht eingerichtet werden' }
  } catch {
    return { ok: false, status: 0, error: 'Verbindung fehlgeschlagen' }
  }
}
