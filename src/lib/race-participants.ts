export type RaceParticipantDraftLike = {
  id: string;
  kind: "human" | "llm";
  name: string;
  model?: string;
  apiBase?: string;
  openaiApiMode?: string;
  openaiReasoningEffort?: string;
  anthropicThinkingBudgetTokens?: number;
};

export function participantKey(p: RaceParticipantDraftLike) {
  if (p.kind === "human") {
    const normalized = p.name.trim().toLowerCase();
    return `human:${normalized || "human"}`;
  }

  return `llm:${p.model || ""}:${p.apiBase || ""}:${p.openaiApiMode || ""}:${p.openaiReasoningEffort || ""}:${p.anthropicThinkingBudgetTokens || ""}`;
}

function normalizedHumanName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Human";
}

export function participantDuplicateLabel(p: RaceParticipantDraftLike) {
  if (p.kind === "human") return normalizedHumanName(p.name);

  const model = p.model || "llm";
  const openaiEffort = p.openaiReasoningEffort?.trim();
  const apiBase = p.apiBase?.trim();
  const openaiApiMode = p.openaiApiMode?.trim();
  const anthropicBudget =
    typeof p.anthropicThinkingBudgetTokens === "number" ? p.anthropicThinkingBudgetTokens : null;
  const parts: string[] = [];
  if (openaiEffort) parts.push(`openai_effort: ${openaiEffort}`);
  if (openaiApiMode) parts.push(`openai_api_mode: ${openaiApiMode}`);
  if (anthropicBudget) parts.push(`anthropic_thinking: ${anthropicBudget}`);
  if (apiBase) parts.push(`api_base: ${apiBase}`);
  return parts.length > 0 ? `${model} (${parts.join(" • ")})` : model;
}

export function removeDuplicateDrafts<TDraft extends RaceParticipantDraftLike>(
  drafts: readonly TDraft[]
) {
  const seen = new Set<string>();
  const next: TDraft[] = [];

  for (const draft of drafts) {
    const key = participantKey(draft);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(draft);
  }

  return next;
}

export function computeDuplicateSummary(drafts: readonly RaceParticipantDraftLike[]) {
  const counts = new Map<string, number>();
  const firstByKey = new Map<string, RaceParticipantDraftLike>();

  for (const draft of drafts) {
    const key = participantKey(draft);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (!firstByKey.has(key)) firstByKey.set(key, draft);
  }

  const duplicateKeys = new Set<string>();
  const duplicateIds = new Set<string>();
  const labels: Array<{ label: string; count: number }> = [];

  for (const [key, count] of counts.entries()) {
    if (count <= 1) continue;
    duplicateKeys.add(key);
    const first = firstByKey.get(key);
    labels.push({ label: first ? participantDuplicateLabel(first) : key, count });
  }

  labels.sort((a, b) => a.label.localeCompare(b.label));

  for (const draft of drafts) {
    const key = participantKey(draft);
    if (duplicateKeys.has(key)) duplicateIds.add(draft.id);
  }

  const summary =
    duplicateKeys.size > 0
      ? labels.map(({ label, count }) => `${label} (×${count})`).join(", ")
      : null;

  return { duplicateKeys, duplicateIds, labels, summary };
}
