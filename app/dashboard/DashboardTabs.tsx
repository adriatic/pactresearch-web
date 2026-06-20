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
  const [cardSkipped, setCardSkipped] = useState(false)

  const unlocked = isBeta || cardSaved || cardAlreadySaved || cardSkipped

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
        <div style={{ lineHeight: '1.7', color: '#333', maxWidth: '640px' }}>
          <h2 style={{ fontWeight: 'bold', marginBottom: '8px' }}>How Pact Research works</h2>
          <p style={{ marginBottom: '24px' }}>
            PACT produces structured, cite-worthy research documents — not chat responses. Here is what to expect.
          </p>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />

          <h3 style={{ fontWeight: 'bold', marginBottom: '12px' }}>Getting started</h3>
          <p style={{ marginBottom: '12px' }}>You need an account to submit a request. Creating one takes under a minute:</p>
          <ol style={{ paddingLeft: '20px', marginBottom: '24px' }}>
            <li style={{ marginBottom: '6px' }}>Enter your email address on this page</li>
            <li style={{ marginBottom: '6px' }}>Click the link we send you</li>
            <li style={{ marginBottom: '6px' }}>You're in — no password, no forms</li>
          </ol>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />

          <h3 style={{ fontWeight: 'bold', marginBottom: '12px' }}>Submitting a request</h3>
          <p style={{ marginBottom: '12px' }}>
            Go to the <strong>Make a request</strong> tab. A short guided conversation helps sharpen your question before it's submitted. You don't need to arrive with a perfectly formed prompt — the conversation handles that.
          </p>
          <p style={{ marginBottom: '24px' }}>
            A credit or debit card can be saved before submission. It is verified immediately but <strong>not charged until your research is delivered</strong>.
          </p>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />

          <h3 style={{ fontWeight: 'bold', marginBottom: '12px' }}>What happens next</h3>
          <p style={{ marginBottom: '24px' }}>
            Your request is processed using PACT — a structured, multi-step AI research tool that we run and review before delivery. This typically takes <strong>one business day</strong>.
          </p>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />

          <h3 style={{ fontWeight: 'bold', marginBottom: '12px' }}>Delivery</h3>
          <p style={{ marginBottom: '12px' }}>
            Results are delivered as a professionally formatted, signed PDF to your email. Only at this point is your card charged:
          </p>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '24px', fontSize: '14px' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #eee' }}>
                <th style={{ textAlign: 'left', padding: '8px 0', color: '#666', fontWeight: 'normal' }}>Tier</th>
                <th style={{ textAlign: 'left', padding: '8px 0', color: '#666', fontWeight: 'normal' }}>Price</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #eee' }}>
                <td style={{ padding: '8px 0' }}>Standard</td>
                <td style={{ padding: '8px 0' }}>$30</td>
              </tr>
              <tr>
                <td style={{ padding: '8px 0' }}>Economy</td>
                <td style={{ padding: '8px 0' }}>$15</td>
              </tr>
            </tbody>
          </table>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />

          <h3 style={{ fontWeight: 'bold', marginBottom: '12px' }}>Continuing the research</h3>
          <p style={{ marginBottom: '24px' }}>
            Your research notebook is retained. If you want to go deeper on any finding or refine the original question, you can submit a follow-up request that builds on what was already covered.
          </p>

          <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '24px 0' }} />

          <h3 style={{ fontWeight: 'bold', marginBottom: '12px' }}>If something goes wrong</h3>
          <p>
            If we are unable to deliver a satisfactory result, <strong>your card is not charged</strong>. We will contact you by email to explain and offer options.
          </p>
        </div>
      )}

      {tab === 'request' && (
        <div>
          <h2 style={{ fontWeight: 'bold', marginBottom: '16px' }}>Make a request</h2>

          {unlocked ? (
            <div>
              {isBeta && (
                <p style={{ color: '#666', marginBottom: '24px', fontStyle: 'italic' }}>
                  Beta access — no payment required.
                </p>
              )}
              {!isBeta && cardSkipped && !cardSaved && !cardAlreadySaved && (
                <p style={{ color: '#666', marginBottom: '24px', fontStyle: 'italic' }}>
                  Continuing without a saved card. You'll be asked to provide payment details before your research is delivered.
                </p>
              )}
              <IPRChat />
            </div>
          ) : (
            <div style={{ maxWidth: '480px' }}>

              {/* Pricing summary */}
              <div style={{ border: '1px solid #e5e5e5', borderRadius: '10px', padding: '20px', marginBottom: '24px', background: '#fafafa' }}>
                <p style={{ fontSize: '13px', fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 14px' }}>
                  Pricing
                </p>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '14px' }}>
                  <span>Standard research</span>
                  <span style={{ fontWeight: '600' }}>$30</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '14px', fontSize: '14px' }}>
                  <span>Economy research</span>
                  <span style={{ fontWeight: '600' }}>$15</span>
                </div>
                <p style={{ fontSize: '13px', color: '#666', margin: 0, lineHeight: '1.6' }}>
                  Your card is charged only after your research is successfully delivered — never before.
                </p>
              </div>

              <p style={{ color: '#666', marginBottom: '20px', fontSize: '14px' }}>
                Save a payment method now, or continue and add one later — before delivery.
              </p>

              <CardSetup onSuccess={() => setCardSaved(true)} />

              <button
                onClick={() => setCardSkipped(true)}
                style={{
                  marginTop: '16px',
                  background: 'none',
                  border: 'none',
                  color: '#888',
                  fontSize: '13px',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Skip for now — continue without saving a card
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
