// =============================================================================
// Datenminimierung beim Import
//
// Grundsatz: Im Bestellimport werden keine Kundennamen, Telefonnummern oder
// E-Mail-Adressen gespeichert.
//   - Namen und E-Mail-Spalten werden gar nicht erst übernommen.
//   - Die Telefonnummer dient nur dazu, denselben Kunden in mehreren Dateien
//     wiederzuerkennen. Gespeichert wird deshalb nicht die Nummer, sondern ein
//     daraus berechnetes Kennzeichen (SHA-256 über Firmen-ID und Nummer).
//     Dasselbe Telefon ergibt in derselben Firma immer dasselbe Kennzeichen,
//     in einer anderen Firma ein anderes.
//
// Ehrliche Einordnung: Das ist eine Pseudonymisierung, keine Anonymisierung.
// Wer die Firmen-ID kennt und alle denkbaren Telefonnummern durchprobiert,
// kann eine Nummer wiederfinden. Die Daten bleiben personenbezogen (DSGVO).
//
// Dieselbe Rechnung führt Migration 007 für bereits gespeicherte Nummern in
// der Datenbank aus – beide Stellen müssen identisch bleiben (siehe Test).
// =============================================================================
import { createHash } from 'crypto'

export const PHONE_PSEUDONYM_PREFIX = 'p1:'

export function isPhonePseudonym(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PHONE_PSEUDONYM_PREFIX)
}

export function pseudonymizePhone(companyId: string, phoneNormalized: string | null | undefined): string | undefined {
  if (!phoneNormalized) return undefined
  if (isPhonePseudonym(phoneNormalized)) return phoneNormalized
  return PHONE_PSEUDONYM_PREFIX + createHash('sha256').update(`${companyId}:${phoneNormalized}`, 'utf8').digest('hex')
}

/** Spalten, die erkannt, aber bewusst nicht übernommen werden. */
export const IGNORED_PERSONAL_FIELDS = ['first_name', 'last_name', 'email'] as const

/** Entfernt alle Klartext-Personendaten aus einer Importzeile (vor dem Speichern). */
export function minimizeRow<T extends { phone_normalized?: string; phone_raw?: string; first_name?: string; last_name?: string; full_name?: string }>(companyId: string, row: T): T {
  const out = { ...row }
  out.phone_normalized = pseudonymizePhone(companyId, row.phone_normalized)
  delete out.phone_raw
  delete out.first_name
  delete out.last_name
  delete out.full_name
  return out
}
