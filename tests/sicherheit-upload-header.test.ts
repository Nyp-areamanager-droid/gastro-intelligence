// Nr. 10 (Prüfregeln) und Nr. 11 (Sicherheits-Header)
import { describe, it, expect } from 'vitest'
import * as XLSX from 'xlsx'
import {
  checkUploadFile, checkPlzCount, checkRowCount, checkRequestSize,
  MAX_UPLOAD_BYTES, MAX_PLZ_PER_UPLOAD, MAX_DATA_ROWS,
} from '../src/lib/import/upload-checks'
import { readWorkbook } from '../src/lib/import/read-table'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { securityHeaders, buildCsp } = require('../security-headers.js')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nextConfig = require('../next.config.js')

const bytes = (s: string) => new TextEncoder().encode(s)
const xlsxBytes = () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['PLZ', 'Straße'], ['50733', 'Neusser Str. 1']]), 'Kunden')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }))
}
const xlsBytes = () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['PLZ'], ['50733']]), 'K')
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'biff8' }))
}

describe('Upload-Prüfung', () => {
  it('echte Dateien werden angenommen, Dateityp kommt vom Server', () => {
    expect(checkUploadFile('a.csv', 10, bytes('PLZ;Straße\n50733;X'))).toEqual({ ok: true, kind: 'csv', contentType: 'text/csv' })
    expect(checkUploadFile('A.CSV', 10, bytes('PLZ'))).toMatchObject({ ok: true, kind: 'csv' })
    expect(checkUploadFile('a.txt', 10, bytes('PLZ'))).toMatchObject({ ok: true, contentType: 'text/plain' })
    expect(checkUploadFile('a.xlsx', 10, xlsxBytes())).toMatchObject({ ok: true, kind: 'xlsx' })
    expect(checkUploadFile('a.xls', 10, xlsBytes())).toMatchObject({ ok: true, kind: 'xls' })
  })
  it('falsche Endungen werden abgelehnt', () => {
    for (const n of ['a.html', 'a.svg', 'a.exe', 'a.js', 'a.pdf', 'a.ods', 'kunden', 'a.csv.html']) {
      expect(checkUploadFile(n, 10, bytes('x'))).toMatchObject({ ok: false, status: 415 })
    }
  })
  it('Inhalt muss zur Endung passen', () => {
    expect(checkUploadFile('a.xlsx', 10, bytes('PLZ;Straße'))).toMatchObject({ ok: false, status: 415 })
    expect(checkUploadFile('a.xls', 10, xlsxBytes())).toMatchObject({ ok: false, status: 415 })
    expect(checkUploadFile('a.csv', 10, xlsxBytes())).toMatchObject({ ok: false, status: 415 })
    expect(checkUploadFile('a.csv', 10, new Uint8Array([0x41, 0x00, 0x42]))).toMatchObject({ ok: false, status: 415 })
  })
  it('Größe und Leere', () => {
    expect(checkUploadFile('a.csv', MAX_UPLOAD_BYTES + 1, bytes('PLZ'))).toMatchObject({ ok: false, status: 413 })
    expect(checkUploadFile('a.csv', MAX_UPLOAD_BYTES, bytes('PLZ'))).toMatchObject({ ok: true })
    expect(checkUploadFile('a.csv', 0, new Uint8Array())).toMatchObject({ ok: false, status: 400 })
    expect(checkRequestSize(String(MAX_UPLOAD_BYTES + 1024 * 1024))).toMatchObject({ ok: false, status: 413 })
    expect(checkRequestSize(String(MAX_UPLOAD_BYTES))).toBeNull()
    expect(checkRequestSize(null)).toBeNull()
  })
  it('PLZ- und Zeilen-Obergrenze', () => {
    expect(checkPlzCount(MAX_PLZ_PER_UPLOAD)).toBeNull()
    expect(checkPlzCount(MAX_PLZ_PER_UPLOAD + 1)).toMatchObject({ ok: false, status: 422 })
    expect(checkRowCount(MAX_DATA_ROWS)).toBeNull()
    expect(checkRowCount(MAX_DATA_ROWS + 1)).toMatchObject({ ok: false, status: 422 })
  })
  it('sehr große Tabelle wird nur bis zur Obergrenze ausgepackt', () => {
    const csv = 'PLZ\n' + '50733\n'.repeat(MAX_DATA_ROWS + 500)
    const wb = readWorkbook(new TextEncoder().encode(csv).buffer as ArrayBuffer, 'a.csv', 'text/csv')
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])
    expect(rows.length).toBe(MAX_DATA_ROWS + 1)          // eine zu viel → wird erkannt und abgelehnt
    expect(checkRowCount(rows.length)).toMatchObject({ ok: false })
  })
  it('die mitgelieferten Testdateien 1–10 bestehen die Prüfung', () => {
    const fs = require('fs'); const path = '/tmp/tdz/'
    if (!fs.existsSync(path)) return
    for (const f of fs.readdirSync(path).filter((x: string) => /\.(csv|xlsx)$/.test(x))) {
      const b = new Uint8Array(fs.readFileSync(path + f))
      expect(checkUploadFile(f, b.length, b), f).toMatchObject({ ok: true })
    }
  })
})

describe('Sicherheits-Header', () => {
  const prod = Object.fromEntries(securityHeaders({ dev: false, supabaseUrl: 'https://abcdefgh.supabase.co' }).map((h: { key: string; value: string }) => [h.key, h.value]))
  it('alle Header vorhanden', () => {
    expect(Object.keys(prod).sort()).toEqual(['Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Permissions-Policy', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options'])
    expect(prod['X-Frame-Options']).toBe('DENY')
    expect(prod['X-Content-Type-Options']).toBe('nosniff')
  })
  it('CSP: keine fremden Skripte, kein Einbetten, kein eval in Produktion', () => {
    const csp = prod['Content-Security-Policy']
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline'(;|$)/)
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("connect-src 'self' https://abcdefgh.supabase.co wss://abcdefgh.supabase.co;")
    expect(csp).not.toContain('*.supabase.co')            // nur das eigene Projekt
    expect(buildCsp({ supabaseUrl: undefined })).toContain('https://*.supabase.co')  // Rückfall ohne Einstellung
    expect(csp).toContain('https://*.tile.openstreetmap.org')
    expect(buildCsp({ dev: true })).toContain("'unsafe-eval'")
  })
  it('next.config: Header für alle Pfade, Bildoptimierung aus, kein X-Powered-By', async () => {
    const h = await nextConfig.headers()
    expect(h).toHaveLength(1)
    expect(h[0].source).toBe('/:path*')
    expect(nextConfig.images).toEqual({ unoptimized: true })
    expect(nextConfig.poweredByHeader).toBe(false)
  })
})
