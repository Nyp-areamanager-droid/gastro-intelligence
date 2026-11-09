import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { resolveCompanyContext } from '@/lib/auth/company-context'
import { loadPlzMap } from '@/lib/geo/overpass'

export const maxDuration = 60

/**
 * GET /api/geo/plz-map?plz=01067
 *
 * PLZ-Fläche, Straßen (an der PLZ-Grenze abgeschnitten) und Anzahl der
 * Hausadressen je Straße aus OpenStreetMap, für jede deutsche PLZ.
 * Öffentliche Geodaten, keine Firmendaten. Nur für angemeldete Mitglieder
 * einer Firma, damit der Kartendienst nicht von außen belastet wird.
 */
export async function GET(req: NextRequest) {
  const auth = await resolveCompanyContext(createServerSupabaseClient())
  if (auth.ok === false) return NextResponse.json({ error: auth.error }, { status: auth.status })

  const plz = req.nextUrl.searchParams.get('plz') || ''
  const result = await loadPlzMap(plz)
  if (result.ok === false) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ ...result.map, cached: result.cached })
}
