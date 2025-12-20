"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, {
  ForceGraphMethods,
  LinkObject,
  NodeObject,
} from "react-force-graph-2d";
import { Run } from "./reasoning-trace";
import * as d3 from "d3";
import { API_BASE } from "@/lib/constants";
// This is a placeholder component for the force-directed graph
// In a real implementation, you would use a library like D3.js or react-force-graph

// CSS variables for styling
const STYLES = {
  fixedNodeColor: "#e63946", // Red
  fluidNodeColor: "#457b9d", // Steel Blue
  linkColor: "#adb5bd", // Grey
  highlightColor: "#fca311", // Orange/Yellow
  successColor: "#2a9d8f", // Teal
  minNodeOpacity: 0.3,
  minLinkOpacity: 0.15,
};

interface ForceDirectedGraphProps {
  runId: number | null;
  runs: Run[];
  includeGraphLinks?: boolean;
  highlightStep?: number | null;
  compareRunIds?: number[];
  compareHighlightStep?: number | null;
  compareColorByRunId?: Record<number, string>;
  onNodeSelect?: (node: GraphNode) => void;
}

// Extended node and link types that include run metadata
interface GraphNode extends NodeObject {
  id: string;
  type?: "fixed" | "fluid";
  radius?: number;
  baseOpacity?: number;
  runIds: number[]; // Array of run indices this node is part of
  isMainNode?: boolean; // Whether this is a start/destination node
  fx?: number;
  fy?: number;
}

interface GraphLink extends LinkObject {
  source: string | GraphNode;
  target: string | GraphNode;
  runId: number; // Array of run indices this link is part of
  kind: "path" | "wiki";
  toStep?: number;
}

export default function ForceDirectedGraph({
  runs,
  runId,
  includeGraphLinks,
  highlightStep,
  compareRunIds,
  compareHighlightStep,
  compareColorByRunId,
  onNodeSelect,
}: ForceDirectedGraphProps) {
  const isCompareMode = (compareRunIds?.length ?? 0) > 0;
  const compareRunSet = useMemo(() => new Set(compareRunIds ?? []), [compareRunIds]);
  const internalCompareColorByRunId = useMemo(() => {
    if (!isCompareMode) return {} as Record<number, string>;
    const palette = [
      "#e63946", // red
      "#457b9d", // blue
      "#2a9d8f", // teal
      "#fca311", // orange
      "#a855f7", // purple
      "#22c55e", // green
    ];

    const map: Record<number, string> = {};
    for (let i = 0; i < (compareRunIds?.length ?? 0); i++) {
      const id = compareRunIds![i]!;
      map[id] = palette[i % palette.length]!;
    }
    return map;
  }, [compareRunIds, isCompareMode]);

  const effectiveCompareColors = compareColorByRunId ?? internalCompareColorByRunId;

  const focusRunColor = useMemo(() => {
    if (!isCompareMode || runId === null) return STYLES.highlightColor;
    return effectiveCompareColors[runId] ?? STYLES.highlightColor;
  }, [effectiveCompareColors, isCompareMode, runId]);
  const zoomNodeFilter = useCallback(
    (node: GraphNode) => {
      if (node.type === "fixed") return true;
      if (isCompareMode) {
        return node.runIds.some((id) => compareRunSet.has(id));
      }
      if (runId !== null) return node.runIds.includes(runId);
      return node.runIds.length > 0;
    },
    [compareRunSet, isCompareMode, runId]
  );

  const zoomToFitFocus = useCallback(
    (durationMs: number) => {
      if (!graphRef.current) return;
      graphRef.current.zoomToFit(durationMs, 20, zoomNodeFilter);
    },
    [zoomNodeFilter]
  );

  const selectedRun = runId === null ? null : runs[runId] || null;

  const selectedMaxStepIndex = useMemo(() => {
    if (!selectedRun) return null;
    const maxIdx = Math.max(0, selectedRun.steps.length - 1);
    if (typeof highlightStep !== "number") return maxIdx;
    return Math.max(0, Math.min(maxIdx, highlightStep));
  }, [highlightStep, selectedRun]);

  const selectedReachedArticles = useMemo(() => {
    if (isCompareMode) return null;
    if (!selectedRun) return null;
    const maxIdx = selectedMaxStepIndex ?? Math.max(0, selectedRun.steps.length - 1);
    const set = new Set<string>();
    for (let i = 0; i <= maxIdx; i++) {
      const article = selectedRun.steps[i]?.article;
      if (article) set.add(article);
    }
    return set;
  }, [isCompareMode, selectedRun, selectedMaxStepIndex]);

  const selectedStepNumberById = useMemo(() => {
    if (isCompareMode) return null;
    if (!selectedRun) return null;
    const maxIdx = selectedMaxStepIndex ?? Math.max(0, selectedRun.steps.length - 1);
    const map = new Map<string, number>();
    for (let i = 0; i <= maxIdx; i++) {
      const article = selectedRun.steps[i]?.article;
      if (!article) continue;
      if (!map.has(article)) map.set(article, i + 1);
    }
    return map;
  }, [isCompareMode, selectedRun, selectedMaxStepIndex]);

  const [baseGraphData, setBaseGraphData] = useState<{
    nodes: GraphNode[];
    links: GraphLink[];
  }>({ nodes: [], links: [] });
  const [graphLinks, setGraphLinks] = useState<GraphLink[]>([]);
  const [graphExtraNodes, setGraphExtraNodes] = useState<GraphNode[]>([]);
  const graphLinksCacheRef = useRef<Map<string, string[]>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<ForceGraphMethods<GraphNode, GraphLink>>(null);
  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });

  // Track container dimensions
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const parent = container.parentElement;
    
    const updateDimensions = () => {
      const width = parent ? parent.clientWidth : container.clientWidth;
      const height = parent ? parent.clientHeight : container.clientHeight;
      
      // Constrain dimensions to reasonable values
      const constrainedWidth = Math.min(width, window.innerWidth);
      const constrainedHeight = Math.min(height, window.innerHeight);
      
      setDimensions({
        width: constrainedWidth,
        height: constrainedHeight,
      });
    };
    
    // Initial measurement
    updateDimensions();
    
    // Set up resize observer
    const resizeObserver = new ResizeObserver(updateDimensions);
    resizeObserver.observe(container);
    
    if (parent) {
      resizeObserver.observe(parent);
    }
    
    // Clean up
    return () => {
      resizeObserver.unobserve(container);
      if (parent) {
        resizeObserver.unobserve(parent);
      }
      resizeObserver.disconnect();
    };
  }, []);

  // Build base graph data ONLY when runs change, not when runId changes
  useEffect(() => {
    // mock all the data
    const nodesMap: Map<string, GraphNode> = new Map();
    const linksList: GraphLink[] = [];
    const mainNodes: Set<string> = new Set();

    const ensureNode = (article: string, runIndex: number) => {
      const existing = nodesMap.get(article);
      if (!existing) {
        nodesMap.set(article, {
          id: article,
          type: "fluid",
          radius: 5,
          runIds: [runIndex],
        });
        return;
      }
      if (!existing.runIds.includes(runIndex)) {
        existing.runIds.push(runIndex);
      }
    };

    for (let runIndex = 0; runIndex < runs.length; runIndex++) {
      const run = runs[runIndex];
      const sourceArticle = run.start_article;
      const destinationArticle = run.destination_article;
      mainNodes.add(sourceArticle);
      mainNodes.add(destinationArticle);

      // Ensure main nodes exist even before a run has progressed.
      ensureNode(sourceArticle, runIndex);
      ensureNode(destinationArticle, runIndex);

      for (let i = 0; i < run.steps.length - 1; i++) {
        const step = run.steps[i];
        const nextStep = run.steps[i + 1];

        ensureNode(step.article, runIndex);
        ensureNode(nextStep.article, runIndex);

        if (step.article !== nextStep.article) {
          linksList.push({
            source: step.article,
            target: nextStep.article,
            runId: runIndex,
            kind: "path",
            toStep: i + 1,
          });
        }
      }
    }

    mainNodes.forEach((node) => {
      const oldNode = nodesMap.get(node);
      nodesMap.set(node, {
        ...(oldNode || { id: node, type: "fluid", radius: 5, runIds: [] }),
        id: node,
        type: "fixed",
        radius: 7,
        isMainNode: true,
      });
    });

    // position the main nodes in a circle
    const radius = 400;
    const centerX = 0;
    const centerY = 0;
    const mainNodesArray = Array.from(mainNodes);
    const angle = 2 * Math.PI / mainNodesArray.length;
    const angleOffset = Math.PI;
    mainNodesArray.forEach((node, index) => {
      const nodeObj = nodesMap.get(node)!;
      nodeObj.fx = centerX + radius * Math.cos(angle * index + angleOffset);
      nodeObj.fy = centerY + radius * Math.sin(angle * index + angleOffset);
    });

    const tmpGraphData: { nodes: GraphNode[]; links: GraphLink[] } = {
      nodes: Array.from(nodesMap.values()),
      links: linksList,
    };

    setBaseGraphData(tmpGraphData);

    return;
   
  }, [runs]); // Only depends on runs, not runId

  const graphData = useMemo(() => {
    const nodeMap = new Map<string, GraphNode>();
    for (const node of baseGraphData.nodes) {
      nodeMap.set(node.id, node);
    }
    for (const node of graphExtraNodes) {
      if (!nodeMap.has(node.id)) {
        nodeMap.set(node.id, node);
      }
    }

    const nodes = Array.from(nodeMap.values());
    const nodeSet = new Set(nodeMap.keys());

    const filteredBaseLinks = baseGraphData.links.filter((link) => {
      const source = typeof link.source === "string" ? link.source : link.source.id;
      const target = typeof link.target === "string" ? link.target : link.target.id;
      return nodeSet.has(source) && nodeSet.has(target);
    });
    const filtered = graphLinks.filter((link) => {
      const source = typeof link.source === "string" ? link.source : link.source.id;
      const target = typeof link.target === "string" ? link.target : link.target.id;
      return nodeSet.has(source) && nodeSet.has(target);
    });
    return {
      nodes,
      links: [...filteredBaseLinks, ...filtered],
    };
  }, [baseGraphData, graphExtraNodes, graphLinks]);

  useEffect(() => {
    if (!includeGraphLinks) {
      setGraphLinks([]);
      setGraphExtraNodes([]);
      return;
    }

    if (baseGraphData.nodes.length === 0) {
      setGraphLinks([]);
      setGraphExtraNodes([]);
      return;
    }

    const MAX_SOURCE_NODES = 300;
    const MAX_NEIGHBORS_PER_SOURCE = 40;
    const MAX_EXTRA_NODES = 450;
    const MAX_LINKS_PER_SOURCE = 400;

    const baseNodeIds = baseGraphData.nodes.map((n) => n.id);
    const nodeSet = new Set(baseNodeIds);

    const baseEdgeKeys = new Set<string>();
    for (const link of baseGraphData.links) {
      const source = typeof link.source === "string" ? link.source : link.source.id;
      const target = typeof link.target === "string" ? link.target : link.target.id;
      if (!source || !target) continue;
      baseEdgeKeys.add(`${source}→${target}`);
    }

    const sourceIds: string[] = [];
    const addedSourceIds = new Set<string>();
    if (runId !== null) {
      const selectedRun = runs[runId];
      if (selectedRun) {
        for (const step of selectedRun.steps) {
          if (addedSourceIds.has(step.article)) continue;
          if (!nodeSet.has(step.article)) continue;
          addedSourceIds.add(step.article);
          sourceIds.push(step.article);
          if (sourceIds.length >= MAX_SOURCE_NODES) break;
        }
      }
    }
    if (sourceIds.length < MAX_SOURCE_NODES) {
      for (const id of baseNodeIds) {
        if (addedSourceIds.has(id)) continue;
        addedSourceIds.add(id);
        sourceIds.push(id);
        if (sourceIds.length >= MAX_SOURCE_NODES) break;
      }
    }

    const controller = new AbortController();

    const getOutgoingLinks = async (title: string) => {
      const cached = graphLinksCacheRef.current.get(title);
      if (cached) return cached;

      const response = await fetch(
        `${API_BASE}/get_article_with_links/${encodeURIComponent(title)}`,
        { signal: controller.signal }
      );
      if (!response.ok) {
        throw new Error(`Failed to load links for ${title} (${response.status})`);
      }
      const data = await response.json();
      const links =
        data && Array.isArray(data.links) ? (data.links as string[]) : ([] as string[]);
      graphLinksCacheRef.current.set(title, links);
      return links;
    };

    void (async () => {
      const nextLinks: GraphLink[] = [];
      const seenKeys = new Set(baseEdgeKeys);

      const extraNodeIds = new Set<string>();
      const nextExtraNodes: GraphNode[] = [];

      for (const source of sourceIds) {
        if (controller.signal.aborted) return;

        let outgoing: string[];
        try {
          outgoing = await getOutgoingLinks(source);
        } catch {
          continue;
        }

        let scanned = 0;
        let addedNeighbors = 0;
        for (const target of outgoing) {
          if (controller.signal.aborted) return;
          scanned += 1;
          if (scanned > MAX_LINKS_PER_SOURCE) break;

          const targetKnown = nodeSet.has(target) || extraNodeIds.has(target);
          if (!targetKnown) {
            if (nextExtraNodes.length >= MAX_EXTRA_NODES) continue;
            extraNodeIds.add(target);
            nextExtraNodes.push({
              id: target,
              type: "fluid",
              radius: 4,
              baseOpacity: 0.18,
              runIds: [],
            });
          }

          const shouldAdd = nodeSet.has(target) || extraNodeIds.has(target);
          if (!shouldAdd) continue;

          const key = `${source}→${target}`;
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);
          nextLinks.push({ source, target, runId: -1, kind: "wiki" });
          addedNeighbors += 1;
          if (addedNeighbors >= MAX_NEIGHBORS_PER_SOURCE) break;
        }
      }

      if (controller.signal.aborted) return;
      setGraphLinks(nextLinks);
      setGraphExtraNodes(nextExtraNodes);
    })();

    return () => {
      controller.abort();
    };
  }, [includeGraphLinks, baseGraphData, runId, runs]);

  // Set up the force simulation
  useEffect(() => {
    if (!graphRef.current || graphData.nodes.length === 0) return;

    let zoomTimer: number | null = null;
    const setupTimer = window.setTimeout(() => {
      const graph = graphRef.current;
      if (!graph) return;

      const radialForceStrength = 0.7;
      const radialTargetRadius = 40;
      const linkDistance = 35;
      const chargeStrength = -100;
      const COLLISION_PADDING = 3;

      // Initialize force simulation
      graph.d3Force(
        "link",
        d3
          .forceLink(graphData.links)
          .id((d: GraphNode) => d.id)
          .distance(linkDistance)
          .strength(0.9)
      );
      graph.d3Force(
        "charge",
        d3.forceManyBody().strength(chargeStrength)
      );
      graph.d3Force(
        "radial",
        d3.forceRadial(radialTargetRadius, 0, 0).strength(radialForceStrength)
      );
      graph.d3Force(
        "collide",
        d3
          .forceCollide()
          .radius((d: GraphNode) => (d.radius || 5) + COLLISION_PADDING)
      );
      graph.d3Force("center", d3.forceCenter(0, 0));

      // Give the simulation a bit of time to stabilize, then zoom to fit
      zoomTimer = window.setTimeout(() => {
        if (graphRef.current) {
          zoomToFitFocus(500);
        }
      }, 500);
    }, 100);

    return () => {
      window.clearTimeout(setupTimer);
      if (zoomTimer !== null) window.clearTimeout(zoomTimer);
    };
  }, [graphData, zoomToFitFocus]);

  // Recenter graph when dimensions change
  useEffect(() => {
    if (dimensions.width > 0 && dimensions.height > 0 && graphRef.current) {
      zoomToFitFocus(400);
    }
  }, [dimensions, zoomToFitFocus]);

  // Full page resize handler
  useEffect(() => {
    const handleResize = () => {
      if (graphRef.current) {
        zoomToFitFocus(400);
      }
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [zoomToFitFocus]);

  // Helper function to determine node color based on current runId
  const getNodeColor = (node: GraphNode) => {
    if (!isCompareMode && runId !== null && selectedReachedArticles?.has(node.id)) {
      return STYLES.highlightColor;
    }

    // Nodes not in the selected run get their default colors
    return node.type === "fixed"
      ? STYLES.fixedNodeColor
      : STYLES.fluidNodeColor;
  };

  const isLinkInCompareRuns = (link: GraphLink) => {
    if (!isCompareMode) return false;
    if (link.kind !== "path") return false;
    if (!compareRunSet.has(link.runId)) return false;
    if (typeof compareHighlightStep !== "number") return true;
    if (typeof link.toStep !== "number") return false;
    return link.toStep <= compareHighlightStep;
  };

  // Helper function to determine link color based on current runId
  const getLinkColor = (link: GraphLink) => {
    if (isLinkInCompareRuns(link)) {
      return effectiveCompareColors[link.runId] ?? STYLES.linkColor;
    }
    if (isLinkInCurrentRun(link)) {
      return STYLES.highlightColor;
    }
    if (link.kind === "wiki") {
      return `rgba(173, 181, 189, ${STYLES.minLinkOpacity})`;
    }
    return STYLES.linkColor;
  };


  const isLinkInCurrentRun = (link: GraphLink) => {
    if (runId === null) return false;
    if (link.kind !== "path" || link.runId !== runId) return false;
    if (typeof selectedMaxStepIndex !== "number") return true;
    if (typeof link.toStep !== "number") return false;
    return link.toStep <= selectedMaxStepIndex;
  };

  return (
    <div className="w-full h-full flex items-center justify-center relative overflow-hidden">
      <div ref={containerRef} className="w-full h-full absolute inset-0">
        <ForceGraph2D
          ref={graphRef}
          graphData={graphData}
          nodeLabel="id"
          nodeColor={getNodeColor}
          linkColor={getLinkColor}
          linkDirectionalArrowLength={(link) => (isLinkInCurrentRun(link) ? 7 : 0)}
          linkDirectionalArrowRelPos={1}
          linkDirectionalArrowColor={(link) =>
            isCompareMode && isLinkInCurrentRun(link) ? focusRunColor : STYLES.highlightColor
          }
          linkWidth={(link) => {
            if (isCompareMode) {
              if (isLinkInCompareRuns(link)) {
                if (runId !== null && link.kind === "path" && link.runId === runId) return 4;
                return 2.5;
              }
              if (link.kind === "path") return 0;
            }
            if (isLinkInCurrentRun(link)) return 4;
            return link.kind === "wiki" ? 0.6 : 1;
          }}
          nodeRelSize={5}
          onNodeHover={(node) => {
            if (!containerRef.current) return;
            containerRef.current.style.cursor =
              node && onNodeSelect ? "pointer" : "default";
          }}
          onNodeClick={(node) => {
            if (!onNodeSelect) return;
            onNodeSelect(node as GraphNode);
          }}
          nodeCanvasObject={(node, ctx, globalScale) => {
            const label = node.id;
            const fontSize = 12 / globalScale;
            ctx.font = `${fontSize}px Sans-Serif`;
            const textWidth = ctx.measureText(label).width;
            const bckgDimensions = [textWidth, fontSize].map((n) => n + fontSize * 0.2);
            const [labelWidth, labelHeight] = bckgDimensions;

            const isInHighlightedRuns = isCompareMode
              ? node.runIds.some((id) => compareRunSet.has(id))
              : runId !== null && node.runIds.includes(runId);
            const isReached =
              !isCompareMode && runId !== null && Boolean(selectedReachedArticles?.has(node.id));

            // Apply opacity based on node type and properties
            const opacity = isReached
              ? 1.0
              : isInHighlightedRuns
              ? 0.55
              : typeof node.baseOpacity === "number"
              ? node.baseOpacity
              : STYLES.minNodeOpacity;

            // Draw node circle with appropriate styling
            ctx.globalAlpha = opacity;
            const radius = node.radius || (node.type === "fixed" ? 7 : 5);
            ctx.beginPath();
            ctx.arc(node.x!, node.y!, radius, 0, 2 * Math.PI);
            ctx.fillStyle = node.isMainNode ? STYLES.fixedNodeColor : STYLES.fluidNodeColor;
            ctx.fill();

            // Add white stroke around nodes
            ctx.strokeStyle = isReached ? STYLES.highlightColor : "transparent";
            ctx.globalAlpha = opacity;
            ctx.lineWidth = 3;
            ctx.stroke();

            // Draw label with background for better visibility
            const shouldShowLabel =
              node.type === "fixed" || isReached;

            if (shouldShowLabel) {
              const nodeX = typeof node.x === "number" ? node.x : 0;
              const nodeY = typeof node.y === "number" ? node.y : 0;
              const labelX = nodeX;
              const labelTopY = nodeY + 8;

              // Draw label background
              ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
              ctx.fillRect(
                labelX - labelWidth / 2,
                labelTopY,
                labelWidth,
                labelHeight
              );

              // Draw label text
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = "black";
              ctx.fillText(label, labelX, labelTopY + labelHeight / 2);
            }

            const stepNumber = selectedStepNumberById?.get(node.id);
            if (isReached && typeof stepNumber === "number") {
              const numberFontSize = 11 / globalScale;
              ctx.font = `700 ${numberFontSize}px Sans-Serif`;
              ctx.textAlign = "center";
              ctx.textBaseline = "middle";
              ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
              ctx.fillText(String(stepNumber), node.x!, node.y!);
            }
          }}
          width={dimensions.width || containerRef.current?.clientWidth || 800}
          height={dimensions.height || containerRef.current?.clientHeight || 800}
          enableNodeDrag={true}
          enableZoomInteraction={true}
          cooldownTicks={100}
          cooldownTime={2000}
        />
      </div>
    </div>
  );
}
