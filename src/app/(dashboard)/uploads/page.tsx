'use client'
// Import: neue Datei (mit Vorschau) und Liste der bisherigen Importe.
import { FileUploader } from '@/components/upload/FileUploader'
import { Card, Notice, PageHeader, fmtDate, fmtInt } from '@/components/ui'
import { useAccount, type AccountUpload } from '@/lib/account/use-account'

const STATUS: Record<string, { label: string; cls: string }> = {
  completed: { label: 'Im Bestand', cls: 'badge-good' },
  replaced: { label: 'Ersetzt', cls: 'badge-neutral' },
  processing: { label: 'In Arbeit', cls: 'badge-accent' },
  pending: { label: 'In Arbeit', cls: 'badge-accent' },
  failed: { label: 'Fehlgeschlagen', cls: 'badge-bad' },
}
const MODE: Record<string, string> = { first: 'Erster Import', replace: 'Ersetzt', append: 'Ergänzt' }

export default function UploadsPage() {
  const { data, reload } = useAccount()
  const canImport = !data || data.role !== 'viewer'
  const uploads: AccountUpload[] = data?.uploads || []

  return (
    <div className="page max-w-[980px]">
      <PageHeader title="Import" lead="Bestelldaten aus Kasse oder Bestellsystem einlesen. Vor dem Speichern sehen Sie eine Vorschau." />

      {canImport
        ? <FileUploader onImported={reload} />
        : <Notice tone="info" title="Nur Ansicht">Mit Ihrer Rolle (Betrachter) können Sie Auswertungen ansehen, aber keine Daten importieren. Bitte wenden Sie sich an den Inhaber Ihres Kontos.</Notice>}

      <Card className="mt-8" title="Was die Datei enthalten sollte" lead="Die Spalten werden automatisch erkannt und lassen sich in der Vorschau ändern.">
        <dl className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
          <Hint term="Postleitzahl" need="Pflicht">Fehlt sie, wird sie aus Straße und Ort nur dann ergänzt, wenn das eindeutig ist (Straßenverzeichnis für ganz Deutschland). Sonst wird die Zeile nicht übernommen.</Hint>
          <Hint term="Straße und Hausnummer" need="Empfohlen">Grundlage der Karte und der Straßenauswertung.</Hint>
          <Hint term="Umsatz und Bestelldatum" need="Empfohlen">Für Umsatz, Bestellwert, Entwicklung nach Tagen und Wochen.</Hint>
          <Hint term="Kundennummer" need="Hilfreich">Damit derselbe Kunde über mehrere Importe hinweg einmal zählt.</Hint>
        </dl>
        <p className="mt-4 text-[13px] text-ink-muted">Am genauesten ist eine Datei mit einer Zeile je Bestellung. Namen und E-Mail-Adressen werden nicht benötigt und nicht gespeichert.</p>
      </Card>

      <Card className="mt-4" pad={false} title="Bisherige Importe" lead={uploads.length ? undefined : 'Noch keine Importe.'}>
        {uploads.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Datei</th><th>Importiert am</th><th>Zeitraum der Daten</th><th className="r">Zeilen</th><th>Art</th><th>Stand</th></tr></thead>
              <tbody>{uploads.map(u => {
                const s = STATUS[u.status] || { label: u.status, cls: 'badge-neutral' }
                return (
                  <tr key={u.id}>
                    <td className="max-w-[280px] truncate" title={u.filename}>{u.filename}</td>
                    <td className="num">{fmtDate(u.created_at.slice(0, 10))}</td>
                    <td className="num">{u.period_start ? `${fmtDate(u.period_start)} – ${fmtDate(u.period_end)}` : <span className="text-ink-muted">unbekannt</span>}</td>
                    <td className="r">{fmtInt(u.row_count)}</td>
                    <td>{u.import_mode ? MODE[u.import_mode] || u.import_mode : '—'}</td>
                    <td><span className={s.cls}>{s.label}</span></td>
                  </tr>
                )
              })}</tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}

function Hint({ term, need, children }: { term: string; need: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="flex items-center gap-2 font-medium">{term}<span className="badge-neutral">{need}</span></dt>
      <dd className="mt-0.5 text-[13px] text-ink-soft">{children}</dd>
    </div>
  )
}
