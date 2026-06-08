'use client'

import { useState } from 'react'
import CardSetup from './CardSetup'
import IPRChat from './IPRChat'

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '10px 24px',
  fontSize: '15px',
  fontWeight: active ? 'bold' : 'normal',
  background: 'none',
  border: 'none',
  borderBottom: active ? '2px solid #000' : '2px solid transparent',
  cursor: 'pointer',
  color: active ? '#000' : '#666',
})
export default function DashboardTabs({ isBeta, cardAlreadySaved }: { isBeta: boolean, cardAlreadySaved: boolean }) {
  const [tab, setTab] = useState<'how' | 'request'>('how')
  const [cardSaved, setCardSaved] = useState(false)

  return (
    <div>
      <div style={{ display: 'flex', borderBottom: '1px solid #eee', marginBottom: '32px' }}>
        <button style={tabStyle(tab === 'how')} onClick={() => setTab('how')}>
          How it works
        </button>
        <button style={tabStyle(tab === 'request')} onClick={() => setTab('request')}>
          Make a request
        </button>
      </div>

      {tab === 'how' && (
        <div style={{ lineHeight: '1.7', color: '#333' }}>
          <h2 style={{ fontWeight: 'bold', marginBottom: '16px' }}>How the PACT Research Service works</h2>
          <p>PACT is a structured AI research tool that produces thorough, cite-worthy analysis — not a chat response. Here is what to expect when you submit a request.</p>
          <h3 style={{ marginTop: '28px', marginBottom: '8px' }}>1. Submit your research question</h3>
          <p>Go to the <strong>Make a request</strong> tab. Describe your research question and provide any relevant context. The more specific you are, the more useful the result.</p>
          <h3 style={{ marginTop: '28px', marginBottom: '8px' }}>2. Your card is required before submission</h3>
          <p>You will be asked to enter a credit or debit card on the <strong>Make a request</strong> tab. Your card is verified immediately but <strong>not charged</strong> until your research is successfully delivered.</p>
          <h3 style={{ marginTop: '28px', marginBottom: '8px' }}>3. We run the research</h3>
          <p>Your request is processed using PACT on our end. A structured multi-step research session is conducted and reviewed before delivery. This typically takes one business day.</p>
          <h3 style={{ marginTop: '28px', marginBottom: '8px' }}>4. You receive a PDF</h3>
          <p>The results are delivered as a professionally formatted PDF to your delivery email. Only at this point is your card charged — $30 for Standard or $15 for Economy.</p>
          <h3 style={{ marginTop: '28px', marginBottom: '8px' }}>5. Continue the research</h3>
          <p>Your research notebook is retained on our end. If you want to go deeper on any finding, you can submit a follow-up request referencing your original.</p>
          <h3 style={{ marginTop: '28px', marginBottom: '8px' }}>If something goes wrong</h3>
          <p>If we are unable to deliver a satisfactory result, your card is not charged. We will contact you by email to explain and offer options.</p>
        </div>
      )}

      {tab === 'request' && (
        <div>
          <h2 style={{ fontWeight: 'bold', marginBottom: '16px' }}>Make a request</h2>

          {isBeta || cardSaved || cardAlreadySaved ? (
            <div>
              {isBeta && (
                <p style={{ color: '#666', marginBottom: '24px', fontStyle: 'italic' }}>
                  Beta access — no payment required.
                </p>
              )}
              <IPRChat />
            </div>
          ) : (
            <div>
              <p style={{ color: '#666', marginBottom: '24px' }}>
                Before submitting a research request, please save a payment method.
                Your card will not be charged until your research is successfully delivered.
              </p>
              <CardSetup onSuccess={() => setCardSaved(true)} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
