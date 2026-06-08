import { createClient } from '@/utils/supabase/server'
import { NextResponse } from 'next/server'

const IPR_SYSTEM_PROMPT = `You are helping someone submit a research request to PACT Research Service.
Your goal is to help them articulate their research question clearly and provide useful context.

RULES:
- Ask clarifying questions first. Do not summarize until you know: (1) the core research question, (2) relevant background or context, (3) what kind of output they need.
- Ask ONE question per response.
- Keep responses concise and conversational.
- Only after you have enough information, output the result in this exact format:

RESEARCH_QUESTION_START
<the refined research question>
RESEARCH_QUESTION_END

CONTEXT_START
<relevant background context>
CONTEXT_END

- After outputting the result, ask if they want to refine it further.
- Never generate a generic placeholder — wait for real information.
- Maximum 5 user turns before producing the final output regardless.`

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { messages } = await request.json()

    if (!messages || !Array.isArray(messages)) {
      return NextResponse.json({ error: 'Invalid messages' }, { status: 400 })
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: IPR_SYSTEM_PROMPT,
        messages: messages,
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      console.error('Anthropic API error:', err)
      return NextResponse.json({ error: 'AI service error' }, { status: 500 })
    }

    const data = await response.json()
    const content = data.content?.[0]?.text ?? ''

    return NextResponse.json({ content })
  } catch (err) {
    console.error('IPR chat error:', err)
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
