import { redirect } from 'next/navigation'

export default function RootPage({
  searchParams,
}: {
  searchParams: { [key: string]: string | string[] | undefined }
}) {
  if (searchParams.code || searchParams.type === 'recovery') {
    const code = typeof searchParams.code === 'string' ? searchParams.code : ''
    redirect(`/auth/reset-password?code=${code}`)
  }
  redirect('/auth/login')
}
