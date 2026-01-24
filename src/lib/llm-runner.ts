import { API_BASE } from '@/lib/constants'
import type { StepV1 } from '@/lib/session-types'

type RunLlmRaceArgs = {
  startArticle: string
  destinationArticle: string
  model: string
  apiBase?: string
  openaiApiMode?: string
  openaiReasoningEffort?: string
  openaiReasoningSummary?: string
  anthropicThinkingBudgetTokens?: number
  googleThinkingConfig?: Record<string, unknown>
  traceContext?: {
    sessionId: string
    runId: string
    traceparent: string
  }
  resumeFromSteps?: StepV1[]
  maxSteps: number
  maxLinks: number | null
  maxTokens: number | null
  signal?: AbortSignal
  onStep: (step: StepV1) => void
}

type LocalLlmStepResponse = {
  step?: unknown
}

async function localRunStep({
  startArticle,
  destinationArticle,
  model,
  steps,
  maxSteps,
  maxLinks,
  maxTokens,
  apiBase,
  openaiApiMode,
  openaiReasoningEffort,
  openaiReasoningSummary,
  anthropicThinkingBudgetTokens,
  googleThinkingConfig,
  traceContext,
  signal,
}: {
  startArticle: string
  destinationArticle: string
  model: string
  steps: StepV1[]
  maxSteps: number
  maxLinks: number | null
  maxTokens: number | null
  apiBase?: string
  openaiApiMode?: string
  openaiReasoningEffort?: string
  openaiReasoningSummary?: string
  anthropicThinkingBudgetTokens?: number
  googleThinkingConfig?: Record<string, unknown>
  traceContext?: {
    sessionId: string
    runId: string
    traceparent: string
  }
  signal?: AbortSignal
}) {
  const payload: Record<string, unknown> = {
    start_article: startArticle,
    destination_article: destinationArticle,
    model,
    steps: steps.map((step) => ({
      type: step.type,
      article: step.article,
      at: typeof step.at === 'string' && step.at.length > 0 ? step.at : new Date().toISOString(),
      metadata: step.metadata || null,
    })),
    api_base: apiBase || null,
    openai_api_mode: openaiApiMode || null,
    openai_reasoning_effort: openaiReasoningEffort || null,
    openai_reasoning_summary: openaiReasoningSummary || null,
    anthropic_thinking_budget_tokens:
      typeof anthropicThinkingBudgetTokens === 'number' && anthropicThinkingBudgetTokens > 0
        ? anthropicThinkingBudgetTokens
        : null,
    google_thinking_config: googleThinkingConfig || null,
    max_steps: typeof maxSteps === 'number' && maxSteps > 0 ? maxSteps : 20,
    max_links: typeof maxLinks === 'number' && maxLinks > 0 ? maxLinks : null,
    max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : null,
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (traceContext?.traceparent) headers.traceparent = traceContext.traceparent
  if (traceContext?.sessionId) headers['x-wikirace-session-id'] = traceContext.sessionId
  if (traceContext?.runId) headers['x-wikirace-run-id'] = traceContext.runId

  const response = await fetch(`${API_BASE}/llm/local_run/step`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LLM request failed (${response.status}): ${text}`)
  }

  return (await response.json()) as LocalLlmStepResponse
}

export async function runLlmRace({
  startArticle,
  destinationArticle,
  model,
  apiBase,
  openaiApiMode,
  openaiReasoningEffort,
  openaiReasoningSummary,
  anthropicThinkingBudgetTokens,
  googleThinkingConfig,
  traceContext,
  resumeFromSteps,
  maxSteps,
  maxLinks,
  maxTokens,
  signal,
  onStep,
}: RunLlmRaceArgs) {
  const stepsSoFar: StepV1[] = resumeFromSteps && resumeFromSteps.length > 0 ? [...resumeFromSteps] : []

  if (stepsSoFar.length === 0) {
    stepsSoFar.push({ type: 'start', article: startArticle, at: new Date().toISOString() })
  } else if (stepsSoFar[0]?.article !== startArticle) {
    stepsSoFar.unshift({ type: 'start', article: startArticle, at: new Date().toISOString() })
  }

  const maxIterations = Math.max(1, maxSteps) + 5
  for (let i = 0; i < maxIterations; i++) {
    if (signal?.aborted) {
      const current = stepsSoFar[stepsSoFar.length - 1]?.article || startArticle
      onStep({
        type: 'lose',
        article: current,
        metadata: { aborted: true, reason: 'aborted' },
      })
      return { result: 'abandoned' as const }
    }

    const response = await localRunStep({
      startArticle,
      destinationArticle,
      model,
      steps: stepsSoFar,
      maxSteps,
      maxLinks,
      maxTokens,
      apiBase,
      openaiApiMode,
      openaiReasoningEffort,
      openaiReasoningSummary,
      anthropicThinkingBudgetTokens,
      googleThinkingConfig,
      traceContext,
      signal,
    })

    const rawStep = (response as { step?: unknown }).step
    if (!rawStep || typeof rawStep !== 'object') {
      throw new Error('Unexpected response from llm/local_run/step')
    }

    const step = rawStep as StepV1
    onStep(step)
    stepsSoFar.push(step)

    if (step.type === 'win') return { result: 'win' as const }
    if (step.type === 'lose') return { result: 'lose' as const }
  }

  const current = stepsSoFar[stepsSoFar.length - 1]?.article || startArticle
  onStep({
    type: 'lose',
    article: current,
    metadata: { reason: 'max_steps', max_steps: maxSteps },
  })
  return { result: 'lose' as const }
}
