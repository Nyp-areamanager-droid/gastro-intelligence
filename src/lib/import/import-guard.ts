// =============================================================================
// Wiederholte Datenimporte ohne Doppelzählung
//
// Drei Fälle beim Upload:
//   - Erster Import: einfach einlesen.
//   - „Daten ersetzen“: die bisherigen Kundendaten (gleiche Filiale bzw. ohne
//     Filiale) werden durch die neue Datei ersetzt.
//   - „Neuen Zeitraum ergänzen“: die neue Datei kommt dazu. Erlaubt nur, wenn
//     ihr Zeitraum NACH dem bisherigen liegt und sie nicht weitgehend dieselben
//     Zeilen enthält. Sonst würden Bestellungen doppelt gezählt.
// Dieselbe Datei (gleicher Inhalt, Prüfsumme) wird nie ein zweites Mal
// dazugezählt. Neu einlesen geht nur über „Daten ersetzen“.
// =============================================================================

import { createHash } from 'crypto'

export type ImportMode = 'auto' | 'replace' | 'append'

export function parseImportMode(raw: unknown): ImportMode {
  return raw === 'replace' || raw === 'append' ? raw : 'auto'
}

export function fileFingerprint(buffer: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(buffer)).digest('hex')
}

/** Ein Datensatz in einer Form, die Datei-unabhängig vergleichbar ist. */
export function rowFingerprint(r: {
  postal_code?: string | null; street_normalized?: string | null; house_number?: string | null
  phone_normalized?: string | null; customer_ref?: string | null
  total_orders?: number | null; total_revenue?: number | null
}): string {
  return [
    (r.customer_ref || '').trim().toLowerCase(),
    r.postal_code || '', (r.street_normalized || '').toLowerCase(), (r.house_number || '').toLowerCase(),
    r.phone_normalized || '', Number(r.total_orders ?? 0), Number(r.total_revenue ?? 0).toFixed(2),
  ].join('|')
}

/** Anteil der neuen Zeilen, die es genau so schon gibt (0 bis 1). */
export function overlapShare(newFingerprints: string[], existingFingerprints: Iterable<string>): number {
  if (newFingerprints.length === 0) return 0
  const existing = new Set(existingFingerprints)
  let same = 0
  for (const f of newFingerprints) if (existing.has(f)) same++
  return same / newFingerprints.length
}

/** Ab diesem Anteil gleicher Zeilen gilt eine „Ergänzung“ als dieselben Daten. */
export const SAME_DATA_SHARE = 0.5

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export function parsePeriodDate(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!ISO_DATE.test(s)) return null
  const d = new Date(s + 'T00:00:00Z')
  return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s ? null : s
}

export function formatDateDE(iso: string | null | undefined): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}.${m}.${y}`
}

export interface ExistingUpload {
  id: string
  filename: string
  created_at: string
  file_hash: string | null
  period_start: string | null
  period_end: string | null
}

export type ImportDecision =
  | { ok: true; action: 'first' | 'replace' | 'append'; replaceUploadIds: string[] }
  | { ok: false; code: 'duplicate_file' | 'choose_mode' | 'append_period_unknown' | 'append_overlap' | 'invalid_period'; message: string; existing?: { filename: string; uploaded_at: string; period_start: string | null; period_end: string | null } }

/**
 * Entscheidet ohne Datenbankzugriff, ob und wie importiert wird.
 * Der Abgleich auf gleiche Zeilen (overlapShare) kommt danach im Upload.
 */
export function decideImport(params: {
  mode: ImportMode
  fileHash: string
  existing: ExistingUpload[]
  newPeriod: { start: string | null; end: string | null }
}): ImportDecision {
  const { mode, fileHash, existing, newPeriod } = params
  if (newPeriod.start && newPeriod.end && newPeriod.start > newPeriod.end) {
    return { ok: false, code: 'invalid_period', message: 'Der Zeitraum ist ungültig: Das Enddatum liegt vor dem Startdatum.' }
  }
  if (existing.length === 0) return { ok: true, action: 'first', replaceUploadIds: [] }

  const newest = [...existing].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  const info = (u: ExistingUpload) => ({ filename: u.filename, uploaded_at: u.created_at, period_start: u.period_start, period_end: u.period_end })

  const same = existing.find(u => u.file_hash && u.file_hash === fileHash)
  if (same && mode !== 'replace') {
    return {
      ok: false, code: 'duplicate_file', existing: info(same),
      message: `Diese Datei wurde bereits am ${formatDateDE(same.created_at)} hochgeladen („${same.filename}“). Sie wurde nicht noch einmal gezählt. Wenn Sie sie neu einlesen möchten, wählen Sie „Daten ersetzen“.`,
    }
  }

  if (mode === 'auto') {
    return {
      ok: false, code: 'choose_mode', existing: info(newest),
      message: 'Für dieses Unternehmen gibt es bereits Daten. Bitte wählen Sie: „Daten ersetzen“, wenn die neue Datei die bisherigen Daten vollständig enthält, oder „Neuen Zeitraum ergänzen“, wenn sie nur einen späteren Zeitraum enthält.',
    }
  }

  if (mode === 'replace') return { ok: true, action: 'replace', replaceUploadIds: existing.map(u => u.id) }

  // append: neuer Zeitraum muss nach allem Bisherigen beginnen
  const ends = existing.map(u => u.period_end)
  if (!newPeriod.start || ends.some(e => !e)) {
    return {
      ok: false, code: 'append_period_unknown', existing: info(newest),
      message: 'Der Zeitraum der neuen oder der bisherigen Daten ist nicht bekannt. Ohne Zeitraum lässt sich eine Doppelzählung nicht ausschließen. Bitte geben Sie den Zeitraum der neuen Datei an oder wählen Sie „Daten ersetzen“ mit einer Gesamtdatei.',
    }
  }
  const lastEnd = (ends as string[]).sort().reverse()[0]
  if (newPeriod.start <= lastEnd.slice(0, 10)) {
    return {
      ok: false, code: 'append_overlap', existing: info(newest),
      message: `Der neue Zeitraum beginnt am ${formatDateDE(newPeriod.start)}, die bisherigen Daten reichen aber bis ${formatDateDE(lastEnd)}. Bestellungen würden doppelt gezählt. Bitte nur Bestellungen nach dem ${formatDateDE(lastEnd)} ergänzen oder „Daten ersetzen“ wählen.`,
    }
  }
  return { ok: true, action: 'append', replaceUploadIds: [] }
}

export { mergeCustomers } from '@/lib/analysis/merge-customers'
