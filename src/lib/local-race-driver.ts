import { API_BASE } from "@/lib/constants";
import type { RaceDriver } from "@/lib/race-driver";
import {
  abandonRun,
  appendRunStep,
  deleteRuns,
  finishRun,
  forceWinRun,
  getSession,
  pauseHumanTimers,
  pauseHumanTimerForRun,
  resumeHumanTimerForRun,
} from "@/lib/session-store";
import { nowIso } from "@/lib/session-utils";
import { canonicalizeTitle } from "@/lib/wiki-canonical";
import { normalizeWikiTitle, wikiTitlesMatch } from "@/lib/wiki-title";

function stripWikiFragment(title: string) {
  const hashIndex = title.indexOf("#");
  return hashIndex >= 0 ? title.slice(0, hashIndex) : title;
}

async function fetchArticleLinks(articleTitle: string) {
  try {
    const response = await fetch(
      `${API_BASE}/get_article_with_links/${encodeURIComponent(articleTitle)}`
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { links?: unknown };
    if (!data || !Array.isArray(data.links)) return null;
    if (data.links.some((link) => typeof link !== "string")) return null;
    return data.links as string[];
  } catch {
    return null;
  }
}

export function createLocalRaceDriver(sessionId: string): RaceDriver {
  return {
    mode: "local",
    capabilities: {
      canAddAi: true,
      canControlRun: () => true,
      canCancelRun: () => false,
      canRestartRun: () => false,
      canExport: true,
    },

    async makeMove({ runId, title }) {
      const session = getSession(sessionId);
      if (!session) return false;

      const run = session.runs.find((r) => r.id === runId) || null;
      if (!run) return false;
      if (run.kind !== "human") return false;
      if (run.status !== "running") return false;

      const nextArticleRaw = stripWikiFragment(title);
      const steps = run.steps;
      const currentArticleRaw = stripWikiFragment(
        steps[steps.length - 1]?.article || session.start_article
      );

      // Prevent double-counting when the iframe navigates to a section anchor.
      if (wikiTitlesMatch(nextArticleRaw, currentArticleRaw)) return true;

      const currentHops = Math.max(0, steps.length - 1);
      const nextHops = currentHops + 1;

      const autoStartTimer = session.human_timer?.auto_start_on_first_action !== false;
      if (autoStartTimer && run.timer_state && run.timer_state !== "running") {
        pauseHumanTimers({ sessionId, exceptRunId: run.id });
        resumeHumanTimerForRun({ sessionId, runId: run.id });
      }

      const at = nowIso();

      const [canonicalCurrent, canonicalNext, canonicalTarget] = await Promise.all([
        canonicalizeTitle(currentArticleRaw),
        canonicalizeTitle(nextArticleRaw),
        canonicalizeTitle(session.destination_article),
      ]);

      if (wikiTitlesMatch(canonicalNext, canonicalTarget)) {
        appendRunStep({
          sessionId,
          runId: run.id,
          step: { type: "win", article: session.destination_article, at },
        });
        finishRun({ sessionId, runId: run.id, result: "win", finishedAtIso: at });
        return true;
      }

      const links = await fetchArticleLinks(canonicalCurrent);
      if (links) {
        const outgoing = new Set(links.map((link) => normalizeWikiTitle(link)));
        if (!outgoing.has(normalizeWikiTitle(canonicalNext))) {
          return false;
        }
      }

      const maxSteps =
        typeof run.max_steps === "number"
          ? run.max_steps
          : typeof session.rules?.max_hops === "number"
            ? session.rules.max_hops
            : 20;

      if (nextHops >= maxSteps) {
        appendRunStep({
          sessionId,
          runId: run.id,
          step: {
            type: "lose",
            article: canonicalNext,
            at,
            metadata: { reason: "max_hops", max_hops: maxSteps },
          },
        });
        finishRun({ sessionId, runId: run.id, result: "lose", finishedAtIso: at });
        return true;
      }

      appendRunStep({
        sessionId,
        runId: run.id,
        step: { type: "move", article: canonicalNext, at },
      });
      return true;
    },

    abandonRun(runId) {
      abandonRun({ sessionId, runId });
    },

    deleteRuns(runIds) {
      deleteRuns({ sessionId, runIds });
    },

    forceWinRun(runId) {
      forceWinRun({ sessionId, runId });
    },

    pauseHumanTimers(exceptRunId) {
      pauseHumanTimers({ sessionId, exceptRunId });
    },

    resumeHumanTimerForRun(runId) {
      resumeHumanTimerForRun({ sessionId, runId });
    },

    pauseHumanTimerForRun(runId) {
      pauseHumanTimerForRun({ sessionId, runId });
    },
  };
}
