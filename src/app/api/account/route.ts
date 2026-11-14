import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveCompanyContext } from '@/lib/auth/company-context'

export const dynamic = 'force-dynamic'

/**
 * GET /api/account
 * Angaben für „Einstellungen“ und die Importliste: Firma, eigene Rolle,
 * Zahl der Nutzer je Rolle, Standorte, bisherige Importe, Datenmenge.
 * Gelesen wird mit der Sitzung des Nutzers (RLS).
 */
export async function GET() {
  const supabase = await createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const { companyId, role } = auth.ctx
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabase as any
  const [{ data: { user } }, { data: company }, { data: members }, { data: stores }, { data: uploads, error: upErr }, { count: records }, { count: plz }] = await Promise.all([
    supabase.auth.getUser(),
    db.from('companies').select('name, plan, created_at').eq('id', companyId).maybeSingle(),
    db.from('company_users').select('role').eq('company_id', companyId),
    db.from('stores').select('id, name, city, postal_code, is_active').eq('company_id', companyId).order('name'),
    db.from('uploads').select('id, filename, created_at, period_start, period_end, row_count, status, import_mode, store_id, file_size_bytes').eq('company_id', companyId).order('created_at', { ascending: false }).limit(200),
    db.from('customers').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
    db.from('analytics').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
  ])
  if (upErr) return NextResponse.json({ error: 'Die Angaben konnten nicht geladen werden. Bitte erneut versuchen.' }, { status: 500 })
  const roles: Record<string, number> = {}
  for (const m of members || []) roles[m.role] = (roles[m.role] || 0) + 1
  return NextResponse.json({
    user: { email: user?.email || '' },
    company: { name: company?.name || '', plan: company?.plan || null, created_at: company?.created_at || null },
    role,
    members: { total: (members || []).length, by_role: roles },
    stores: stores || [],
    uploads: uploads || [],
    usage: { records: records ?? 0, postal_codes: plz ?? 0, imports: (uploads || []).filter((u: { status: string }) => u.status === 'completed').length },
  }, { headers: { 'Cache-Control': 'private, no-store' } })
}
