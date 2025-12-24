import { API_BASE } from '@/lib/constants'
import type { StepV1 } from '@/lib/session-types'
import { canonicalizeTitle } from '@/lib/wiki-canonical'
import { wikiTitlesMatch } from '@/lib/wiki-title'

type RunLlmRaceArgs = {
  startArticle: string
  destinationArticle: string
  model: string
  apiBase?: string
  reasoningEffort?: string
  resumeFromSteps?: StepV1[]
  maxSteps: number
  maxLinks: number | null
  maxTokens: number | null
  signal?: AbortSignal
  onStep: (step: StepV1) => void
}

async function fetchArticleLinks(articleTitle: string) {
  const response = await fetch(
    `${API_BASE}/get_article_with_links/${encodeURIComponent(articleTitle)}`
  )
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Failed to fetch links (${response.status}): ${text}`)
  }
  const data = await response.json()
  if (!data || !Array.isArray(data.links)) {
    throw new Error('Unexpected response from get_article_with_links')
  }
  return data.links as string[]
}

type ChooseLinkResponse = {
  selected_index?: unknown
  tries?: unknown
  llm_output?: unknown
  llm_outputs?: unknown
  answer_errors?: unknown
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
}

async function chooseLink({
  model,
  currentArticle,
  targetArticle,
  pathSoFar,
  links,
  maxTokens,
  apiBase,
  reasoningEffort,
  signal,
}: {
  model: string
  currentArticle: string
  targetArticle: string
  pathSoFar: string[]
  links: string[]
  maxTokens: number | null
  apiBase?: string
  reasoningEffort?: string
  signal?: AbortSignal
}) {
  const payload: Record<string, unknown> = {
    model,
    current_article: currentArticle,
    target_article: targetArticle,
    path_so_far: pathSoFar,
    links,
    max_tries: 3,
    max_tokens: typeof maxTokens === 'number' && maxTokens > 0 ? maxTokens : null,
    api_base: apiBase || null,
    reasoning_effort: reasoningEffort || null,
  }

  const response = await fetch(`${API_BASE}/llm/choose_link`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LLM request failed (${response.status}): ${text}`)
  }

  return (await response.json()) as ChooseLinkResponse
}

export async function runLlmRace({
  startArticle,
  destinationArticle,
  model,
  apiBase,
  reasoningEffort,
  resumeFromSteps,
  maxSteps,
  maxLinks,
  maxTokens,
  signal,
  onStep,
}: RunLlmRaceArgs) {
  const pathSoFar: string[] = []
  if (resumeFromSteps && resumeFromSteps.length > 0) {
    for (const step of resumeFromSteps) {
      const last = pathSoFar[pathSoFar.length - 1]
      if (step.article && step.article !== last) pathSoFar.push(step.article)
    }
  }
  if (pathSoFar.length === 0) {
    pathSoFar.push(startArticle)
  } else if (pathSoFar[0] !== startArticle) {
    pathSoFar.unshift(startArticle)
  }

  let current = pathSoFar[pathSoFar.length - 1]
  const movesTaken = Math.max(0, pathSoFar.length - 1)
  const canonicalDestination = await canonicalizeTitle(destinationArticle)

  for (let step = movesTaken; step < maxSteps; step++) {
    if (signal?.aborted) {
      onStep({
        type: 'lose',
        article: current,
        metadata: { aborted: true, reason: 'aborted' },
      })
      return { result: 'abandoned' as const }
    }

    if (wikiTitlesMatch(current, destinationArticle)) {
      return { result: 'win' as const }
    }

    const canonicalCurrent = await canonicalizeTitle(current)
    if (wikiTitlesMatch(canonicalCurrent, canonicalDestination)) {
      return { result: 'win' as const }
    }

    const allLinks = await fetchArticleLinks(current)
    const links =
      typeof maxLinks === 'number' && Number.isFinite(maxLinks) && maxLinks > 0
        ? allLinks.slice(0, maxLinks)
        : allLinks
    if (links.length === 0) {
      onStep({
        type: 'lose',
        article: current,
        metadata: { reason: 'no_links' },
      })
      return { result: 'lose' as const }
    }

    const chooseResponse = await chooseLink({
      model,
      currentArticle: current,
      targetArticle: destinationArticle,
      pathSoFar,
      links,
      maxTokens,
      apiBase,
      reasoningEffort,
      signal,
    })

    const chosenIndex =
      typeof chooseResponse.selected_index === 'number'
        ? chooseResponse.selected_index
        : null

    const llmMetadata: Record<string, unknown> = {
      tries: typeof chooseResponse.tries === 'number' ? chooseResponse.tries : 0,
      llm_output:
        typeof chooseResponse.llm_output === 'string' || chooseResponse.llm_output === null
          ? chooseResponse.llm_output
          : null,
    }

    if (
      Array.isArray(chooseResponse.llm_outputs) &&
      chooseResponse.llm_outputs.every((v) => typeof v === 'string')
    ) {
      llmMetadata.llm_outputs = chooseResponse.llm_outputs
    }

    if (typeof chooseResponse.prompt_tokens === 'number') {
      llmMetadata.prompt_tokens = chooseResponse.prompt_tokens
    }
    if (typeof chooseResponse.completion_tokens === 'number') {
      llmMetadata.completion_tokens = chooseResponse.completion_tokens
    }
    if (typeof chooseResponse.total_tokens === 'number') {
      llmMetadata.total_tokens = chooseResponse.total_tokens
    }

    if (chosenIndex === null) {
      if (
        Array.isArray(chooseResponse.answer_errors) &&
        chooseResponse.answer_errors.every((v) => typeof v === 'string')
      ) {
        llmMetadata.answer_errors = chooseResponse.answer_errors
      }

      onStep({
        type: 'lose',
        article: current,
        metadata: {
          reason: 'bad_answer',
          ...llmMetadata,
        },
      })
      return { result: 'lose' as const }
    }

    const selected = links[chosenIndex - 1]
    let reachedTarget = wikiTitlesMatch(selected, destinationArticle)
    if (!reachedTarget) {
      const canonicalSelected = await canonicalizeTitle(selected)
      reachedTarget = wikiTitlesMatch(canonicalSelected, canonicalDestination)
    }

    if (reachedTarget) {
      onStep({
        type: 'win',
        article: destinationArticle,
        metadata: {
          selected_index: chosenIndex,
          ...llmMetadata,
        },
      })
      return { result: 'win' as const }
    }

    onStep({
      type: 'move',
      article: selected,
      metadata: {
        selected_index: chosenIndex,
        ...llmMetadata,
      },
    })
    pathSoFar.push(selected)
    current = selected
  }

  onStep({
    type: 'lose',
    article: current,
    metadata: { reason: 'max_steps', max_steps: maxSteps },
  })
  return { result: 'lose' as const }
}
