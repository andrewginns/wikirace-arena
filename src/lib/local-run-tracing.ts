import { API_BASE } from '@/lib/constants'

type StartLocalRunTraceArgs = {
  sessionId: string
  runId: string
  model: string
  apiBase?: string
  openaiApiMode?: string
  openaiReasoningEffort?: string
  openaiReasoningSummary?: string
  anthropicThinkingBudgetTokens?: number
  googleThinkingConfig?: Record<string, unknown>
}

type StartLocalRunTraceResponse = {
  traceparent: string
  span_name: string
}

export async function startLocalRunTrace(args: StartLocalRunTraceArgs) {
  try {
    const response = await fetch(`${API_BASE}/llm/local_run/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: args.sessionId,
        run_id: args.runId,
        model: args.model,
        api_base: args.apiBase || null,
        openai_api_mode: args.openaiApiMode || null,
        openai_reasoning_effort: args.openaiReasoningEffort || null,
        openai_reasoning_summary: args.openaiReasoningSummary || null,
        anthropic_thinking_budget_tokens:
          typeof args.anthropicThinkingBudgetTokens === 'number'
            ? args.anthropicThinkingBudgetTokens
            : null,
        google_thinking_config: args.googleThinkingConfig || null,
      }),
    })

    if (!response.ok) return null

    const data = (await response.json()) as StartLocalRunTraceResponse
    if (!data || typeof data.traceparent !== 'string' || data.traceparent.trim().length === 0) {
      return null
    }
    return { traceparent: data.traceparent }
  } catch {
    return null
  }
}

export async function endLocalRunTrace(args: { sessionId: string; runId: string }) {
  try {
    await fetch(`${API_BASE}/llm/local_run/end`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: args.sessionId, run_id: args.runId }),
    })
  } catch {
    // ignore
  }
}

