"use client";

import q3Results from "../../results/qwen3.json"
import q3_30B_A3B_Results from "../../results/qwen3-30B-A3-results.json"
// import mockResults from "../../qwen3-final-results.json"
import { useMemo, useState, useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";
import ForceDirectedGraph from "@/components/force-directed-graph";
import RunsList from "@/components/runs-list";
import { cn } from "@/lib/utils";
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from "@/components/ui/select";
import { Run as ForceGraphRun } from "@/components/reasoning-trace";
import HopsSparkline from "@/components/hops-sparkline";
import WikiSummaryCard from "@/components/wiki-summary-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/ui/status-chip";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Check, Copy, Trash2, UploadIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { addViewerDataset, removeViewerDataset, useViewerDatasetsStore } from "@/lib/viewer-datasets";
import { formatHops, viewerRunHops } from "@/lib/hops";
import { getChartPalette } from "@/lib/theme-colors";

const defaultModels = {
  "Qwen3-14B": q3Results,
  "Qwen3-30B-A3B": q3_30B_A3B_Results,
}

// Use the type expected by RunsList
interface Run {
  start_article: string;
  destination_article: string;
  steps: string[];
  result: string;
  near_miss?: boolean;
}

// Interface for model statistics
interface ModelStats {
  winPercentage: number;
  avgHops: number;
  stdDevHops: number;
  totalRuns: number;
  wins: number;
  medianHops: number;
  minHops: number;
  maxHops: number;
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function ViewerTab({
  handleTryRun,
  onGoToPlayTab,
  showPlayCta,
}: {
  handleTryRun: (startArticle: string, destinationArticle: string) => void;
  onGoToPlayTab?: () => void;
  showPlayCta?: boolean;
}) {
  const { datasets } = useViewerDatasetsStore();
  const [selectedRun, setSelectedRun] = useState<number | null>(null);
  const [pauseAutoplayToken, setPauseAutoplayToken] = useState<number | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("Qwen3-14B");
  const [modelStats, setModelStats] = useState<ModelStats | null>(null);
  const [importText, setImportText] = useState<string>("");
  const [importName, setImportName] = useState<string>("");
  const [importError, setImportError] = useState<string | null>(null);
  const [showWinsOnly, setShowWinsOnly] = useState<boolean>(true);
  const [pendingSelectRun, setPendingSelectRun] = useState<Run | null>(null);
  const [graphFocusMode, setGraphFocusMode] = useState<"all" | "selected">("all");
  const [previewArticle, setPreviewArticle] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [compareSelectedRunIds, setCompareSelectedRunIds] = useState<Set<number>>(
    () => new Set()
  );
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareHop, setCompareHop] = useState(0);
  
  const savedModels = useMemo(() => {
    const obj: Record<string, unknown> = {};
    for (const dataset of datasets) {
      obj[`Saved: ${dataset.name}`] = dataset.data;
    }
    return obj;
  }, [datasets]);
  
  const models = useMemo(() => {
    return {
      ...defaultModels,
      ...savedModels,
    };
  }, [savedModels]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const comparePalette = useMemo(() => getChartPalette(), []);

  const winRuns = useMemo(() => runs.filter((run) => run.result === "win"), [runs]);
  const winHopCounts = useMemo(
    () => winRuns.map((run) => viewerRunHops(run)),
    [winRuns]
  );
  const bestRun = useMemo(() => {
    if (winRuns.length === 0) return null;
    return winRuns.reduce((best, run) => {
      const bestHops = viewerRunHops(best);
      const runHops = viewerRunHops(run);
      return runHops < bestHops ? run : best;
    });
  }, [winRuns]);
  const worstRun = useMemo(() => {
    if (runs.length === 0) return null;
    return runs.reduce((worst, run) => {
      const worstHops = viewerRunHops(worst);
      const runHops = viewerRunHops(run);
      return runHops > worstHops ? run : worst;
    });
  }, [runs]);

  useEffect(() => {
    // Keep selected model valid as models change.
    if (!(selectedModel in models)) {
      const first = Object.keys(models)[0];
      if (first) setSelectedModel(first);
    }
  }, [models, selectedModel]);

  useEffect(() => {
    // Convert the model data to the format expected by RunsList
    const convertedRuns: Run[] = models[selectedModel]?.runs?.map((run: {
      start_article: string;
      destination_article: string;
      steps: { type: string; article: string }[];
      result: string;
    }) => ({
      start_article: run.start_article,
      destination_article: run.destination_article,
      steps: run.steps.map((step: { article: string }) => step.article),
      result: run.result
    })) || [];
    const winRunsForModel = convertedRuns.filter((run) => run.result === "win");
    const minWinHops =
      winRunsForModel.length > 0
        ? Math.min(...winRunsForModel.map((run) => viewerRunHops(run)))
        : null;
    const withNearMiss: Run[] = convertedRuns.map((run) => ({
      ...run,
      near_miss:
        minWinHops !== null &&
        run.result !== "win" &&
        viewerRunHops(run) <= minWinHops + 2,
    }));
    setRuns(withNearMiss);

    // Calculate model statistics
    const totalRuns = convertedRuns.length;
    const wins = winRunsForModel.length;
    const winPercentage = totalRuns > 0 ? (wins / totalRuns) * 100 : 0;
    
    // Calculate hops statistics for winning runs (hops = link-clicks/moves, not nodes)
    const hopCounts = winRunsForModel.map((run) => viewerRunHops(run));
    const avgHops = hopCounts.length > 0 
      ? hopCounts.reduce((sum, count) => sum + count, 0) / hopCounts.length 
      : 0;
    
    // Calculate standard deviation
    const variance = hopCounts.length > 0
      ? hopCounts.reduce((sum, count) => sum + Math.pow(count - avgHops, 2), 0) / hopCounts.length
      : 0;
    const stdDevHops = Math.sqrt(variance);

    // Calculate median, min, max steps
    const sortedHops = [...hopCounts].sort((a, b) => a - b);
    const medianHops = hopCounts.length > 0
      ? hopCounts.length % 2 === 0
        ? (sortedHops[hopCounts.length / 2 - 1] + sortedHops[hopCounts.length / 2]) / 2
        : sortedHops[Math.floor(hopCounts.length / 2)]
      : 0;
    const minHops = hopCounts.length > 0 ? Math.min(...hopCounts) : 0;
    const maxHops = hopCounts.length > 0 ? Math.max(...hopCounts) : 0;

    setModelStats({
      winPercentage,
      avgHops,
      stdDevHops,
      totalRuns,
      wins,
      medianHops,
      minHops,
      maxHops
    });
  }, [selectedModel, models]);

  const handleRunSelect = (runId: number) => {
    setSelectedRun(runId);
  };

  const pauseAutoplay = () => {
    setPauseAutoplayToken(Date.now());
  };

  const filterRuns = useMemo(() => {
    if (showWinsOnly) return runs.filter((run) => run.result === "win");
    return runs;
  }, [runs, showWinsOnly]);

  const selectedRunData = selectedRun === null ? null : filterRuns[selectedRun] || null;

  const compareRunIds = useMemo(() => {
    return Array.from(compareSelectedRunIds).sort((a, b) => a - b);
  }, [compareSelectedRunIds]);

  useEffect(() => {
    setCompareSelectedRunIds(new Set());
    setCompareEnabled(false);
    setCompareHop(0);
  }, [selectedModel, showWinsOnly]);

  useEffect(() => {
    if (!selectedRunData) {
      setPreviewArticle(null);
      return;
    }
    const last =
      selectedRunData.steps[selectedRunData.steps.length - 1] ||
      selectedRunData.start_article;
    setPreviewArticle(last);
  }, [selectedRunData]);

  const selectRunFromSummary = (run: Run | null) => {
    if (!run) return;
    pauseAutoplay();

    const idx = filterRuns.indexOf(run);
    if (idx >= 0) {
      setSelectedRun(idx);
      return;
    }

    // The run is hidden by the wins-only filter (or filtered out); expand and then select.
    setSelectedRun(null);
    setPendingSelectRun(run);
    setShowWinsOnly(false);
  };

  useEffect(() => {
    if (!pendingSelectRun) return;
    const idx = filterRuns.indexOf(pendingSelectRun);
    if (idx < 0) return;
    setSelectedRun(idx);
    setPendingSelectRun(null);
  }, [filterRuns, pendingSelectRun]);

  useEffect(() => {
    if (selectedRunData || graphFocusMode !== "selected") return;
    setGraphFocusMode("all");
  }, [graphFocusMode, selectedRunData]);

  useEffect(() => {
    if (selectedRun === null) return;
    if (filterRuns.length === 0) {
      setSelectedRun(null);
      return;
    }
    if (selectedRun > filterRuns.length - 1) {
      setSelectedRun(0);
    }
  }, [filterRuns.length, selectedRun]);

  // Convert the runs to the format expected by ForceDirectedGraph
  const forceGraphRuns = useMemo(() => {
    return filterRuns.map((run): ForceGraphRun => ({
      start_article: run.start_article,
      destination_article: run.destination_article,
      steps: run.steps.map(article => ({ type: "move", article }))
    }));
  }, [filterRuns]);

  const compareColorByRunId = useMemo(() => {
    const map: Record<number, string> = {};
    for (let i = 0; i < compareRunIds.length; i++) {
      map[compareRunIds[i]!] = comparePalette[i % comparePalette.length]!;
    }
    return map;
  }, [comparePalette, compareRunIds]);

  const compareMaxHop = useMemo(() => {
    if (compareRunIds.length < 2) return 0;
    let maxHop = 0;
    for (const runId of compareRunIds) {
      const steps = forceGraphRuns[runId]?.steps ?? [];
      maxHop = Math.max(maxHop, Math.max(0, steps.length - 1));
    }
    return maxHop;
  }, [compareRunIds, forceGraphRuns]);

  const compareHopClamped = useMemo(() => {
    return clampNumber(compareHop, 0, compareMaxHop);
  }, [compareHop, compareMaxHop]);

  useEffect(() => {
    if (!compareEnabled) return;
    if (compareRunIds.length < 2) {
      setCompareEnabled(false);
      return;
    }
    setCompareHop((prev) => clampNumber(prev, 0, compareMaxHop));
  }, [compareEnabled, compareMaxHop, compareRunIds.length]);

  const graphConfig = useMemo(() => {
    if (compareEnabled && compareRunIds.length >= 2) {
      const focusRunId =
        selectedRun !== null && compareSelectedRunIds.has(selectedRun)
          ? selectedRun
          : compareRunIds[0] ?? null;
      return {
        runs: forceGraphRuns,
        runId: focusRunId,
        compareRunIds,
        compareColorByRunId,
        compareHighlightStep: compareHopClamped,
        highlightStep: compareHopClamped,
      };
    }

    if (graphFocusMode === "selected" && selectedRunData) {
      return {
        runs: [
          {
            start_article: selectedRunData.start_article,
            destination_article: selectedRunData.destination_article,
            steps: selectedRunData.steps.map((article) => ({ type: "move", article })),
          },
        ],
        runId: 0,
        compareRunIds: undefined,
        compareColorByRunId: undefined,
        compareHighlightStep: undefined,
        highlightStep: undefined,
      };
    }

    return {
      runs: forceGraphRuns,
      runId: selectedRun,
      compareRunIds: undefined,
      compareColorByRunId: undefined,
      compareHighlightStep: undefined,
      highlightStep: undefined,
    };
  }, [
    compareColorByRunId,
    compareEnabled,
    compareHopClamped,
    compareRunIds,
    compareSelectedRunIds,
    forceGraphRuns,
    graphFocusMode,
    selectedRun,
    selectedRunData,
  ]);

  const toggleCompareRunSelected = (runId: number) => {
    setCompareSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  };

  const clearCompareSelection = () => {
    setCompareSelectedRunIds(new Set());
    setCompareEnabled(false);
    setCompareHop(0);
  };

  const copySelectedPath = async () => {
    if (!selectedRunData) return;
    const hops = viewerRunHops(selectedRunData);
    const text = [
      `${selectedRunData.start_article} → ${selectedRunData.destination_article}`,
      `Hops: ${hops}`,
      "Path:",
      ...selectedRunData.steps.map((step, idx) => `${idx}. ${step}`),
    ].join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus("copied");
      window.setTimeout(() => setCopyStatus("idle"), 1800);
    } catch {
      setCopyStatus("error");
      window.setTimeout(() => setCopyStatus("idle"), 1800);
    }
  };

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const jsonData = JSON.parse(e.target?.result as string);
        
        // Validate the JSON structure has the required fields
        if (!jsonData.runs || !Array.isArray(jsonData.runs)) {
          alert("Invalid JSON format. File must contain a 'runs' array.");
          return;
        }
        
        // Create a filename-based model name, removing extension and path
        const fileName = file.name.replace(/\.[^/.]+$/, "");
        const modelName = fileName;

        addViewerDataset({ name: modelName, data: jsonData });
        setSelectedModel(`Saved: ${modelName}`);
      } catch (error) {
        alert(`Error parsing JSON file: ${error.message}`);
      }
    };
    reader.readAsText(file);
    
    // Reset the file input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const handleImportFromText = () => {
    setImportError(null);
    try {
      const jsonData = JSON.parse(importText);
      if (!jsonData.runs || !Array.isArray(jsonData.runs)) {
        throw new Error("Invalid JSON format. JSON must contain a 'runs' array.");
      }
      const name = importName.trim() || "Pasted dataset";
      addViewerDataset({ name, data: jsonData });
      setSelectedModel(`Saved: ${name}`);
      setImportText("");
      setImportName("");
    } catch (error) {
      setImportError(error.message);
    }
  };

  const handleStartNewRace = () => {
    onGoToPlayTab?.();
  };

  const handleTryRandomMatchup = () => {
    const pool = winRuns.length > 0 ? winRuns : runs;
    if (pool.length === 0) {
      handleStartNewRace();
      return;
    }

    const randomRun = pool[Math.floor(Math.random() * pool.length)];
    handleTryRun(randomRun.start_article, randomRun.destination_article);
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4 p-2">
     <Card className="p-3 col-span-12 row-start-1">
       <div className="space-y-3">
         {showPlayCta && (
           <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
             <div className="space-y-1">
               <div className="text-sm font-semibold text-foreground">
                 Want to race an AI?
               </div>
               <div className="text-xs text-muted-foreground">
                 Start a new game from scratch, or jump into a random matchup.
               </div>
             </div>
             <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
               <Button size="sm" onClick={handleStartNewRace}>
                 Start a race
               </Button>
               <Button size="sm" variant="outline" onClick={handleTryRandomMatchup}>
                 Random matchup
               </Button>
             </div>
           </div>
         )}

         <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
           <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
             <div className="flex-shrink-0">
               <Select value={selectedModel} onValueChange={setSelectedModel}>
                 <SelectTrigger className="w-[220px]">
                   <SelectValue placeholder="Select model" />
                 </SelectTrigger>
                 <SelectContent>
                   {Object.keys(models).map((modelName) => (
                     <SelectItem key={modelName} value={modelName}>
                       {modelName}
                     </SelectItem>
                   ))}
                 </SelectContent>
               </Select>
             </div>

             <div className="flex flex-wrap items-center gap-2">
               <Button
                 variant="outline"
                 size="sm"
                 className="flex items-center gap-1"
                 onClick={handleUploadClick}
               >
                 <UploadIcon size={14} />
                 <span>Upload JSON</span>
                 <input
                   type="file"
                   ref={fileInputRef}
                   accept=".json"
                   className="hidden"
                   onChange={handleFileUpload}
                 />
               </Button>

               <Dialog>
                 <DialogTrigger asChild>
                   <Button variant="outline" size="sm" className="flex items-center gap-1">
                     <UploadIcon size={14} />
                     <span>Paste JSON</span>
                   </Button>
                 </DialogTrigger>
                 <DialogContent className="max-w-3xl">
                   <DialogHeader>
                     <DialogTitle>Import dataset JSON</DialogTitle>
                     <DialogDescription>
                       Paste a viewer-compatible JSON file (must contain a top-level 'runs' array).
                     </DialogDescription>
                   </DialogHeader>
                   <div className="space-y-3">
                     <div>
                       <Label htmlFor="dataset-name">Name</Label>
                       <Input
                         id="dataset-name"
                         value={importName}
                         onChange={(e) => setImportName(e.target.value)}
                         placeholder="My results"
                       />
                     </div>
                     <textarea
                       className="w-full h-64 text-xs font-mono border rounded-md p-2"
                       value={importText}
                       onChange={(e) => setImportText(e.target.value)}
                       placeholder='{"runs": [...], ...}'
                     />
                     {importError && (
                       <div className="rounded-md border border-status-error/30 bg-status-error/10 p-2 text-sm text-foreground">
                         {importError}
                       </div>
                     )}
                   </div>
                   <DialogFooter>
                     <Button onClick={handleImportFromText} disabled={importText.trim().length === 0}>
                       Import
                     </Button>
                   </DialogFooter>
                 </DialogContent>
               </Dialog>

               {datasets.length > 0 && (
                 <Dialog>
                   <DialogTrigger asChild>
                     <Button variant="outline" size="sm" className="flex items-center gap-1">
                       <Trash2 size={14} />
                       <span>Manage</span>
                     </Button>
                   </DialogTrigger>
                   <DialogContent className="max-w-2xl">
                     <DialogHeader>
                       <DialogTitle>Saved datasets</DialogTitle>
                       <DialogDescription>
                         Remove datasets saved locally in this browser.
                       </DialogDescription>
                     </DialogHeader>
                     <div className="space-y-2">
                       {datasets.map((d) => (
                         <div key={d.id} className="flex items-center justify-between gap-2 border rounded-md p-2">
                           <div className="text-sm font-medium">{d.name}</div>
                           <Button
                             variant="outline"
                             size="sm"
                             onClick={() => {
                               removeViewerDataset(d.id);
                             }}
                           >
                             Remove
                           </Button>
                         </div>
                       ))}
                     </div>
                   </DialogContent>
                 </Dialog>
               )}
             </div>
           </div>

           <div className="flex items-center gap-2 text-xs sm:flex-shrink-0">
             <Tooltip>
               <TooltipTrigger asChild>
                 <Button
                   size="sm"
                   variant={showWinsOnly ? "secondary" : "outline"}
                   className="h-8 px-3"
                   onClick={() => setShowWinsOnly((prev) => !prev)}
                 >
                   {showWinsOnly ? "Wins only: On" : "Wins only: Off"}
                 </Button>
               </TooltipTrigger>
               <TooltipContent side="top" align="end">
                 Show only successful runs. Turn off to include losses and near misses.
               </TooltipContent>
             </Tooltip>
           </div>
         </div>

         {(modelStats || runs.length > 0) && (
           <div className="flex flex-col gap-2 w-full">
             {modelStats && (
               <div className="flex flex-wrap gap-1.5 items-center">
                 <Badge variant="outline" className="px-2 py-0.5 flex gap-1 items-center">
                   <span className="text-xs font-medium">Success:</span>
                   <span className="text-xs font-semibold">{modelStats.winPercentage.toFixed(1)}%</span>
                   <span className="text-xs text-muted-foreground">({modelStats.wins}/{modelStats.totalRuns})</span>
                 </Badge>

                 <Tooltip>
                   <TooltipTrigger asChild>
                     <Badge variant="outline" className="px-2 py-0.5 flex gap-1 items-center">
                       <span className="text-xs font-medium">Mean hops:</span>
                       <span className="text-xs font-semibold">{modelStats.avgHops.toFixed(1)}</span>
                       <span className="text-xs text-muted-foreground">+/-{modelStats.stdDevHops.toFixed(1)}</span>
                     </Badge>
                   </TooltipTrigger>
                   <TooltipContent side="top" align="start">
                     A hop is one link-click between articles (moves, not nodes).
                   </TooltipContent>
                 </Tooltip>

                 <Badge variant="outline" className="px-2 py-0.5 flex gap-1 items-center">
                   <span className="text-xs font-medium">Median hops:</span>
                   <span className="text-xs font-semibold">{modelStats.medianHops.toFixed(1)}</span>
                 </Badge>

                 <Badge variant="outline" className="px-2 py-0.5 flex gap-1 items-center">
                   <span className="text-xs font-medium">Min hops:</span>
                   <span className="text-xs font-semibold">{modelStats.minHops}</span>
                 </Badge>

                 <Badge variant="outline" className="px-2 py-0.5 flex gap-1 items-center">
                   <span className="text-xs font-medium">Max hops:</span>
                   <span className="text-xs font-semibold">{modelStats.maxHops}</span>
                 </Badge>

                  {winHopCounts.length > 0 && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge
                          variant="outline"
                          className="px-2 py-0.5 flex gap-2 items-center"
                        >
                          <span className="text-xs font-medium">Dist:</span>
                          <HopsSparkline values={winHopCounts} />
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="top" align="start">
                        Distribution of hop counts for wins.
                      </TooltipContent>
                    </Tooltip>
                  )}
               </div>
             )}

             {runs.length > 0 && (
               <div className="grid gap-3 sm:grid-cols-2 text-xs text-muted-foreground">
                 <button
                   type="button"
                   className={cn(
                     "rounded-md border p-2 bg-muted/30 text-left transition-colors",
                     bestRun ? "hover:bg-muted/40" : "opacity-60 cursor-not-allowed"
                   )}
                   onClick={() => selectRunFromSummary(bestRun)}
                   disabled={!bestRun}
                 >
                   <div className="font-medium text-foreground text-sm">Best run</div>
                   {bestRun ? (
                     <div className="mt-1">
                       {bestRun.start_article} → {bestRun.destination_article}
                       <div className="text-[11px]">{formatHops(viewerRunHops(bestRun))}</div>
                     </div>
                   ) : (
                     <div className="mt-1">No wins yet</div>
                   )}
                 </button>

                 <button
                   type="button"
                   className={cn(
                     "rounded-md border p-2 bg-muted/30 text-left transition-colors",
                     worstRun ? "hover:bg-muted/40" : "opacity-60 cursor-not-allowed"
                   )}
                   onClick={() => selectRunFromSummary(worstRun)}
                   disabled={!worstRun}
                 >
                   <div className="font-medium text-foreground text-sm">Longest run</div>
                   {worstRun ? (
                     <div className="mt-1">
                       {worstRun.start_article} → {worstRun.destination_article}
                       <div className="text-[11px]">{formatHops(viewerRunHops(worstRun))}</div>
                     </div>
                   ) : (
                     <div className="mt-1">No data yet</div>
                   )}
                 </button>
               </div>
             )}
           </div>
         )}
       </div>
      </Card>
	  <div className="md:col-span-3 flex flex-col md:sticky md:top-4 md:self-start md:h-[calc(100vh_-_2rem)]">
        <div className="bg-card rounded-lg p-3 border flex-grow overflow-hidden flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-2 flex-shrink-0">
            <h3 className="text-sm font-medium text-muted-foreground">Runs</h3>
            {compareSelectedRunIds.size > 0 && (
              <Badge variant="outline" className="text-[11px]">
                {compareSelectedRunIds.size} selected
              </Badge>
            )}
          </div>
          <div className="flex-grow overflow-hidden">
            <RunsList
              runs={filterRuns}
              onSelectRun={handleRunSelect}
              selectedRunId={selectedRun}
              onTryRun={handleTryRun}
              pauseToken={pauseAutoplayToken}
              selectedRunIds={compareSelectedRunIds}
              onToggleRunSelected={toggleCompareRunSelected}
            />
          </div>
        </div>
      </div>

      <div className="md:col-span-9">
        <Card className="w-full p-3 m-0 flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-sm font-medium">Visualization</div>
                <div className="text-xs text-muted-foreground">
                  {selectedRunData
                    ? "Hover nodes for details."
                    : "Select a run to highlight its path."}
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant={graphFocusMode === "all" ? "secondary" : "outline"}
                      className="h-8"
                      disabled={compareEnabled}
                      onClick={() => setGraphFocusMode("all")}
                    >
                      All runs
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end">
                    Show all runs in the dataset.
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant={graphFocusMode === "selected" ? "secondary" : "outline"}
                      className="h-8"
                      disabled={!selectedRunData || compareEnabled}
                      onClick={() => setGraphFocusMode("selected")}
                    >
                      Selected only
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end">
                    Focus the graph on the selected run.
                  </TooltipContent>
                </Tooltip>

                {compareRunIds.length >= 2 && (
                  <Button
                    size="sm"
                    variant={compareEnabled ? "secondary" : "outline"}
                    className="h-8"
                    onClick={() => {
                      if (compareEnabled) {
                        setCompareEnabled(false);
                        return;
                      }
                      setCompareHop(0);
                      setCompareEnabled(true);
                    }}
                  >
                    {compareEnabled ? "Exit compare" : "Compare"}
                  </Button>
                )}

                {compareSelectedRunIds.size > 0 && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8"
                    onClick={clearCompareSelection}
                  >
                    Clear
                  </Button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full bg-competitive"
                  aria-hidden="true"
                />
                Start/target
              </div>
              <div className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full bg-muted-foreground"
                  aria-hidden="true"
                />
                Articles
              </div>
              <div className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full bg-status-running"
                  aria-hidden="true"
                />
                Selected path
              </div>
            </div>

            {compareEnabled && compareRunIds.length >= 2 && (
              <div className="rounded-md border bg-background/60 p-2 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">
                    Comparing {compareRunIds.length} runs • Hop {compareHopClamped}/{compareMaxHop}
                  </div>
                  <div className="text-xs text-muted-foreground">Choices at this hop</div>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setCompareHop((prev) => clampNumber(prev - 1, 0, compareMaxHop))}
                    disabled={compareHopClamped <= 0}
                  >
                    Prev
                  </Button>

                  <input
                    type="range"
                    min={0}
                    max={compareMaxHop}
                    value={compareHopClamped}
                    onChange={(e) => setCompareHop(Number.parseInt(e.target.value, 10))}
                    className="flex-1"
                    aria-label="Compare hop"
                  />

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => setCompareHop((prev) => clampNumber(prev + 1, 0, compareMaxHop))}
                    disabled={compareHopClamped >= compareMaxHop}
                  >
                    Next
                  </Button>

                  <div className="text-xs text-muted-foreground tabular-nums w-[70px] text-right">
                    {compareHopClamped}/{compareMaxHop}
                  </div>
                </div>

                <div className="space-y-1">
                  {compareRunIds.map((runId) => {
                    const run = filterRuns[runId];
                    if (!run) return null;
                    const steps = forceGraphRuns[runId]?.steps ?? [];
                    const maxIdx = Math.max(0, steps.length - 1);
                    const idx = clampNumber(compareHopClamped, 0, maxIdx);
                    const from = steps[idx]?.article || run.start_article;
                    const to = steps[idx + 1]?.article;
                    const isActive = runId === selectedRun;
                    const color = compareColorByRunId[runId];

                    return (
                      <button
                        key={`viewer-compare-hop-${runId}`}
                        type="button"
                        onClick={() => setSelectedRun(runId)}
                        className={cn(
                          "w-full rounded-md border px-2 py-1 text-left",
                          isActive
                            ? "border-primary/50 bg-primary/5"
                            : "border-border hover:bg-muted/40"
                        )}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span
                                className="h-2 w-2 rounded-full flex-shrink-0"
                                style={{ backgroundColor: color }}
                                aria-hidden="true"
                              />
                              <div className="text-xs font-medium truncate">
                                {run.start_article} → {run.destination_article}
                              </div>
                            </div>
                            <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                              {to ? `${from} → ${to}` : `${from} (end)`}
                            </div>
                          </div>
                          <div className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">
                            {Math.min(compareHopClamped, maxIdx)}/{maxIdx}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="h-[400px] overflow-hidden">
            <div
              className="w-full h-full"
              onWheelCapture={pauseAutoplay}
              onPointerDownCapture={pauseAutoplay}
              onTouchStartCapture={pauseAutoplay}
            >
              <ForceDirectedGraph
                runs={graphConfig.runs}
                runId={graphConfig.runId}
                compareRunIds={graphConfig.compareRunIds}
                compareColorByRunId={graphConfig.compareColorByRunId}
                compareHighlightStep={graphConfig.compareHighlightStep}
                highlightStep={graphConfig.highlightStep}
              />
            </div>
          </div>

          {selectedRunData ? (
            <div className="rounded-lg border bg-muted/10 p-3 space-y-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">
                    {selectedRunData.start_article} → {selectedRunData.destination_article}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="text-[11px]">
                      {formatHops(viewerRunHops(selectedRunData))}
                    </Badge>
                    {selectedRunData.result ? (
                      <StatusChip
                        status={
                          selectedRunData.result === "win" ? "finished" : "error"
                        }
                      >
                        {selectedRunData.result === "win" ? "Win" : selectedRunData.result}
                      </StatusChip>
                    ) : null}
                    {selectedRunData.near_miss ? (
                      <StatusChip status="active">Near miss</StatusChip>
                    ) : null}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() =>
                      handleTryRun(
                        selectedRunData.start_article,
                        selectedRunData.destination_article
                      )
                    }
                  >
                    Play this matchup
                  </Button>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={copySelectedPath}
                        className="gap-2"
                      >
                        {copyStatus === "copied" ? (
                          <Check className="h-4 w-4" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                        {copyStatus === "copied"
                          ? "Copied"
                          : copyStatus === "error"
                            ? "Copy failed"
                            : "Copy path"}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="end">
                      Copies the matchup + full path to your clipboard.
                    </TooltipContent>
                  </Tooltip>
                </div>
              </div>

	              <div className="space-y-3">
	                <div>
	                  <div className="text-xs text-muted-foreground">Path</div>
	                  <div className="mt-2 flex flex-wrap items-center gap-1">
	                    {selectedRunData.steps.map((step, idx) => {
	                      const isActive = previewArticle === step;
	                      return (
	                        <button
	                          key={`${idx}-${step}`}
	                          type="button"
	                          onClick={() => setPreviewArticle(step)}
	                          className={cn(
	                            "max-w-full rounded-md border bg-background px-2 py-0.5 text-[11px] transition-colors",
	                            "hover:bg-muted/40",
	                            isActive && "ring-2 ring-muted-foreground/30 ring-offset-1"
	                          )}
	                          title={step}
	                        >
	                          <span className="tabular-nums text-muted-foreground mr-1">
	                            {idx}
	                          </span>
	                          <span className="truncate">{step}</span>
	                        </button>
	                      );
	                    })}
	                  </div>
	                </div>

	                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
	                  <div>
	                    <div className="text-xs text-muted-foreground">Start</div>
	                    <div className="mt-2">
	                      <WikiSummaryCard title={selectedRunData.start_article} />
	                    </div>
	                  </div>
	                  <div>
	                    <div className="text-xs text-muted-foreground">Target</div>
	                    <div className="mt-2">
	                      <WikiSummaryCard title={selectedRunData.destination_article} />
	                    </div>
	                  </div>
	                </div>

	                {previewArticle &&
	                  previewArticle !== selectedRunData.start_article &&
	                  previewArticle !== selectedRunData.destination_article && (
	                    <div>
	                      <div className="text-xs text-muted-foreground">Preview</div>
	                      <div className="mt-2">
	                        <WikiSummaryCard title={previewArticle} />
	                      </div>
	                    </div>
	                  )}
	              </div>
	            </div>
	          ) : (
	            <div className="rounded-lg border bg-muted/10 p-3 text-xs text-muted-foreground">
              Select a run to see its path details.
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
