import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { generatePactFile, generateShortSlug } from '@/utils/generatePactFile'

const resend = new Resend(process.env.RESEND_API_KEY!)

interface ConversationTurn {
  role: 'assistant' | 'user'
  content: string
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
}

function generateSampleSQL(params: {
  requestId: string
  researchQuestion: string
  context: string
  modelTier: string
  messages: ConversationTurn[]
  userEmail: string
  slug: string
  domain: string
  summary: string
}): string {
  const { requestId, researchQuestion, context, messages, slug, domain, summary } = params

  const escape = (s: string) => s.replace(/'/g, "''")

  const conversationJSON = JSON.stringify(
    messages.map(m => ({ role: m.role, content: m.content })),
    null,
    2
  ).replace(/'/g, "''")

  const domainValue = domain ? `'${escape(domain)}'` : `'REPLACE_WITH_DOMAIN'`
  const summaryValue = summary ? `'${escape(summary)}'` : `'REPLACE_WITH_ONE_SENTENCE_SUMMARY'`

  return `-- Sample Insert — generated from request ${requestId.substring(0, 8)}
-- Run in Supabase SQL editor after delivering the PDF
-- Only REPLACE_WITH_PDF_URL needs to be filled in manually

insert into samples (
  slug,
  domain,
  title,
  summary,
  refined_question,
  refined_context,
  pdf_url,
  pdf_thumbnail_url,
  ipr_conversation,
  sort_order,
  published
) values (
  '${escape(slug)}',
  ${domainValue},
  '${escape(researchQuestion)}',
  ${summaryValue},
  '${escape(researchQuestion)}',
  '${escape(context)}',
  'REPLACE_WITH_PDF_URL',
  '',
  '${conversationJSON}'::jsonb,
  0,
  false
)
on conflict (slug) do update set
  domain = excluded.domain,
  title = excluded.title,
  summary = excluded.summary,
  refined_question = excluded.refined_question,
  refined_context = excluded.refined_context,
  pdf_url = excluded.pdf_url,
  ipr_conversation = excluded.ipr_conversation,
  sort_order = excluded.sort_order,
  published = excluded.published;
`
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Capture the full, unmodified request body BEFORE any destructuring.
    // This rides along to the internal notification email as its own
    // {slug}-request.json attachment, independent of whatever fields this
    // route happens to destructure below. Early groundwork for the planned
    // Darwin/PACT peer-services architecture, where a request needs to
    // carry its full original context rather than only a curated subset
    // of fields per route. Side effect: also fixes the domain-silently-
    // dropped problem in practice, since the full body rides along
    // regardless of what's explicitly read out of it here — though
    // domain/customer_email as real schema fields is still the more
    // robust long-term fix and remains separately tracked.
    const requestBody = await request.json()

    const { requestId, researchQuestion, context, modelTier, deliveryEmail, messages, domain, summary } = requestBody

    const tierLabel = modelTier === 'economy' ? 'Economy ($15)' : 'Standard ($30)'
    const toEmail = deliveryEmail || user.email!

    // Generate short slug — used for filenames and SQL slug
    const shortSlug = generateShortSlug(researchQuestion)
    const fileSlug = `${shortSlug}-${requestId.substring(0, 8)}`

    // Strip markdown for display in emails
    const cleanQuestion = stripMarkdown(researchQuestion)
    const cleanContext = context ? stripMarkdown(context) : ''

    // Generate .pact file
    const pactContent = generatePactFile({
      requestId,
      researchQuestion,
      context: context || '',
      modelTier,
      userEmail: user.email!,
    })

    const pactFilename = `${fileSlug}.pact`
    const pactBase64 = Buffer.from(pactContent).toString('base64')

    // Generate SQL file
    const sqlContent = generateSampleSQL({
      requestId,
      researchQuestion,
      context: context || '',
      modelTier,
      messages: messages || [],
      userEmail: user.email!,
      slug: fileSlug,
      domain: domain || '',
      summary: summary || '',
    })

    const sqlFilename = `${fileSlug}.sql`
    const sqlBase64 = Buffer.from(sqlContent).toString('base64')

    // Full raw request-submission JSON — internal notification only, not sent to the user
    const rawRequestJSON = JSON.stringify(requestBody, null, 2)
    const rawRequestFilename = `${fileSlug}-request.json`
    const rawRequestBase64 = Buffer.from(rawRequestJSON).toString('base64')

    // Email to user
    await resend.emails.send({
      from: 'PACT Research Service <research@pactresearch.net>',
      to: toEmail,
      subject: 'Your PACT Research Request Has Been Received',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>Research Request Received</h2>
          <p>Thank you for submitting a research request. Here is a summary:</p>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px; font-weight: bold; width: 160px;">Request ID</td>
              <td style="padding: 8px;">${requestId}</td>
            </tr>
            <tr style="background: #f9f9f9;">
              <td style="padding: 8px; font-weight: bold;">Research question</td>
              <td style="padding: 8px;">${cleanQuestion}</td>
            </tr>
            ${cleanContext ? `
            <tr>
              <td style="padding: 8px; font-weight: bold;">Context</td>
              <td style="padding: 8px;">${cleanContext}</td>
            </tr>` : ''}
            <tr style="background: #f9f9f9;">
              <td style="padding: 8px; font-weight: bold;">Research depth</td>
              <td style="padding: 8px;">${tierLabel}</td>
            </tr>
            <tr>
              <td style="padding: 8px; font-weight: bold;">Delivery email</td>
              <td style="padding: 8px;">${toEmail}</td>
            </tr>
          </table>
          <p style="margin-top: 24px;">Your results will be delivered within one business day. Payment will only be collected after successful delivery.</p>
          <p>If you have any questions, reply to this email.</p>
          <p style="color: #999; font-size: 12px; margin-top: 32px;">PACT Research Service — pactresearch.net</p>
        </div>
      `,
    })

    // Email to Nik with .pact file, SQL insert, and full raw request JSON attached
    await resend.emails.send({
      from: 'PACT Research Service <research@pactresearch.net>',
      to: 'nik@congral.us',
      subject: `New PACT Request [${requestId.substring(0, 8)}] — ${modelTier.toUpperCase()}`,
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2>New Research Request</h2>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 8px; font-weight: bold; width: 160px;">Request ID</td>
              <td style="padding: 8px;">${requestId}</td>
            </tr>
            <tr style="background: #f9f9f9;">
              <td style="padding: 8px; font-weight: bold;">From</td>
              <td style="padding: 8px;">${user.email}</td>
            </tr>
            <tr>
              <td style="padding: 8px; font-weight: bold;">Delivery email</td>
              <td style="padding: 8px;">${toEmail}</td>
            </tr>
            <tr style="background: #f9f9f9;">
              <td style="padding: 8px; font-weight: bold;">Research depth</td>
              <td style="padding: 8px;">${tierLabel}</td>
            </tr>
            <tr>
              <td style="padding: 8px; font-weight: bold;">Domain</td>
              <td style="padding: 8px;">${domain || '—'}</td>
            </tr>
            <tr style="background: #f9f9f9;">
              <td style="padding: 8px; font-weight: bold;">Research question</td>
              <td style="padding: 8px;">${cleanQuestion}</td>
            </tr>
            ${cleanContext ? `
            <tr>
              <td style="padding: 8px; font-weight: bold;">Context</td>
              <td style="padding: 8px;">${cleanContext}</td>
            </tr>` : ''}
          </table>
          <p style="margin-top: 24px;">Three files are attached:</p>
          <ul>
            <li><strong>${pactFilename}</strong> — import into PACT, run the session, verify, then trigger payment</li>
            <li><strong>${sqlFilename}</strong> — SQL insert ready to run; only REPLACE_WITH_PDF_URL needs filling in</li>
            <li><strong>${rawRequestFilename}</strong> — full raw request submission, unmodified, for reference/debugging</li>
          </ul>
          <p style="color: #999; font-size: 12px; margin-top: 32px;">PACT Research Service — pactresearch.net</p>
        </div>
      `,
      attachments: [
        {
          filename: pactFilename,
          content: pactBase64,
        },
        {
          filename: sqlFilename,
          content: sqlBase64,
        },
        {
          filename: rawRequestFilename,
          content: rawRequestBase64,
        },
      ],
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('send-confirmation error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
