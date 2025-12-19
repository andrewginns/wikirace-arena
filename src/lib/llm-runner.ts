import { API_BASE } from '@/lib/constants'
import type { StepV1 } from '@/lib/session-types'
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

type LlmUsage = {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

const buildPrompt = (
  current: string,
  target: string,
  pathSoFar: string[],
  links: string[]
) => {
  const formattedLinks = links.map((l, i) => `${i + 1}. ${l}`).join('\n')
  const formattedPath = pathSoFar.join(' -> ')

  return `You are playing WikiRun, trying to navigate from one Wikipedia article to another using only links.

IMPORTANT: You MUST put your final answer in <answer>NUMBER</answer> tags, where NUMBER is the link number.
For example, if you want to choose link 3, output <answer>3</answer>.

Current article: ${current}
Target article: ${target}
Available links (numbered):
${formattedLinks}

Your path so far: ${formattedPath}

Think about which link is most likely to lead you toward the target article.
First, analyze each link briefly and how it connects to your goal, then select the most promising one.

Remember to format your final answer by explicitly writing out the xml number tags like this: <answer>NUMBER</answer>`
}

function extractAnswer(response: string, maximumAnswer: number) {
  const matches = response.match(/<answer>(\d+)<\/answer>/g)
  if (!matches || matches.length === 0) {
    return {
      answer: null,
      error: `No <answer>NUMBER</answer> found. Choose a number between 1 and ${maximumAnswer}.`,
    }
  }
  if (matches.length > 1) {
    return {
      answer: null,
      error: 'Multiple <answer> tags found. Respond with exactly one.',
    }
  }

  const m = matches[0].match(/<answer>(\d+)<\/answer>/)
  const value = m ? Number.parseInt(m[1]) : NaN
  if (Number.isNaN(value)) {
    return {
      answer: null,
      error: `Answer is not a number. Choose a number between 1 and ${maximumAnswer}.`,
    }
  }
  if (value < 1 || value > maximumAnswer) {
    return {
      answer: null,
      error: `Answer out of bounds. Choose a number between 1 and ${maximumAnswer}.`,
    }
  }
  return { answer: value, error: null }
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

async function callLlm({
  model,
  prompt,
  maxTokens,
  apiBase,
  reasoningEffort,
  signal,
}: {
  model: string
  prompt: string
  maxTokens: number | null
  apiBase?: string
  reasoningEffort?: string
  signal?: AbortSignal
}) {
  const payload: Record<string, unknown> = {
    model,
    prompt,
    api_base: apiBase || null,
  }
  if (typeof maxTokens === 'number' && Number.isFinite(maxTokens) && maxTokens > 0) {
    payload.max_tokens = maxTokens
  }
  if (reasoningEffort && reasoningEffort.trim().length > 0) {
    payload.reasoning_effort = reasoningEffort
  }

  const response = await fetch(`${API_BASE}/llm/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`LLM request failed (${response.status}): ${text}`)
  }

  const data: unknown = await response.json()
  const parsed = data as { content?: unknown; usage?: unknown }
  const content = parsed.content
  if (typeof content !== 'string' || content.length === 0) {
    throw new Error('LLM returned empty content')
  }

  const usageRaw = parsed.usage as
    | {
        prompt_tokens?: unknown
        completion_tokens?: unknown
        total_tokens?: unknown
        input_tokens?: unknown
        output_tokens?: unknown
      }
    | undefined
  const usage: LlmUsage | null = usageRaw
    ? {
        promptTokens:
          typeof usageRaw.prompt_tokens === 'number'
            ? usageRaw.prompt_tokens
            : typeof usageRaw.input_tokens === 'number'
              ? usageRaw.input_tokens
              : undefined,
        completionTokens:
          typeof usageRaw.completion_tokens === 'number'
            ? usageRaw.completion_tokens
            : typeof usageRaw.output_tokens === 'number'
              ? usageRaw.output_tokens
              : undefined,
        totalTokens:
          typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
      }
    : null

  return { content, usage }
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

    const basePrompt = buildPrompt(current, destinationArticle, pathSoFar, links)
    let prompt = basePrompt

    const llmOutputs: string[] = []
    let lastOutput: string | null = null
    let promptTokensSum = 0
    let completionTokensSum = 0
    let totalTokensSum = 0
    let sawPromptTokens = false
    let sawCompletionTokens = false
    let sawAnyUsage = false

    const maxTries = 3
    let chosenIndex: number | null = null
    let usedTry: number | null = null
    const answerErrors: string[] = []

    for (let tryNum = 0; tryNum < maxTries; tryNum++) {
      const { content: response, usage } = await callLlm({
        model,
        prompt,
        maxTokens,
        apiBase,
        reasoningEffort,
        signal,
      })

      llmOutputs.push(response)
      lastOutput = response

      if (usage) {
        if (typeof usage.promptTokens === 'number') {
          promptTokensSum += usage.promptTokens
          sawPromptTokens = true
          sawAnyUsage = true
        }
        if (typeof usage.completionTokens === 'number') {
          completionTokensSum += usage.completionTokens
          sawCompletionTokens = true
          sawAnyUsage = true
        }

        const callTotal =
          typeof usage.totalTokens === 'number'
            ? usage.totalTokens
            : typeof usage.promptTokens === 'number' ||
                typeof usage.completionTokens === 'number'
              ? (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0)
              : null
        if (typeof callTotal === 'number') {
          totalTokensSum += callTotal
          sawAnyUsage = true
        }
      }

      const { answer, error } = extractAnswer(response, links.length)
      if (answer !== null) {
        chosenIndex = answer
        usedTry = tryNum
        break
      }

      if (error) answerErrors.push(error)

      const retryMessage = `IMPORTANT: ${error}`
      prompt = `${basePrompt}\n\n${retryMessage}`
    }

    if (chosenIndex === null) {
      const llmMetadata: Record<string, unknown> = {
        tries: maxTries,
        answer_errors: answerErrors,
        llm_output: lastOutput,
      }
      if (llmOutputs.length > 1) {
        llmMetadata.llm_outputs = llmOutputs
      }
      if (sawAnyUsage) {
        if (sawPromptTokens) llmMetadata.prompt_tokens = promptTokensSum
        if (sawCompletionTokens) llmMetadata.completion_tokens = completionTokensSum
        llmMetadata.total_tokens = totalTokensSum
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

    const llmMetadata: Record<string, unknown> = {
      tries: usedTry ?? 0,
      llm_output: lastOutput,
    }
    if (llmOutputs.length > 1) {
      llmMetadata.llm_outputs = llmOutputs
    }
    if (sawAnyUsage) {
      if (sawPromptTokens) llmMetadata.prompt_tokens = promptTokensSum
      if (sawCompletionTokens) llmMetadata.completion_tokens = completionTokensSum
      llmMetadata.total_tokens = totalTokensSum
    }

    const selected = links[chosenIndex - 1]
    if (wikiTitlesMatch(selected, destinationArticle)) {
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
