export type RaceParticipantKind = "human" | "llm";

export type RaceParticipantDraft = {
  id: string;
  kind: RaceParticipantKind;
  name: string;
  model?: string;
  apiBase?: string;
  reasoningEffort?: string;
};

export type RaceRules = {
  maxHops: number;
  maxLinks: number | null;
  maxTokens: number | null;
  includeImageLinks: boolean;
};

export type RaceConfig = {
  title?: string;
  startPage: string;
  targetPage: string;
  participants: RaceParticipantDraft[];
  rules: RaceRules;
  humanTimer?: {
    autoStartOnFirstAction: boolean;
  };
};
