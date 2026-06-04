import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'
import Stripe from 'stripe'

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!)

export async function POST() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      console.log('setup-intent: no user')
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    console.log('setup-intent: user', user.email)

    // Get or create Stripe customer
    let customerId: string

    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single()

    console.log('setup-intent: profile', profile, 'error', profileError)

    if (profile?.stripe_customer_id) {
      customerId = profile.stripe_customer_id
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
      })
      customerId = customer.id
      console.log('setup-intent: created customer', customerId)

      await supabase
        .from('profiles')
        .update({ stripe_customer_id: customerId })
        .eq('id', user.id)
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    })

    console.log('setup-intent: created setupIntent', setupIntent.id)

    return NextResponse.json({ clientSecret: setupIntent.client_secret })
  } catch (err) {
    console.error('setup-intent error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
