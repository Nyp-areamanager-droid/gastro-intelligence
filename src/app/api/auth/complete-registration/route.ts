import { NextResponse } from 'next/server'
import { createServerSupabaseClient, createServiceClient } from '@/lib/supabase/server'
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
 *   und optional das CAPTCHA aus den Supabase-Einstellungen. Ein signUp über
 *   den Server würde alle Anfragen über die Server-IP bündeln.
 * - Diese Route ist nicht öffentlich: Sie braucht eine gültige Sitzung.
 *   Die Nutzer-ID kommt aus der Sitzung, nie aus dem Request.
 * - Idempotent: Hat der Nutzer schon eine Firma, passiert nichts.
 *   Bricht die Firmenanlage ab, wird sie beim nächsten Login nachgeholt.
 *   Es bleiben also keine Konten dauerhaft ohne Firma zurück.
 * - Firmenname kommt aus den Metadaten, die der Nutzer beim signUp selbst
 *   gesetzt hat. Er betrifft nur seine eigene neue Firma.
 */
export async function POST() {
  const supabase = createServerSupabaseClient()
  const { data: authData, error: authError } = await supabase.auth.getUser()
  const user = authData?.user
  if (authError || !user) {
    return NextResponse.json({ error: 'Nicht authentifiziert' }, { status: 401 })
  }

  const service = createServiceClient()

  // 1. Schon einer Firma zugeordnet? Dann ist nichts zu tun.
  const { data: existing, error: existingError } = await service
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

  // 3. Firma anlegen
  const { data: company, error: companyError } = await service
    .from('companies')
    .insert({ name: nameCheck.value, slug: buildCompanySlug(nameCheck.value), plan: 'trial' })
    .select('id')
    .single()
  if (companyError || !company) {
    return NextResponse.json({ error: 'Unternehmen konnte nicht angelegt werden' }, { status: 500 })
  }

  // 4. Owner-Zuordnung
  const { error: memberError } = await service
    .from('company_users')
    .insert({ company_id: company.id, user_id: user.id, role: 'owner' })
  if (memberError) {
    await service.from('companies').delete().eq('id', company.id)
    return NextResponse.json({ error: 'Owner-Zuordnung fehlgeschlagen, bitte erneut anmelden' }, { status: 500 })
  }

  // 5. Doppelte Anlage durch zwei gleichzeitige Aufrufe zurückrollen.
  // Die älteste Zuordnung bleibt, alle späteren entfernen sich selbst.
  // So bleibt genau eine Firma übrig, egal wie viele Aufrufe parallel laufen.
  const { data: after } = await service
    .from('company_users')
    .select('company_id, joined_at')
    .eq('user_id', user.id)
    .order('joined_at', { ascending: true })
    .order('company_id', { ascending: true })
  if (after && after.length > 1 && after[0].company_id !== company.id) {
    await service.from('company_users').delete().eq('company_id', company.id).eq('user_id', user.id)
    await service.from('companies').delete().eq('id', company.id)
    return NextResponse.json({ status: 'already_registered' })
  }

  return NextResponse.json({ status: 'created' })
}
