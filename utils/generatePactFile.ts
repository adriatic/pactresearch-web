interface PactRequest {
  requestId: string
  researchQuestion: string
  context: string
  modelTier: string
  userEmail: string
}

export function generatePactFile(req: PactRequest): string {
  const now = Date.now()
  const discussionId = `discussion-${now}`
  const cellId = `${now}-${Math.random().toString(36).substring(2, 15)}`

  // Generate notebook name from research question (first 60 chars)
  const notebookName = req.researchQuestion.length > 60
    ? req.researchQuestion.substring(0, 57) + '...'
    : req.researchQuestion

  // Generate system prompt from form data
  const tierInstruction = req.modelTier === 'economy'
    ? 'Provide a focused, concise analysis covering the key points efficiently.'
    : 'Provide a thorough, comprehensive analysis with detailed explanations, citations where possible, and actionable recommendations.'

  const contextSection = req.context
    ? `\n\nUser context: ${req.context}`
    : ''

  const systemPrompt = `You are a structured research specialist conducting a PACT research session for ${req.userEmail}.

Research topic: ${req.researchQuestion}${contextSection}

${tierInstruction} Organize findings clearly with headings, use evidence-based sources, and structure the response so it can be exported as a professional PDF report.`

  // Build the prompt text for the first cell
  const promptText = req.context
    ? `${req.researchQuestion}\n\nAdditional context: ${req.context}`
    : req.researchQuestion

  const payload = {
    version: 1,
    exportedAt: now,
    notebook: {
      name: notebookName,
      systemPrompt: systemPrompt,
    },
    discussions: [
      {
        id: discussionId,
        name: 'Research Question',
        createdAt: now,
        totalTimeMs: 0,
      },
    ],
    cells: [
      {
        id: cellId,
        discussionId: discussionId,
        parentId: null,
        promptText: promptText,
        response: '',
        model: req.modelTier === 'economy' ? 'claude-haiku' : 'claude-sonnet',
        cellType: 'user',
        createdAt: now,
      },
    ],
  }

  const pactFile = {
    version: 1,
    signedAt: now,
    signer: 'pactresearch.net',
    signature: `request-${req.requestId}`,
    payload: payload,
  }

  return JSON.stringify(pactFile, null, 2)
}
