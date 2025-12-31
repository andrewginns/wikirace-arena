import { useState } from 'react'
import { API_BASE } from '@/lib/constants'

type InferenceArgs = {
  prompt: string
  model: string
  maxTokens: number
  apiBase?: string
}

export function useInference() {
  const [isLoading, setIsLoading] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [inferenceResult, setInferenceResult] = useState('')
  const [error, setError] = useState<string | null>(null)

  const inferenceInternal = async ({
    prompt,
    model,
    maxTokens,
    apiBase,
  }: InferenceArgs) => {
    setIsLoading(true)
    setPartialText('')
    setError(null)

    try {
      const response = await fetch(`${API_BASE}/llm/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          prompt,
          max_tokens: maxTokens,
          api_base: apiBase || null,
        }),
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`LLM request failed (${response.status}): ${text}`)
      }

      const data = await response.json()
      const content = data.content || ''

      setInferenceResult(content)
      setIsLoading(false)

      return { status: 'success', result: content }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setError(message)
      setIsLoading(false)
      return { status: 'error', result: message }
    }
  }

  const status = isLoading ? 'thinking' : error ? 'error' : 'done'

  return {
    status,
    partialText,
    inferenceResult,
    error,
    inference: inferenceInternal,
  }
}

