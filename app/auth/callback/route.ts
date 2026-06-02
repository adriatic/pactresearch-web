import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const error = searchParams.get('error')
  const error_description = searchParams.get('error_description')

  console.log('Callback hit:', { code: !!code, error, error_description })
  console.log('Full URL:', request.url)

  if (code) {
    const supabase = await createClient()
    const { data, error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)
    console.log('Exchange result:', { user: data?.user?.email, error: exchangeError })
  }

  return NextResponse.redirect(`${origin}/dashboard`)
}