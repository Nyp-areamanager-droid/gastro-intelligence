// =============================================================================
// Serverseitige Ermittlung von Nutzer und Firma
//
// Grundregel: Die Firma eines Requests wird IMMER hier auf dem Server aus der
// Sitzung ermittelt — nie aus Formular- oder Query-Daten des Browsers.
// Erst danach darf eine Route den Service-Key (umgeht RLS) verwenden.
// =============================================================================

import type { Database } from '@/lib/supabase/database.types'

export type CompanyRole = Database['public']['Enums']['user_role']

export interface CompanyContext {
  userId: string
  companyId: string
  role: CompanyRole
}

export type CompanyContextResult =
  | { ok: true; ctx: CompanyContext }
  | { ok: false; status: 401 | 403 | 409 | 500; error: string }

// Minimaler Ausschnitt des Supabase-Clients, den diese Prüfung braucht.
// So lässt sich die Funktion ohne echte Datenbank testen.
export interface AuthCapableClient {
  auth: {
    getUser(): Promise<{ data: { user: { id: string } | null }; error: unknown }>
  }
  // Locker typisiert, damit sowohl der echte Supabase-Client als auch
  // Test-Attrappen passen. Das Ergebnis wird unten explizit geprüft.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
}

interface MembershipRow {
  company_id: string
  role: CompanyRole
}

/**
 * Ermittelt den eingeloggten Nutzer und seine Firma.
 * `supabase` muss der Client mit der Nutzersitzung sein (Anon-Key + Cookies),
 * nicht der Service-Client.
 */
export async function resolveCompanyContext(
  supabase: AuthCapableClient
): Promise<CompanyContextResult> {
  const { data: authData, error: authError } = await supabase.auth.getUser()
  const user = authData?.user
  if (authError || !user) {
    return { ok: false, status: 401, error: 'Nicht authentifiziert' }
  }

  const { data, error: membershipError } = await supabase
    .from('company_users')
    .select('company_id, role')
    .eq('user_id', user.id)
  const memberships = data as MembershipRow[] | null

  if (membershipError) {
    return { ok: false, status: 500, error: 'Firmenzugehörigkeit konnte nicht geprüft werden' }
  }
  if (!memberships || memberships.length === 0) {
    return { ok: false, status: 403, error: 'Kein Unternehmen gefunden' }
  }
  if (memberships.length > 1) {
    // Mehrere Firmen pro Nutzer sind im Produkt noch nicht vorgesehen.
    // Lieber ablehnen als eine Firma zufällig auswählen.
    return { ok: false, status: 409, error: 'Nutzer ist mehreren Unternehmen zugeordnet – Auswahl wird noch nicht unterstützt' }
  }

  const { company_id, role } = memberships[0]
  return { ok: true, ctx: { userId: user.id, companyId: company_id, role } }
}

export function hasRole(ctx: CompanyContext, allowed: CompanyRole[]): boolean {
  return allowed.includes(ctx.role)
}

// ── Rollenmodell ─────────────────────────────────────────────────────────────
// owner   : alles, inkl. Mitglieder und Firmeneinstellungen
// admin   : alles, inkl. Mitglieder und Firmeneinstellungen
// manager : Daten importieren und Analysen ändern
// viewer  : nur lesen
// Dieselbe Einteilung gilt in der Datenbank (Migration 002, can_write_company_data()).
export const DATA_WRITE_ROLES: CompanyRole[] = ['owner', 'admin', 'manager']
export const ADMIN_ROLES: CompanyRole[] = ['owner', 'admin']

export function canWriteCompanyData(ctx: CompanyContext): boolean {
  return hasRole(ctx, DATA_WRITE_ROLES)
}

/**
 * Macht einen Dateinamen sicher für einen Storage-Pfad:
 * keine Ordnerwechsel ("../", "/"), keine Steuerzeichen, begrenzte Länge.
 */
export function sanitizeStorageFileName(name: string): string {
  const base = (name.split(/[\\/]/).pop() || '').trim()
  const cleaned = base
    .normalize('NFKD')
    .replace(/[^\w.\-]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^[._]+/, '')
    .slice(0, 120)
  return cleaned || 'upload'
}
