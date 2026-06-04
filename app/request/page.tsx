'use client'

import { useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { useRouter } from 'next/navigation'

export default function RequestPage() {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    research_question: '',
    context: '',
    model_tier: 'standard',
    delivery_email: '',
  })

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)

    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      router.push('/login')
      return
    }

    const { data: requestData, error } = await supabase.from('requests').insert({
      user_id: user.id,
      research_question: form.research_question,
      context: form.context,
      model_tier: form.model_tier,
      delivery_email: form.delivery_email || user.email,
    }).select('id').single()

    if (error || !requestData) {
      console.error(error)
      setLoading(false)
      return
    }

    // Send confirmation emails
    await fetch('/api/email/send-confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requestData.id,
        researchQuestion: form.research_question,
        context: form.context,
        modelTier: form.model_tier,
        deliveryEmail: form.delivery_email || user.email,
      }),
    })

    router.push('/dashboard?submitted=true')
  }

  return (
    <main style={{ maxWidth: '600px', margin: '60px auto', fontFamily: 'sans-serif', padding: '0 24px' }}>
      <h1 style={{ fontWeight: 'bold', marginBottom: '16px' }}>Submit a Research Request</h1>
      <p style={{ color: '#666' }}>
        Describe your research question. You will receive a confirmation email shortly,
        and your PDF results within one business day. Payment is collected only after
        successful delivery.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginTop: '32px' }}>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="research_question"><strong>Research question</strong></label>
          <textarea
            id="research_question"
            name="research_question"
            value={form.research_question}
            onChange={handleChange}
            required
            rows={4}
            placeholder="What would you like PACT to research?"
            style={{ padding: '10px', fontSize: '16px', borderRadius: '6px', border: '1px solid #ccc', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="context"><strong>Context</strong> <span style={{ color: '#999', fontWeight: 'normal' }}>(optional)</span></label>
          <textarea
            id="context"
            name="context"
            value={form.context}
            onChange={handleChange}
            rows={3}
            placeholder="Any background information that would help the researcher..."
            style={{ padding: '10px', fontSize: '16px', borderRadius: '6px', border: '1px solid #ccc', resize: 'vertical' }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="model_tier"><strong>Research depth</strong></label>
          <select
            id="model_tier"
            name="model_tier"
            value={form.model_tier}
            onChange={handleChange}
            style={{ padding: '10px', fontSize: '16px', borderRadius: '6px', border: '1px solid #ccc' }}
          >
            <option value="standard">Standard — thorough analysis ($30)</option>
            <option value="economy">Economy — focused overview ($15)</option>
          </select>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <label htmlFor="delivery_email"><strong>Delivery email</strong> <span style={{ color: '#999', fontWeight: 'normal' }}>(leave blank to use your login email)</span></label>
          <input
            id="delivery_email"
            name="delivery_email"
            type="email"
            value={form.delivery_email}
            onChange={handleChange}
            placeholder="your@email.com"
            style={{ padding: '10px', fontSize: '16px', borderRadius: '6px', border: '1px solid #ccc' }}
          />
        </div>

        <button
          type="submit"
          disabled={loading}
          style={{ padding: '14px', fontSize: '16px', borderRadius: '6px', background: '#000', color: '#fff', border: 'none', cursor: 'pointer', marginTop: '8px' }}
        >
          {loading ? 'Submitting...' : 'Submit request'}
        </button>

      </form>
    </main>
  )
}
