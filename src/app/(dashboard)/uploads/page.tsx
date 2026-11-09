'use client'

import { FileUploader } from '@/components/upload/FileUploader'

// Die Upload-Logik liegt in FileUploader: Prüfung auf bereits vorhandene
// Daten („Daten ersetzen“ / „Neuen Zeitraum ergänzen“), verständliche
// Meldungen und Zusammenfassung. Vorher hatte diese Seite eine eigene,
// ältere Kopie dieser Logik.
export default function UploadsPage() {
  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Daten hochladen</h1>
        <p className="text-[#8a9bb5] text-sm mt-1">Excel oder CSV mit Bestelldaten importieren</p>
      </div>

      <FileUploader />

      {/* Hinweis */}
      <div className="mt-6 p-4 bg-[#1a2233] rounded-xl border border-[#2a3d5a]">
        <p className="text-xs text-[#8a9bb5] font-semibold uppercase tracking-wider mb-2">Erwartete Spalten</p>
        <p className="text-xs text-[#4a5a70]">
          Telefon, Vorname, Nachname, Straße, PLZ, Stadt, Bestellungen, Umsatz, Letztes Bestelldatum, Plattform
        </p>
        <p className="text-xs text-[#4a5a70] mt-2">
          Pflicht ist nur die PLZ. Ohne Straße gibt es keine Straßenauswertung, ohne Datum keine Zeitraum-Prüfung beim Ergänzen.
        </p>
      </div>
    </div>
  )
}
