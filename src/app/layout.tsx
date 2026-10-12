import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Gastro Intelligence Platform',
  description: 'Deutschlandweite Analyse-Plattform für Gastronomie & Lieferdienste',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@100..1000&family=DM+Mono:wght@400;500&family=Syne:wght@700;800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="font-sans bg-brand-dark text-white antialiased">
        {children}
      </body>
    </html>
  )
}
