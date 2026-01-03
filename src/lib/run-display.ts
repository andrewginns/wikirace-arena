import { llmDisplayNameOverride, llmModelShortName } from "@/lib/llm-display";

export type RunDisplayInput = {
  kind: "human" | "llm";
  playerName?: string | null;
  model?: string | null;
  openaiReasoningEffort?: string | null;
  anthropicThinkingBudgetTokens?: number | null;
};

export function formatRunDisplayName({
  kind,
  playerName,
  model,
  openaiReasoningEffort,
  anthropicThinkingBudgetTokens,
}: RunDisplayInput) {
  if (kind === "human") return playerName || "Human";

  const modelValue = model || "LLM";
  const modelShort = llmModelShortName(modelValue) || modelValue;
  const openaiEffort = openaiReasoningEffort?.trim();
  const anthropicBudget =
    typeof anthropicThinkingBudgetTokens === "number" ? anthropicThinkingBudgetTokens : null;
  const overrideRaw = playerName?.trim();
  const override = llmDisplayNameOverride({ playerName: overrideRaw, model: modelValue });

  if (overrideRaw && overrideRaw !== modelValue) {
    const overrideLower = override.toLowerCase();
    const modelLower = modelShort.toLowerCase();
    const effortLower = openaiEffort?.toLowerCase();
    const thinkingTag =
      typeof anthropicBudget === "number" ? `thinking:${anthropicBudget}` : null;

    const overrideAlreadyIncludesModel = overrideLower.includes(modelLower);
    const overrideAlreadyIncludesEffort = effortLower
      ? overrideLower.includes(effortLower)
      : true;
    const overrideAlreadyIncludesThinking = thinkingTag
      ? overrideLower.includes(thinkingTag.toLowerCase())
      : true;

    const suffixParts: string[] = [];
    if (!overrideAlreadyIncludesModel) suffixParts.push(modelShort);
    if (openaiEffort && !overrideAlreadyIncludesEffort) suffixParts.push(openaiEffort);
    if (thinkingTag && !overrideAlreadyIncludesThinking) suffixParts.push(thinkingTag);

    if (suffixParts.length === 0) return override;
    return `${override} (${suffixParts.join(" • ")})`;
  }

  if (openaiEffort) return `${modelShort} (${openaiEffort})`;
  if (anthropicBudget) return `${modelShort} (thinking:${anthropicBudget})`;
  return modelShort;
}
