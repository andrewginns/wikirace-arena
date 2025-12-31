import type { RaceDriver } from "@/lib/race-driver";
import type { RaceState } from "@/lib/race-state";
import {
  addLlmParticipant,
  abandonRun,
  cancelRun,
  makeMove,
  restartRun,
} from "@/lib/multiplayer-store";

export function createMultiplayerRaceDriver(race: RaceState): RaceDriver {
  const youPlayerId = race.you_player_id || null;
  const isHost = Boolean(youPlayerId && race.owner_player_id && youPlayerId === race.owner_player_id);
  const yourHumanRun = youPlayerId
    ? race.runs.find((r) => r.kind === "human" && r.player_id === youPlayerId) || null
    : null;

  return {
    mode: "multiplayer",
    capabilities: {
      canAddAi: isHost,
      canControlRun: (runId) => {
        if (race.status !== "running") return false;
        if (!yourHumanRun) return false;
        return yourHumanRun.status === "running" && yourHumanRun.id === runId;
      },
      canCancelRun: () => isHost,
      canRestartRun: () => isHost,
      canExport: true,
    },

    async makeMove({ title }) {
      const room = await makeMove(title);
      return Boolean(room);
    },

    async addAi(args) {
      const room = await addLlmParticipant(args);
      return Boolean(room);
    },

    async cancelRun(runId) {
      await cancelRun(runId);
    },

    abandonRun(runId) {
      void abandonRun(runId);
    },

    async restartRun(runId) {
      await restartRun(runId);
    },
  };
}
