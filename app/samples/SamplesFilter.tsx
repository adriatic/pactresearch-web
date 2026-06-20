'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback } from 'react'

const DOMAINS = [
  'All',
  'Science',
  'Music History',
  'Economics',
  'Medicine',
  'Cycling',
  'Law & Policy',
  'Research Methodology',
]

const SORT_OPTIONS = [
  { value: 'date', label: 'Newest first' },
  { value: 'domain', label: 'By domain' },
  { value: 'popularity', label: 'Most viewed' },
]

export default function SamplesFilter() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const q = searchParams.get('q') ?? ''
  const domain = searchParams.get('domain') ?? 'All'
  const sort = searchParams.get('sort') ?? 'date'

  const updateParams = useCallback(
    (updates: Record<string, string>) => {
      const params = new URLSearchParams(searchParams.toString())
      Object.entries(updates).forEach(([key, value]) => {
        if (value && value !== 'All') {
          params.set(key, value)
        } else {
          params.delete(key)
        }
      })
      router.push(`/samples?${params.toString()}`)
    },
    [router, searchParams]
  )

  return (
    <div style={{ marginBottom: '32px' }}>
      {/* Search bar */}
      <input
        type="search"
        placeholder="Search samples..."
        defaultValue={q}
        onChange={(e) => {
          const timeout = setTimeout(() => {
            updateParams({ q: e.target.value })
          }, 300)
          return () => clearTimeout(timeout)
        }}
        style={{
          width: '100%',
          padding: '10px 16px',
          fontSize: '15px',
          border: '1px solid #e5e5e5',
          borderRadius: '8px',
          marginBottom: '16px',
          outline: 'none',
          boxSizing: 'border-box',
        }}
      />

      {/* Domain filters + sort — same row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>

        {/* Domain pills */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {DOMAINS.map((d) => (
            <button
              key={d}
              onClick={() => updateParams({ domain: d })}
              style={{
                padding: '6px 14px',
                fontSize: '13px',
                borderRadius: '20px',
                border: '1px solid #e5e5e5',
                background: domain === d ? '#0a0a0a' : '#fff',
                color: domain === d ? '#fff' : '#333',
                cursor: 'pointer',
                fontWeight: domain === d ? '500' : 'normal',
              }}
            >
              {d}
            </button>
          ))}
        </div>

        {/* Sort select */}
        <select
          value={sort}
          onChange={(e) => updateParams({ sort: e.target.value })}
          style={{
            padding: '6px 12px',
            fontSize: '13px',
            border: '1px solid #e5e5e5',
            borderRadius: '8px',
            background: '#fff',
            color: '#333',
            cursor: 'pointer',
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
