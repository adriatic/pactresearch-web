'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { useParams } from 'next/navigation'

interface ConversationTurn {
  role: 'assistant' | 'user'
  content: string
}

interface Sample {
  id: string
  slug: string
  domain: string
  title: string
  summary: string
  ipr_conversation: ConversationTurn[]
  refined_question: string
  refined_context: string
  pdf_url: string
  view_count: number
  created_at: string
}

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: '3px 8px',
        fontSize: '11px',
        color: copied ? '#4a4a4a' : '#999',
        background: copied ? '#e8e8e8' : 'transparent',
        border: '1px solid #e0e0e0',
        borderRadius: '4px',
        cursor: 'pointer',
        marginTop: '6px',
        transition: 'all 0.15s ease',
      }}
    >
      <CopyIcon />
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export default function SampleDetailPage() {
  const params = useParams()
  const slug = params.slug as string
  const [sample, setSample] = useState<Sample | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    async function load() {
      const supabase = createClient()

      const { data, error } = await supabase
        .from('samples')
        .select('*')
        .eq('slug', slug)
        .eq('published', true)
        .single()

      if (error || !data) {
        setError(true)
        setLoading(false)
        return
      }

      setSample(data as Sample)
      setLoading(false)

      // Increment view count
      await supabase
        .from('samples')
        .update({ view_count: (data.view_count ?? 0) + 1 })
        .eq('id', data.id)
    }

    load()
  }, [slug])

  if (loading) {
    return (
      <main style={{ maxWidth: '760px', margin: '0 auto', padding: '48px 24px' }}>
        <p style={{ color: '#999', fontSize: '14px' }}>Loading...</p>
      </main>
    )
  }

  if (error || !sample) {
    return (
      <main style={{ maxWidth: '760px', margin: '0 auto', padding: '48px 24px' }}>
        <Link href="/samples" style={{ fontSize: '14px', color: '#666', textDecoration: 'none' }}>
          ← Back to samples
        </Link>
        <p style={{ marginTop: '32px', color: '#666', fontSize: '14px' }}>
          Sample not found.
        </p>
      </main>
    )
  }

  return (
    <main style={{ maxWidth: '760px', margin: '0 auto', padding: '48px 24px' }}>

      {/* Back link */}
      <Link href="/samples" style={{ fontSize: '14px', color: '#666', textDecoration: 'none' }}>
        ← Back to samples
      </Link>

      {/* Domain badge + title */}
      <div style={{ marginTop: '24px', marginBottom: '32px' }}>
        <span
          style={{
            display: 'inline-block',
            padding: '3px 10px',
            fontSize: '11px',
            fontWeight: '500',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            background: '#f0f0f0',
            borderRadius: '20px',
            color: '#555',
            marginBottom: '12px',
          }}
        >
          {sample.domain}
        </span>
        <h1 style={{ fontSize: '24px', fontWeight: '600', lineHeight: '1.4', color: '#0a0a0a', margin: 0 }}>
          {sample.title}
        </h1>
        <p style={{ marginTop: '12px', fontSize: '15px', color: '#666', lineHeight: '1.6' }}>
          {sample.summary}
        </p>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '32px 0' }} />

      {/* IPR Conversation */}
      {sample.ipr_conversation && sample.ipr_conversation.length > 0 && (
        <div style={{ marginBottom: '40px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px', color: '#0a0a0a' }}>
            How this research request was formed
          </h2>
          <p style={{ fontSize: '13px', color: '#999', marginBottom: '20px', lineHeight: '1.5' }}>
            Each research request starts with a short conversation that sharpens the question before submission.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {sample.ipr_conversation.map((turn, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: turn.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                {/* Role label */}
                <span style={{
                  fontSize: '11px',
                  color: '#aaa',
                  marginBottom: '4px',
                  letterSpacing: '0.03em',
                }}>
                  {turn.role === 'assistant' ? 'Research Assistant' : 'You'}
                </span>

                {/* Bubble */}
                <div
                  style={{
                    maxWidth: '85%',
                    background: turn.role === 'user' ? '#0a0a0a' : '#f0f0f0',
                    color: turn.role === 'user' ? '#fff' : '#333',
                    borderRadius: '12px',
                    padding: '10px 14px',
                    fontSize: '14px',
                    lineHeight: '1.6',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {turn.content}
                </div>

                {/* Copy button — user messages only */}
                {turn.role === 'user' && (
                  <CopyButton text={turn.content} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '32px 0' }} />

      {/* Refined research request — read only */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px', color: '#0a0a0a' }}>
          The refined research request
        </h2>
        <p style={{ fontSize: '13px', color: '#999', marginBottom: '20px', lineHeight: '1.5' }}>
          After the conversation, the question and context are refined and submitted for research.
        </p>

        <div style={{ border: '1px solid #e5e5e5', borderRadius: '10px', padding: '20px', background: '#fafafa', display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <div>
            <p style={{ fontSize: '12px', fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 6px' }}>
              Research question
            </p>
            <p style={{ fontSize: '15px', color: '#0a0a0a', lineHeight: '1.6', margin: 0 }}>
              {sample.refined_question}
            </p>
          </div>
          <div>
            <p style={{ fontSize: '12px', fontWeight: '600', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', margin: '0 0 6px' }}>
              Context
            </p>
            <p style={{ fontSize: '15px', color: '#0a0a0a', lineHeight: '1.6', margin: 0 }}>
              {sample.refined_context}
            </p>
          </div>
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '32px 0' }} />

      {/* Research findings link */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '8px', color: '#0a0a0a' }}>
          The delivered research
        </h2>

        <a
          href={sample.pdf_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '15px',
            fontWeight: '500',
            color: '#0a0a0a',
            textDecoration: 'none',
            borderBottom: '1px solid #0a0a0a',
            paddingBottom: '1px',
          }}
        >
          Read the research findings →
        </a>

        {/* Continuation note */}
        <div style={{
          marginTop: '20px',
          padding: '16px',
          background: '#f8f8f8',
          borderRadius: '8px',
          borderLeft: '3px solid #ddd',
        }}>
          <p style={{ fontSize: '13px', color: '#555', lineHeight: '1.7', margin: 0 }}>
            This document covers sections 1–3 in full, reaching into section 4 within PACT's standard session window. The Table of Contents shows the full research scope — a follow-up request can continue from any section by name, picking up exactly where this left off. <strong>Follow-up requests are coming soon.</strong>
          </p>
        </div>
      </div>

      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '32px 0' }} />

      {/* CTA */}
      <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
        <p style={{ fontSize: '15px', color: '#666', marginBottom: '16px' }}>
          Ready to research something like this?
        </p>
        <a
          href="https://app.pactresearch.net/login"
          style={{
            display: 'inline-block',
            background: '#0a0a0a',
            color: '#fff',
            padding: '12px 32px',
            borderRadius: '8px',
            fontSize: '15px',
            fontWeight: '500',
            textDecoration: 'none',
          }}
        >
          Research like this →
        </a>
      </div>

    </main>
  )
}
