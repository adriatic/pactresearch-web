import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import DashboardTabs from './DashboardTabs'

interface DashboardPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

export default async function DashboardPage({ searchParams }: DashboardPageProps) {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()

  if (!user || error) {
    redirect('/logout')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_beta, stripe_customer_id')
    .eq('id', user!.id)
    .single()

  const isBeta = profile?.is_beta ?? false
  const params = await searchParams
  const cardJustSaved = params?.card === 'saved'
  const hasStripeCustomer = !!profile?.stripe_customer_id

  return (
    <main style={{ maxWidth: '700px', margin: '60px auto', fontFamily: 'sans-serif', padding: '0 24px' }}>
      <h1 style={{ fontWeight: 'bold', marginBottom: '8px' }}>PACT Research Service</h1>

      <p style={{ color: '#666', marginBottom: '32px' }}>
        Welcome, {user!.email} — <a href="/logout" style={{ color: '#999', fontSize: '14px' }}>Sign out</a>
      </p>      <DashboardTabs isBeta={isBeta} cardAlreadySaved={cardJustSaved || hasStripeCustomer} />
    </main>
  )
}
