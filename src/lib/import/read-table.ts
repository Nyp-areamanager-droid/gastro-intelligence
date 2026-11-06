// =============================================================================
// Tabellen-Datei (Excel oder CSV) robust einlesen
//
// SheetJS liest CSV-Dateien ohne BOM als Latin-1. Eine UTF-8-Datei mit der
// Spalte "Straße" wird dann zu "StraÃe": Die Straßenspalte wird nicht
// erkannt und der Import hat keine einzige Straße. Deshalb werden CSV-Dateien
// hier selbst dekodiert: zuerst UTF-8, bei ungültigen Bytes Windows-1252
// (typisch für deutsche Excel-CSV-Exporte).
// =============================================================================

import * as XLSX from 'xlsx'

export function isCsvFile(name: string, type: string): boolean {
  return /\.(csv|txt)$/i.test(name) || /^text\/(csv|plain)/i.test(type)
}

export function decodeCsv(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

export function readWorkbook(buffer: ArrayBuffer, name: string, type: string): XLSX.WorkBook {
  if (isCsvFile(name, type)) {
    return XLSX.read(decodeCsv(buffer), { type: 'string', cellDates: true })
  }
  return XLSX.read(buffer, { type: 'array', cellDates: true })
}
