// Farbstufen der Karte für „Bestellungen“ und „Umsatz“ (ohne Browser testbar).
// Fünf Stufen von hell nach dunkel in der Akzentfarbe.
export const INTENSITY = ['#B9CBEA', '#8FAADB', '#5F84C8', '#3862AE', '#173A7A']

/** Grenzen der fünf Stufen: etwa gleich viele Straßen je Stufe (Quintile der Werte > 0). */
export function intensityBreaks(values: number[]): number[] {
  const v = values.filter(x => x > 0).sort((a, b) => a - b)
  if (!v.length) return []
  const raw = [0.2, 0.4, 0.6, 0.8].map(q => v[Math.min(v.length - 1, Math.floor(q * v.length))])
  return [...new Set(raw)]           // gleiche Grenzen (wenige verschiedene Werte) nur einmal
}

/** Stufe 0–4 für einen Wert. */
export function intensityStep(value: number, breaks: number[]): number {
  let i = 0
  while (i < breaks.length && value >= breaks[i]) i++
  // bei weniger als vier Grenzen die Stufen über die ganze Skala verteilen
  return breaks.length >= 4 ? i : Math.round(i * (INTENSITY.length - 1) / Math.max(1, breaks.length))
}
