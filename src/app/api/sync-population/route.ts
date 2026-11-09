import { NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveCompanyContext, canWriteCompanyData } from '@/lib/auth/company-context'
import { verifiedPopulation } from '@/lib/geo/population'

/**
 * POST /api/sync-population
 *
 * Gleicht die Einwohnerzahlen in den PLZ-Analysen der EIGENEN Firma mit der
 * belegten Quelle ab (postal_codes mit population_method, siehe
 * lib/geo/population.ts):
 *   - belegte Zahl vorhanden → übernehmen, Durchdringung neu rechnen
 *   - keine belegte Zahl     → Einwohner, Durchdringung und „nicht erreicht“
 *                               auf null (Anzeige „—“)
 * Früher füllte die Route Lücken aus einer fest eingebauten, unbelegten
 * Tabelle und schrieb diese Werte zusätzlich als „amtlich“ in postal_codes.
 * Diese Route schreibt keine Referenzdaten mehr.
 */
export async function POST() {
  const supabase = createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { companyId } = auth.ctx

  // Ändert gespeicherte Analysen: nur Schreibrollen. Das Dashboard ruft die
  // Route beim Laden auf und ignoriert Fehler, für viewer bleibt alles beim Alten.
  if (!canWriteCompanyData(auth.ctx)) {
    return NextResponse.json({ error: 'Keine Berechtigung zum Ändern von Analysen' }, { status: 403 })
  }

  try {
    const { data: rows, error } = await supabase
      .from('analytics')
      .select('id, postal_code, population, customer_count, order_count')
      .eq('company_id', companyId)
    if (error) return NextResponse.json({ error: 'Analysen konnten nicht gelesen werden' }, { status: 500 })
    if (!rows?.length) return NextResponse.json({ updated: 0, total: 0 })

    const plzList = [...new Set(rows.map(r => r.postal_code))]
    const { data: refs } = await supabase
      .from('postal_codes')
      .select('postal_code, population, households, population_method, population_reference_date')
      .in('postal_code', plzList)
    const byPlz = new Map((refs || []).map(r => [r.postal_code, verifiedPopulation(r)]))

    let updated = 0
    for (const row of rows) {
      const pop = byPlz.get(row.postal_code)?.population ?? null
      if ((row.population ?? null) === pop) continue
      const customers = row.customer_count || 0
      const { error: updateError } = await supabase
        .from('analytics')
        .update({
          population: pop,
          market_penetration_pct: pop ? Math.round(customers / pop * 10000) / 100 : null,
          not_reached_residents: pop ? Math.max(0, pop - customers) : null,
        })
        .eq('id', row.id)
        .eq('company_id', companyId)
      if (!updateError) updated++
    }

    return NextResponse.json({ updated, total: rows.length, verified_plz: [...byPlz.values()].filter(v => v.population).length })
  } catch {
    return NextResponse.json({ error: 'Abgleich der Einwohnerzahlen fehlgeschlagen' }, { status: 500 })
  }
}
