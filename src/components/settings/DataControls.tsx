'use client'
// Ihre Daten: Auswertungen als CSV herunterladen, alle importierten Daten löschen.
import { useState } from 'react'
import { Download } from 'lucide-react'
import { Card, Notice } from '@/components/ui'

const EXPORTS = [
  { type: 'plz', label: 'Postleitzahlen', text: 'Umsatz, Bestellungen, Einwohner und Bestellungen je 1.000 Einwohner je PLZ' },
  { type: 'strassen', label: 'Straßen', text: 'Kunden, Bestellungen und Umsatz je Straße' },
  { type: 'empfehlungen', label: 'Empfehlungen', text: 'Alle Empfehlungen mit Zahlen und Begründung' },
]
const WORD = 'LÖSCHEN'

export function DataControls({ role, hasData, onChanged }: { role: string; hasData: boolean; onChanged: () => void }) {
  const canDelete = role === 'owner' || role === 'admin'
  const [open, setOpen] = useState(false)
  const [word, setWord] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'good' | 'bad' | 'warn'; text: string } | null>(null)

  async function removeAll() {
    setBusy(true); setMsg(null)
    try {
      const res = await fetch('/api/data', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: word }) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) setMsg({ tone: 'bad', text: body.error || 'Die Daten konnten nicht gelöscht werden.' })
      else { setMsg(body.warning ? { tone: 'warn', text: `Die Daten wurden gelöscht. ${body.warning}` } : { tone: 'good', text: 'Alle importierten Daten wurden gelöscht.' }); setOpen(false); setWord(''); onChanged() }
    } catch { setMsg({ tone: 'bad', text: 'Die Verbindung wurde unterbrochen. Bitte prüfen Sie, ob die Daten noch vorhanden sind, und versuchen Sie es erneut.' }) }
    setBusy(false)
  }

  return (
    <>
      <Card className="mt-4" title="Auswertungen herunterladen" lead="CSV-Dateien für Excel. Enthalten sind Summen je Gebiet und Straße, keine einzelnen Kundendatensätze.">
        {hasData ? (
          <ul className="grid gap-3 sm:grid-cols-3">
            {EXPORTS.map(e => (
              <li key={e.type} className="rounded-control border border-line p-3">
                <div className="font-medium">{e.label}</div>
                <p className="mt-0.5 text-[13px] text-ink-soft">{e.text}</p>
                <a href={`/api/export?type=${e.type}`} download className="btn-secondary btn-sm mt-3"><Download size={15} aria-hidden />Herunterladen</a>
              </li>
            ))}
          </ul>
        ) : <p className="text-ink-soft">Sobald Daten importiert sind, können Sie die Auswertungen hier herunterladen.</p>}
      </Card>

      <Card className="mt-4" title="Daten löschen" lead="Entfernt alle importierten Bestelldaten, Auswertungen, Hinweise und Importe dieses Unternehmens endgültig. Konto, Nutzer und Standorte bleiben bestehen.">
        {msg && <div className="mb-3"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
        {!canDelete ? <p className="text-ink-soft">Nur Inhaber und Administratoren können die Daten löschen.</p>
          : !hasData ? <p className="text-ink-soft">Es sind keine importierten Daten vorhanden.</p>
          : !open ? <button type="button" className="btn-danger" onClick={() => { setOpen(true); setMsg(null) }}>Alle importierten Daten löschen …</button>
          : (
            <div className="rounded-control border border-bad/40 bg-bad-soft/50 p-4">
              <p className="font-medium">Das lässt sich nicht rückgängig machen.</p>
              <p className="mt-1 text-[13px] text-ink-soft">Wenn Sie die Auswertungen behalten möchten, laden Sie sie vorher oben herunter. Zur Bestätigung geben Sie bitte das Wort {WORD} ein.</p>
              <label className="mt-3 block max-w-[260px]"><span className="field-label">Bestätigung</span>
                <input className="input" value={word} onChange={e => setWord(e.target.value)} autoComplete="off" placeholder={WORD} /></label>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="btn bg-bad text-white hover:opacity-90" disabled={busy || word !== WORD} onClick={removeAll}>{busy ? 'Wird gelöscht …' : 'Endgültig löschen'}</button>
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setOpen(false); setWord('') }}>Abbrechen</button>
              </div>
            </div>
          )}
      </Card>
    </>
  )
}
