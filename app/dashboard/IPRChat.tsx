'use client'

import { useState } from 'react'
import { createClient } from '@/utils/supabase/client'
import { useRouter } from 'next/navigation'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

function parseIPROutput(content: string): { question: string; context: string } | null {
  const qMatch = content.match(/RESEARCH_QUESTION_START\s*([\s\S]*?)\s*RESEARCH_QUESTION_END/)
  const cMatch = content.match(/CONTEXT_START\s*([\s\S]*?)\s*CONTEXT_END/)
  if (qMatch && cMatch) {
    return { question: qMatch[1].trim(), context: cMatch[1].trim() }
  }
  return null
}

function cleanContent(content: string): string {
  return content
    .replace(/RESEARCH_QUESTION_START[\s\S]*?RESEARCH_QUESTION_END/g, '')
    .replace(/CONTEXT_START[\s\S]*?CONTEXT_END/g, '')
    .trim()
}

export default function IPRChat() {
  const router = useRouter()
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Tell me what you would like to research. What topic or question is on your mind?' }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [turnCount, setTurnCount] = useState(0)
  const [iprResult, setIprResult] = useState<{ question: string; context: string } | null>(null)
  const [editedQuestion, setEditedQuestion] = useState('')
  const [editedContext, setEditedContext] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function sendMessage() {
    if (!input.trim() || loading) return

    const userMessage: Message = { role: 'user', content: input.trim() }
    const newMessages = [...messages, userMessage]
    setMessages(newMessages)
    setInput('')
    setLoading(true)

    const newTurnCount = turnCount + 1
    setTurnCount(newTurnCount)

    try {
      const res = await fetch('/api/ipr/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: newMessages }),
      })
      const data = await res.json()
      const assistantContent = data.content ?? 'Sorry, something went wrong.'

      const parsed = parseIPROutput(assistantContent)
      if (parsed) {
        setIprResult(parsed)
        setEditedQuestion(parsed.question)
        setEditedContext(parsed.context)
      }

      const displayContent = parsed ? cleanContent(assistantContent) || 'Here is your refined research request. Please review and edit if needed, then submit.' : assistantContent

      setMessages(prev => [...prev, { role: 'assistant', content: displayContent }])
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, something went wrong. Please try again.' }])
    }

    setLoading(false)
  }

  async function handleSubmit() {
    setSubmitting(true)
    const supabase = createClient()
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      router.push('/login')
      return
    }

    const { data: requestData, error } = await supabase.from('requests').insert({
      user_id: user.id,
      research_question: editedQuestion,
      context: editedContext,
      model_tier: 'standard',
      delivery_email: user.email,
    }).select('id').single()

    if (error || !requestData) {
      console.error(error)
      setSubmitting(false)
      return
    }

    await fetch('/api/email/send-confirmation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: requestData.id,
        researchQuestion: editedQuestion,
        context: editedContext,
        modelTier: 'standard',
        deliveryEmail: user.email,
      }),
    })

    router.push('/dashboard?submitted=true')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Chat messages */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', maxHeight: '400px', overflowY: 'auto', padding: '4px' }}>
        {messages.map((msg, i) => (
          <div key={i} style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '85%',
            background: msg.role === 'user' ? '#000' : '#f0f0f0',
            color: msg.role === 'user' ? '#fff' : '#333',
            borderRadius: '12px',
            padding: '10px 14px',
            fontSize: '15px',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
          }}>
            {msg.content}
          </div>
        ))}
        {loading && (
          <div style={{ alignSelf: 'flex-start', color: '#999', fontSize: '14px', padding: '8px' }}>
            Thinking...
          </div>
        )}
      </div>

      {/* Input */}
      {!iprResult && (
        <div style={{ display: 'flex', gap: '8px' }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() } }}
            placeholder="Type your response... (Enter to send)"
            rows={2}
            style={{ flex: 1, padding: '10px', fontSize: '15px', borderRadius: '8px', border: '1px solid #ccc', resize: 'none' }}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            style={{ padding: '10px 18px', background: '#000', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '15px' }}
          >
            Send
          </button>
        </div>
      )}

      {/* IPR Result — editable summary */}
      {iprResult && (
        <div style={{ border: '1px solid #ddd', borderRadius: '10px', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px', background: '#fafafa' }}>
          <h3 style={{ margin: 0, fontWeight: 'bold' }}>Your Research Request</h3>
          <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>Review and edit if needed before submitting.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Research question</label>
            <textarea
              value={editedQuestion}
              onChange={e => setEditedQuestion(e.target.value)}
              rows={3}
              style={{ padding: '10px', fontSize: '15px', borderRadius: '6px', border: '1px solid #ccc', resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Context</label>
            <textarea
              value={editedContext}
              onChange={e => setEditedContext(e.target.value)}
              rows={3}
              style={{ padding: '10px', fontSize: '15px', borderRadius: '6px', border: '1px solid #ccc', resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleSubmit}
              disabled={submitting || !editedQuestion.trim()}
              style={{ padding: '12px 24px', background: '#000', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '16px' }}
            >
              {submitting ? 'Submitting...' : 'Submit request'}
            </button>
            <button
              onClick={() => { setIprResult(null); setMessages(prev => [...prev, { role: 'assistant', content: 'What would you like to change?' }]) }}
              style={{ padding: '12px 24px', background: 'none', color: '#666', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', fontSize: '16px' }}
            >
              Refine further
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
