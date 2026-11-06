// Prüfungen rund um die Registrierung.
// Getrennt von den Routen, damit sie ohne Datenbank testbar sind.

export interface RegistrationInput {
  email: string
  password: string
  companyName: string
}

export type RegistrationValidation =
  | { ok: true; value: RegistrationInput }
  | { ok: false; error: string }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export type CompanyNameValidation =
  | { ok: true; value: string }
  | { ok: false; error: string }

export function validateCompanyName(raw: unknown): CompanyNameValidation {
  const name = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  if (name.length < 2 || name.length > 100) {
    return { ok: false, error: 'Unternehmensname muss zwischen 2 und 100 Zeichen lang sein' }
  }
  return { ok: true, value: name }
}

/** Formularprüfung vor dem signUp (im Browser genutzt). */
export function validateRegistrationInput(raw: unknown): RegistrationValidation {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    return { ok: false, error: 'Bitte eine gültige E-Mail-Adresse angeben' }
  }
  if (password.length < 8 || password.length > 128) {
    return { ok: false, error: 'Passwort muss zwischen 8 und 128 Zeichen lang sein' }
  }
  const company = validateCompanyName(body.companyName)
  if (company.ok === false) return { ok: false, error: company.error }

  return { ok: true, value: { email, password, companyName: company.value } }
}

// Gleiche Slug-Logik wie bisher auf der Registrierungsseite
export function buildCompanySlug(companyName: string, now: number = Date.now()): string {
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50)
  return `${slug}-${now}`
}
