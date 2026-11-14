// Texte aus fremden Quellen (OpenStreetMap, hochgeladene Dateien, URL)
// werden in Leaflet-Popups als HTML eingesetzt. Ohne Maskierung könnte ein
// Eintrag wie <img src=x onerror=…> im Browser des Nutzers Code ausführen.
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

export function poiPopupHtml(poi: { name?: unknown; category?: unknown; is_competitor?: unknown }): string {
  return `<b>${escapeHtml(poi.name)}</b><br>${escapeHtml(poi.category)}` +
    (poi.is_competitor ? '<br><b style="color:#7c6dfa">⚡ Wettbewerber</b>' : '')
}
