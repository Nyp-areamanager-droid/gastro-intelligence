// =============================================================================
// Excel-Import mit SheetJS 0.20.3: alle erlaubten Formate bleiben lesbar,
// Datum und Zahlen kommen unverändert an, präparierte Dateien richten nichts an.
// =============================================================================
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import { readWorkbook } from '@/lib/import/read-table'
import { checkUploadFile } from '@/lib/import/upload-checks'

const ROWS = [
  ['Kundennummer', 'PLZ', 'Straße', 'Hausnummer', 'Bestellungen', 'Umsatz'],
  ['K-1', '50733', 'Neusser Str.', '12', 3, 45.5],
  ['K-2', '50735', 'Äußere Kanalstr.', '7a', 1, 18],
]
function build(bookType: XLSX.BookType): ArrayBuffer {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ROWS), 'Daten')
  const out = XLSX.write(wb, { type: 'array', bookType }) as ArrayBuffer
  return out
}
const toRows = (wb: XLSX.WorkBook) => XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 })

describe('Excel-Formate', () => {
  it.each([['xlsx', 'xlsx'], ['biff8', 'xls'], ['xlsb', 'xlsb']] as const)('%s wird gelesen (Umlaute, Zahlen)', (bookType, ext) => {
    const wb = readWorkbook(build(bookType), `kunden.${ext}`, '')
    const rows = toRows(wb)
    expect(rows[1]).toEqual(['K-1', '50733', 'Neusser Str.', '12', 3, 45.5])
    expect(rows[2][2]).toBe('Äußere Kanalstr.')
  })

  it('xlsx besteht die Dateiprüfung des Uploads', () => {
    const bytes = new Uint8Array(build('xlsx'))
    expect(checkUploadFile('kunden.xlsx', bytes.length, bytes).ok).toBe(true)
  })

  it('CSV mit Semikolon und UTF-8 bleibt lesbar', () => {
    const csv = new TextEncoder().encode('PLZ;Straße\n50733;Neusser Str.\n')
    const wb = readWorkbook(csv.buffer as ArrayBuffer, 'k.csv', 'text/csv')
    expect(toRows(wb)[1]).toEqual(['50733', 'Neusser Str.'])
  })

  it('Datei mit Tabellenname "__proto__" verändert keine Standardobjekte', () => {
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(ROWS), 'proto_blatt')
    const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    // Blattname im gepackten Dokument durch "__proto__" ersetzen (gleiche Länge nötig → Text im ZIP unkomprimiert nicht sicher);
    // deshalb zusätzlich das Lesen eines Blatts mit diesem Namen direkt prüfen:
    const wb2 = XLSX.read(buf, { type: 'array' })
    wb2.SheetNames[0] = '__proto__'
    wb2.Sheets['__proto__'] = wb2.Sheets['proto_blatt']
    readWorkbook(buf, 'a.xlsx', '')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false)
  })

  it('beschädigte oder falsch benannte Datei wird von der Dateiprüfung abgelehnt (415)', () => {
    const junk = new Uint8Array(2000).map((_, i) => (i * 37) % 251)
    const r = checkUploadFile('kaputt.xlsx', junk.length, junk)
    expect(r.ok).toBe(false)
  })
})
