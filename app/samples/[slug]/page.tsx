'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import Link from 'next/link'
import { useParams } from 'next/navigation'

interface ProcessStep {
  step: number
  description: string
  screenshot_url: string
}

interface Sample {
  id: string
  slug: string
  domain: string
  title: string
  summary: string
  ipr_screenshot_url: string | null
  pdf_url: string
  pdf_thumbnail_url: string
  process_steps: ProcessStep[]
  view_count: number
  created_at: string
}

function ExpandableImage({ src, alt }: { src: string; alt: string }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <>
      <img
        src={src}
        alt={alt}
        onClick={() => setExpanded(true)}
        style={{
          width: '100%',
          borderRadius: '8px',
          border: '1px solid #e5e5e5',
          cursor: 'zoom-in',
          display: 'block',
        }}
      />
      {expanded && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'zoom-out',
            padding: '24px',
          }}
        >
          <img
            src={src}
            alt={alt}
            style={{
              maxWidth: '90vw',
              maxHeight: '90vh',
              borderRadius: '8px',
              objectFit: 'contain',
            }}
          />
        </div>
      )}
    </>
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

      {/* IPR screenshot */}
      {sample.ipr_screenshot_url && (
        <div style={{ marginBottom: '40px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px', color: '#0a0a0a' }}>
            The research request
          </h2>
          <ExpandableImage src={sample.ipr_screenshot_url} alt="Research request screenshot" />
          <p style={{ marginTop: '8px', fontSize: '12px', color: '#999' }}>Click to expand</p>
        </div>
      )}

      {/* How it was made */}
      {sample.process_steps && sample.process_steps.length > 0 && (
        <div style={{ marginBottom: '40px' }}>
          <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '20px', color: '#0a0a0a' }}>
            How it was made
          </h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
            {sample.process_steps.map((step) => (
              <div key={step.step} style={{ display: 'flex', gap: '16px' }}>
                <div
                  style={{
                    flexShrink: 0,
                    width: '28px',
                    height: '28px',
                    borderRadius: '50%',
                    background: '#0a0a0a',
                    color: '#fff',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '13px',
                    fontWeight: '500',
                    marginTop: '2px',
                  }}
                >
                  {step.step}
                </div>
                <div style={{ flex: 1 }}>
                  <p style={{ fontSize: '14px', color: '#333', lineHeight: '1.6', margin: '0 0 12px' }}>
                    {step.description}
                  </p>
                  {step.screenshot_url && (
                    <ExpandableImage src={step.screenshot_url} alt={`Step ${step.step}`} />
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <hr style={{ border: 'none', borderTop: '1px solid #eee', margin: '32px 0' }} />

      {/* PDF download */}
      <div style={{ marginBottom: '40px' }}>
        <h2 style={{ fontSize: '16px', fontWeight: '600', marginBottom: '16px', color: '#0a0a0a' }}>
          The delivered research
        </h2>
        <a
          href={sample.pdf_url}
          target="_blank"
          rel="noopener noreferrer"
          style={{ textDecoration: 'none', display: 'inline-block' }}
        >
          <div
            style={{
              border: '1px solid #e5e5e5',
              borderRadius: '8px',
              overflow: 'hidden',
              display: 'inline-block',
              transition: 'box-shadow 0.15s ease',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.boxShadow = 'none'
            }}
          >
            <img
              src={sample.pdf_thumbnail_url}
              alt="PDF preview"
              style={{ width: '280px', display: 'block' }}
            />
            <div
              style={{
                padding: '10px 16px',
                background: '#0a0a0a',
                color: '#fff',
                fontSize: '13px',
                fontWeight: '500',
                textAlign: 'center',
              }}
            >
              Download PDF →
            </div>
          </div>
        </a>
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
