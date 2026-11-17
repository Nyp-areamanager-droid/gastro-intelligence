// =============================================================================
// Google-Places-Schlüssel: Der Import liest ihn nur über die Datenbankfunktion
// get_company_places_key() (Migration 011), nie direkt aus companies.
// =============================================================================
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

describe('Google-Places-Schlüssel im Quelltext', () => {
  it('Upload-Route greift nie direkt auf die Spalte zu, nur über die Funktion', () => {
    const src = readFileSync('src/app/api/upload/route.ts', 'utf8')
    expect(src).not.toMatch(/select\(['"`][^'"`]*google_places_api_key/)
    expect(src).toContain("rpc('get_company_places_key')")
  })

  it('keine andere Stelle der App liest google_places_api_key aus der Datenbank', () => {
    const hits = String(execSync('grep -rln "google_places_api_key" src --include=*.ts --include=*.tsx || true'))
      .split('\n').filter(Boolean)
      .filter(f => !f.endsWith('database.types.ts') && !f.endsWith('types/index.ts'))
    expect(hits).toEqual([])
  })
})
