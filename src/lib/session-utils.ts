import type { RunResult, RunV1, SessionV1, StepV1 } from '@/lib/session-types'
import { llmDisplayNameOverride, llmModelShortName } from '@/lib/llm-display'

export function nowIso() {
  return new Date().toISOString()
}

export function makeId(prefix: string) {
  const randomId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${randomId}`
}

export function computeHops(steps: StepV1[]) {
  return Math.max(0, steps.length - 1)
}

export function finalizeRun(run: RunV1, result: RunResult, finishedAtIso?: string) {
  const finished_at = finishedAtIso || nowIso()

  let duration_ms = new Date(finished_at).getTime() - new Date(run.started_at).getTime()

  if (run.kind === 'human' && run.timer_state) {
    let activeMs = typeof run.active_ms === 'number' ? run.active_ms : 0
    if (run.timer_state === 'running' && run.last_resumed_at) {
      activeMs +=
        new Date(finished_at).getTime() - new Date(run.last_resumed_at).getTime()
    }
    duration_ms = Math.max(0, activeMs)
  }

  return {
    ...run,
    status: result === 'abandoned' ? 'abandoned' : 'finished',
    result,
    finished_at,
    hops: computeHops(run.steps),
    duration_ms: Math.max(0, duration_ms),
    ...(run.kind === 'human' && run.timer_state
      ? { timer_state: 'paused' as const, active_ms: duration_ms, last_resumed_at: undefined }
      : {}),
  } satisfies RunV1
}

export function runDisplayName(run: RunV1) {
  if (run.kind === 'human') return run.player_name || 'Human'
  const model = run.model || 'LLM'
  const modelShort = llmModelShortName(model) || model
  const openaiEffort = run.openai_reasoning_effort?.trim()
  const anthropicBudget =
    typeof run.anthropic_thinking_budget_tokens === 'number'
      ? run.anthropic_thinking_budget_tokens
      : null
  const overrideRaw = run.player_name?.trim()
  const override = llmDisplayNameOverride({ playerName: overrideRaw, model })
  if (overrideRaw && overrideRaw !== model) {
    const overrideLower = override.toLowerCase()
    const modelLower = modelShort.toLowerCase()
    const effortLower = openaiEffort?.toLowerCase()
    const thinkingTag =
      typeof anthropicBudget === 'number' ? `thinking:${anthropicBudget}` : null

    const overrideAlreadyIncludesModel = overrideLower.includes(modelLower)
    const overrideAlreadyIncludesEffort = effortLower
      ? overrideLower.includes(effortLower)
      : true
    const overrideAlreadyIncludesThinking = thinkingTag
      ? overrideLower.includes(thinkingTag.toLowerCase())
      : true

    const suffixParts: string[] = []
    if (!overrideAlreadyIncludesModel) suffixParts.push(modelShort)
    if (openaiEffort && !overrideAlreadyIncludesEffort) suffixParts.push(openaiEffort)
    if (thinkingTag && !overrideAlreadyIncludesThinking) suffixParts.push(thinkingTag)

    if (suffixParts.length === 0) return override
    return `${override} (${suffixParts.join(' • ')})`
  }

  if (openaiEffort) return `${modelShort} (${openaiEffort})`
  if (anthropicBudget) return `${modelShort} (thinking:${anthropicBudget})`
  return modelShort
}

export function sessionDisplayName(session: SessionV1) {
  if (session.title && session.title.trim().length > 0) return session.title
  return `${session.start_article} → ${session.destination_article}`
}

export function viewerResultFromRun(run: RunV1) {
  if (run.result === 'abandoned') return 'lose'
  return run.result || 'lose'
}
