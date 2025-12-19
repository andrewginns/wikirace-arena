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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Trash2, UploadIcon } from "lucide-react";
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

export default function ViewerTab({
  handleTryRun,
}: {
  handleTryRun: (startArticle: string, destinationArticle: string) => void;
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

  const winRuns = useMemo(() => runs.filter((run) => run.result === "win"), [runs]);
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

  return (
    <div className="grid grid-cols-1 md:grid-cols-12 gap-4 h-[calc(100vh_-_200px)] max-h-[calc(100vh_-_200px)] overflow-hidden p-2">
     <Card className="p-3 col-span-12 row-start-1">
       <div className="space-y-3">
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
                       <div className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-md p-2">
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
             <Button
               size="sm"
               variant={showWinsOnly ? "secondary" : "outline"}
               className="h-8 px-3"
               onClick={() => setShowWinsOnly((prev) => !prev)}
             >
               {showWinsOnly ? "Wins only: On" : "Wins only: Off"}
             </Button>
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

                 <Badge variant="outline" className="px-2 py-0.5 flex gap-1 items-center">
                   <span className="text-xs font-medium">Mean hops:</span>
                   <span className="text-xs font-semibold">{modelStats.avgHops.toFixed(1)}</span>
                   <span className="text-xs text-muted-foreground">+/-{modelStats.stdDevHops.toFixed(1)}</span>
                 </Badge>

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
      <div className="md:col-span-3 flex flex-col max-h-full overflow-hidden">
        <div className="bg-card rounded-lg p-3 border flex-grow overflow-hidden flex flex-col">
          <h3 className="text-sm font-medium mb-2 text-muted-foreground flex-shrink-0">
            Runs
          </h3>
          <div className="flex-grow overflow-hidden">
            <RunsList
              runs={filterRuns}
              onSelectRun={handleRunSelect}
              selectedRunId={selectedRun}
              onTryRun={handleTryRun}
              pauseToken={pauseAutoplayToken}
            />
          </div>
        </div>
      </div>

      <div className="md:col-span-9 max-h-full overflow-hidden">
        <Card className="w-full h-full p-3 m-0 overflow-hidden flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <div className="text-sm font-medium">Visualization</div>
            <div className="text-xs text-muted-foreground">
              {selectedRunData ? "Selected run highlighted" : "Select a run to highlight"}
            </div>
          </div>

          <div className="flex-1 min-h-0 overflow-hidden">
            <div
              className="w-full h-full"
              onWheelCapture={pauseAutoplay}
              onPointerDownCapture={pauseAutoplay}
              onTouchStartCapture={pauseAutoplay}
            >
              <ForceDirectedGraph runs={forceGraphRuns} runId={selectedRun} />
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
