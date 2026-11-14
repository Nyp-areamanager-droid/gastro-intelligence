import { redirect } from 'next/navigation'

export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const params = await searchParams
  if (params.code || params.type === 'recovery') {
    const code = typeof params.code === 'string' ? params.code : ''
    redirect(`/auth/reset-password?code=${encodeURIComponent(code)}`)
  }
  redirect('/auth/login')
}
