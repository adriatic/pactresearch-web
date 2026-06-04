'use client'

import { useState, useEffect } from 'react'
import { loadStripe } from '@stripe/stripe-js'
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js'

const stripePromise = loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY!)

function CardForm({ onSuccess }: { onSuccess: () => void }) {
  const stripe = useStripe()
  const elements = useElements()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!stripe || !elements) return

    setLoading(true)
    setError(null)

    const { error } = await stripe.confirmSetup({
      elements,
      confirmParams: {
        return_url: `${window.location.origin}/dashboard?card=saved`,
      },
    })

    if (error) {
      setError(error.message ?? 'Something went wrong')
      setLoading(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <PaymentElement />
      {error && <p style={{ color: 'red', fontSize: '14px' }}>{error}</p>}
      <button
        type="submit"
        disabled={loading || !stripe}
        style={{ padding: '12px', fontSize: '16px', borderRadius: '6px', background: '#000', color: '#fff', border: 'none', cursor: 'pointer' }}
      >
        {loading ? 'Saving...' : 'Save card'}
      </button>
    </form>
  )
}

export default function CardSetup({ onSuccess }: { onSuccess: () => void }) {
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const [fetchError, setFetchError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    fetch('/api/stripe/setup-intent', { method: 'POST' })
      .then(res => res.json())
      .then(data => {
        if (!cancelled) {
          if (data.clientSecret) {
            setClientSecret(data.clientSecret)
          } else {
            setFetchError('Could not initialize payment form.')
          }
        }
      })
      .catch(() => {
        if (!cancelled) setFetchError('Could not connect to payment service.')
      })

    return () => { cancelled = true }
  }, [])

  if (fetchError) {
    return <p style={{ color: 'red' }}>{fetchError}</p>
  }

  if (!clientSecret) {
    return <p style={{ color: '#666' }}>Loading payment form...</p>
  }

  return (
    <Elements stripe={stripePromise} options={{ clientSecret }}>
      <CardForm onSuccess={onSuccess} />
    </Elements>
  )
}
