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
import { MAX_DATA_ROWS } from './upload-checks'

// Kopfzeile + Höchstzahl + 1: So lässt sich erkennen, dass es mehr Zeilen
// sind, ohne eine riesige Datei vollständig auszupacken.
const SHEET_ROWS = MAX_DATA_ROWS + 2

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
    // raw: true → Werte bleiben Text. Sonst liest die Bibliothek "143,91" als 14391
    // (Komma als Tausendertrenner). Zahlen und Daten wandelt parseAndCleanRows selbst um.
    return XLSX.read(decodeCsv(buffer), { type: 'string', raw: true, sheetRows: SHEET_ROWS })
  }
  // Kein cellDates: Datumszellen kommen als Excel-Seriennummer und werden in
  // parseAndCleanRows exakt (UTC) umgerechnet. Mit cellDates entstehen Date-Objekte,
  // die als Text nicht mehr erkannt wurden (Datum ging verloren).
  return XLSX.read(buffer, { type: 'array', sheetRows: SHEET_ROWS })
}
