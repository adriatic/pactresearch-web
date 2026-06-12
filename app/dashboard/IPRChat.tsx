'use client'

import { useState, useRef, useEffect } from 'react'
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

function renderMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^(\d+)\.\s/gm, '<br/>$1. ')
    .replace(/\n\n/g, '<br/><br/>')
    .replace(/\n/g, '<br/>')
}

export default function IPRChat() {
  const router = useRouter()
  const messagesEndRef = useRef<HTMLDivElement>(null)
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
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

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

      if (!res.ok) {
        throw new Error(`Server error: ${res.status}`)
      }

      const data = await res.json()
      const assistantContent = data.content ?? 'Sorry, something went wrong.'

      const parsed = parseIPROutput(assistantContent)
      if (parsed) {
        setIprResult(parsed)
        setEditedQuestion(parsed.question)
        setEditedContext(parsed.context)
      }

      let displayContent = cleanContent(assistantContent)
      if (!displayContent) {
        displayContent = 'Here is your refined research request. Please review and edit if needed, then submit when ready.'
      }

      setMessages(prev => [...prev, { role: 'assistant', content: displayContent }])
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Something went wrong — please try again. If the problem persists, reload the page.'
      }])
      console.error('IPR chat error:', err)
    }

    setLoading(false)
  }

  async function handleSubmit() {
    setSubmitting(true)
    setSubmitError(null)

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
      setSubmitError('Failed to save your request. Please try again.')
      setSubmitting(false)
      return
    }

    const emailRes = await fetch('/api/email/send-confirmation', {
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

    if (!emailRes.ok) {
      console.error('Email send failed')
    }

    setSubmitting(false)
    setSubmitted(true)

    setTimeout(() => {
      router.push('/dashboard?submitted=true')
    }, 1500)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>

      {/* Chat messages */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          maxHeight: '420px',
          overflowY: 'auto',
          padding: '4px 4px 8px',
        }}
      >
        {messages.map((msg, i) => (
          <div
            key={i}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '85%',
              background: msg.role === 'user' ? '#000' : '#f0f0f0',
              color: msg.role === 'user' ? '#fff' : '#333',
              borderRadius: '12px',
              padding: '10px 14px',
              fontSize: '15px',
              lineHeight: '1.6',
            }}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }}
          />
        ))}

        {loading && (
          <div
            style={{
              alignSelf: 'flex-start',
              background: '#f0f0f0',
              borderRadius: '12px',
              padding: '10px 14px',
              fontSize: '14px',
              color: '#888',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span style={{ letterSpacing: '2px' }}>●●●</span>
            <span>Thinking...</span>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      {!iprResult && (
        <div style={{ display: 'flex', gap: '8px' }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                sendMessage()
              }
            }}
            placeholder={loading ? 'Waiting for response...' : 'Type your response... (Enter to send)'}
            disabled={loading}
            rows={2}
            style={{
              flex: 1,
              padding: '10px',
              fontSize: '15px',
              borderRadius: '8px',
              border: '1px solid #ccc',
              resize: 'none',
              opacity: loading ? 0.5 : 1,
              cursor: loading ? 'not-allowed' : 'text',
            }}
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            style={{
              padding: '10px 18px',
              background: loading || !input.trim() ? '#ccc' : '#000',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
              fontSize: '15px',
              fontWeight: '500',
              minWidth: '80px',
              transition: 'background 0.15s ease',
            }}
          >
            {loading ? '...' : 'Send'}
          </button>
        </div>
      )}

      {/* IPR Result */}
      {iprResult && (
        <div
          style={{
            border: '1px solid #ddd',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '16px',
            background: '#fafafa',
          }}
        >
          <h3 style={{ margin: 0, fontWeight: 'bold' }}>Your Research Request</h3>
          <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>
            Review and edit if needed before submitting.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Research question</label>
            <textarea
              value={editedQuestion}
              onChange={e => setEditedQuestion(e.target.value)}
              disabled={submitted}
              rows={3}
              style={{
                padding: '10px',
                fontSize: '15px',
                borderRadius: '6px',
                border: '1px solid #ccc',
                resize: 'vertical',
                opacity: submitted ? 0.6 : 1,
              }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontWeight: 'bold', fontSize: '14px' }}>Context</label>
            <textarea
              value={editedContext}
              onChange={e => setEditedContext(e.target.value)}
              disabled={submitted}
              rows={3}
              style={{
                padding: '10px',
                fontSize: '15px',
                borderRadius: '6px',
                border: '1px solid #ccc',
                resize: 'vertical',
                opacity: submitted ? 0.6 : 1,
              }}
            />
          </div>

          {submitError && (
            <p style={{ color: '#c00', fontSize: '14px', margin: 0 }}>{submitError}</p>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleSubmit}
              disabled={submitting || submitted || !editedQuestion.trim()}
              style={{
                padding: '12px 24px',
                background: submitted ? '#4a4a4a' : submitting || !editedQuestion.trim() ? '#ccc' : '#000',
                color: '#fff',
                border: 'none',
                borderRadius: '6px',
                cursor: submitting || submitted || !editedQuestion.trim() ? 'not-allowed' : 'pointer',
                fontSize: '16px',
                fontWeight: '500',
                transition: 'background 0.2s ease',
              }}
            >
              {submitted ? 'Submitted ✓' : submitting ? 'Submitting...' : 'Submit request'}
            </button>

            {!submitted && (
              <button
                onClick={() => {
                  setIprResult(null)
                  setMessages(prev => [...prev, {
                    role: 'assistant',
                    content: 'What would you like to change or explore further?'
                  }])
                }}
                style={{
                  padding: '12px 24px',
                  background: 'none',
                  color: '#666',
                  border: '1px solid #ccc',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontSize: '16px',
                }}
              >
                Refine further
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
