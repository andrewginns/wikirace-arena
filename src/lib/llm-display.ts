type LlmLabelInput = {
  model?: string | null
  openaiReasoningEffort?: string | null
  anthropicThinkingBudgetTokens?: number | null
}

function normalizeTrimmed(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function llmModelShortName(model: string | null | undefined) {
  const modelValue = normalizeTrimmed(model)
  if (!modelValue) return null

  const parts = modelValue.split(':', 2)
  if (parts.length === 2) return normalizeTrimmed(parts[1])
  return modelValue
}

export function llmDisplayNameOverride({
  playerName,
  model,
}: {
  playerName?: string | null
  model?: string | null
}) {
  const override = normalizeTrimmed(playerName)
  if (!override) return null

  const modelFull = normalizeTrimmed(model)
  if (!modelFull) return override

  const modelShort = llmModelShortName(modelFull) || modelFull
  if (override === modelFull) return modelShort
  if (override.startsWith(modelFull)) return `${modelShort}${override.slice(modelFull.length)}`
  return override
}

export function llmModelLabel({
  model,
  openaiReasoningEffort,
  anthropicThinkingBudgetTokens,
}: LlmLabelInput) {
  const modelValue = llmModelShortName(model)
  if (!modelValue) return null

  const openaiEffort = normalizeTrimmed(openaiReasoningEffort)
  if (openaiEffort) return `${modelValue} (${openaiEffort})`

  const thinkingBudget =
    typeof anthropicThinkingBudgetTokens === 'number' && anthropicThinkingBudgetTokens > 0
      ? anthropicThinkingBudgetTokens
      : null
  if (thinkingBudget !== null) return `${modelValue} (thinking:${thinkingBudget})`

  return modelValue
}

export function llmSettingsSubtext({
  apiBase,
  openaiApiMode,
}: {
  apiBase?: string | null
  openaiApiMode?: string | null
}) {
  const parts: string[] = []
  const base = normalizeTrimmed(apiBase)
  if (base) parts.push(`api_base: ${base}`)

  const apiMode = normalizeTrimmed(openaiApiMode)
  if (apiMode) parts.push(`api_mode: ${apiMode}`)

  return parts.length > 0 ? parts.join(' • ') : null
}
