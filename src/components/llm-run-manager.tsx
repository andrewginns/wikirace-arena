"use client";

import { useCallback, useEffect, useRef } from "react";
import { API_BASE } from "@/lib/constants";
import { runLlmRace } from "@/lib/llm-runner";
import {
  appendRunStep,
  finishRun,
  forceWinRun,
  useSessionsStore,
} from "@/lib/session-store";
import type { RunV1, SessionV1 } from "@/lib/session-types";
import { normalizeWikiTitle, wikiTitlesMatch } from "@/lib/wiki-title";

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_LINKS: number | null = null;
const DEFAULT_MAX_TOKENS: number | null = null;

function getRunLimits(run: RunV1, session: SessionV1) {
  const sessionRules = session.rules;
  return {
    maxSteps:
      typeof run.max_steps === "number"
        ? run.max_steps
        : typeof sessionRules?.max_hops === "number"
        ? sessionRules.max_hops
        : DEFAULT_MAX_STEPS,
    maxLinks:
      typeof run.max_links === "number"
        ? run.max_links
        : sessionRules?.max_links === null
        ? null
        : typeof sessionRules?.max_links === "number"
        ? sessionRules.max_links
        : DEFAULT_MAX_LINKS,
    maxTokens:
      typeof run.max_tokens === "number"
        ? run.max_tokens
        : sessionRules?.max_tokens === null
        ? null
        : typeof sessionRules?.max_tokens === "number"
        ? sessionRules.max_tokens
        : DEFAULT_MAX_TOKENS,
  };
}

export default function LlmRunManager() {
  const { sessions } = useSessionsStore();
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  const canonicalTitleCacheRef = useRef<Map<string, string>>(new Map());
  const canonicalTitleInFlightRef = useRef<Map<string, Promise<string>>>(new Map());

  const canonicalizeTitle = useCallback(async (title: string) => {
    const key = normalizeWikiTitle(title);
    const cached = canonicalTitleCacheRef.current.get(key);
    if (cached) return cached;

    const inFlight = canonicalTitleInFlightRef.current.get(key);
    if (inFlight) return inFlight;

    const promise = (async () => {
      try {
        const response = await fetch(
          `${API_BASE}/canonical_title/${encodeURIComponent(title)}`
        );
        if (response.ok) {
          const data = (await response.json()) as { title?: unknown };
          if (typeof data.title === "string" && data.title.trim().length > 0) {
            canonicalTitleCacheRef.current.set(key, data.title);
            return data.title;
          }
        }
      } catch {
        // ignore
      }

      canonicalTitleCacheRef.current.set(key, title);
      return title;
    })();

    canonicalTitleInFlightRef.current.set(key, promise);
    try {
      return await promise;
    } finally {
      canonicalTitleInFlightRef.current.delete(key);
    }
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    const activeRunIds = new Set<string>();

    for (const [sessionId, session] of Object.entries(sessions)) {
      for (const run of session.runs) {
        if (run.kind !== "llm") continue;
        if (run.status !== "running") continue;
        if (!run.model || run.model.trim().length === 0) continue;

        const controllerAlreadyRunning = controllers.has(run.id);
        activeRunIds.add(run.id);
        if (controllerAlreadyRunning) continue;

        const controller = new AbortController();
        controllers.set(run.id, controller);

        const limits = getRunLimits(run, session);
        let lastArticle = run.steps[run.steps.length - 1]?.article || session.start_article;

        void (async () => {
          try {
            const [canonicalLast, canonicalTarget] = await Promise.all([
              canonicalizeTitle(lastArticle),
              canonicalizeTitle(session.destination_article),
            ]);

            if (controller.signal.aborted) return;

            if (wikiTitlesMatch(canonicalLast, canonicalTarget)) {
              forceWinRun({ sessionId, runId: run.id });
              return;
            }

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
  }, [canonicalizeTitle, sessions]);

  return null;
}
