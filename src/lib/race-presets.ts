export type RacePresetId = "sprint" | "classic" | "marathon";

export type RacePresetBudgets = {
  maxHops: number;
  maxLinks: number | null;
  maxTokens: number | null;
};

export type RacePresetDefinition = {
  id: RacePresetId;
  name: string;
  description: string;
  budgets: RacePresetBudgets;
};

export const RACE_PRESETS: RacePresetDefinition[] = [
  {
    id: "sprint",
    name: "Sprint",
    description: "Fast rounds. Great for humans.",
    budgets: { maxHops: 12, maxLinks: 200, maxTokens: 1500 },
  },
  {
    id: "classic",
    name: "Classic",
    description: "Balanced default.",
    budgets: { maxHops: 20, maxLinks: null, maxTokens: null },
  },
  {
    id: "marathon",
    name: "Marathon",
    description: "More hops + more thinking time.",
    budgets: { maxHops: 35, maxLinks: null, maxTokens: null },
  },
];

export function findRacePresetByBudgets(
  budgets: RacePresetBudgets
): RacePresetDefinition | null {
  return (
    RACE_PRESETS.find(
      (preset) =>
        preset.budgets.maxHops === budgets.maxHops &&
        preset.budgets.maxLinks === budgets.maxLinks &&
        preset.budgets.maxTokens === budgets.maxTokens
    ) || null
  );
}

