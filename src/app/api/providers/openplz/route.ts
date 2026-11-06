import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient, createReferenceDataClient } from '@/lib/supabase/server'
import { resolveCompanyContext, hasRole, ADMIN_ROLES } from '@/lib/auth/company-context'
import { openplzProvider, censusProvider } from '@/lib/providers'
import { invalidateStreetDirectory } from '@/lib/geo/street-directory'

// GET /api/providers/openplz?plz=51063&refresh=false
export async function GET(req: NextRequest) {
  // Nur für eingeloggte Mitglieder einer Firma. Die Route schreibt mit dem
  // Service-Key in gemeinsame Referenztabellen (keine Firmendaten).
  const auth = await resolveCompanyContext(createServerSupabaseClient())
  if (auth.ok === false) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }

  const plz = req.nextUrl.searchParams.get('plz')
  const forceRefresh = req.nextUrl.searchParams.get('refresh') === 'true'
  // Erzwungenes Neuladen überschreibt den gemeinsamen Cache für alle Firmen
  if (forceRefresh && !hasRole(auth.ctx, ADMIN_ROLES)) {
    return NextResponse.json({ error: 'Neuladen nur für Inhaber oder Admins' }, { status: 403 })
  }

  if (!plz || !/^\d{5}$/.test(plz)) {
    return NextResponse.json({ error: 'Ungültige PLZ' }, { status: 400 })
  }

  // Nur gemeinsame Referenzdaten (siehe createReferenceDataClient)
  const supabase = createReferenceDataClient()

  // Immer aus OpenPLZ (mit 6-Stunden-Zwischenspeicher im Serverprozess).
  // Der Datenbank-Cache wird nicht mehr als Quelle gelesen: Er kennt keine
  // Vollständigkeit und wurde früher mit .limit(1000) abgeschnitten.
  if (forceRefresh) invalidateStreetDirectory(plz)
  const start = Date.now()
  const dir = await openplzProvider.getStreetDirectory(plz)
  const plzInfo = await openplzProvider.getPostalCodeInfo(plz)
  const census = censusProvider.getCensusData(plz)
  const duration = Date.now() - start

  if (dir.status !== 'complete') {
    await supabase.from('data_refresh_logs').insert({
      postal_code: plz,
      data_type: 'streets',
      data_source: 'openplz',
      status: 'failed',
      records_fetched: dir.totalFetched,
      duration_ms: duration,
      error_message: dir.status === 'empty' ? 'Keine Straßen von OpenPLZ zurückgegeben' : `Unvollständig: ${dir.reason}`,
    })

    return NextResponse.json({
      plz,
      streets: [],
      count: 0,
      complete: false,
      status: dir.status,
      warning: dir.status === 'empty'
        ? `Keine Straßen für PLZ ${plz} in OpenPLZ gefunden. Die PLZ existiert möglicherweise nicht.`
        : `Straßenverzeichnis für PLZ ${plz} unvollständig (${dir.reason}). Es wurde nichts gespeichert.`,
      census: census || { warning: `Einwohnerzahl für PLZ ${plz} nicht im Zensus 2022 vorhanden.` },
    })
  }

  const streets = dir.streets

  // Postal Code upserten. Einwohnerfelder nur mitschicken, wenn wirklich
  // Werte vorliegen: sonst würde ein Aufruf vorhandene Einwohnerzahlen im
  // gemeinsamen Bestand mit null überschreiben.
  await supabase.from('postal_codes').upsert({
    postal_code: plz,
    city: plzInfo?.city || plz,
    state: plzInfo?.state || null,
    district: plzInfo?.district || null,
    municipality: plzInfo?.municipality || null,
    ...(census?.population
      ? {
          population: census.population,
          households: census.households || null,
          population_year: census.year || null,
          population_source: 'census',
        }
      : {}),
    data_source: 'openplz',
    trust_level: 'official',
    last_fetched_at: new Date().toISOString(),
    needs_refresh: false,
  }, { onConflict: 'postal_code' })

  // Straßenliste der PLZ ersetzen (nur vollständige Listen kommen hier an)
  const fetchedAt = new Date().toISOString()
  const streetRecords = streets.map(s => ({
    postal_code: plz,
    name: s.name,
    name_normalized: s.key,
    data_source: 'openplz' as const,
    last_fetched_at: fetchedAt,
  }))

  const { error: deleteError } = await supabase.from('streets').delete().eq('postal_code', plz)
  if (!deleteError) {
    for (let i = 0; i < streetRecords.length; i += 500) {
      await supabase.from('streets')
        .upsert(streetRecords.slice(i, i + 500), { onConflict: 'postal_code,name_normalized', ignoreDuplicates: false })
    }
  }

  // Log
  await supabase.from('data_refresh_logs').insert({
    postal_code: plz,
    data_type: 'streets',
    data_source: 'openplz',
    status: 'success',
    records_fetched: streets.length,
    duration_ms: duration,
  })

  return NextResponse.json({
    plz,
    city: plzInfo?.city,
    state: plzInfo?.state,
    streets: streets.map(s => s.name),
    count: streets.length,
    complete: true,
    source: 'openplz',
    census: census || {
      warning: `Einwohnerzahl für PLZ ${plz} nicht im Zensus 2022 vorhanden. Bitte manuell ergänzen oder alternative Quelle nutzen.`,
    },
  })
}
