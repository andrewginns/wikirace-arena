"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import ModelPicker from "@/components/model-picker";
import { parseOptionalPositiveInt } from "@/lib/number-utils";
import {
  allPresetModelDrafts,
  gpt52ReasoningSweepDrafts,
} from "@/lib/model-presets";
import type { AddAiArgs } from "@/lib/race-driver";

type ExistingLlmRunLike = {
  kind: string;
  model?: string | null;
  api_base?: string | null;
  openai_api_mode?: string | null;
  openai_reasoning_effort?: string | null;
  anthropic_thinking_budget_tokens?: number;
};

type AddAiDefaults = {
  max_hops: number;
  max_links: number | null;
  max_tokens: number | null;
};

function keyForDraft(draft: {
  model: string;
  api_base?: string;
  openai_api_mode?: string;
  openai_reasoning_effort?: string;
  anthropic_thinking_budget_tokens?: number;
}) {
  return `llm:${draft.model}:${draft.api_base || ""}:${draft.openai_api_mode || ""}:${draft.openai_reasoning_effort || ""}:${draft.anthropic_thinking_budget_tokens || ""}`;
}

export default function AddAiForm({
  mode,
  modelList,
  defaults,
  existingRuns,
  onAddAi,
  initialModel,
  onClose,
}: {
  mode: "inline" | "dialog";
  modelList: string[];
  defaults: AddAiDefaults;
  existingRuns: readonly ExistingLlmRunLike[];
  onAddAi: (args: AddAiArgs) => Promise<unknown>;
  initialModel?: string;
  onClose?: () => void;
}) {
  const [addAiPresetsOpen, setAddAiPresetsOpen] = useState(false);
  const [addAiLoading, setAddAiLoading] = useState(false);

  const [aiModel, setAiModel] = useState(() => {
    if (typeof initialModel === "string") return initialModel;
    return mode === "inline" ? modelList[0] || "" : "";
  });
  const [aiName, setAiName] = useState("");
  const [aiApiBase, setAiApiBase] = useState("");
  const [aiOpenaiApiMode, setAiOpenaiApiMode] = useState("");
  const [aiOpenaiReasoningEffort, setAiOpenaiReasoningEffort] = useState("");
  const [aiMaxSteps, setAiMaxSteps] = useState("");
  const [aiMaxLinks, setAiMaxLinks] = useState("");
  const [aiMaxTokens, setAiMaxTokens] = useState("");

  useEffect(() => {
    if (mode !== "inline") return;
    if (aiModel.trim().length > 0) return;
    if (modelList.length === 0) return;
    setAiModel(modelList[0] || "");
  }, [aiModel, mode, modelList]);

  const existingKeys = useMemo(() => {
    return new Set(
      existingRuns
        .filter((run) => run.kind === "llm")
        .map((run) =>
          keyForDraft({
            model: run.model || "",
            api_base: run.api_base || undefined,
            openai_api_mode: run.openai_api_mode || undefined,
            openai_reasoning_effort: run.openai_reasoning_effort || undefined,
            anthropic_thinking_budget_tokens: run.anthropic_thinking_budget_tokens,
          })
        )
    );
  }, [existingRuns]);

  const resetOptionalFields = () => {
    setAiName("");
    setAiApiBase("");
    setAiOpenaiApiMode("");
    setAiOpenaiReasoningEffort("");
    setAiMaxSteps("");
    setAiMaxLinks("");
    setAiMaxTokens("");
  };

  const addPreset = async (drafts: AddAiArgs[]) => {
    setAddAiLoading(true);
    try {
      let addedAny = false;
      const mutableKeys = new Set(existingKeys);

      for (const draft of drafts) {
        const model = draft.model.trim();
        if (!model) continue;

        const key = keyForDraft({
          model,
          api_base: draft.api_base,
          openai_api_mode: draft.openai_api_mode,
          openai_reasoning_effort: draft.openai_reasoning_effort,
          anthropic_thinking_budget_tokens: draft.anthropic_thinking_budget_tokens,
        });
        if (mutableKeys.has(key)) continue;

        const result = await onAddAi({ ...draft, model });
        if (!result) break;

        mutableKeys.add(key);
        addedAny = true;
      }

      if (addedAny && mode === "dialog") {
        onClose?.();
      }
    } finally {
      setAddAiLoading(false);
    }
  };

  const allPresetModels = () => {
    const drafts = allPresetModelDrafts(modelList).map((draft) => ({
      model: draft.model,
    }));
    void addPreset(drafts);
  };

  const gpt52ReasoningSweep = () => {
    const drafts = gpt52ReasoningSweepDrafts().map((draft) => ({
      model: draft.model,
      player_name: draft.name || undefined,
      openai_reasoning_effort: draft.openaiReasoningEffort,
    }));
    void addPreset(drafts);
  };

  const submitAddAi = () => {
    if (aiModel.trim().length === 0) return;

    setAddAiLoading(true);
    void (async () => {
      try {
        const result = await onAddAi({
          model: aiModel.trim(),
          player_name: aiName.trim() || undefined,
          api_base: aiApiBase.trim() || undefined,
          openai_api_mode: aiOpenaiApiMode.trim() || undefined,
          openai_reasoning_effort: aiOpenaiReasoningEffort.trim() || undefined,
          max_steps: parseOptionalPositiveInt(aiMaxSteps, "undefined"),
          max_links: parseOptionalPositiveInt(aiMaxLinks, "undefined"),
          max_tokens: parseOptionalPositiveInt(aiMaxTokens, "undefined"),
        });

        if (mode === "dialog") {
          if (!result) return;
          resetOptionalFields();
          onClose?.();
          return;
        }

        resetOptionalFields();
      } finally {
        setAddAiLoading(false);
      }
    })();
  };

  return (
    <>
      {mode === "inline" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="text-[11px] text-muted-foreground">Quick add:</div>
          {modelList.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={addAiLoading}
              onClick={() => {
                const model = modelList[0];
                if (!model) return;
                setAddAiLoading(true);
                void (async () => {
                  try {
                    await onAddAi({ model });
                  } finally {
                    setAddAiLoading(false);
                  }
                })();
              }}
            >
              Add {modelList[0]}
            </Button>
          ) : null}

          <Popover open={addAiPresetsOpen} onOpenChange={setAddAiPresetsOpen}>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" disabled={addAiLoading}>
                Presets
              </Button>
            </PopoverTrigger>
            <PopoverContent className="p-1 w-72" align="start">
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Add multiple AI racers at once (additive).
              </div>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                disabled={addAiLoading || modelList.length === 0}
                onClick={() => {
                  setAddAiPresetsOpen(false);
                  allPresetModels();
                }}
              >
                All preset models
              </Button>
              <Button
                type="button"
                variant="ghost"
                className="w-full justify-start"
                disabled={addAiLoading}
                onClick={() => {
                  setAddAiPresetsOpen(false);
                  gpt52ReasoningSweep();
                }}
              >
                GPT-5.2 reasoning sweep
              </Button>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {mode === "dialog" && (
        <Popover open={addAiPresetsOpen} onOpenChange={setAddAiPresetsOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" disabled={addAiLoading}>
              Presets
            </Button>
          </PopoverTrigger>
          <PopoverContent className="p-1 w-72" align="start">
            <div className="px-2 py-1.5 text-xs text-muted-foreground">
              Add multiple AI racers at once (additive).
            </div>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start"
              disabled={addAiLoading || modelList.length === 0}
              onClick={() => {
                setAddAiPresetsOpen(false);
                allPresetModels();
              }}
            >
              All preset models
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full justify-start"
              disabled={addAiLoading}
              onClick={() => {
                setAddAiPresetsOpen(false);
                gpt52ReasoningSweep();
              }}
            >
              GPT-5.2 reasoning sweep
            </Button>
          </PopoverContent>
        </Popover>
      )}

      <div className={mode === "dialog" ? "space-y-3" : "mt-3 space-y-3"}>
        <ModelPicker
          label="Model"
          value={aiModel}
          onValueChange={setAiModel}
          options={modelList}
          placeholder="Type any PydanticAI model id"
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Display name (optional)</Label>
            <Input
              value={aiName}
              onChange={(e) => setAiName(e.target.value)}
              placeholder={mode === "dialog" ? "Bot #1" : "e.g. Bot #1"}
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">OpenAI reasoning effort (optional)</Label>
            <Input
              value={aiOpenaiReasoningEffort}
              onChange={(e) => setAiOpenaiReasoningEffort(e.target.value)}
              placeholder="low / medium / high / xhigh"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">API base override (optional)</Label>
            <Input
              value={aiApiBase}
              onChange={(e) => setAiApiBase(e.target.value)}
              placeholder="http://localhost:8001/v1"
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">OpenAI API mode (optional)</Label>
            <Input
              value={aiOpenaiApiMode}
              onChange={(e) => setAiOpenaiApiMode(e.target.value)}
              placeholder="chat / responses"
              className="mt-1"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label className="text-xs">Max steps</Label>
            <Input
              value={aiMaxSteps}
              onChange={(e) => setAiMaxSteps(e.target.value)}
              inputMode="numeric"
              placeholder={`Default (${defaults.max_hops})`}
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Max links</Label>
            <Input
              value={aiMaxLinks}
              onChange={(e) => setAiMaxLinks(e.target.value)}
              inputMode="numeric"
              placeholder={
                defaults.max_links === null
                  ? "Default (Unlimited)"
                  : `Default (${defaults.max_links})`
              }
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">Max tokens</Label>
            <Input
              value={aiMaxTokens}
              onChange={(e) => setAiMaxTokens(e.target.value)}
              inputMode="numeric"
              placeholder={
                defaults.max_tokens === null
                  ? "Default (Unlimited)"
                  : `Default (${defaults.max_tokens})`
              }
              className="mt-1"
            />
          </div>
        </div>

        {mode === "inline" && (
          <Button
            size="sm"
            disabled={addAiLoading || aiModel.trim().length === 0}
            onClick={submitAddAi}
          >
            {addAiLoading ? "Adding…" : "Add AI"}
          </Button>
        )}
      </div>

      {mode === "dialog" && (
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline">Cancel</Button>
          </DialogClose>
          <Button disabled={addAiLoading || aiModel.trim().length === 0} onClick={submitAddAi}>
            {addAiLoading ? "Adding…" : "Add AI"}
          </Button>
        </DialogFooter>
      )}
    </>
  );
}
