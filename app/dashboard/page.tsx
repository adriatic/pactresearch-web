import { createClient } from '@/utils/supabase/server'
import { redirect } from 'next/navigation'
import DashboardTabs from './DashboardTabs'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('is_beta')
    .eq('id', user!.id)
    .single()

  const isBeta = profile?.is_beta ?? false

  return (
    <main style={{ maxWidth: '700px', margin: '60px auto', fontFamily: 'sans-serif', padding: '0 24px' }}>
      <h1 style={{ fontWeight: 'bold', marginBottom: '8px' }}>PACT Research Service</h1>
      <p style={{ color: '#666', marginBottom: '32px' }}>Welcome, {user!.email}</p>
      <DashboardTabs isBeta={isBeta} />
    </main>
  )
}