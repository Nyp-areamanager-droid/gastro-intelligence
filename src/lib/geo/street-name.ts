// =============================================================================
// Einheitliche Normalisierung von Straßennamen
//
// Einzige Stelle im Projekt, die festlegt, wann zwei Schreibweisen dieselbe
// Straße sind. Genutzt von: Import (engine.ts), Straßenverzeichnis
// (providers), Straßen-Cache (streets.name_normalized), Karte (AnalysisMap).
//
// Der Schlüssel ist nur zum Vergleichen da, nie zur Anzeige.
// =============================================================================

const UMLAUTS: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }

/**
 * Entfernt eine Hausnummer am Ende, z. B. "12", "12a", "12 a", "12-14",
 * "12/14", "12a-c". Zahlen mitten im Namen bleiben erhalten
 * ("Straße des 17. Juni").
 */
export function stripHouseNumber(raw: string): string {
  return raw
    .trim()
    .replace(/[\s,]+\d+\s*[a-z]?(\s*[-/]\s*\d*\s*[a-z]?)?\s*$/i, '')
    .trim()
}

/**
 * Vergleichsschlüssel für einen reinen Straßennamen OHNE Hausnummer,
 * z. B. aus einem Straßenverzeichnis. Zahlen bleiben erhalten, denn es gibt
 * echte Namen wie "Weg 2" oder "An der B 5" (rund 0,1 % der Einträge in
 * OpenPLZ).
 *
 * - Groß/klein, Umlaute (ä/ae), ß/ss werden gleich behandelt
 * - "Straße", "Strasse", "Str." → "str"; "Platz", "Pl." → "pl"
 * - "Sankt" → "st"
 * - Leerzeichen, Punkte, Bindestriche, Apostrophe fallen weg
 */
export function streetNameKey(name: string): string {
  if (!name) return ''
  let s = name.normalize('NFC').trim().toLowerCase()
  s = s.replace(/[äöüß]/g, ch => UMLAUTS[ch])
  s = s
    .replace(/strasse\b|str\b\.?/g, 'str')
    .replace(/\bplatz\b|\bpl\b\.?/g, 'pl')
    .replace(/gasse\b/g, 'g')
    .replace(/\bsankt\b/g, 'st')
  return s.replace(/[\s.\-'’´`,]+/g, '')
}

/**
 * Vergleichsschlüssel für eine Adresseingabe, die eine Hausnummer enthalten
 * kann (Kundendaten). Die Hausnummer am Ende wird entfernt.
 */
export function normalizeStreetName(raw: string): string {
  if (!raw) return ''
  return streetNameKey(stripHouseNumber(raw))
}

/**
 * Schlüssel einer Adresseingabe gegen ein Verzeichnis auflösen.
 * Zuerst ohne Hausnummer ("Neusser Str. 12" → "neusserstr"). Gibt es den
 * nicht, aber den vollen Namen ("Weg 2" → "weg2"), gilt der volle Name.
 */
export function resolveStreetKey(raw: string, directoryKeys: Set<string>): string {
  const stripped = normalizeStreetName(raw)
  if (directoryKeys.has(stripped)) return stripped
  const full = streetNameKey(raw)
  if (full && directoryKeys.has(full)) return full
  return stripped
}

/** Gleiche Straße? Kurzform für normalizeStreetName(a) === normalizeStreetName(b). */
export function isSameStreet(a: string, b: string): boolean {
  const ka = normalizeStreetName(a)
  return ka !== '' && ka === normalizeStreetName(b)
}
