import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { validateCompanyName, buildCompanySlug } from '@/lib/auth/registration'

/**
 * POST /api/auth/complete-registration
 *
 * Legt für einen bereits angemeldeten Nutzer seine Firma und die
 * Owner-Zuordnung an. Aufgerufen nach der Registrierung (wenn sofort eine
 * Sitzung besteht) und nach jedem Login.
 *
 * Warum so:
 * - Das Konto selbst wird im Browser per supabase.auth.signUp angelegt.
 *   Dadurch greifen die Rate-Limits von Supabase pro echter IP-Adresse
 *   und optional das CAPTCHA aus den Supabase-Einstellungen.
 * - Firma und Owner-Zuordnung legt die Datenbankfunktion register_company
 *   (supabase/pending/003_register_company.sql) an. Sie läuft mit der Sitzung
 *   des Nutzers, kein Service-Key. Die Funktion legt nur für den Aufrufer selbst
 *   an, nur wenn er noch keine Firma hat, in einer Transaktion und gegen
 *   gleichzeitige Aufrufe gesperrt. Andere Firmen kann sie nicht berühren.
 * - Idempotent: Hat der Nutzer schon eine Firma, passiert nichts.
 * - Firmenname kommt aus den Metadaten, die der Nutzer beim signUp selbst
 *   gesetzt hat. Er betrifft nur seine eigene neue Firma.
 */
export async function POST() {
  const supabase = await createServerSupabaseClient()
  const { data: authData, error: authError } = await supabase.auth.getUser()
  const user = authData?.user
  if (authError || !user) {
    return NextResponse.json({ error: 'Nicht authentifiziert' }, { status: 401 })
  }

  // 1. Schon einer Firma zugeordnet? Dann ist nichts zu tun.
  //    (Eigene Zuordnung ist für den Nutzer per RLS lesbar.)
  const { data: existing, error: existingError } = await supabase
    .from('company_users')
    .select('company_id')
    .eq('user_id', user.id)
  if (existingError) {
    return NextResponse.json({ error: 'Firmenzugehörigkeit konnte nicht geprüft werden' }, { status: 500 })
  }
  if (existing && existing.length > 0) {
    return NextResponse.json({ status: 'already_registered' })
  }

  // 2. Firmenname aus den eigenen Registrierungsdaten
  const nameCheck = validateCompanyName(user.user_metadata?.company_name)
  if (nameCheck.ok === false) {
    return NextResponse.json({ error: 'Kein gültiger Unternehmensname hinterlegt' }, { status: 400 })
  }

  // 3. Firma + Owner-Zuordnung atomar in der Datenbank anlegen
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabase as any).rpc('register_company', {
    p_name: nameCheck.value,
    p_slug: buildCompanySlug(nameCheck.value),
  })
  if (error || !data) {
    return NextResponse.json({ error: 'Unternehmen konnte nicht angelegt werden' }, { status: 500 })
  }
  const status = (data as { status?: string }).status
  return NextResponse.json({ status: status === 'already_registered' ? 'already_registered' : 'created' })
}
