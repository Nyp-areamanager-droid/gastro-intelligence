// =============================================================================
// Serverseitige Prüfung hochgeladener Dateien (Nr. 10)
//
// Der Browser prüft nur die Dateiendung, und das lässt sich umgehen. Der
// Server prüft deshalb selbst: Größe, Endung und ob der Inhalt wirklich zu
// dieser Endung passt. Erst danach wird die Datei gelesen und gespeichert.
// =============================================================================

// Vercel nimmt pro Anfrage höchstens 4,5 MB an. Mit 4 MB bekommt der Nutzer
// eine verständliche Meldung statt eines technischen Fehlers.
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024
// Zuschlag für den Rahmen der Anfrage (Formularfelder, Trennzeilen)
export const MAX_REQUEST_BYTES = MAX_UPLOAD_BYTES + 64 * 1024
// Je Upload höchstens so viele verschiedene Postleitzahlen. Jede PLZ löst
// Abfragen bei OpenPLZ/OpenStreetMap und Schreibvorgänge im gemeinsamen
// Straßenverzeichnis aus.
export const MAX_PLZ_PER_UPLOAD = 100
// Höchstzahl an Datenzeilen. Schützt vor Excel-Dateien, die klein
// gepackt sind, ausgepackt aber Millionen Zeilen enthalten.
export const MAX_DATA_ROWS = 200_000

export type UploadKind = 'csv' | 'xlsx' | 'xls'

const EXTENSIONS: Record<string, { kind: UploadKind; contentType: string }> = {
  csv: { kind: 'csv', contentType: 'text/csv' },
  txt: { kind: 'csv', contentType: 'text/plain' },
  xlsx: { kind: 'xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xlsb: { kind: 'xlsx', contentType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12' },
  xls: { kind: 'xls', contentType: 'application/vnd.ms-excel' },
}
export const ALLOWED_EXTENSIONS = Object.keys(EXTENSIONS).map(e => '.' + e)

export type UploadCheck =
  | { ok: true; kind: UploadKind; contentType: string }
  | { ok: false; status: number; error: string }

const mb = (n: number) => (n / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })

export function checkRequestSize(contentLength: string | null): UploadCheck | null {
  const n = Number(contentLength)
  if (contentLength && Number.isFinite(n) && n > MAX_REQUEST_BYTES) {
    return { ok: false, status: 413, error: `Die Datei ist zu groß. Erlaubt sind höchstens ${mb(MAX_UPLOAD_BYTES)} MB.` }
  }
  return null
}

export function checkUploadFile(name: string, size: number, bytes: Uint8Array): UploadCheck {
  const ext = (name.match(/\.([^.\\/]+)$/)?.[1] || '').toLowerCase()
  const spec = EXTENSIONS[ext]
  if (!spec) {
    return { ok: false, status: 415, error: `Dieses Dateiformat wird nicht unterstützt (${ext ? '.' + ext : 'ohne Endung'}). Möglich sind: ${ALLOWED_EXTENSIONS.join(', ')}` }
  }
  if (size > MAX_UPLOAD_BYTES || bytes.length > MAX_UPLOAD_BYTES) {
    return { ok: false, status: 413, error: `Die Datei ist zu groß (${mb(Math.max(size, bytes.length))} MB). Erlaubt sind höchstens ${mb(MAX_UPLOAD_BYTES)} MB.` }
  }
  if (bytes.length === 0) {
    return { ok: false, status: 400, error: 'Die Datei ist leer.' }
  }
  const startsWith = (sig: number[]) => sig.every((b, i) => bytes[i] === b)
  let matches: boolean
  if (spec.kind === 'xlsx') {
    matches = startsWith([0x50, 0x4b, 0x03, 0x04])                        // ZIP-Container
  } else if (spec.kind === 'xls') {
    matches = startsWith([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) // altes Excel (OLE)
  } else {
    // Text: keine Nullbytes und kein bekanntes Binärformat
    const sample = bytes.subarray(0, 8192)
    matches = !sample.includes(0) && !startsWith([0x50, 0x4b, 0x03, 0x04]) && !startsWith([0xd0, 0xcf, 0x11, 0xe0])
  }
  if (!matches) {
    return { ok: false, status: 415, error: `Der Inhalt passt nicht zur Endung .${ext}. Bitte die Datei direkt aus Excel oder dem Kassensystem exportieren und erneut hochladen.` }
  }
  return { ok: true, kind: spec.kind, contentType: spec.contentType }
}

export function checkPlzCount(count: number): UploadCheck | null {
  if (count > MAX_PLZ_PER_UPLOAD) {
    return { ok: false, status: 422, error: `Die Datei enthält ${count.toLocaleString('de-DE')} verschiedene Postleitzahlen. Pro Upload sind höchstens ${MAX_PLZ_PER_UPLOAD} möglich. Bitte die Datei nach Filiale oder Liefergebiet aufteilen. Es wurde nichts importiert.` }
  }
  return null
}

export function checkRowCount(count: number): UploadCheck | null {
  if (count > MAX_DATA_ROWS) {
    return { ok: false, status: 422, error: `Die Datei enthält mehr als ${MAX_DATA_ROWS.toLocaleString('de-DE')} Zeilen. Bitte in kleinere Zeiträume aufteilen. Es wurde nichts importiert.` }
  }
  return null
}
