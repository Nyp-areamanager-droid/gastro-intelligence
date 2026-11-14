import type { Metadata, Viewport } from 'next'
// Schrift liegt im Projekt (kein Abruf bei Google: schneller und ohne
// Übermittlung der IP-Adresse der Nutzer an Dritte)
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import './globals.css'

export const metadata: Metadata = {
  title: { default: 'Gastro Intelligence', template: '%s – Gastro Intelligence' },
  description: 'Liefergebiete verstehen: Bestellungen nach Straße und Postleitzahl auswerten.',
}
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#F5F6F8' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  )
}
