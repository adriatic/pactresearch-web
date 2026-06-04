import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'
import { Resend } from 'resend'
import { generatePactFile } from '@/utils/generatePactFile'

const resend = new Resend(process.env.RESEND_API_KEY!)

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { requestId, researchQuestion, context, modelTier, deliveryEmail } = await request.json()

    const tierLabel = modelTier === 'economy' ? 'Economy ($15)' : 'Standard ($30)'
    const toEmail = deliveryEmail || user.email!

    // Generate .pact file
    const pactContent = generatePactFile({
      requestId,
      researchQuestion,
      context: context || '',
      modelTier,
      userEmail: user.email!,
    })

    const pactFilename = `pact-request-${requestId.substring(0, 8)}.pact`
    const pactBase64 = Buffer.from(pactContent).toString('base64')

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
              <td style="padding: 8px;">${researchQuestion}</td>
            </tr>
            ${context ? `
            <tr>
              <td style="padding: 8px; font-weight: bold;">Context</td>
              <td style="padding: 8px;">${context}</td>
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

    // Email to Nik with .pact file attached
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
              <td style="padding: 8px; font-weight: bold;">Research question</td>
              <td style="padding: 8px;">${researchQuestion}</td>
            </tr>
            ${context ? `
            <tr style="background: #f9f9f9;">
              <td style="padding: 8px; font-weight: bold;">Context</td>
              <td style="padding: 8px;">${context}</td>
            </tr>` : ''}
          </table>
          <p style="margin-top: 24px;">The PACT notebook file is attached. Import it into PACT, run the session, verify, then trigger payment.</p>
          <p style="color: #999; font-size: 12px; margin-top: 32px;">PACT Research Service — pactresearch.net</p>
        </div>
      `,
      attachments: [
        {
          filename: pactFilename,
          content: pactBase64,
        },
      ],
    })

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('send-confirmation error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
