import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { setupIntentId } = await request.json()

    if (!setupIntentId) {
      return NextResponse.json({ error: 'Missing setupIntentId' }, { status: 400 })
    }

    const setupIntent = await stripe.setupIntents.retrieve(setupIntentId)

    if (setupIntent.status !== 'succeeded') {
      return NextResponse.json({ error: 'SetupIntent not succeeded' }, { status: 400 })
    }

    const customerId = setupIntent.customer as string

    await supabase
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', user.id)

    console.log('save-customer: saved', customerId, 'for', user.email)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('save-customer error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
