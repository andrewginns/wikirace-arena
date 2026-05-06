import type { RunV1, SessionV1 } from '@/lib/session-types'
import { viewerResultFromRun } from '@/lib/session-utils'

export function buildViewerDatasetFromSession({
  session,
  runs,
  name,
}: {
  session: SessionV1
  runs: RunV1[]
  name: string
}) {
  const maxSteps =
    typeof session.rules?.max_hops === 'number' ? session.rules.max_hops : 20

  return {
    name,
    article_list: [session.start_article, session.destination_article],
    num_trials: 1,
    num_workers: 1,
    max_steps: maxSteps,
    agent_settings: {
      model: 'mixed',
      api_base: null,
      max_links: session.rules?.max_links ?? null,
      max_tries: 3,
    },
    runs: runs.map((run) => ({
      model:
        run.kind === 'human'
          ? `human/${run.player_name || 'Human'}`
          : run.model || 'llm',
      api_base: run.api_base || null,
      openai_api_mode: run.openai_api_mode || null,
      openai_reasoning_effort: run.openai_reasoning_effort || null,
      openai_reasoning_summary: run.openai_reasoning_summary || null,
      anthropic_thinking_budget_tokens: run.anthropic_thinking_budget_tokens ?? null,
      google_thinking_config: run.google_thinking_config || null,
      max_steps:
        typeof run.max_steps === 'number'
          ? run.max_steps
          : typeof session.rules?.max_hops === 'number'
            ? session.rules.max_hops
            : null,
      max_links:
        run.max_links === null
          ? null
          : typeof run.max_links === 'number'
            ? run.max_links
            : session.rules?.max_links ?? null,
      max_tokens:
        run.max_tokens === null
          ? null
          : typeof run.max_tokens === 'number'
            ? run.max_tokens
            : session.rules?.max_tokens ?? null,
      max_tries: 3,
      result: viewerResultFromRun(run),
      start_article: session.start_article,
      destination_article: session.destination_article,
      steps: run.steps,
    })),
  }
}
