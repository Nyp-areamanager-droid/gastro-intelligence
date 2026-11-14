'use client'
// Zeitraum-Auswahl für die Übersicht. Die Vorgaben beziehen sich auf das
// letzte Datum in den Daten (nicht auf „heute“), damit auch ältere Importe
// sinnvoll gefiltert werden.
import type { OverviewResponse } from '@/lib/insights/use-overview'

const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember']

export function RangePicker({ info, value, onChange }: { info: OverviewResponse['range']; value: { from: string; to: string } | null; onChange: (v: { from: string; to: string } | null) => void }) {
  const { start, end } = info.available
  if (!start || !end) return null
  const options: { key: string; label: string; from: string; to: string }[] = [
    { key: 'd28', label: 'Letzte 4 Wochen der Daten', from: addDays(end, -27) < start ? start : addDays(end, -27), to: end },
    { key: 'd84', label: 'Letzte 12 Wochen der Daten', from: addDays(end, -83) < start ? start : addDays(end, -83), to: end },
  ]
  // jeder Kalendermonat im Datenzeitraum
  let y = +start.slice(0, 4), m = +start.slice(5, 7)
  const months: typeof options = []
  while (`${y}-${String(m).padStart(2, '0')}` <= end.slice(0, 7) && months.length < 36) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`, last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    months.push({ key: first.slice(0, 7), label: `${MONTHS[m - 1]} ${y}`, from: first < start ? start : first, to: last > end ? end : last })
    m++; if (m > 12) { m = 1; y++ }
  }
  const all = [...options, ...months.reverse()]
  const current = value ? all.find(o => o.from === value.from && o.to === value.to)?.key ?? 'custom' : ''
  return (
    <select aria-label="Zeitraum" className="input h-9 w-auto" value={current}
      onChange={e => { const o = all.find(x => x.key === e.target.value); onChange(o ? { from: o.from, to: o.to } : null) }}>
      <option value="">Gesamter Zeitraum</option>
      {all.map(o => <option key={o.key} value={o.key}>{o.label}</option>)}
    </select>
  )
}
