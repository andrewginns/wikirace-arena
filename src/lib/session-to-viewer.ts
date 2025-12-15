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
  const maxSteps = Math.max(
    20,
    ...runs.map((r) => (typeof r.hops === 'number' ? r.hops + 1 : r.steps.length))
  )

  return {
    name,
    article_list: [session.start_article, session.destination_article],
    num_trials: 1,
    num_workers: 1,
    max_steps: maxSteps,
    agent_settings: {
      model: 'mixed',
      api_base: null,
      max_links: 200,
      max_tries: 3,
    },
    runs: runs.map((run) => ({
      model:
        run.kind === 'human'
          ? `human/${run.player_name || 'Human'}`
          : run.model || 'llm',
      api_base: run.api_base || null,
      max_links: 200,
      max_tries: 3,
      result: viewerResultFromRun(run),
      start_article: session.start_article,
      destination_article: session.destination_article,
      steps: run.steps,
    })),
  }
}

