"use client";

import { useEffect, useRef } from "react";
import { runLlmRace } from "@/lib/llm-runner";
import {
  appendRunStep,
  finishRun,
  forceWinRun,
  useSessionsStore,
} from "@/lib/session-store";
import type { RunV1 } from "@/lib/session-types";
import { wikiTitlesMatch } from "@/lib/wiki-title";

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_LINKS = 200;
const DEFAULT_MAX_TOKENS = 3000;

function getRunLimits(run: RunV1) {
  return {
    maxSteps: typeof run.max_steps === "number" ? run.max_steps : DEFAULT_MAX_STEPS,
    maxLinks: typeof run.max_links === "number" ? run.max_links : DEFAULT_MAX_LINKS,
    maxTokens: typeof run.max_tokens === "number" ? run.max_tokens : DEFAULT_MAX_TOKENS,
  };
}

export default function LlmRunManager() {
  const { sessions } = useSessionsStore();
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const controllers = controllersRef.current;
    const activeRunIds = new Set<string>();

    for (const [sessionId, session] of Object.entries(sessions)) {
      for (const run of session.runs) {
        if (run.kind !== "llm") continue;
        if (run.status !== "running") continue;
        if (!run.model || run.model.trim().length === 0) continue;

        const controllerAlreadyRunning = controllers.has(run.id);
        if (!controllerAlreadyRunning) {
          const lastArticle = run.steps[run.steps.length - 1]?.article || session.start_article;
          if (wikiTitlesMatch(lastArticle, session.destination_article)) {
            forceWinRun({ sessionId, runId: run.id });
            continue;
          }
        }

        activeRunIds.add(run.id);
        if (controllerAlreadyRunning) continue;

        const controller = new AbortController();
        controllers.set(run.id, controller);

        const limits = getRunLimits(run);
        let lastArticle = run.steps[run.steps.length - 1]?.article || session.start_article;

        void (async () => {
          try {
            const { result } = await runLlmRace({
              startArticle: session.start_article,
              destinationArticle: session.destination_article,
              model: run.model || "llm",
              apiBase: run.api_base,
              reasoningEffort: run.reasoning_effort,
              resumeFromSteps: run.steps,
              maxSteps: limits.maxSteps,
              maxLinks: limits.maxLinks,
              maxTokens: limits.maxTokens,
              signal: controller.signal,
              onStep: (step) => {
                if (controller.signal.aborted) return;
                lastArticle = step.article;
                appendRunStep({ sessionId, runId: run.id, step });
              },
            });

            if (controller.signal.aborted) return;
            if (result === "abandoned") return;
            finishRun({ sessionId, runId: run.id, result });
          } catch (err) {
            if (controller.signal.aborted) return;

            const message = err instanceof Error ? err.message : String(err);
            appendRunStep({
              sessionId,
              runId: run.id,
              step: {
                type: "lose",
                article: lastArticle,
                metadata: { reason: "error", error: message },
              },
            });
            finishRun({ sessionId, runId: run.id, result: "lose" });
          } finally {
            controllersRef.current.delete(run.id);
          }
        })();
      }
    }

    for (const [runId, controller] of Array.from(controllers.entries())) {
      if (activeRunIds.has(runId)) continue;
      controller.abort();
      controllers.delete(runId);
    }
  }, [sessions]);

  return null;
}
