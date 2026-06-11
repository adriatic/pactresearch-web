import { Suspense } from 'react'
import { createClient } from '@/utils/supabase/server'
import SampleCard, { Sample } from './SampleCard'
import SamplesFilter from './SamplesFilter'

export const metadata = {
  title: 'Research Samples — Pact Research',
  description: 'Browse real research produced by PACT across science, economics, music, medicine, and more.',
}

interface PageProps {
  searchParams: Promise<{ q?: string; domain?: string; sort?: string }>
}

async function SamplesGrid({ q, domain, sort }: { q: string; domain: string; sort: string }) {
  const supabase = await createClient()

  let query = supabase
    .from('samples')
    .select('id, slug, domain, title, summary, ipr_screenshot_url, pdf_thumbnail_url, view_count, created_at')
    .eq('published', true)

  // Full-text search
  if (q) {
    query = query.textSearch('title', q, { type: 'websearch', config: 'english' })
  }

  // Domain filter
  if (domain && domain !== 'All') {
    query = query.eq('domain', domain)
  }

  // Sort
  if (sort === 'popularity') {
    query = query.order('view_count', { ascending: false })
  } else if (sort === 'domain') {
    query = query.order('domain', { ascending: true }).order('created_at', { ascending: false })
  } else {
    query = query.order('created_at', { ascending: false })
  }

  const { data: samples, error } = await query

  if (error) {
    return (
      <p style={{ color: '#666', fontSize: '14px' }}>
        Unable to load samples. Please try again later.
      </p>
    )
  }

  if (!samples || samples.length === 0) {
    return (
      <p style={{ color: '#666', fontSize: '14px' }}>
        No samples found{q ? ` for "${q}"` : ''}{domain && domain !== 'All' ? ` in ${domain}` : ''}.
      </p>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
        gap: '24px',
      }}
    >
      {samples.map((sample) => (
        <SampleCard key={sample.id} sample={sample as Sample} />
      ))}
    </div>
  )
}

export default async function SamplesPage({ searchParams }: PageProps) {
  const { q = '', domain = 'All', sort = 'date' } = await searchParams

  return (
    <main style={{ maxWidth: '1100px', margin: '0 auto', padding: '48px 24px' }}>

      {/* Header */}
      <div style={{ marginBottom: '40px' }}>
        <h1 style={{ fontSize: '28px', fontWeight: '600', marginBottom: '8px', color: '#0a0a0a' }}>
          Research samples
        </h1>
        <p style={{ fontSize: '15px', color: '#666', lineHeight: '1.6', margin: 0 }}>
          Real research produced by PACT. Browse by topic, search by keyword, or download any PDF.
        </p>
      </div>

      {/* Filter — client component */}
      <Suspense fallback={null}>
        <SamplesFilter />
      </Suspense>

      {/* Grid — server component, re-renders on searchParam change */}
      <Suspense
        fallback={
          <div style={{ color: '#999', fontSize: '14px' }}>Loading samples...</div>
        }
      >
        <SamplesGrid q={q} domain={domain} sort={sort} />
      </Suspense>

    </main>
  )
}
