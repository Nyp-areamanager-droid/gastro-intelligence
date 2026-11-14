'use client'
// Import in drei Schritten: Datei wählen → Vorschau prüfen → importieren.
// In der Vorschau wird nichts gespeichert. Der Server rechnet (api/upload mit
// preview=1) und zeigt, was übernommen würde, welche Zeilen Probleme haben
// und welche Spalte wofür verwendet wird.
import { useCallback, useState } from 'react'
import { useDropzone } from 'react-dropzone'
import { FileSpreadsheet, ShieldCheck, UploadCloud } from 'lucide-react'
import { MAX_UPLOAD_BYTES } from '@/lib/import/upload-checks'
import { createClient } from '@/lib/supabase/client'
import { Notice, Spinner, fmtDate, fmtEur, fmtInt } from '@/components/ui'
import { GEO_STATUS_TEXT, RELIABLE_STATUSES, type GeoSummary, type GeoStatus } from '@/lib/geo/address-match'

interface Problem { row: number; reason: string }
interface Preview {
  preview: true
  needs_mapping?: boolean
  message?: string
  filename: string
  headers: string[]
  mapping: Record<string, string>
  fields: { field: string; label: string; required?: boolean; note?: string }[]
  unused_headers?: string[]
  not_stored?: string[]
  phone_pseudonymized?: boolean
  order_level?: boolean
  counts?: { rows_in_file: number; rows_valid: number; rows_skipped: number; duplicates: number; invalid_values: number; invalid_dates?: number; postal_codes: number }
  totals?: { orders: number; revenue: number }
  period?: { start: string | null; end: string | null; from_file: boolean }
  sample?: { postal_code: string; city: string | null; street: string | null; house_number: string | null; total_orders: number; total_revenue: number; last_order_date: string | null; customer_ref: string | null; has_phone_mark: boolean; platform: string | null }[]
  problems?: Problem[]
  problems_total?: number
  geo?: GeoSummary | null
  existing?: { has_data: boolean; same_file: { filename: string; uploaded_at: string } | null; last_period_end: string | null }
}
interface ImportResult {
  success: boolean
  summary?: { total_rows: number; valid_rows: number; duplicate_rows: number; error_rows: number; invalid_value_rows?: number; unique_plz: number; period: { start: string | null; end: string | null }; problems?: Problem[] }
  totals?: { customers: number; orders: number; revenue: number }
  import_mode?: 'first' | 'replace' | 'append'
  recommendations?: number
  error?: string
  code?: string
  existing?: { filename: string; uploaded_at: string; period_start: string | null; period_end: string | null }
}
type Mode = 'auto' | 'replace' | 'append'
type Step = 'choose' | 'checking' | 'preview' | 'importing' | 'done'

const ALLOWED = ['.xlsx', '.xls', '.xlsb', '.csv']
const STEPS = ['Datei wählen', 'Vorschau prüfen', 'Fertig']

function downloadProblems(filename: string, problems: Problem[]) {
  const csv = '﻿Zeile;Grund\r\n' + problems.map(p => `${p.row};"${p.reason.replace(/"/g, '""')}"`).join('\r\n')
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url; a.download = `fehlerbericht-${filename.replace(/\.[^.]+$/, '')}.csv`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function FileUploader({ onImported }: { onImported?: () => void }) {
  const [step, setStep] = useState<Step>('choose')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  const [mode, setMode] = useState<Mode>('auto')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [needPeriod, setNeedPeriod] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)
  const [showMapping, setShowMapping] = useState(false)
  const [showAllProblems, setShowAllProblems] = useState(false)

  const post = useCallback(async (f: File, extra: Record<string, string>) => {
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { status: 401, data: { error: 'Sie sind nicht mehr angemeldet. Bitte melden Sie sich erneut an.' } }
    const { data: membership } = await supabase.from('company_users').select('company_id').eq('user_id', user.id).single()
    if (!membership) return { status: 403, data: { error: 'Ihrem Konto ist noch kein Unternehmen zugeordnet. Bitte melden Sie sich einmal ab und wieder an.' } }
    const fd = new FormData()
    fd.append('file', f)
    fd.append('company_id', membership.company_id)
    for (const [k, v] of Object.entries(extra)) fd.append(k, v)
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd })
      let data
      try { data = await res.json() } catch {
        data = { error: res.status === 413 ? 'Die Datei ist zu groß. Bitte teilen Sie sie auf, zum Beispiel nach Monaten.' : 'Der Server hat nicht wie erwartet geantwortet. Bitte versuchen Sie es erneut.' }
      }
      return { status: res.status, data }
    } catch {
      return { status: 0, data: { error: 'Die Verbindung wurde unterbrochen. Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.' } }
    }
  }, [])

  const runPreview = useCallback(async (f: File, map: Record<string, string | null>) => {
    setStep('checking'); setError(null)
    const { status, data } = await post(f, { preview: '1', mapping: JSON.stringify(map) })
    if (status !== 200 || !data.preview) { setError(data.error || 'Die Datei konnte nicht geprüft werden.'); setStep('choose'); setFile(null); return }
    const p = data as Preview
    setPreview(p)
    if (p.needs_mapping) setShowMapping(true)
    setMode(p.existing?.has_data ? (p.existing.same_file ? 'replace' : 'append') : 'auto')
    setStep('preview')
  }, [post])

  const onDrop = useCallback(async (files: File[]) => {
    const f = files[0]
    if (!f) return
    const ext = f.name.substring(f.name.lastIndexOf('.')).toLowerCase()
    if (!ALLOWED.includes(ext)) { setError(`Dieses Dateiformat wird nicht unterstützt (${ext}). Möglich sind: ${ALLOWED.join(', ')}`); return }
    if (f.size > MAX_UPLOAD_BYTES) { setError(`Die Datei ist zu groß (${(f.size / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB). Erlaubt sind höchstens ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Bitte teilen Sie sie auf, zum Beispiel nach Monaten.`); return }
    setFile(f); setMapping({}); setResult(null); setNeedPeriod(false); setPeriodStart(''); setPeriodEnd(''); setShowMapping(false); setShowAllProblems(false)
    await runPreview(f, {})
  }, [runPreview])

  const changeMapping = (field: string, header: string) => {
    if (!file) return
    const next = { ...mapping, [field]: header || null }
    setMapping(next)
    runPreview(file, next)
  }

  const startImport = async () => {
    if (!file) return
    setStep('importing'); setError(null)
    const extra: Record<string, string> = { mode, mapping: JSON.stringify(mapping) }
    if (periodStart) extra.period_start = periodStart
    if (periodEnd) extra.period_end = periodEnd
    const { status, data } = await post(file, extra)
    if (data.success) { setResult(data); setStep('done'); onImported?.(); return }
    if (status === 409) {
      // Es gibt schon Daten und der Server braucht eine Entscheidung. Nichts wurde gespeichert.
      if (['append_period_unknown', 'append_overlap', 'invalid_period'].includes(data.code)) setNeedPeriod(true)
      if (['duplicate_file', 'append_same_data'].includes(data.code)) setMode('replace')
      if (mode === 'auto') setMode('append')
    }
    setError(data.error || 'Der Import ist fehlgeschlagen.')
    setStep('preview')
  }

  const reset = () => { setStep('choose'); setFile(null); setPreview(null); setResult(null); setError(null); setMapping({}); setNeedPeriod(false) }

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop, maxFiles: 1, noClick: true, noKeyboard: true,
    accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'], 'application/vnd.ms-excel': ['.xls', '.xlsb'], 'text/csv': ['.csv'] },
  })

  const stepIndex = step === 'choose' || step === 'checking' ? 0 : step === 'done' ? 2 : 1
  const p = preview
  const problems = p?.problems || []

  return (
    <div>
      <ol className="mb-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]" aria-label="Schritte des Imports">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2" aria-current={i === stepIndex ? 'step' : undefined}>
            <span className={`num flex h-6 w-6 items-center justify-center rounded-full text-[12px] font-semibold ${i < stepIndex ? 'bg-good-soft text-good' : i === stepIndex ? 'bg-accent text-white' : 'bg-sunken text-ink-muted'}`}>{i + 1}</span>
            <span className={i === stepIndex ? 'font-medium text-ink' : 'text-ink-muted'}>{s}</span>
            {i < STEPS.length - 1 && <span aria-hidden className="mx-1 h-px w-6 bg-line-strong" />}
          </li>
        ))}
      </ol>

      {error && <div className="mb-4"><Notice tone="bad" title="Das hat nicht geklappt">{error}{step === 'preview' && ' Es wurde nichts gespeichert.'}</Notice></div>}

      {(step === 'choose' || step === 'checking') && (
        <div {...getRootProps()} className={`card flex flex-col items-center px-6 py-12 text-center transition-colors ${isDragActive ? 'border-accent bg-accent-soft/50' : 'border-dashed border-line-strong'}`}>
          <input {...getInputProps()} aria-label="Datei auswählen" />
          {step === 'checking' ? (
            <><Spinner label="Datei wird geprüft" /><p className="mt-2 text-[13px] text-ink-muted">Es wird noch nichts gespeichert.</p></>
          ) : (
            <>
              <UploadCloud size={28} className="text-ink-muted" aria-hidden />
              <h2 className="mt-3 text-[16px] font-semibold">Export aus Kasse oder Bestellsystem hochladen</h2>
              <p className="mt-1 max-w-[52ch] text-ink-soft">Datei hierher ziehen oder auswählen. Sie sehen zuerst eine Vorschau und entscheiden dann, ob importiert wird.</p>
              <button type="button" className="btn-primary mt-5" onClick={open}>Datei auswählen</button>
              <p className="mt-3 text-[12.5px] text-ink-muted">CSV oder Excel (.csv, .xlsx, .xls, .xlsb), höchstens {MAX_UPLOAD_BYTES / 1024 / 1024} MB</p>
            </>
          )}
        </div>
      )}

      {(step === 'preview' || step === 'importing') && p && file && (
        <div className="space-y-4">
          <div className="card card-pad flex flex-wrap items-center gap-3">
            <FileSpreadsheet size={20} className="shrink-0 text-ink-muted" aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{p.filename}</div>
              <div className="text-[12.5px] text-ink-muted">{(file.size / 1024).toLocaleString('de-DE', { maximumFractionDigits: 0 })} KB{p.counts ? ` · ${fmtInt(p.counts.rows_in_file)} Zeilen` : ''}</div>
            </div>
            <button type="button" className="btn-ghost btn-sm" onClick={reset} disabled={step === 'importing'}>Andere Datei</button>
          </div>

          {p.needs_mapping && <Notice tone="warn" title="Postleitzahl nicht gefunden">{p.message}</Notice>}

          {p.counts && p.totals && (
            <>
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <MiniStat label="Wird übernommen" value={`${fmtInt(p.counts.rows_valid)} Zeilen`} sub={p.counts.rows_valid < p.counts.rows_in_file ? `von ${fmtInt(p.counts.rows_in_file)}` : 'alle Zeilen'} />
                <MiniStat label="Bestellungen" value={fmtInt(p.totals.orders)} sub={p.order_level ? 'eine Zeile je Bestellung' : undefined} />
                <MiniStat label="Umsatz" value={fmtEur(p.totals.revenue, 2)} />
                <MiniStat label="Zeitraum" value={p.period?.start ? `${fmtDate(p.period.start)} – ${fmtDate(p.period.end)}` : 'unbekannt'} sub={p.period?.start ? `${fmtInt(p.counts.postal_codes)} Postleitzahlen` : 'kein Datum in der Datei'} small />
              </div>

              <GeoCheck geo={p.geo} />

              {(p.problems_total ?? 0) > 0 && (
                <div className="card">
                  <div className="card-head">
                    <div>
                      <h3 className="section-title">{fmtInt(p.problems_total)} Zeilen mit Auffälligkeiten</h3>
                      <p className="section-lead">
                        {[p.counts.rows_skipped > 0 && `${fmtInt(p.counts.rows_skipped)} ohne gültige oder eindeutig bestimmbare Postleitzahl (werden nicht übernommen)`,
                          p.counts.duplicates > 0 && `${fmtInt(p.counts.duplicates)} doppelt (werden einmal gezählt)`,
                          p.counts.invalid_values > 0 && `${fmtInt(p.counts.invalid_values)} mit unlesbarem Umsatz oder unlesbarer Anzahl (zählen als 0 € bzw. 1 Bestellung)`,
                          (p.counts.invalid_dates ?? 0) > 0 && `${fmtInt(p.counts.invalid_dates)} mit unlesbarem Datum (werden ohne Datum übernommen)`].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    {problems.length > 0 && <button type="button" className="btn-secondary btn-sm" onClick={() => downloadProblems(p.filename, problems)}>Fehlerbericht herunterladen</button>}
                  </div>
                  {problems.length > 0 && (
                    <div className="table-wrap mt-3">
                      <table className="table">
                        <thead><tr><th className="w-24">Zeile</th><th>Grund</th></tr></thead>
                        <tbody>{(showAllProblems ? problems : problems.slice(0, 5)).map((x, i) => <tr key={i}><td className="num">{x.row}</td><td>{x.reason}</td></tr>)}</tbody>
                      </table>
                      {problems.length > 5 && (
                        <button type="button" className="link block px-4 py-3 text-[13px] sm:px-5" onClick={() => setShowAllProblems(s => !s)}>
                          {showAllProblems ? 'Weniger anzeigen' : `Alle ${fmtInt(problems.length)} anzeigen`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {p.sample && p.sample.length > 0 && (
                <div className="card">
                  <div className="card-head"><div><h3 className="section-title">So werden die Daten gespeichert</h3><p className="section-lead">Die ersten {p.sample.length} Zeilen nach der Bereinigung.</p></div></div>
                  <div className="table-wrap mt-3">
                    <table className="table">
                      <thead><tr><th>PLZ</th><th>Ort</th><th>Straße</th><th>Nr.</th><th className="r">Bestellungen</th><th className="r">Umsatz</th><th>Datum</th><th>Kunde erkennbar über</th></tr></thead>
                      <tbody>{p.sample.map((s, i) => (
                        <tr key={i}>
                          <td className="num">{s.postal_code}</td><td>{s.city || '—'}</td><td>{s.street || '—'}</td><td>{s.house_number || '—'}</td>
                          <td className="r">{fmtInt(s.total_orders)}</td><td className="r">{fmtEur(s.total_revenue, 2)}</td><td className="num">{fmtDate(s.last_order_date)}</td>
                          <td className="text-ink-soft">{s.customer_ref ? 'Kundennummer' : s.has_phone_mark ? 'Telefon-Kennzeichen' : '—'}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

          <Notice tone="info" title="Datenschutz">
            <span className="inline-flex items-start gap-1.5"><ShieldCheck size={15} className="mt-0.5 shrink-0 text-accent" aria-hidden />
              <span>
                Namen und E-Mail-Adressen werden nicht gespeichert{p.not_stored?.length ? <> (in dieser Datei: {p.not_stored.map(h => `„${h}“`).join(', ')})</> : null}.
                {p.phone_pseudonymized ? ' Telefonnummern werden nicht gespeichert, nur ein daraus berechnetes Kennzeichen, um denselben Kunden wiederzuerkennen.' : ''}
              </span>
            </span>
          </Notice>

          <div className="card">
            <button type="button" className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left sm:px-5" aria-expanded={showMapping} onClick={() => setShowMapping(s => !s)}>
              <span><span className="section-title">Spaltenzuordnung</span><span className="section-lead block">{Object.keys(p.mapping).length} von {p.headers.length} Spalten der Datei werden verwendet. {showMapping ? '' : 'Zum Prüfen oder Ändern öffnen.'}</span></span>
              <span className="link shrink-0 text-[13px]">{showMapping ? 'Schließen' : 'Öffnen'}</span>
            </button>
            {showMapping && (
              <div className="grid gap-x-6 gap-y-3 border-t border-line p-4 sm:grid-cols-2 sm:p-5">
                {p.fields.map(f => (
                  <label key={f.field} className="block">
                    <span className="field-label">{f.label}{f.required && <span className="text-bad"> (Pflicht)</span>}</span>
                    <select className="input" value={p.mapping[f.field] || ''} disabled={step === 'importing'} onChange={e => changeMapping(f.field, e.target.value)}>
                      <option value="">– nicht vorhanden –</option>
                      {p.headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                    {f.note && <span className="field-help block">{f.note}</span>}
                  </label>
                ))}
                {p.unused_headers && p.unused_headers.length > 0 && <p className="text-[12.5px] text-ink-muted sm:col-span-2">Nicht verwendet: {p.unused_headers.join(', ')}</p>}
              </div>
            )}
          </div>

          {p.existing?.has_data && !p.needs_mapping && (
            <fieldset className="card card-pad">
              <legend className="sr-only">Umgang mit den vorhandenen Daten</legend>
              <h3 className="section-title">Sie haben bereits Daten importiert. Was soll mit dieser Datei geschehen?</h3>
              {p.existing.same_file && <p className="mt-1 text-warn">Genau diese Datei wurde am {fmtDate(p.existing.same_file.uploaded_at.slice(0, 10))} schon importiert. Ergänzen würde alles doppelt zählen.</p>}
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <ModeOption checked={mode === 'append'} disabled={!!p.existing.same_file} onChange={() => setMode('append')} title="Neuen Zeitraum ergänzen"
                  text={`Die Datei enthält nur Bestellungen nach dem bisherigen Stand${p.existing.last_period_end ? ` (bis ${fmtDate(p.existing.last_period_end)})` : ''}. Sie wird dazugezählt.`} />
                <ModeOption checked={mode === 'replace'} onChange={() => setMode('replace')} title="Bisherige Daten ersetzen"
                  text="Die Datei enthält alle Bestellungen. Die bisherigen Daten dieses Standorts werden gelöscht und durch diese Datei ersetzt." />
              </div>
              {(needPeriod || (mode === 'append' && !p.period?.start)) && (
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label><span className="field-label">Zeitraum der Datei von</span><input type="date" className="input" value={periodStart} onChange={e => setPeriodStart(e.target.value)} /></label>
                  <label><span className="field-label">bis</span><input type="date" className="input" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} /></label>
                  <p className="field-help sm:col-span-2">Die Datei enthält kein Datum. Damit nichts doppelt gezählt wird, geben Sie bitte an, welchen Zeitraum sie abdeckt.</p>
                </div>
              )}
            </fieldset>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" className="btn-primary" disabled={step === 'importing' || !!p.needs_mapping || !p.counts || (mode === 'append' && !p.period?.start && !periodStart)} onClick={startImport}>
              {step === 'importing' ? 'Import läuft …' : mode === 'replace' ? 'Daten ersetzen und importieren' : 'Import starten'}
            </button>
            <button type="button" className="btn-ghost" onClick={reset} disabled={step === 'importing'}>Abbrechen</button>
            {step === 'importing' && <Spinner label="Daten werden gespeichert und ausgewertet" />}
          </div>
        </div>
      )}

      {step === 'done' && result?.summary && (
        <div className="space-y-4">
          <Notice tone="good" title="Import abgeschlossen">
            {fmtInt(result.summary.valid_rows)} Zeilen übernommen
            {result.import_mode === 'replace' ? '. Die bisherigen Daten wurden ersetzt.' : result.import_mode === 'append' ? '. Der neue Zeitraum wurde ergänzt; Kunden aus beiden Zeiträumen zählen einmal.' : '.'}
            {result.summary.error_rows > 0 && ` ${fmtInt(result.summary.error_rows)} Zeilen ohne gültige Postleitzahl wurden nicht übernommen.`}
          </Notice>
          {result.totals && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <MiniStat label="Bestand: Kunden" value={fmtInt(result.totals.customers)} />
              <MiniStat label="Bestand: Bestellungen" value={fmtInt(result.totals.orders)} />
              <MiniStat label="Bestand: Umsatz" value={fmtEur(result.totals.revenue, 2)} />
              <MiniStat label="Zeitraum der Datei" value={result.summary.period.start ? `${fmtDate(result.summary.period.start)} – ${fmtDate(result.summary.period.end)}` : 'unbekannt'} small />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <a href="/dashboard" className="btn-primary">Zur Übersicht</a>
            <a href="/streets" className="btn-secondary">Karte ansehen</a>
            <button type="button" className="btn-ghost" onClick={reset}>Weitere Datei importieren</button>
          </div>
        </div>
      )}
    </div>
  )
}

function MiniStat({ label, value, sub, small }: { label: string; value: string; sub?: string; small?: boolean }) {
  return (
    <div className="card card-pad">
      <div className="text-[13px] text-ink-muted">{label}</div>
      <div className={`num mt-1 font-semibold tracking-tight ${small ? 'text-[15px] leading-7' : 'text-[20px] leading-7'}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[12.5px] text-ink-muted">{sub}</div>}
    </div>
  )
}

function ModeOption({ checked, onChange, title, text, disabled }: { checked: boolean; onChange: () => void; title: string; text: string; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer gap-3 rounded-control border p-3 ${checked ? 'border-accent bg-accent-soft/50' : 'border-line-strong'} ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}>
      <input type="radio" name="import-mode" className="mt-1 accent-[rgb(31,75,153)]" checked={checked} disabled={disabled} onChange={onChange} />
      <span><span className="block font-medium">{title}</span><span className="block text-[13px] text-ink-soft">{text}</span></span>
    </label>
  )
}

/** Ergebnis der Adressprüfung gegen das deutschlandweite Straßenverzeichnis */
function GeoCheck({ geo }: { geo?: GeoSummary | null }) {
  if (geo === undefined) return null
  if (geo === null) {
    return <Notice title="Adressen nicht geprüft">Das deutschlandweite Straßenverzeichnis ist noch nicht eingerichtet. Die Daten werden wie bisher übernommen; fehlende Postleitzahlen können nicht ergänzt werden.</Notice>
  }
  if (!geo.total) return null
  const order: GeoStatus[] = ['exakt', 'schreibweise', 'plz_ergaenzt', 'plz_pruefen', 'mehrdeutig', 'strasse_unbekannt', 'plz_unbekannt', 'ohne_strasse', 'ohne_ort']
  const rows = order.filter(k => geo.by_status[k] > 0)
  const pct = (n: number) => `${(n / geo.total * 100).toLocaleString('de-DE', { maximumFractionDigits: 1 })} %`
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h3 className="section-title">Adressprüfung: {geo.reliable_pct?.toLocaleString('de-DE')} % sicher zugeordnet</h3>
          <p className="section-lead">Jede Adresse wurde mit dem Straßenverzeichnis für ganz Deutschland abgeglichen (OpenStreetMap). Angegebene Postleitzahlen werden nie verändert, fehlende nur ergänzt, wenn Straße und Ort eindeutig sind.</p>
        </div>
      </div>
      <div className="table-wrap mt-3">
        <table className="table">
          <thead><tr><th>Ergebnis</th><th className="r">Zeilen</th><th className="r">Anteil</th></tr></thead>
          <tbody>{rows.map(k => (
            <tr key={k}>
              <td><span className={RELIABLE_STATUSES.has(k) ? 'text-good' : 'text-warn'} aria-hidden>●</span> {GEO_STATUS_TEXT[k]}</td>
              <td className="r num">{fmtInt(geo.by_status[k])}</td>
              <td className="r num">{pct(geo.by_status[k])}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="border-t border-line px-4 py-2.5 text-[12px] text-ink-muted sm:px-5">
        Das Verzeichnis enthält keine Hausnummern. Liegt eine Straße in mehreren Postleitzahlen und fehlt die PLZ in der Datei, wird die Zeile nicht geraten, sondern im Fehlerbericht genannt.
        {geo.directory_version ? ` Stand des Verzeichnisses: ${geo.directory_version}.` : ''}
      </p>
    </div>
  )
}
