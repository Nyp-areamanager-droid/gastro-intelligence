'use client'
import { useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { ConfidenceBadge } from '@/components/ui'
import type { Recommendation } from '@/lib/insights/recommendations'

const PRIORITY: Record<number, { label: string; cls: string }> = {
  1: { label: 'Zuerst ansehen', cls: 'badge-bad' },
  2: { label: 'Prüfen', cls: 'badge-warn' },
  3: { label: 'Zur Kenntnis', cls: 'badge-neutral' },
}

/**
 * Eine Empfehlung mit den fünf Angaben: Feststellung, Zahlen dahinter,
 * Bedeutung, mögliche Maßnahme, Sicherheit der Aussage.
 */
export function RecommendationCard({ rec, defaultOpen = false, compact = false }: { rec: Recommendation; defaultOpen?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  const p = PRIORITY[rec.priority]
  return (
    <article className="card">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex w-full items-start gap-3 p-4 text-left sm:p-5">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-1.5"><span className={p.cls}>{p.label}</span><ConfidenceBadge level={rec.confidence.level} /></div>
          <h3 className="text-[15px] font-semibold leading-snug">{rec.title}</h3>
          <p className="mt-1 text-ink-soft">{rec.finding}</p>
        </div>
        <ChevronDown size={18} aria-hidden className={`mt-1 shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-line px-4 pb-4 pt-3 sm:px-5 sm:pb-5">
          <dl className={`grid gap-x-8 gap-y-4 ${compact ? '' : 'md:grid-cols-2'}`}>
            <div className={compact ? '' : 'md:col-span-2'}>
              <dt className="text-[12.5px] font-medium text-ink-muted">Zahlen dahinter</dt>
              <dd className="mt-1"><ul className="list-disc space-y-1 pl-5 text-ink-soft">{rec.evidence.map((e, i) => <li key={i} className="num">{e}</li>)}</ul></dd>
            </div>
            <div><dt className="text-[12.5px] font-medium text-ink-muted">Warum das wichtig ist</dt><dd className="mt-1 text-ink-soft">{rec.relevance}</dd></div>
            <div><dt className="text-[12.5px] font-medium text-ink-muted">Was Sie tun können</dt><dd className="mt-1 text-ink">{rec.action}</dd></div>
            <div className={compact ? '' : 'md:col-span-2'}><dt className="text-[12.5px] font-medium text-ink-muted">Wie sicher ist das?</dt><dd className="mt-1 text-ink-soft"><span className="font-medium capitalize text-ink">{rec.confidence.level}.</span> {rec.confidence.reason}</dd></div>
          </dl>
          {rec.postal_codes.length > 0 && rec.kind !== 'data_gap' && (
            <div className="mt-4 flex flex-wrap gap-2">
              {rec.postal_codes.slice(0, 3).map(plz => <Link key={plz} href={`/streets?plz=${plz}`} className="btn-secondary btn-sm">PLZ {plz} auf der Karte</Link>)}
            </div>
          )}
        </div>
      )}
    </article>
  )
}
