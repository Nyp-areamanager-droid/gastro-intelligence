import type { Metadata } from 'next'
import { DM_Sans, DM_Mono, Syne } from 'next/font/google'
import './globals.css'

const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' })
const dmMono = DM_Mono({ subsets: ['latin'], weight: ['400','500'], variable: '--font-dm-mono' })
const syne   = Syne({ subsets: ['latin'], weight: ['700','800'], variable: '--font-syne' })

export const metadata: Metadata = {
  title: 'Gastro Intelligence Platform',
  description: 'Deutschlandweite Analyse-Plattform für Gastronomie & Lieferdienste',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de" className="dark">
      <body className={`${dmSans.variable} ${dmMono.variable} ${syne.variable} font-sans bg-brand-dark text-white antialiased`}>
        {children}
      </body>
    </html>
  )
}
