import type { RunResult, RunV1, SessionV1, StepV1 } from '@/lib/session-types'

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
  const effort = run.reasoning_effort?.trim()
  const override = run.player_name?.trim()
  if (override && override !== model) {
    const overrideLower = override.toLowerCase()
    const modelLower = model.toLowerCase()
    const effortLower = effort?.toLowerCase()
    const overrideAlreadyIncludesModel = overrideLower.includes(modelLower)
    const overrideAlreadyIncludesEffort = effortLower
      ? overrideLower.includes(effortLower)
      : true
    if (overrideAlreadyIncludesModel && overrideAlreadyIncludesEffort) {
      return override
    }

    const suffixParts = [model]
    if (effort) suffixParts.push(effort)
    return `${override} (${suffixParts.join(' • ')})`
  }

  if (effort) return `${model} (${effort})`
  return model
}

export function sessionDisplayName(session: SessionV1) {
  if (session.title && session.title.trim().length > 0) return session.title
  return `${session.start_article} → ${session.destination_article}`
}

export function viewerResultFromRun(run: RunV1) {
  if (run.result === 'abandoned') return 'lose'
  return run.result || 'lose'
}
