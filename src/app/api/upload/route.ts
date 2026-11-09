import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createServerSupabaseClient, createReferenceDataClient } from '@/lib/supabase/server'
import { resolveCompanyContext, canWriteCompanyData, sanitizeStorageFileName } from '@/lib/auth/company-context'
import {
  detectColumns, parseAndCleanRows, computeRFM,
  computeDashboardKPIs, generateAlerts, generateRecommendations,
  analyzeStreets, analyzePLZ, NO_STREET_DIRECTORY
} from '@/lib/analysis/engine'
import { streetNameKey } from '@/lib/geo/street-name'
import { readWorkbook } from '@/lib/import/read-table'
import { DataProviderOrchestrator, censusProvider } from '@/lib/providers'
import { getPopulation } from '@/lib/census'
import type { ParsedCustomerRow } from '@/types'

export const maxDuration = 60 // Vercel: max 60s für Pro plan

export async function POST(req: NextRequest) {
  // ── 0. Nutzer und Firma serverseitig ermitteln ────────────────────────────
  // Die Firma kommt ausschließlich aus der Sitzung. Alle Firmendaten (Datei,
  // Upload, Kunden, Analysen) werden mit DIESER Sitzung geschrieben, die
  // RLS-Regeln greifen also zusätzlich zur Prüfung hier.
  const supabase = createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { companyId, userId } = auth.ctx

  // Import verändert Firmendaten: nur owner, admin, manager (nicht viewer)
  if (!canWriteCompanyData(auth.ctx)) {
    return NextResponse.json({ error: 'Keine Berechtigung zum Importieren von Daten' }, { status: 403 })
  }

  // Service-Key nur für gemeinsame Referenzdaten (PLZ, Straßenverzeichnis)
  const reference = createReferenceDataClient()

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const requestedCompanyId = formData.get('company_id') as string | null
    const storeIdRaw = formData.get('store_id') as string | null
    const storeId = storeIdRaw && storeIdRaw.trim() ? storeIdRaw.trim() : null

    if (!file) {
      return NextResponse.json({ error: 'Datei erforderlich' }, { status: 400 })
    }

    // Ältere Clients senden company_id noch mit. Weicht sie von der
    // Sitzung ab, wird abgelehnt statt still die eigene Firma zu nehmen.
    if (requestedCompanyId && requestedCompanyId !== companyId) {
      return NextResponse.json({ error: 'Kein Zugriff auf dieses Unternehmen' }, { status: 403 })
    }

    // Filiale muss zur eigenen Firma gehören
    if (storeId) {
      const { data: store } = await supabase
        .from('stores')
        .select('id')
        .eq('id', storeId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (!store) {
        return NextResponse.json({ error: 'Filiale gehört nicht zu diesem Unternehmen' }, { status: 403 })
      }
    }

    // ── 1. Datei in Supabase Storage hochladen ────────────────────────────────
    const fileBuffer = await file.arrayBuffer()
    const storagePath = `${companyId}/${Date.now()}_${sanitizeStorageFileName(file.name)}`

    const { error: storageError } = await supabase.storage
      .from('uploads')
      .upload(storagePath, fileBuffer, { contentType: file.type })

    if (storageError) {
      console.error('Storage-Upload fehlgeschlagen:', storageError.message)
      return NextResponse.json({ error: 'Die Datei konnte nicht gespeichert werden. Bitte versuchen Sie es erneut.' }, { status: 500 })
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
    const workbook = readWorkbook(fileBuffer, file.name, file.type)
    const worksheet = workbook.Sheets[workbook.SheetNames[0]]
    const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' })

    if (!rawRows.length) {
      await supabase.from('uploads').update({ status: 'failed', error_message: 'Datei leer' }).eq('id', upload.id)
      return NextResponse.json({ error: 'Die Datei enthält keine Datenzeilen, nur eine Kopfzeile oder gar nichts.' }, { status: 400 })
    }

    // ── 4. Spalten erkennen ───────────────────────────────────────────────────
    const headers = Object.keys(rawRows[0])
    const columnMapping = detectColumns(headers)

    if (!columnMapping.postal_code) {
      await supabase.from('uploads').update({
        status: 'failed',
        error_message: 'Keine PLZ-Spalte erkannt. Bitte Spalten manuell zuordnen.'
      }).eq('id', upload.id)
      return NextResponse.json({
        error: 'In der Datei wurde keine Spalte mit Postleitzahlen gefunden. Bitte eine Spalte „PLZ“ ergänzen und erneut hochladen.',
        headers, detected: columnMapping,
      }, { status: 422 })
    }

    // ── 5. Bereinigung + RFM ──────────────────────────────────────────────────
    const { rows: cleanedRows, duplicates, errors, invalid_values: invalidValues } = parseAndCleanRows(rawRows, columnMapping)
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
      // Straßenverzeichnis live laden (vollständig oder ausdrücklich unvollständig).
      // Der gespeicherte Straßen-Cache wird hier bewusst NICHT gelesen: Er hat
      // keine Kennzeichnung, ob er vollständig ist (siehe Konzept, neue Tabelle).
      const streetDir = await orchestrator.getStreets(plz)
      const directory = { streets: streetDir.streets, complete: streetDir.complete }

      // Nur vollständige Listen speichern
      if (streetDir.complete) {
        const plzInfo = await orchestrator.getPostalCodeData(plz)
        await reference.from('postal_codes').upsert({
          postal_code: plz,
          city: plzInfo.info.city || plzRows[0]?.city || plz,
          state: plzInfo.info.state || null,
          data_source: plzInfo.info.data_source || 'openplz',
          last_fetched_at: new Date().toISOString(),
        }, { onConflict: 'postal_code' })

        // Liste der PLZ ersetzen: Alte (evtl. gekürzte) Einträge entfernen,
        // vollständige Liste neu schreiben.
        const fetchedAt = new Date().toISOString()
        const cacheRecords = streetDir.streets.map(name => ({
          postal_code: plz,
          name,
          name_normalized: streetNameKey(name),
          data_source: 'openplz' as const,
          last_fetched_at: fetchedAt,
        }))
        const { error: deleteError } = await reference.from('streets').delete().eq('postal_code', plz)
        if (!deleteError) {
          for (let i = 0; i < cacheRecords.length; i += 500) {
            await reference.from('streets').upsert(cacheRecords.slice(i, i + 500), { onConflict: 'postal_code,name_normalized', ignoreDuplicates: true })
          }
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
          await reference.from('postal_codes').upsert({
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
        directory,
        population,
        households,
      )
      if (!streetDir.complete && streetDir.error) analysis.warnings.push(`⚠️ ${streetDir.error}`)
      plzAnalyses.push(analysis)

      // Straßen-Analyse
      const streetResults = analyzeStreets(plzRows, directory)

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
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          potential_scenarios: analysis.potential_scenarios as unknown as any,
          top_recommendations: analysis.warnings,
        })
        .select()
        .single()

      // Straßen-Analytics speichern: alle Straßen, auch ohne Bestellungen
      // (früher nur die ersten 200 nach Bestellungen – Straßen ohne
      // Bestellungen fielen dabei als erste weg)
      if (analyticsRecord) {
        const streetRecords = streetResults.map(s => ({
          analytics_id: analyticsRecord.id,
          company_id: companyId,
          postal_code: plz,
          street_name: s.street_name,
          street_name_normalized: streetNameKey(s.street_name),
          customer_count: s.customer_count,
          order_count: s.order_count,
          revenue: s.revenue,
          avg_order_value: s.avg_order_value,
          orders_per_customer: s.orders_per_customer,
          street_class: s.street_class,
          is_in_official_list: s.is_in_official_list,
        }))
        for (let i = 0; i < streetRecords.length; i += 500) {
          await supabase.from('street_analytics').insert(streetRecords.slice(i, i + 500))
        }
      }
    }

    // ── 8. Dashboard KPIs + Alerts + Empfehlungen ─────────────────────────────
    const kpis = computeDashboardKPIs(rowsWithRFM)
    const streetResultsAll = rowsWithRFM.length > 0 ? analyzeStreets(rowsWithRFM, NO_STREET_DIRECTORY) : []
    const recs = generateRecommendations(kpis, plzAnalyses, streetResultsAll)
    const alertPayloads = generateAlerts(kpis)

    // Alte, noch offene Warnungen und unbearbeitete Empfehlungen werden durch
    // die neuen ersetzt. Sonst stehen nach mehreren Uploads dieselben Warnungen
    // mehrfach und mit veralteten Zahlen im Dashboard.
    await supabase.from('alerts')
      .update({ is_resolved: true, resolved_at: new Date().toISOString() })
      .eq('company_id', companyId).eq('is_resolved', false)
    await supabase.from('marketing_actions')
      .update({ status: 'replaced' })
      .eq('company_id', companyId).eq('status', 'recommended')

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
        invalid_value_rows: invalidValues,
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
      { error: 'Bei der Auswertung ist ein Fehler aufgetreten. Bitte versuchen Sie es erneut. Bleibt der Fehler, prüfen Sie bitte das Dateiformat.' },
      { status: 500 }
    )
  }
}
