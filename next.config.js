const { securityHeaders } = require('./security-headers')

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Kein „X-Powered-By: Next.js“ (verrät die eingesetzte Software)
  poweredByHeader: false,
  // Die App nutzt keine Bildoptimierung (kein next/image). Abschalten schließt
  // den Endpunkt /_next/image, auf den sich mehrere Next.js-Lücken beziehen.
  images: { unoptimized: true },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders({ dev: process.env.NODE_ENV !== 'production' }) }]
  },
}

module.exports = nextConfig
