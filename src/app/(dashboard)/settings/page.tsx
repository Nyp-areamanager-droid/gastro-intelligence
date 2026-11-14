'use client'
// Einstellungen: Konto, Firma, Rollen, Standorte, Datenmenge, Exporte.
import { Card, LoadError, PageHeader, PageSkeleton, fmtDate, fmtInt } from '@/components/ui'
import { ROLE_LABELS, useAccount } from '@/lib/account/use-account'
import { DataControls } from '@/components/settings/DataControls'

const ROLE_ORDER = ['owner', 'admin', 'manager', 'viewer']

export default function SettingsPage() {
  const { data, error, loading, reload } = useAccount()
  if (loading && !data) return <PageSkeleton stats={0} blocks={3} />
  if (error || !data) return <LoadError message={error || 'Keine Antwort'} onRetry={reload} />
  const myRole = ROLE_LABELS[data.role]

  return (
    <div className="page max-w-[980px]">
      <PageHeader title="Einstellungen" lead="Konto, Unternehmen, Zugriffsrechte und Ihre Daten." />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Ihr Konto">
          <dl className="space-y-3">
            <Row label="E-Mail-Adresse">{data.user.email}</Row>
            <Row label="Ihre Rolle">{myRole?.label || data.role}<span className="block text-[13px] text-ink-muted">{myRole?.can}</span></Row>
          </dl>
          <a href="/auth/forgot-password" className="btn-secondary btn-sm mt-4">Passwort ändern</a>
        </Card>
        <Card title="Unternehmen">
          <dl className="space-y-3">
            <Row label="Name">{data.company.name}</Row>
            <Row label="Konto seit">{fmtDate(data.company.created_at?.slice(0, 10))}</Row>
            <Row label="Datenmenge">{fmtInt(data.usage.records)} Datensätze in {fmtInt(data.usage.postal_codes)} Postleitzahlen aus {fmtInt(data.usage.imports)} {data.usage.imports === 1 ? 'Import' : 'Importen'}</Row>
          </dl>
        </Card>
      </div>

      <Card className="mt-4" pad={false} title="Nutzer und Rollen" lead={`${fmtInt(data.members.total)} ${data.members.total === 1 ? 'Nutzer hat' : 'Nutzer haben'} Zugriff auf dieses Unternehmen. Jeder Nutzer sieht ausschließlich die Daten dieses Unternehmens.`}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Rolle</th><th>Darf</th><th className="r">Nutzer</th></tr></thead>
            <tbody>{ROLE_ORDER.map(r => (
              <tr key={r}><td className="font-medium">{ROLE_LABELS[r].label}{r === data.role && <span className="badge-accent ml-2">Sie</span>}</td><td className="text-ink-soft">{ROLE_LABELS[r].can}</td><td className="r">{fmtInt(data.members.by_role[r] || 0)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <p className="px-4 py-3 text-[13px] text-ink-muted sm:px-5">Weitere Nutzer einladen ist noch nicht in der Oberfläche möglich. Bitte wenden Sie sich an uns, wir richten den Zugang ein.</p>
      </Card>

      <Card className="mt-4" pad={false} title="Standorte" lead={data.stores.length ? 'Ab zwei Standorten erscheint in der Übersicht eine Auswahl.' : undefined}>
        {data.stores.length ? (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Ort</th><th>PLZ</th><th>Stand</th></tr></thead>
              <tbody>{data.stores.map(s => <tr key={s.id}><td className="font-medium">{s.name}</td><td>{s.city || '—'}</td><td className="num">{s.postal_code || '—'}</td><td><span className={s.is_active ? 'badge-good' : 'badge-neutral'}>{s.is_active ? 'Aktiv' : 'Inaktiv'}</span></td></tr>)}</tbody>
            </table>
          </div>
        ) : <p className="px-4 pb-4 text-ink-soft sm:px-5 sm:pb-5">Es ist kein einzelner Standort angelegt. Alle Importe zählen für das gesamte Unternehmen.</p>}
      </Card>

      <DataControls role={data.role} hasData={data.usage.records > 0} onChanged={reload} />
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-[13px] text-ink-muted">{label}</dt><dd className="mt-0.5">{children}</dd></div>
}
