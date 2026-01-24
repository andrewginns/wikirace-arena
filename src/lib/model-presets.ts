export const RECOMMENDED_MODELS = [
  "openai-responses:gpt-5.2",
  "openai-responses:gpt-5.1",
  "openai-responses:gpt-5-mini",
  "openai-responses:gpt-5-nano",
] as const;

export const DEFAULT_MODEL_ID = "openai-responses:gpt-5-mini";

type DraftVariant = {
  label: string;
  openaiReasoningEffort?: string;
};

export type ModelPresetDraft = {
  model: string;
  name?: string;
  openaiReasoningEffort?: string;
};

export function allPresetModelDrafts(modelList: readonly string[]): ModelPresetDraft[] {
  const models = Array.from(new Set(modelList.map((m) => m.trim()).filter(Boolean)));
  return models.map((model) => ({ model }));
}

export function gpt52ReasoningSweepDrafts(): ModelPresetDraft[] {
  const model = "openai-responses:gpt-5.2";
  const variants: DraftVariant[] = [
    { label: "default" },
    { label: "low", openaiReasoningEffort: "low" },
    { label: "medium", openaiReasoningEffort: "medium" },
    { label: "high", openaiReasoningEffort: "high" },
  ];

  return variants.map((variant) => ({
    model,
    name: `${model} (${variant.label})`,
    openaiReasoningEffort: variant.openaiReasoningEffort,
  }));
}
