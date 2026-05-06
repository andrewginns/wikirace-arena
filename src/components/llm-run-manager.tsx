import { useEffect, useRef } from "react";
import { runLlmRace } from "@/lib/llm-runner";
import { endLocalRunTrace, startLocalRunTrace } from "@/lib/local-run-tracing";
import {
  appendRunStep,
  finishRun,
  forceWinRun,
  useSessionsStore,
} from "@/lib/session-store";
import type { RunV1, SessionV1 } from "@/lib/session-types";
import { canonicalizeTitle } from "@/lib/wiki-canonical";
import { wikiTitlesMatch } from "@/lib/wiki-title";

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
        : run.max_links === null
        ? null
        : sessionRules?.max_links === null
        ? null
        : typeof sessionRules?.max_links === "number"
        ? sessionRules.max_links
        : DEFAULT_MAX_LINKS,
    maxTokens:
      typeof run.max_tokens === "number"
        ? run.max_tokens
        : run.max_tokens === null
        ? null
        : sessionRules?.max_tokens === null
        ? null
        : typeof sessionRules?.max_tokens === "number"
        ? sessionRules.max_tokens
        : DEFAULT_MAX_TOKENS,
  };
}

export default function LlmRunManager() {
  const { sessions, active_session_id } = useSessionsStore();
  const controllersRef = useRef<Map<string, AbortController>>(new Map());

  // In React StrictMode (dev), effects are mounted/unmounted twice. Abort any in-flight
  // controllers on unmount to avoid duplicate runners continuing in the background.
  useEffect(() => {
    const controllers = controllersRef.current;
    return () => {
      for (const controller of controllers.values()) {
        controller.abort();
      }
      controllers.clear();
    };
  }, []);

  useEffect(() => {
    const controllers = controllersRef.current;
    const activeRunKeys = new Set<string>();

    const activeSessionEntries = active_session_id && sessions[active_session_id]
      ? ([[active_session_id, sessions[active_session_id]]] as const)
      : [];

    for (const [sessionId, session] of activeSessionEntries) {
      for (const run of session.runs) {
        if (run.kind !== "llm") continue;
        if (run.status !== "running") continue;
        if (!run.model || run.model.trim().length === 0) continue;

        const runKey = `${sessionId}:${run.id}`;
        const controllerAlreadyRunning = controllers.has(runKey);
        activeRunKeys.add(runKey);
        if (controllerAlreadyRunning) continue;

        const controller = new AbortController();
        controllers.set(runKey, controller);

        const limits = getRunLimits(run, session);
        let lastArticle = run.steps[run.steps.length - 1]?.article || session.start_article;

        void (async () => {
          let traceContext: { sessionId: string; runId: string; traceparent: string } | undefined;

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

            const trace = await startLocalRunTrace({
              sessionId,
              runId: run.id,
              model: run.model || "llm",
              apiBase: run.api_base,
              openaiApiMode: run.openai_api_mode,
              openaiReasoningEffort: run.openai_reasoning_effort,
              openaiReasoningSummary: run.openai_reasoning_summary,
              anthropicThinkingBudgetTokens: run.anthropic_thinking_budget_tokens,
              googleThinkingConfig: run.google_thinking_config,
            });
            if (trace) {
              traceContext = { sessionId, runId: run.id, traceparent: trace.traceparent };
            }

            const { result } = await runLlmRace({
              startArticle: session.start_article,
              destinationArticle: session.destination_article,
              model: run.model || "llm",
              apiBase: run.api_base,
              openaiApiMode: run.openai_api_mode,
              openaiReasoningEffort: run.openai_reasoning_effort,
              openaiReasoningSummary: run.openai_reasoning_summary,
              anthropicThinkingBudgetTokens: run.anthropic_thinking_budget_tokens,
              googleThinkingConfig: run.google_thinking_config,
              traceContext,
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
            if (traceContext) {
              await endLocalRunTrace({ sessionId: traceContext.sessionId, runId: traceContext.runId });
            }
            if (controllersRef.current.get(runKey) === controller) {
              controllersRef.current.delete(runKey);
            }
          }
        })();
      }
    }

    for (const [runKey, controller] of Array.from(controllers.entries())) {
      if (activeRunKeys.has(runKey)) continue;
      controller.abort();
      controllers.delete(runKey);
    }
  }, [active_session_id, sessions]);

  return null;
}
