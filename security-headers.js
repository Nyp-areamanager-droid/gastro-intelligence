// Sicherheits-Header für alle Seiten und API-Antworten (Nr. 11).
// Eigene Datei, damit die Tests genau diese Werte prüfen.
//
// Was der Browser laden darf:
//   Skripte/Styles: nur von der eigenen Seite (Next.js braucht 'unsafe-inline'
//     für seine eingebetteten Startskripte; fremde Skriptquellen bleiben gesperrt)
//   Schriften: nur von der eigenen Seite (liegen im Projekt)
//   Bilder: eigene Seite, Kartenkacheln von OpenStreetMap, Leaflet-Symbole von cdnjs
//   Verbindungen: eigene Seite (API-Routen) und das eingestellte Supabase-Projekt
//   Einbetten in fremde Seiten (Clickjacking): verboten
// Supabase: genau das eingestellte Projekt statt aller *.supabase.co-Adressen.
// Ohne Einstellung (z. B. im Test) gilt die allgemeine Supabase-Adresse.
function supabaseSources(url) {
  try {
    const u = new URL(url)
    return [u.origin, u.origin.replace(/^http/, 'ws')]
  } catch {
    return ['https://*.supabase.co', 'wss://*.supabase.co']
  }
}

function buildCsp({ dev = false, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL } = {}) {
  const directives = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'font-src': ["'self'", 'data:'],
    'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org', 'https://cdnjs.cloudflare.com'],
    'connect-src': ["'self'", ...supabaseSources(supabaseUrl), ...(dev ? ['ws:'] : [])],
    'frame-ancestors': ["'none'"],
    'frame-src': ["'none'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
  }
  return Object.entries(directives).map(([k, v]) => `${k} ${v.join(' ')}`).join('; ')
}

function securityHeaders({ dev = false, supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL } = {}) {
  return [
    { key: 'Content-Security-Policy', value: buildCsp({ dev, supabaseUrl }) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ]
}

module.exports = { buildCsp, securityHeaders }
