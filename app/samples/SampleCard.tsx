'use client'

import Link from 'next/link'

export interface Sample {
  id: string
  slug: string
  domain: string
  title: string
  summary: string
  ipr_screenshot_url: string | null
  pdf_thumbnail_url: string
  view_count: number
  created_at: string
}

export default function SampleCard({ sample }: { sample: Sample }) {
  return (
    <Link
      href={`/samples/${sample.slug}`}
      style={{ textDecoration: 'none', color: 'inherit' }}
    >
      <div
        style={{
          border: '1px solid #e5e5e5',
          borderRadius: '12px',
          overflow: 'hidden',
          cursor: 'pointer',
          transition: 'box-shadow 0.15s ease',
          background: '#fff',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.08)'
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.boxShadow = 'none'
        }}
      >
        {/* PDF thumbnail */}
        <div
          style={{
            width: '100%',
            aspectRatio: '4/3',
            overflow: 'hidden',
            background: '#f5f5f5',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {sample.ipr_screenshot_url ? (
            <img
              src={sample.ipr_screenshot_url}
              alt={sample.title}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            />
          ) : (
            <div style={{ color: '#ccc', fontSize: '13px' }}>No preview</div>
          )}
        </div>

        {/* Card body */}
        <div style={{ padding: '16px', flex: 1, display: 'flex', flexDirection: 'column', gap: '8px' }}>

          {/* Domain badge */}
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
              alignSelf: 'flex-start',
            }}
          >
            {sample.domain}
          </span>

          {/* Title */}
          <p
            style={{
              fontSize: '14px',
              fontWeight: '500',
              lineHeight: '1.5',
              color: '#0a0a0a',
              margin: 0,
              flex: 1,
            }}
          >
            {sample.title}
          </p>

          {/* Summary */}
          <p
            style={{
              fontSize: '13px',
              color: '#666',
              lineHeight: '1.5',
              margin: 0,
            }}
          >
            {sample.summary}
          </p>
        </div>
      </div>
    </Link>
  )
}
