// Gemeinsamer Rahmen der Seiten vor der Anmeldung (Anmelden, Registrieren,
// Passwort vergessen/neu setzen).
import type { ReactNode } from 'react'

export function AuthShell({ title, lead, children, footer }: { title: string; lead?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-10">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-[10px] bg-accent text-white">
            <svg width="20" height="20" viewBox="0 0 18 18" fill="none"><path d="M9 1.5c-3 0-5.25 2.3-5.25 5.2 0 3.7 4.2 8.3 4.9 9a.5.5 0 0 0 .7 0c.7-.7 4.9-5.3 4.9-9C14.25 3.8 12 1.5 9 1.5Z" stroke="currentColor" strokeWidth="1.5" /><path d="M6.6 7.4h4.8M6.6 5.4h4.8M9 5.4v4.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
          </span>
          <span className="text-[17px] font-semibold tracking-tight">Gastro Intelligence</span>
        </div>
        <main className="card p-6 sm:p-7">
          <h1 className="text-[19px] font-semibold leading-7">{title}</h1>
          {lead && <p className="mt-1 text-ink-soft">{lead}</p>}
          <div className="mt-5">{children}</div>
        </main>
        {footer && <div className="mt-4 text-center text-[13.5px] text-ink-soft">{footer}</div>}
        <p className="mt-8 text-center text-[12.5px] text-ink-muted">Liefergebiete verstehen: Bestellungen nach Straße und Postleitzahl.</p>
      </div>
    </div>
  )
}

/** Meldungen des Anmeldedienstes (englisch) in verständliches Deutsch. */
export function authErrorDE(message: string | undefined | null): string {
  const m = String(message || '').replace(/^Error:\s*/, '')
  const map: [RegExp, string][] = [
    [/invalid login credentials/i, 'E-Mail-Adresse oder Passwort stimmen nicht.'],
    [/email not confirmed/i, 'Bitte bestätigen Sie zuerst Ihre E-Mail-Adresse über den Link in unserer Nachricht.'],
    [/signups? (not allowed|disabled)/i, 'Neue Konten können zurzeit nicht selbst angelegt werden. Bitte wenden Sie sich an uns, wir richten Ihren Zugang ein.'],
    [/already registered|already been registered/i, 'Für diese E-Mail-Adresse gibt es bereits ein Konto. Bitte melden Sie sich an.'],
    [/rate limit|too many requests|security purposes/i, 'Zu viele Versuche in kurzer Zeit. Bitte warten Sie einen Moment und versuchen Sie es erneut.'],
    [/password should be at least/i, 'Das Passwort ist zu kurz. Bitte mindestens 8 Zeichen verwenden.'],
    [/weak password|pwned|compromised/i, 'Dieses Passwort ist zu unsicher. Bitte wählen Sie ein anderes.'],
    [/same password|different from the old/i, 'Das neue Passwort muss sich vom bisherigen unterscheiden.'],
    [/failed to fetch|network/i, 'Keine Verbindung zum Server. Bitte prüfen Sie Ihre Internetverbindung.'],
    [/unable to validate email|invalid email/i, 'Bitte geben Sie eine gültige E-Mail-Adresse ein.'],
  ]
  for (const [re, de] of map) if (re.test(m)) return de
  return m || 'Das hat nicht geklappt. Bitte versuchen Sie es erneut.'
}
