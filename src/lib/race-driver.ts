export type RaceCapabilities = {
  canAddAi: boolean;
  canControlRun: (runId: string) => boolean;
  canCancelRun: (runId: string) => boolean;
  canRestartRun: (runId: string) => boolean;
  canExport: boolean;
};

export type AddAiArgs = {
  model: string;
  player_name?: string;
  api_base?: string;
  reasoning_effort?: string;
  max_steps?: number;
  max_links?: number | null;
  max_tokens?: number | null;
};

export type RaceDriver = {
  mode: "local" | "multiplayer";
  capabilities: RaceCapabilities;

  makeMove: (args: { runId: string; title: string }) => Promise<boolean>;

  addAi?: (args: AddAiArgs) => Promise<boolean>;
  cancelRun?: (runId: string) => Promise<void>;
  restartRun?: (runId: string) => Promise<void>;

  abandonRun?: (runId: string) => void;
  deleteRuns?: (runIds: string[]) => void;
  forceWinRun?: (runId: string) => void;

  pauseHumanTimers?: (exceptRunId: string | null) => void;
  resumeHumanTimerForRun?: (runId: string) => void;
  pauseHumanTimerForRun?: (runId: string) => void;

  exportToViewer?: () => Promise<void>;
};
