import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createServiceClient } from '@/lib/supabase/server'
import {
  detectColumns, parseAndCleanRows, computeRFM,
  computeDashboardKPIs, generateAlerts, generateRecommendations,
  analyzeStreets, analyzePLZ
} from '@/lib/analysis/engine'
import { DataProviderOrchestrator, censusProvider } from '@/lib/providers'
import { getPopulation } from '@/lib/census'
import type { ParsedCustomerRow } from '@/types'

export const maxDuration = 60 // Vercel: max 60s für Pro plan

export async function POST(req: NextRequest) {
  const supabase = createServiceClient()

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const companyId = formData.get('company_id') as string
    const storeId = formData.get('store_id') as string | null
    const userId = formData.get('user_id') as string

    if (!file || !companyId) {
      return NextResponse.json({ error: 'Datei und company_id erforderlich' }, { status: 400 })
    }

    // ── 1. Datei in Supabase Storage hochladen ────────────────────────────────
    const fileBuffer = await file.arrayBuffer()
    const storagePath = `${companyId}/${Date.now()}_${file.name}`

    const { error: storageError } = await supabase.storage
      .from('uploads')
      .upload(storagePath, fileBuffer, { contentType: file.type })

    if (storageError) {
      return NextResponse.json({ error: `Upload-Fehler: ${storageError.message}` }, { status: 500 })
    }

    // ── 2. Upload-Datensatz erstellen ─────────────────────────────────────────
    const { data: upload, error: uploadError } = await supabase
      .from('uploads')
      .insert({
        company_id: companyId,
        store_id: storeId || null,
        uploaded_by: userId,
        filename: file.name,
        storage_path: storagePath,
        file_size_bytes: file.size,
        file_type: file.type,
        status: 'processing',
      })
      .select()
      .single()

    if (uploadError || !upload) {
      return NextResponse.json({ error: 'Upload-Record konnte nicht erstellt werden' }, { status: 500 })
    }

    // ── 3. Excel parsen ───────────────────────────────────────────────────────
    const workbook = XLSX.read(fileBuffer, { type: 'array', cellDates: true })
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' })

    if (!rawRows.length) {
      await supabase.from('uploads').update({ status: 'failed', error_message: 'Datei leer' }).eq('id', upload.id)
      return NextResponse.json({ error: 'Datei enthält keine Daten' }, { status: 400 })
    }

    // ── 4. Spalten erkennen ───────────────────────────────────────────────────
    const headers = Object.keys(rawRows[0])
    const columnMapping = detectColumns(headers)

    if (!columnMapping.postal_code) {
      await supabase.from('uploads').update({
        status: 'failed',
        error_message: 'Keine PLZ-Spalte erkannt. Bitte Spalten manuell zuordnen.'
      }).eq('id', upload.id)
      return NextResponse.json({ error: 'Keine PLZ-Spalte erkannt', headers, detected: columnMapping }, { status: 422 })
    }

    // ── 5. Bereinigung + RFM ──────────────────────────────────────────────────
    const { rows: cleanedRows, duplicates, errors } = parseAndCleanRows(rawRows, columnMapping)
    const rowsWithRFM = computeRFM(cleanedRows)

    // Datumsbereich
    const dates = rowsWithRFM.map(r => r.last_order_date).filter(Boolean) as string[]
    const periodStart = dates.length ? dates.sort()[0] : null
    const periodEnd = dates.length ? dates.sort().reverse()[0] : null

    // ── 6. Kunden in DB speichern (upsert, Batches à 500) ────────────────────
    const BATCH = 500
    for (let i = 0; i < rowsWithRFM.length; i += BATCH) {
      const batch = rowsWithRFM.slice(i, i + BATCH)
      const records = batch.map((r: ParsedCustomerRow) => ({
        company_id: companyId,
        store_id: storeId || null,
        upload_id: upload.id,
        phone_normalized: r.phone_normalized || null,
        phone_raw: r.phone_raw || null,
        first_name: r.first_name || null,
        last_name: r.last_name || null,
        full_name: r.full_name || null,
        street: r.street || null,
        street_normalized: r.street_normalized || null,
        house_number: r.house_number || null,
        postal_code: r.postal_code!,
        city: r.city || null,
        total_orders: r.total_orders,
        total_revenue: r.total_revenue,
        avg_order_value: r.avg_order_value || null,
        last_order_date: r.last_order_date || null,
        rfm_segment: r.rfm_segment || null,
        rfm_score: r.rfm_score || null,
        is_vip: r.is_vip || false,
        platform: r.platform || null,
        late_deliveries: r.late_deliveries || 0,
      }))

      await supabase.from('customers').insert(records)
    }

    // ── 7. Analyse pro PLZ ────────────────────────────────────────────────────
    const plzGroups = new Map<string, ParsedCustomerRow[]>()
    for (const r of rowsWithRFM) {
      if (!plzGroups.has(r.postal_code!)) plzGroups.set(r.postal_code!, [])
      plzGroups.get(r.postal_code!)!.push(r)
    }

    // Hole Company Google Places Key
    const { data: company } = await supabase
      .from('companies')
      .select('google_places_api_key')
      .eq('id', companyId)
      .single()

    const orchestrator = new DataProviderOrchestrator(company?.google_places_api_key || undefined)
    const plzAnalyses = []

    for (const [plz, plzRows] of plzGroups) {
      // Straßen aus DB oder live
      let officialStreets: string[] = []
      const { data: dbStreets } = await supabase
        .from('streets')
        .select('name')
        .eq('postal_code', plz)

      if (dbStreets && dbStreets.length > 0) {
        officialStreets = dbStreets.map(s => s.name)
      } else {
        // Live aus OpenPLZ
        const result = await orchestrator.getStreets(plz)
        officialStreets = result.streets

        // Straßen in DB cachen
        if (officialStreets.length > 0) {
          // PLZ erst sicherstellen
          const plzInfo = await orchestrator.getPostalCodeData(plz)
          await supabase.from('postal_codes').upsert({
            postal_code: plz,
            city: plzInfo.info.city || plzRows[0]?.city || plz,
            state: plzInfo.info.state || null,
            population: plzInfo.census?.population || null,
            households: plzInfo.census?.households || null,
            population_year: plzInfo.census?.year || null,
            data_source: plzInfo.info.data_source || 'openplz',
            trust_level: plzInfo.census?.trust_level || 'public',
            last_fetched_at: new Date().toISOString(),
          }, { onConflict: 'postal_code' })

          // Straßen einfügen
          const streetRecords = officialStreets.map(name => ({
            postal_code: plz,
            name,
            name_normalized: name.toLowerCase().replace(/\s+/g,'').replace(/straße/g,'str'),
            data_source: 'openplz' as const,
            last_fetched_at: new Date().toISOString(),
          }))
          await supabase.from('streets').upsert(streetRecords, { onConflict: 'postal_code,name_normalized', ignoreDuplicates: true })
        }
      }

      // PLZ-Bevölkerungsdaten (postal_codes DB oder CENSUS-Fallback)
      const { data: plzData } = await supabase
        .from('postal_codes')
        .select('population, households')
        .eq('postal_code', plz)
        .single()

      // CENSUS-Fallback wenn postal_codes keine Population hat
      const censusData = censusProvider.getCensusData(plz)
      // Dreifacher Fallback: DB → providers/CENSUS_DATA → census.ts (mit Schätzwert)
      const population = plzData?.population || censusData?.population || getPopulation(plz) || null
      const households = plzData?.households || censusData?.households || null

      // Population in postal_codes schreiben falls noch nicht vorhanden
      if (!plzData?.population && population) {
        try {
          await supabase.from('postal_codes').upsert({
            postal_code: plz,
            city: plzRows[0]?.city || plz,
            population,
            households,
            population_year: 2022,
            data_source: 'census',
            trust_level: 'official',
            last_fetched_at: new Date().toISOString(),
          }, { onConflict: 'postal_code' })
        } catch {
          // Nicht-kritisch: Bevölkerungsdaten konnten nicht gecacht werden
        }
      }

      const analysis = analyzePLZ(
        plzRows,
        officialStreets,
        population,
        households,
      )
      plzAnalyses.push(analysis)

      // Straßen-Analyse
      const streetResults = analyzeStreets(plzRows, officialStreets)

      // Analytics in DB speichern (alte Einträge für diese PLZ+Company entfernen um Duplikate zu vermeiden)
      await supabase.from('analytics').delete().eq('company_id', companyId).eq('postal_code', plz)

      const { data: analyticsRecord } = await supabase
        .from('analytics')
        .insert({
          company_id: companyId,
          store_id: storeId || null,
          upload_id: upload.id,
          postal_code: plz,
          period_start: periodStart,
          period_end: periodEnd,
          customer_count: analysis.customer_count,
          order_count: analysis.order_count,
          revenue: analysis.revenue,
          avg_order_value: analysis.avg_order_value,
          orders_per_customer: analysis.orders_per_customer,
          population: analysis.population,
          market_penetration_pct: analysis.market_penetration_pct,
          not_reached_residents: analysis.not_reached_residents,
          streets_total: analysis.streets_total,
          streets_with_orders: analysis.streets_with_orders,
          streets_without_orders: analysis.streets_without_orders,
          streets_coverage_pct: analysis.streets_coverage_pct,
          one_time_buyers: analysis.one_time_buyers,
          repeat_customers: analysis.repeat_customers,
          vip_customers: analysis.vip_customers,
          potential_scenarios: analysis.potential_scenarios,
          top_recommendations: analysis.warnings,
        })
        .select()
        .single()

      // Straßen-Analytics speichern
      if (analyticsRecord) {
        const streetRecords = streetResults.slice(0, 200).map(s => ({
          analytics_id: analyticsRecord.id,
          company_id: companyId,
          postal_code: plz,
          street_name: s.street_name,
          street_name_normalized: s.street_name.toLowerCase().replace(/\s+/g,'').replace(/straße/g,'str'),
          customer_count: s.customer_count,
          order_count: s.order_count,
          revenue: s.revenue,
          avg_order_value: s.avg_order_value,
          orders_per_customer: s.orders_per_customer,
          street_class: s.street_class,
          is_in_official_list: s.is_in_official_list,
        }))
        await supabase.from('street_analytics').insert(streetRecords)
      }
    }

    // ── 8. Dashboard KPIs + Alerts + Empfehlungen ─────────────────────────────
    const kpis = computeDashboardKPIs(rowsWithRFM)
    const streetResultsAll = rowsWithRFM.length > 0 ? analyzeStreets(rowsWithRFM, []) : []
    const recs = generateRecommendations(kpis, plzAnalyses, streetResultsAll)
    const alertPayloads = generateAlerts(kpis)

    // Alerts speichern
    if (alertPayloads.length) {
      await supabase.from('alerts').insert(
        alertPayloads.map(a => ({ ...a, company_id: companyId, store_id: storeId || null }))
      )
    }

    // Marketing-Empfehlungen speichern
    if (recs.length) {
      await supabase.from('marketing_actions').insert(
        recs.map(r => ({
          company_id: companyId,
          store_id: storeId || null,
          upload_id: upload.id,
          action_type: r.action_type,
          title: r.title,
          description: r.description,
          estimated_cost: r.estimated_cost,
          estimated_potential: r.estimated_potential,
          estimated_roi: r.roi,
          priority: r.priority,
          status: 'recommended',
        }))
      )
    }

    // ── 9. Upload abschließen ─────────────────────────────────────────────────
    await supabase.from('uploads').update({
      status: 'completed',
      row_count: rowsWithRFM.length,
      column_mapping: columnMapping,
      period_start: periodStart,
      period_end: periodEnd,
      processed_at: new Date().toISOString(),
    }).eq('id', upload.id)

    return NextResponse.json({
      success: true,
      upload_id: upload.id,
      summary: {
        total_rows: rawRows.length,
        valid_rows: rowsWithRFM.length,
        duplicate_rows: duplicates,
        error_rows: errors,
        unique_plz: plzGroups.size,
        period: { start: periodStart, end: periodEnd },
      },
      kpis,
      alerts: alertPayloads.length,
      recommendations: recs.length,
      plz_analyses: plzAnalyses.length,
    })

  } catch (err) {
    console.error('Upload processing error:', err)
    return NextResponse.json(
      { error: 'Interner Fehler bei der Verarbeitung', details: String(err) },
      { status: 500 }
    )
  }
}
