/** @type {import('next').NextConfig} */
const nextConfig = {
  // TODO: Remove once Supabase query types are fully annotated (P1 task)
  typescript: {
    ignoreBuildErrors: true,
  },
}

module.exports = nextConfig
