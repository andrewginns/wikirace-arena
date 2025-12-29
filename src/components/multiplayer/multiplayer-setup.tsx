"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { VirtualizedCombobox } from "@/components/ui/virtualized-combobox";
import WikiArticlePreview from "@/components/wiki-article-preview";
import { cn } from "@/lib/utils";
import { ArrowLeftRight, Shuffle } from "lucide-react";
import {
  createRoom,
  joinRoom,
  useMultiplayerStore,
} from "@/lib/multiplayer-store";
import popularNodes from "../../../results/popular_nodes.json";

type Preset = {
  id: "sprint" | "classic" | "marathon";
  name: string;
  description: string;
  rules: { maxHops: number; maxLinks: number | null; maxTokens: number | null };
};

const PRESETS: Preset[] = [
  {
    id: "sprint",
    name: "Sprint",
    description: "Fast rounds. Great for humans.",
    rules: { maxHops: 12, maxLinks: 200, maxTokens: 1500 },
  },
  {
    id: "classic",
    name: "Classic",
    description: "Balanced default.",
    rules: { maxHops: 20, maxLinks: null, maxTokens: null },
  },
  {
    id: "marathon",
    name: "Marathon",
    description: "More hops + more thinking time.",
    rules: { maxHops: 35, maxLinks: null, maxTokens: null },
  },
];

function toOptionalPositiveInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const asInt = Math.floor(parsed);
  return asInt > 0 ? asInt : null;
}

function pickRandom(items: string[]) {
  if (items.length === 0) return null;
  const idx = Math.floor(Math.random() * items.length);
  return items[idx] || null;
}

export default function MultiplayerSetup({
  allArticles,
  isServerConnected,
  prefillRoomId,
}: {
  allArticles: string[];
  isServerConnected: boolean;
  prefillRoomId?: string;
}) {
  const { error, player_name } = useMultiplayerStore();
  const [createLoading, setCreateLoading] = useState(false);
  const [joinLoading, setJoinLoading] = useState(false);

  const [ownerName, setOwnerName] = useState<string>(player_name || "Host");
  const [roomTitle, setRoomTitle] = useState<string>("");
  const [startPage, setStartPage] = useState<string>("Capybara");
  const [targetPage, setTargetPage] = useState<string>("Pokémon");
  const [maxHops, setMaxHops] = useState<string>("20");
  const [maxLinks, setMaxLinks] = useState<string>("");
  const [maxTokens, setMaxTokens] = useState<string>("");
  const [includeImageLinks, setIncludeImageLinks] = useState<boolean>(false);
  const [disableLinksView, setDisableLinksView] = useState<boolean>(false);

  const matchedPreset = useMemo(() => {
    const hops = toOptionalPositiveInt(maxHops) ?? 20;
    const links = toOptionalPositiveInt(maxLinks);
    const tokens = toOptionalPositiveInt(maxTokens);
    return (
      PRESETS.find(
        (p) =>
          p.rules.maxHops === hops &&
          p.rules.maxLinks === links &&
          p.rules.maxTokens === tokens
      ) || null
    );
  }, [maxHops, maxLinks, maxTokens]);

  const [joinRoomId, setJoinRoomId] = useState<string>(prefillRoomId || "");
  const [joinName, setJoinName] = useState<string>(player_name || "");
  const joinNameWasEmptyRef = useRef(joinName.trim().length === 0);
  const joinNameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!prefillRoomId) return;
    if (!joinNameWasEmptyRef.current) return;
    joinNameInputRef.current?.focus();
  }, [prefillRoomId]);

  const options = useMemo(() => {
    if (allArticles.length > 0) return allArticles;
    return [startPage, targetPage];
  }, [allArticles, startPage, targetPage]);

  const randomPool = useMemo(() => {
    if (popularNodes.length > 0) return popularNodes;
    return options;
  }, [options]);

  const selectRandomArticle = (setter: (article: string) => void) => {
    const picked = pickRandom(randomPool);
    if (!picked) return;
    setter(picked);
  };

  const selectRandomMatchup = () => {
    const start = pickRandom(randomPool);
    if (!start) return;
    let target = pickRandom(randomPool);
    if (!target) return;
    let tries = 0;
    while (target === start && tries < 10) {
      target = pickRandom(randomPool);
      if (!target) return;
      tries += 1;
    }

    setStartPage(start);
    setTargetPage(target);
  };

  const swapPages = () => {
    setStartPage(targetPage);
    setTargetPage(startPage);
  };

  const canCreate =
    isServerConnected &&
    ownerName.trim().length > 0 &&
    startPage.trim().length > 0 &&
    targetPage.trim().length > 0 &&
    startPage.trim() !== targetPage.trim() &&
    !createLoading;

  const canJoin =
    isServerConnected &&
    joinRoomId.trim().length > 0 &&
    joinName.trim().length > 0 &&
    !joinLoading;

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-foreground">
          {error}
        </div>
      )}

      {!isServerConnected && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
          Server not connected. Start the API server first.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="text-sm font-medium">Create a room</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Start a shared race, then send the invite link.
          </div>

          <Separator className="my-3" />

          <div className="space-y-3">
            <div>
              <Label className="text-xs">Your name (host)</Label>
              <Input
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
                placeholder="Host"
                className="mt-1"
              />
            </div>

            <div>
              <Label className="text-xs">Room title (optional)</Label>
              <Input
                value={roomTitle}
                onChange={(e) => setRoomTitle(e.target.value)}
                placeholder="e.g. Lunch break race"
                className="mt-1"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 flex flex-wrap items-center justify-end gap-2">
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

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="sm:col-span-3 rounded-md border bg-muted/10 p-3">
                <div className="text-xs font-medium">Rules preset</div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {PRESETS.map((preset) => {
                    const selected = matchedPreset?.id === preset.id;
                    return (
                      <Button
                        key={preset.id}
                        type="button"
                        variant={selected ? "secondary" : "outline"}
                        size="sm"
                        onClick={() => {
                          setMaxHops(String(preset.rules.maxHops));
                          setMaxLinks(
                            preset.rules.maxLinks === null
                              ? ""
                              : String(preset.rules.maxLinks)
                          );
                          setMaxTokens(
                            preset.rules.maxTokens === null
                              ? ""
                              : String(preset.rules.maxTokens)
                          );
                        }}
                      >
                        {preset.name}
                      </Button>
                    );
                  })}
                </div>
                <div className="mt-2 text-[11px] text-muted-foreground">
                  {matchedPreset?.description || "Custom rules."}
                </div>
              </div>

              <div>
                <Label className="text-xs">Max hops</Label>
                <Input
                  value={maxHops}
                  onChange={(e) => setMaxHops(e.target.value)}
                  inputMode="numeric"
                  className="mt-1"
                />
              </div>
              <div>
                <Label className="text-xs">Max links (future AI)</Label>
                <Input
                  value={maxLinks}
                  onChange={(e) => setMaxLinks(e.target.value)}
                  inputMode="numeric"
                  placeholder="Unlimited"
                  className={cn("mt-1", !maxLinks && "text-muted-foreground")}
                />
              </div>
              <div>
                <Label className="text-xs">Max tokens (future AI)</Label>
                <Input
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(e.target.value)}
                  inputMode="numeric"
                  placeholder="Unlimited"
                  className={cn("mt-1", !maxTokens && "text-muted-foreground")}
                />
              </div>

              <div className="sm:col-span-3 rounded-md border bg-muted/10 p-3 flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">Include image-only links</div>
                  <div className="text-[11px] text-muted-foreground">
                    Show links that only appear as icons/images (e.g. flags).
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={includeImageLinks}
                  onChange={(e) => setIncludeImageLinks(e.target.checked)}
                  aria-label="Include image-only links"
                />
              </div>

              <div className="sm:col-span-3 rounded-md border bg-muted/10 p-3 flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-xs font-medium">Disable links view</div>
                  <div className="text-[11px] text-muted-foreground">
                    Hides the Links/Split panel controls (link clicking in the article still works).
                  </div>
                </div>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={disableLinksView}
                  onChange={(e) => setDisableLinksView(e.target.checked)}
                  aria-label="Disable links view"
                />
              </div>
            </div>

            <Button
              className="w-full"
              disabled={!canCreate}
              onClick={() => {
                if (!canCreate) return;
                setCreateLoading(true);
                void (async () => {
                  try {
                    await createRoom({
                      start_article: startPage,
                      destination_article: targetPage,
                      title: roomTitle.trim() || undefined,
                      owner_name: ownerName.trim() || undefined,
                      rules: {
                        max_hops: toOptionalPositiveInt(maxHops) ?? 20,
                        max_links: toOptionalPositiveInt(maxLinks),
                        max_tokens: toOptionalPositiveInt(maxTokens),
                        include_image_links: includeImageLinks,
                        disable_links_view: disableLinksView,
                      },
                    });
                  } finally {
                    setCreateLoading(false);
                  }
                })();
              }}
            >
              {createLoading ? "Creating…" : "Create room"}
            </Button>
          </div>
        </Card>

        <Card className="p-4">
          <div className="text-sm font-medium">Join a room</div>
          <div className="mt-1 text-xs text-muted-foreground">
            Enter a room code (or open an invite link) and your name.
          </div>

          <Separator className="my-3" />

          <div className="space-y-3">
            <div>
              <Label className="text-xs">Room code</Label>
              <Input
                value={joinRoomId}
                onChange={(e) => setJoinRoomId(e.target.value)}
                placeholder="2Q775B4R or room_2Q775B4R"
                className="mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Your name</Label>
              <Input
                value={joinName}
                ref={joinNameInputRef}
                onChange={(e) => setJoinName(e.target.value)}
                placeholder="Player"
                className="mt-1"
              />
            </div>

            <Button
              variant="secondary"
              className="w-full"
              disabled={!canJoin}
              onClick={() => {
                if (!canJoin) return;
                setJoinLoading(true);
                void (async () => {
                  try {
                    await joinRoom(joinRoomId.trim(), joinName.trim());
                  } finally {
                    setJoinLoading(false);
                  }
                })();
              }}
            >
              {joinLoading ? "Joining…" : "Join room"}
            </Button>

            <div className="text-xs text-muted-foreground">
              Tip: multiplayer works best in single-server mode (build + run API)
              so everyone connects to the same origin.
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
