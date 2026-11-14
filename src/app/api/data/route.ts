import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveCompanyContext, hasRole, ADMIN_ROLES } from '@/lib/auth/company-context'
import { rateLimit, tooManyRequests } from '@/lib/security/rate-limit'

export const dynamic = 'force-dynamic'
const DELETE_CONFIRM_WORD = 'LÖSCHEN'

/**
 * DELETE /api/data   Body: { "confirm": "LÖSCHEN" }
 * Löscht ALLE importierten Daten der eigenen Firma endgültig: Kundendatensätze,
 * Auswertungen, Hinweise, Empfehlungen, Importe und die gespeicherten Dateien.
 * Konto, Firma, Nutzer und Standorte bleiben bestehen.
 *
 * Nur Inhaber und Administratoren. Gelöscht wird mit der Sitzung des Nutzers;
 * die Zugriffsregeln (RLS) begrenzen jede Löschung zusätzlich auf die eigene
 * Firma. Die Firmen-ID kommt nie aus der Anfrage.
 */
export async function DELETE(req: NextRequest) {
  const supabase = await createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (!hasRole(auth.ctx, ADMIN_ROLES)) {
    return NextResponse.json({ error: 'Nur Inhaber und Administratoren können die Daten löschen.' }, { status: 403 })
  }
  const { companyId, userId } = auth.ctx
  const limited = rateLimit(`delete-data:${userId}`, 5, 600_000)
  if (!limited.ok) { const t = tooManyRequests(limited); return NextResponse.json(t.body, t.init) }

  const body = await req.json().catch(() => null)
  if (!body || body.confirm !== DELETE_CONFIRM_WORD) {
    return NextResponse.json({ error: `Zur Bestätigung bitte das Wort ${DELETE_CONFIRM_WORD} eingeben. Es wurde nichts gelöscht.` }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const { data: uploads } = await db.from('uploads').select('storage_path').eq('company_id', companyId)

  // Reihenfolge: erst abhängige Tabellen, zuletzt die Importe
  const deleted: Record<string, number> = {}
  for (const table of ['marketing_actions', 'alerts', 'street_analytics', 'analytics', 'customers', 'uploads']) {
    const { error, count } = await db.from(table).delete({ count: 'exact' }).eq('company_id', companyId)
    if (error) {
      console.error(`Datenlöschung: ${table} fehlgeschlagen:`, error.message)
      return NextResponse.json({
        error: 'Die Daten konnten nicht vollständig gelöscht werden. Bitte versuchen Sie es erneut; der Vorgang kann gefahrlos wiederholt werden.',
        deleted,
      }, { status: 500 })
    }
    deleted[table] = count ?? 0
  }

  // Gespeicherte Dateien: nur Pfade im eigenen Firmenordner
  const paths = ((uploads || []) as { storage_path: string | null }[]).map(u => u.storage_path).filter((p): p is string => typeof p === 'string' && p.startsWith(`${companyId}/`))
  let filesRemoved = 0, filesFailed = 0
  for (let i = 0; i < paths.length; i += 100) {
    const { data, error } = await supabase.storage.from('uploads').remove(paths.slice(i, i + 100))
    if (error) filesFailed += Math.min(100, paths.length - i); else filesRemoved += (data || []).length
  }

  return NextResponse.json({
    success: true, deleted, files_removed: filesRemoved,
    ...(filesFailed ? { warning: `${filesFailed} gespeicherte Dateien konnten nicht entfernt werden. Bitte wenden Sie sich an den Support.` } : {}),
  })
}
