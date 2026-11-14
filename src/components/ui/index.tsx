// Gemeinsame Bauteile der Oberfläche. Jede Seite verwendet diese Bauteile,
// damit Abstände, Farben und Zustände überall gleich sind.
'use client'
import { useId, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, CircleHelp, Info, Loader2, XCircle } from 'lucide-react'

export const fmtInt = (n: number | null | undefined) => n === null || n === undefined ? '—' : Math.round(n).toLocaleString('de-DE')
export const fmtNum = (n: number | null | undefined, digits = 1) => n === null || n === undefined ? '—' : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits })
export const fmtEur = (n: number | null | undefined, digits = 0) => n === null || n === undefined ? '—' : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' €'
export const fmtPct = (n: number | null | undefined, digits = 1) => n === null || n === undefined ? '—' : n.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits }) + ' %'
export const fmtSigned = (n: number | null | undefined) => n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${n.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
export const fmtDate = (iso: string | null | undefined) => !iso ? '—' : `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`

export function PageHeader({ title, lead, actions }: { title: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="page-title">{title}</h1>
        {lead && <p className="page-lead">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  )
}

export function Card({ title, lead, actions, children, pad = true, className = '' }: { title?: ReactNode; lead?: ReactNode; actions?: ReactNode; children: ReactNode; pad?: boolean; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <div className="card-head">
          <div className="min-w-0">
            {title && <h2 className="section-title">{title}</h2>}
            {lead && <p className="section-lead">{lead}</p>}
          </div>
          {actions}
        </div>
      )}
      <div className={pad ? 'card-pad' : (title ? 'pt-3' : '')}>{children}</div>
    </section>
  )
}

/** Kleine Erklärung zu einer Kennzahl: per Klick/Tastatur, nicht nur beim Überfahren. */
export function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <span className="relative inline-flex align-middle">
      <button type="button" aria-label={`Erklärung: ${label}`} aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(o => !o)} onBlur={() => setOpen(false)} onKeyDown={e => e.key === 'Escape' && setOpen(false)}
        className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-ink-muted hover:text-accent">
        <CircleHelp size={14} aria-hidden />
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute left-1/2 top-6 z-30 w-64 -translate-x-1/2 rounded-control border border-line bg-surface p-3 text-left text-[12.5px] font-normal leading-relaxed text-ink-soft shadow-pop">
          {children}
        </span>
      )}
    </span>
  )
}

/** Kennzahl. value = null zeigt „—“; help erklärt, woraus die Zahl berechnet ist. */
export function Stat({ label, value, sub, help, tone }: { label: string; value: ReactNode; sub?: ReactNode; help?: ReactNode; tone?: 'good' | 'bad' | 'warn' }) {
  const toneClass = tone === 'good' ? 'text-good' : tone === 'bad' ? 'text-bad' : tone === 'warn' ? 'text-warn' : 'text-ink-muted'
  return (
    <div className="card card-pad">
      <div className="flex items-center text-[13px] text-ink-muted">{label}{help && <InfoTip label={label}>{help}</InfoTip>}</div>
      <div className="num mt-1.5 text-[26px] font-semibold leading-8 tracking-tight text-ink">{value ?? '—'}</div>
      {sub && <div className={`mt-1 text-[12.5px] ${toneClass}`}>{sub}</div>}
    </div>
  )
}

export function Notice({ tone = 'info', title, children, action }: { tone?: 'info' | 'warn' | 'bad' | 'good'; title?: string; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : tone === 'bad' ? XCircle : tone === 'good' ? CheckCircle2 : Info
  const color = tone === 'warn' ? 'text-warn' : tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-good' : 'text-accent'
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={18} className={`mt-0.5 shrink-0 ${color}`} aria-hidden />
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        <div className="text-ink-soft">{children}</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  )
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: { href: string; label: string } }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <h2 className="text-[17px] font-semibold">{title}</h2>
      {children && <p className="mt-2 max-w-[52ch] text-ink-soft">{children}</p>}
      {action && <Link href={action.href} className="btn-primary mt-5">{action.label}</Link>}
    </div>
  )
}

export function Spinner({ label = 'Wird geladen' }: { label?: string }) {
  return <span className="inline-flex items-center gap-2 text-ink-muted" role="status"><Loader2 size={16} className="animate-spin" aria-hidden />{label} …</span>
}

/** Ladezustand einer ganzen Seite: Platzhalter in der Form des späteren Inhalts. */
export function PageSkeleton({ stats = 4, blocks = 2 }: { stats?: number; blocks?: number }) {
  return (
    <div className="page" aria-busy="true" aria-label="Seite wird geladen">
      <div className="skeleton h-7 w-56" /><div className="skeleton mt-2 h-4 w-80 max-w-full" />
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: stats }, (_, i) => <div key={i} className="card card-pad"><div className="skeleton h-4 w-24" /><div className="skeleton mt-3 h-7 w-20" /></div>)}</div>
      {Array.from({ length: blocks }, (_, i) => <div key={i} className="card card-pad mt-4"><div className="skeleton h-4 w-40" /><div className="skeleton mt-4 h-32 w-full" /></div>)}
    </div>
  )
}

export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="page">
      <Notice tone="bad" title="Die Daten konnten nicht geladen werden" action={onRetry && <button className="btn-secondary btn-sm" onClick={onRetry}>Erneut versuchen</button>}>{message}</Notice>
    </div>
  )
}

export function ConfidenceBadge({ level }: { level: 'hoch' | 'mittel' | 'niedrig' }) {
  const cls = level === 'hoch' ? 'badge-good' : level === 'mittel' ? 'badge-warn' : 'badge-neutral'
  return <span className={cls}>Sicherheit: {level}</span>
}

/** Veränderung gegenüber dem Vorzeitraum, mit Richtung in Worten (nicht nur Farbe). */
export function Delta({ value, goodWhenUp = true }: { value: number | null | undefined; goodWhenUp?: boolean }) {
  if (value === null || value === undefined) return <span className="text-ink-muted">kein Vergleich</span>
  const up = value > 0, flat = Math.abs(value) < 0.05
  const cls = flat ? 'text-ink-muted' : (up === goodWhenUp ? 'text-good' : 'text-bad')
  return <span className={`num ${cls}`}>{flat ? 'unverändert' : `${fmtSigned(value)} ${up ? 'mehr' : 'weniger'}`}</span>
}

export function SegmentedControl<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label: string }) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-control border border-line-strong bg-surface p-0.5">
      {options.map(o => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={`h-8 rounded-[6px] px-3 text-[13px] font-medium transition-colors ${value === o.value ? 'bg-accent text-white' : 'text-ink-soft hover:bg-sunken'}`}>{o.label}</button>
      ))}
    </div>
  )
}
