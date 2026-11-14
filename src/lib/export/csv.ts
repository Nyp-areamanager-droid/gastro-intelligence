// CSV für Excel (deutsche Einstellung): Semikolon, Dezimalkomma, UTF-8 mit BOM.
// Texte, die mit = + - @ beginnen, bekommen ein Hochkomma vorangestellt, damit
// Excel sie nicht als Formel ausführt (Schutz vor „CSV-Injection“ – Straßen-
// und Ortsnamen stammen aus hochgeladenen Dateien).
export type CsvValue = string | number | null | undefined

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'number') return Number.isFinite(v) ? String(v).replace('.', ',') : ''
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(header: string[], rows: CsvValue[][]): string {
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(';')).join('\r\n') + '\r\n'
}
