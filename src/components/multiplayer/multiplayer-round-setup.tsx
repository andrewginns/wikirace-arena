"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { VirtualizedCombobox } from "@/components/ui/virtualized-combobox";
import { ErrorCallout, ServerOfflineCallout } from "@/components/ui/callouts";
import WikiArticlePreview from "@/components/wiki-article-preview";
import { pickRandom, pickRandomDistinctPair } from "@/lib/matchup-random";
import { setupNewRound } from "@/lib/multiplayer-store";
import type { MultiplayerRoomV1 } from "@/lib/multiplayer-types";
import { cn } from "@/lib/utils";
import { ArrowLeftRight, Shuffle } from "lucide-react";
import popularNodes from "../../../results/popular_nodes.json";

export default function MultiplayerRoundSetup({
  room,
  allArticles,
  isServerConnected,
  error,
  onCancel,
}: {
  room: MultiplayerRoomV1;
  allArticles: string[];
  isServerConnected: boolean;
  error: string | null;
  onCancel: () => void;
}) {
  const [startPage, setStartPage] = useState(room.start_article);
  const [targetPage, setTargetPage] = useState(room.destination_article);
  const [loading, setLoading] = useState(false);

  const options = useMemo(() => {
    if (allArticles.length > 0) return allArticles;
    return [startPage, targetPage];
  }, [allArticles, startPage, targetPage]);

  const randomPool = useMemo(() => {
    if (popularNodes.length > 0) return popularNodes;
    return options;
  }, [options]);

  const canSubmit =
    isServerConnected &&
    startPage.trim().length > 0 &&
    targetPage.trim().length > 0 &&
    startPage.trim() !== targetPage.trim() &&
    !loading;

  const selectRandomArticle = (setter: (value: string) => void) => {
    const picked = pickRandom(randomPool);
    if (!picked) return;
    setter(picked);
  };

  const selectRandomMatchup = () => {
    const matchup = pickRandomDistinctPair(randomPool);
    if (!matchup) return;
    setStartPage(matchup.start);
    setTargetPage(matchup.target);
  };

  const swapPages = () => {
    setStartPage(targetPage);
    setTargetPage(startPage);
  };

	  return (
	    <div className="space-y-4">
	      {error && (
	        <ErrorCallout>{error}</ErrorCallout>
	      )}

	      {!isServerConnected && (
	        <ServerOfflineCallout>
	          Server not connected. Start the API server first.
	        </ServerOfflineCallout>
	      )}

      <Card className="p-4">
        <div className="text-sm font-medium">Start a new round</div>
        <div className="mt-1 text-xs text-muted-foreground">
          This resets the current race for everyone in the room.
        </div>

        <Separator className="my-3" />

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={selectRandomMatchup}
            disabled={randomPool.length === 0}
          >
            <Shuffle className="h-4 w-4" />
            Random matchup
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={swapPages}
          >
            <ArrowLeftRight className="h-4 w-4" />
            Swap
          </Button>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label className="text-xs">Start</Label>
            <div className="mt-1 space-y-2">
              <VirtualizedCombobox
                options={options}
                width="100%"
                value={startPage}
                onValueChange={setStartPage}
                wrapValue
              />
              <div className="flex items-center justify-between gap-2">
                <WikiArticlePreview title={startPage} size={40} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 whitespace-nowrap"
                  onClick={() => selectRandomArticle(setStartPage)}
                  disabled={randomPool.length === 0}
                >
                  <Shuffle className="h-3.5 w-3.5 mr-1" />
                  Random
                </Button>
              </div>
            </div>
          </div>

          <div>
            <Label className="text-xs">Target</Label>
            <div className="mt-1 space-y-2">
              <VirtualizedCombobox
                options={options}
                width="100%"
                value={targetPage}
                onValueChange={setTargetPage}
                wrapValue
              />
              <div className="flex items-center justify-between gap-2">
                <WikiArticlePreview title={targetPage} size={40} />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 whitespace-nowrap"
                  onClick={() => selectRandomArticle(setTargetPage)}
                  disabled={randomPool.length === 0}
                >
                  <Shuffle className="h-3.5 w-3.5 mr-1" />
                  Random
                </Button>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={loading}>
            Back
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            className={cn("sm:min-w-[180px]", loading && "opacity-90")}
            onClick={() => {
              if (!canSubmit) return;
              setLoading(true);
              void (async () => {
                try {
                  const next = await setupNewRound(startPage.trim(), targetPage.trim());
                  if (!next) return;
                  onCancel();
                } finally {
                  setLoading(false);
                }
              })();
            }}
          >
            {loading ? "Starting…" : "Continue to lobby"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
