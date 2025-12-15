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
  maxLinks: number;
  maxTokens: number;
};

export type RaceConfig = {
  title?: string;
  startPage: string;
  targetPage: string;
  participants: RaceParticipantDraft[];
  rules: RaceRules;
};


