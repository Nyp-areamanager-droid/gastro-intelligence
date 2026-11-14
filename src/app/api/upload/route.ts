import { rateLimit, tooManyRequests } from '@/lib/security/rate-limit'
import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createServerSupabaseClient, createReferenceDataClient } from '@/lib/supabase/server'
import { resolveCompanyContext, canWriteCompanyData } from '@/lib/auth/company-context'
import {
  detectColumns, applyMappingOverride, IMPORT_FIELDS, parseAndCleanRows, computeRFM,
  computeDashboardKPIs, generateAlerts, generateRecommendations,
  analyzeStreets, analyzePLZ,
} from '@/lib/analysis/engine'
import { streetNameKey } from '@/lib/geo/street-name'
import { readWorkbook } from '@/lib/import/read-table'
import { DataProviderOrchestrator } from '@/lib/providers'
import { verifiedPopulation } from '@/lib/geo/population'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  parseImportMode, parsePeriodDate, fileFingerprint, decideImport, overlapShare,
  rowFingerprint, mergeCustomers, SAME_DATA_SHARE, type ExistingUpload,
} from '@/lib/import/import-guard'
import { checkRequestSize, checkUploadFile, checkPlzCount, checkRowCount } from '@/lib/import/upload-checks'
import { minimizeRow, pseudonymizePhone } from '@/lib/privacy/pseudonym'
import { customerRecordToRow } from '@/lib/analysis/customer-record'
import { directoryAvailable, loadAddressIndex, loadStreetsForPlz } from '@/lib/geo/directory'
import { assignRows } from '@/lib/geo/assign-rows'

/** Kennzeichen in uploads.storage_path: Für diesen Import liegt keine Datei im Speicher. */
const NOT_STORED_MARKER = 'nicht-gespeichert'
import type { ParsedCustomerRow } from '@/types'
import type { Json } from '@/lib/supabase/database.types'

export const maxDuration = 60 // Vercel: max 60s für Pro plan

export async function POST(req: NextRequest) {
  // ── 0. Nutzer und Firma serverseitig ermitteln ────────────────────────────
  // Die Firma kommt ausschließlich aus der Sitzung. Alle Firmendaten (Datei,
  // Upload, Kunden, Analysen) werden mit DIESER Sitzung geschrieben, die
  // RLS-Regeln greifen also zusätzlich zur Prüfung hier.
  const supabase = await createServerSupabaseClient()
  const auth = await resolveCompanyContext(supabase)
  if (auth.ok === false) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { companyId, userId } = auth.ctx

  // Import verändert Firmendaten: nur owner, admin, manager (nicht viewer)
  if (!canWriteCompanyData(auth.ctx)) {
    return NextResponse.json({ error: 'Keine Berechtigung zum Importieren von Daten' }, { status: 403 })
  }

  // Missbrauchsschutz: höchstens 40 Aufrufe (Vorschau + Import) je Nutzer in 10 Minuten
  const limited = rateLimit(`upload:${userId}`, 40, 600_000)
  if (!limited.ok) { const t = tooManyRequests(limited); return NextResponse.json(t.body, t.init) }

  // Service-Key nur für gemeinsame Referenzdaten (PLZ, Straßenverzeichnis)
  const reference = createReferenceDataClient()

  // Zu große Anfragen gar nicht erst einlesen
  const tooLarge = checkRequestSize(req.headers.get('content-length'))
  if (tooLarge && tooLarge.ok === false) {
    return NextResponse.json({ error: tooLarge.error }, { status: tooLarge.status })
  }

  try {
    const formData = await req.formData()
    const file = formData.get('file') as File
    const requestedCompanyId = formData.get('company_id') as string | null
    const storeIdRaw = formData.get('store_id') as string | null
    const storeId = storeIdRaw && storeIdRaw.trim() ? storeIdRaw.trim() : null

    if (!file || typeof file === 'string' || typeof (file as File).arrayBuffer !== 'function') {
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

    // ── 1. Datei lesen und prüfen, BEVOR etwas gespeichert wird ──────────────
    const mode = parseImportMode(formData.get('mode'))
    const userPeriod = {
      start: parsePeriodDate(formData.get('period_start')),
      end: parsePeriodDate(formData.get('period_end')),
    }
    const fileBuffer = await file.arrayBuffer()
    // Größe, Endung und Inhalt prüfen, bevor die Datei gelesen wird
    const fileCheck = checkUploadFile(file.name, file.size, new Uint8Array(fileBuffer))
    if (fileCheck.ok === false) {
      return NextResponse.json({ error: fileCheck.error }, { status: fileCheck.status })
    }
    const fileHash = fileFingerprint(fileBuffer)

    let rawRows: Record<string, unknown>[]
    try {
      const workbook = readWorkbook(fileBuffer, file.name, fileCheck.contentType)
      const worksheet = workbook.Sheets[workbook.SheetNames[0]]
      rawRows = worksheet ? XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' }) : []
    } catch {
      return NextResponse.json({ error: 'Die Datei konnte nicht gelesen werden. Bitte die Datei direkt aus Excel oder dem Kassensystem exportieren und erneut hochladen.' }, { status: 422 })
    }
    const tooManyRows = checkRowCount(rawRows.length)
    if (tooManyRows && tooManyRows.ok === false) {
      return NextResponse.json({ error: tooManyRows.error }, { status: tooManyRows.status })
    }

    if (!rawRows.length) {
      return NextResponse.json({ error: 'Die Datei enthält keine Datenzeilen, nur eine Kopfzeile oder gar nichts.' }, { status: 400 })
    }

    const headers = Object.keys(rawRows[0])
    // Automatische Erkennung, vom Nutzer in der Vorschau korrigierbar
    let mappingOverride: unknown = null
    try { mappingOverride = JSON.parse(String(formData.get('mapping') || 'null')) } catch { mappingOverride = null }
    const columnMapping = applyMappingOverride(detectColumns(headers), mappingOverride, headers)
    // Deutschlandweites Straßenverzeichnis (Migration 009) vorhanden? Dann
    // werden Adressen geprüft und fehlende PLZ – wenn eindeutig – ergänzt.
    const hasDirectory = await directoryAvailable(supabase)
    const canInferPlz = hasDirectory && !!columnMapping.street && !!columnMapping.city
    if (!columnMapping.postal_code && !canInferPlz && formData.get('preview') === '1') {
      // Vorschau: Der Nutzer kann die Spalten selbst zuordnen
      return NextResponse.json({
        preview: true, needs_mapping: true, filename: file.name, headers, mapping: columnMapping, fields: IMPORT_FIELDS,
        message: hasDirectory
          ? 'In der Datei wurde keine Spalte mit Postleitzahlen erkannt. Bitte ordnen Sie die Spalte mit der Postleitzahl zu – oder Straße und Ort, dann wird die PLZ wo möglich ergänzt.'
          : 'In der Datei wurde keine Spalte mit Postleitzahlen erkannt. Bitte ordnen Sie die Spalte mit der Postleitzahl zu.',
      })
    }
    if (!columnMapping.postal_code && !canInferPlz) {
      return NextResponse.json({
        error: 'In der Datei wurde keine Spalte mit Postleitzahlen gefunden. Bitte eine Spalte „PLZ“ ergänzen und erneut hochladen.',
        headers, detected: columnMapping,
      }, { status: 422 })
    }

    const parsed = parseAndCleanRows(rawRows, columnMapping, { allowMissingPostalCode: hasDirectory })
    const { rows: parsedRows, duplicates, invalid_values: invalidValues, invalid_dates: invalidDates, problems } = parsed
    // Datenminimierung: keine Namen, keine Telefonnummern im Klartext
    const minimizedRows = parsedRows.map(r => minimizeRow(companyId, r))
    // Adressen gegen das Straßenverzeichnis prüfen; PLZ nur eindeutig ergänzen
    const loadedDirectory = hasDirectory
      ? await loadAddressIndex(supabase, minimizedRows.map(r => ({ postal_code: r._needs_postal_code ? null : r.postal_code, city: r.city })))
      : null
    const geo = assignRows(minimizedRows, loadedDirectory?.index ?? null, loadedDirectory?.version ?? null)
    const errors = parsed.errors + geo.dropped
    problems.push(...geo.problems)
    problems.sort((a, b) => a.row - b.row)
    const cleanedRows = geo.rows
    const rowsWithRFM = computeRFM(cleanedRows)
    if (!rowsWithRFM.length) {
      return NextResponse.json({ error: 'Keine Zeile der Datei hatte eine gültige Postleitzahl. Es wurde nichts importiert.' }, { status: 422 })
    }

    const tooManyPlz = checkPlzCount(new Set(rowsWithRFM.map(r => r.postal_code)).size)
    if (tooManyPlz && tooManyPlz.ok === false) {
      return NextResponse.json({ error: tooManyPlz.error }, { status: tooManyPlz.status })
    }

    // Zeitraum: Angabe des Nutzers, sonst aus den Bestelldaten der Datei
    const dates = rowsWithRFM.map(r => r.last_order_date).filter(Boolean).sort() as string[]
    const periodStart = userPeriod.start ?? (dates[0] || null)
    const periodEnd = userPeriod.end ?? (dates[dates.length - 1] || null)

    // ── 2. Wiederholter Import? Doppelzählung ausschließen ───────────────────
    let existingQuery = supabase
      .from('uploads')
      .select('id, filename, created_at, file_hash, period_start, period_end')
      .eq('company_id', companyId)
      .eq('status', 'completed')
    existingQuery = storeId ? existingQuery.eq('store_id', storeId) : existingQuery.is('store_id', null)
    const { data: existingUploads, error: existingError } = await existingQuery
    if (existingError) {
      return NextResponse.json({ error: 'Bisherige Uploads konnten nicht geprüft werden. Bitte versuchen Sie es erneut.' }, { status: 500 })
    }

    // ── Vorschau: nichts speichern, nur zeigen, was der Import tun würde ──────
    if (formData.get('preview') === '1') {
      const sameFile = (existingUploads || []).find(u => u.file_hash && u.file_hash === fileHash)
      const usedHeaders = new Set(Object.values(columnMapping))
      return NextResponse.json({
        preview: true,
        filename: file.name,
        headers,
        mapping: columnMapping,
        fields: IMPORT_FIELDS,
        unused_headers: headers.filter(h => !usedHeaders.has(h)),
        // Spalten mit Personendaten, die erkannt, aber nicht gespeichert werden
        not_stored: ['first_name', 'last_name', 'email'].filter(f => columnMapping[f]).map(f => columnMapping[f]),
        phone_pseudonymized: !!columnMapping.phone,
        order_level: !columnMapping.total_orders && !columnMapping.customer_count && !!columnMapping.last_order_date,
        counts: { rows_in_file: rawRows.length, rows_valid: rowsWithRFM.length, rows_skipped: errors, duplicates, invalid_values: invalidValues, invalid_dates: invalidDates, postal_codes: new Set(rowsWithRFM.map(r => r.postal_code)).size },
        totals: {
          orders: rowsWithRFM.reduce((s2, r) => s2 + r.total_orders, 0),
          revenue: Math.round(rowsWithRFM.reduce((s2, r) => s2 + r.total_revenue, 0) * 100) / 100,
        },
        period: { start: periodStart, end: periodEnd, from_file: !userPeriod.start && !userPeriod.end },
        // Beispielzeilen so, wie sie gespeichert würden (ohne Namen, ohne Telefonnummer)
        sample: rowsWithRFM.slice(0, 5).map(r => ({ postal_code: r.postal_code, city: r.city || null, street: r.street || null, house_number: r.house_number || null, total_orders: r.total_orders, total_revenue: r.total_revenue, last_order_date: r.last_order_date || null, customer_ref: r.customer_ref || null, has_phone_mark: !!r.phone_normalized, platform: r.platform || null })),
        problems: problems.slice(0, 200), problems_total: errors + duplicates + invalidValues + invalidDates + (geo.summary ? geo.summary.by_status.plz_pruefen + geo.summary.by_status.plz_unbekannt : 0),
        geo: geo.summary,
        existing: { has_data: (existingUploads || []).length > 0, same_file: sameFile ? { filename: sameFile.filename, uploaded_at: sameFile.created_at } : null,
          last_period_end: ((existingUploads || []).map(u => u.period_end).filter(Boolean).sort().reverse()[0] as string | undefined) || null },
      })
    }

    const decision = decideImport({
      mode, fileHash,
      existing: (existingUploads || []) as ExistingUpload[],
      newPeriod: { start: periodStart, end: periodEnd },
    })
    if (decision.ok === false) {
      return NextResponse.json({ error: decision.message, code: decision.code, existing: decision.existing }, { status: 409 })
    }

    // Ergänzung mit weitgehend denselben Zeilen = dieselben Daten (z. B. als
    // CSV statt Excel gespeichert) → ablehnen
    if (decision.action === 'append') {
      const { data: existingRows, error: rowsError } = await fetchAllRows((from, to) =>
        supabase.from('customers')
          .select('postal_code, street_normalized, house_number, phone_normalized, customer_ref, total_orders, total_revenue', { count: 'exact' })
          .eq('company_id', companyId).order('id').range(from, to))
      if (rowsError) {
        return NextResponse.json({ error: 'Bisherige Daten konnten nicht geprüft werden. Bitte versuchen Sie es erneut.' }, { status: 500 })
      }
      const share = overlapShare(rowsWithRFM.map(rowFingerprint), (existingRows || []).map(e => rowFingerprint({ ...e, phone_normalized: pseudonymizePhone(companyId, e.phone_normalized) })))
      if (share >= SAME_DATA_SHARE) {
        return NextResponse.json({
          code: 'append_same_data',
          error: `${Math.round(share * 100)} % der Zeilen dieser Datei sind bereits genau so vorhanden. Das sind offenbar dieselben Daten, sie würden doppelt gezählt. Es wurde nichts importiert. Wenn die Datei die bisherigen Daten ersetzen soll, wählen Sie „Daten ersetzen“.`,
        }, { status: 409 })
      }
    }

    // ── 3. Die Originaldatei wird NICHT gespeichert ──────────────────────────
    // Sie kann Namen, Telefonnummern und E-Mail-Adressen enthalten. Gespeichert
    // werden nur die bereinigten Zeilen (ohne diese Angaben). Für die Prüfung
    // „dieselbe Datei schon importiert?“ genügt der Fingerabdruck (file_hash).
    const storagePath = NOT_STORED_MARKER

    // ── 4. Upload-Datensatz erstellen ────────────────────────────────────────
    const { data: upload, error: uploadError } = await supabase
      .from('uploads')
      .insert({
        company_id: companyId,
        store_id: storeId || null,
        uploaded_by: userId,
        filename: file.name,
        storage_path: storagePath,
        file_size_bytes: file.size,
        file_type: fileCheck.contentType,
        status: 'processing',
        file_hash: fileHash,
        import_mode: decision.action,
        column_mapping: columnMapping,
      })
      .select()
      .single()
    if (uploadError || !upload) {
      return NextResponse.json({ error: 'Der Upload konnte nicht angelegt werden. Bitte versuchen Sie es erneut.' }, { status: 500 })
    }

    // Bei einem Fehler ab hier: eigene neue Zeilen entfernen, Upload als
    // fehlgeschlagen markieren. Die bisherigen Daten bleiben dann unverändert.
    const failUpload = async (message: string) => {
      await supabase.from('customers').delete().eq('company_id', companyId).eq('upload_id', upload.id)
      await supabase.from('uploads').update({ status: 'failed', error_message: message }).eq('id', upload.id)
      return NextResponse.json({ error: message }, { status: 500 })
    }

    // ── 5. Kunden speichern (Batches à 500) ──────────────────────────────────
    const BATCH = 500
    for (let i = 0; i < rowsWithRFM.length; i += BATCH) {
      const batch = rowsWithRFM.slice(i, i + BATCH)
      const records = batch.map((r: ParsedCustomerRow) => ({
        company_id: companyId,
        store_id: storeId || null,
        upload_id: upload.id,
        customer_ref: r.customer_ref || null,
        // nur das Kennzeichen der Telefonnummer; phone_raw und Namen bleiben leer
        phone_normalized: r.phone_normalized || null,
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
        // Spalte gibt es erst ab Migration 009 – nur mitsenden, wenn das Verzeichnis (also 009) da ist
        ...(loadedDirectory ? { geo_status: r.geo_status || null } : {}),
      }))
      const { error: insertError } = await supabase.from('customers').insert(records)
      if (insertError) {
        console.error('Kunden-Import fehlgeschlagen:', insertError.message)
        return failUpload('Die Kundendaten konnten nicht vollständig gespeichert werden. Es wurde nichts übernommen, die bisherigen Daten sind unverändert.')
      }
    }

    // ── 6. „Daten ersetzen“: bisherige Kundendaten entfernen ─────────────────
    if (decision.action === 'replace' && decision.replaceUploadIds.length) {
      for (let i = 0; i < decision.replaceUploadIds.length; i += 100) {
        const ids = decision.replaceUploadIds.slice(i, i + 100)
        const { error: delError } = await supabase.from('customers').delete().eq('company_id', companyId).in('upload_id', ids)
        if (delError) {
          console.error('Ersetzen fehlgeschlagen:', delError.message)
          return failUpload('Die bisherigen Daten konnten nicht ersetzt werden. Es wurde nichts übernommen, die bisherigen Daten sind unverändert.')
        }
        await supabase.from('uploads').update({ status: 'replaced' }).eq('company_id', companyId).in('id', ids)
      }
    }

    // ── 7. Gesamtbestand: neue Datei + übrige gespeicherte Kunden ────────────
    // Die Auswertungen gelten für ALLE Daten der Firma, nicht nur für die
    // letzte Datei. Dieselbe Person aus mehreren Zeiträumen zählt einmal.
    const { data: otherCustomers, error: otherError } = await fetchAllRows((from, to) =>
      supabase.from('customers').select('*', { count: 'exact' })
        .eq('company_id', companyId).neq('upload_id', upload.id).order('id').range(from, to))
    if (otherError) {
      return failUpload('Die Auswertung konnte nicht erstellt werden. Es wurde nichts übernommen.')
    }
    const allRows = mergeCustomers([
      ...rowsWithRFM,
      ...(otherCustomers || []).map(c => customerRecordToRow(c, companyId)),
    ])

    const plzGroups = new Map<string, ParsedCustomerRow[]>()
    for (const r of allRows) {
      if (!plzGroups.has(r.postal_code!)) plzGroups.set(r.postal_code!, [])
      plzGroups.get(r.postal_code!)!.push(r)
    }

    // PLZ-Auswertungen ohne Kunden mehr (nach „Daten ersetzen“) entfernen
    const { data: oldAnalytics } = await supabase.from('analytics').select('id, postal_code').eq('company_id', companyId)
    const staleIds = (oldAnalytics || []).filter(a => !plzGroups.has(a.postal_code)).map(a => a.id)
    for (let i = 0; i < staleIds.length; i += 100) {
      await supabase.from('analytics').delete().eq('company_id', companyId).in('id', staleIds.slice(i, i + 100))
    }

    // ── 8. Analyse pro PLZ ───────────────────────────────────────────────────
    const { data: company } = await supabase
      .from('companies')
      .select('google_places_api_key')
      .eq('id', companyId)
      .single()

    const orchestrator = new DataProviderOrchestrator(company?.google_places_api_key || undefined)
    // Straßenlisten aller betroffenen PLZ (auch aus früheren Importen) aus dem Verzeichnis
    const directoryStreets = new Map(loadedDirectory?.streets || [])
    if (loadedDirectory) {
      const missingPlz = [...plzGroups.keys()].filter(p => !directoryStreets.has(p))
      for (const [p, list] of await loadStreetsForPlz(supabase, missingPlz)) directoryStreets.set(p, list)
    }
    const plzAnalyses = []
    const allStreetResults: ReturnType<typeof analyzeStreets> = []

    for (const [plz, plzRows] of plzGroups) {
      // Straßenverzeichnis live laden (vollständig oder ausdrücklich unvollständig).
      // Der gespeicherte Straßen-Cache wird hier bewusst NICHT gelesen: Er hat
      // keine Kennzeichnung, ob er vollständig ist (siehe Konzept, neue Tabelle).
      // Vorrang: deutschlandweites Verzeichnis aus der Datenbank (vollständig je
      // PLZ laut Quelle). Nur wenn die PLZ dort fehlt: Live-Abruf wie bisher.
      const fromDirectory = directoryStreets.get(plz)
      const streetDir = fromDirectory
        ? { streets: fromDirectory, complete: true, status: 'complete' as const, source: 'openplz' as const, count: fromDirectory.length, error: undefined }
        : await orchestrator.getStreets(plz)
      const directory = { streets: streetDir.streets, complete: streetDir.complete }

      // Nur vollständige Listen aus dem Live-Abruf speichern (Verzeichnis ist schon da)
      if (streetDir.complete && !fromDirectory) {
        const plzInfo = await orchestrator.getPostalCodeData(plz)
        await reference.from('postal_codes').upsert({
          postal_code: plz,
          city: plzInfo.info.city || plzRows[0]?.city || plz,
          state: plzInfo.info.state || null,
          data_source: plzInfo.info.data_source || 'openplz',
          last_fetched_at: new Date().toISOString(),
        }, { onConflict: 'postal_code' })

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

      // Einwohner/Haushalte nur aus belegter Quelle (Zensus-Import mit
      // population_method). Unbekannt bleibt null und wird als „—“ gezeigt.
      const { data: plzData } = await supabase
        .from('postal_codes')
        .select('population, households, population_method, population_reference_date')
        .eq('postal_code', plz)
        .maybeSingle()
      const { population, households } = verifiedPopulation(plzData)

      const analysis = analyzePLZ(plzRows, directory, population, households)
      if (!streetDir.complete && streetDir.error) analysis.warnings.push(`⚠️ ${streetDir.error}`)
      plzAnalyses.push(analysis)

      const streetResults = analyzeStreets(plzRows, directory)
      allStreetResults.push(...streetResults)

      // Alte Auswertung dieser PLZ ersetzen (keine Duplikate)
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

    // ── 9. Kennzahlen, Warnungen, Empfehlungen aus dem Gesamtbestand ─────────
    const kpis = computeDashboardKPIs(allRows)
    // Straßenergebnisse je PLZ (mit Verzeichnis), damit Empfehlungen zu
    // Straßen ohne Bestellung auf geprüften Daten beruhen
    const recs = generateRecommendations(kpis, plzAnalyses, allStreetResults)
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

    if (alertPayloads.length) {
      await supabase.from('alerts').insert(
        alertPayloads.map(a => ({ ...a, company_id: companyId, store_id: storeId || null }))
      )
    }

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

    // ── 10. Upload abschließen ───────────────────────────────────────────────
    await supabase.from('uploads').update({
      status: 'completed',
      row_count: rowsWithRFM.length,
      period_start: periodStart,
      period_end: periodEnd,
      processed_at: new Date().toISOString(),
      ...(loadedDirectory ? { geo_summary: JSON.parse(JSON.stringify(geo.summary)) as Json } : {}),
    }).eq('id', upload.id)

    return NextResponse.json({
      success: true,
      upload_id: upload.id,
      import_mode: decision.action,
      replaced_uploads: decision.replaceUploadIds.length,
      summary: {
        total_rows: rawRows.length,
        valid_rows: rowsWithRFM.length,
        duplicate_rows: duplicates,
        error_rows: errors,
        problems: problems.slice(0, 200),
        invalid_value_rows: invalidValues,
        invalid_date_rows: invalidDates,
        unique_plz: new Set(rowsWithRFM.map(r => r.postal_code)).size,
        period: { start: periodStart, end: periodEnd },
        geo: geo.summary,
      },
      totals: {
        customers: kpis.total_customers,
        orders: kpis.total_orders,
        revenue: kpis.total_revenue,
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
