from __future__ import annotations

import hashlib
import json
import subprocess
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional

from parallel_eval.benchmark.graph import (
    SQLiteGraph,
    bfs_shortest_paths,
    bfs_shortest_paths_bidirectional,
    build_incoming_index,
)
from parallel_eval.benchmark.schema import MatchupV1, read_jsonl


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _file_sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            block = f.read(1024 * 1024)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def _git_sha() -> Optional[str]:
    try:
        result = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
        sha = (result.stdout or "").strip()
        return sha if sha else None
    except Exception:
        return None


def compute_ground_truth_shortest_paths(
    *,
    db_path: Path,
    dataset_path: Path,
    out_path: Path,
    out_meta_path: Optional[Path],
    max_depth: int,
    max_nodes: int,
    overwrite_hops: bool,
    search_mode: Literal["forward", "bidirectional"] = "forward",
    cli_args: Optional[dict[str, Any]] = None,
) -> None:
    """Enrich a matchup dataset with exact shortest paths (directed, outgoing links)."""

    lines = read_jsonl(dataset_path)
    if not lines:
        raise ValueError(f"Dataset is empty: {dataset_path}")

    matchups: list[MatchupV1] = []
    payloads: list[dict[str, Any]] = []
    for line in lines:
        matchup = MatchupV1.model_validate(line.data)
        matchups.append(matchup)
        payloads.append(dict(line.data))

    by_start: dict[str, list[int]] = defaultdict(list)
    for idx, m in enumerate(matchups):
        by_start[m.start].append(idx)

    if max_depth <= 0:
        raise ValueError(f"--max-depth must be > 0 (got {max_depth})")
    if max_nodes <= 0:
        raise ValueError(f"--max-nodes must be > 0 (got {max_nodes})")

    graph = SQLiteGraph(db_path)
    try:
        all_titles = {m.start for m in matchups} | {m.target for m in matchups}
        missing_titles = [title for title in sorted(all_titles) if not graph.has_article(title)]
        if missing_titles:
            raise ValueError(
                f"Dataset includes {len(missing_titles)} titles missing from DB {db_path}. "
                f"Examples: {missing_titles[:10]!r}"
            )

        incoming_index = build_incoming_index(graph) if search_mode == "bidirectional" else None

        for start, idxs in by_start.items():
            targets = {matchups[i].target for i in idxs}
            if not targets:
                continue

            if search_mode == "forward":
                paths = bfs_shortest_paths(
                    graph,
                    start=start,
                    targets=targets,
                    max_depth=max_depth,
                    max_nodes=max_nodes,
                )
            else:
                paths = bfs_shortest_paths_bidirectional(
                    graph,
                    start=start,
                    targets=targets,
                    max_depth=max_depth,
                    max_nodes=max_nodes,
                    incoming_index=incoming_index,
                )

            missing = [t for t in sorted(targets) if t not in paths]
            if missing:
                hint = (
                    f"Missing {len(missing)}/{len(targets)} targets for start={start!r}. "
                    f"Try increasing --max-depth (currently {max_depth}) and/or --max-nodes (currently {max_nodes}). "
                    f"Examples: {missing[:5]!r}"
                )
                raise RuntimeError(hint)

            for i in idxs:
                m = matchups[i]
                payload = payloads[i]
                path = paths[m.target]
                computed_hops = max(0, len(path) - 1)
                recorded_hops = m.shortest_path_hops
                if recorded_hops is not None and recorded_hops != computed_hops:
                    if not overwrite_hops:
                        raise ValueError(
                            f"shortest_path_hops mismatch for id={m.id}: recorded={recorded_hops} computed={computed_hops}. "
                            "Re-run with --overwrite-hops to update the dataset output."
                        )
                    payload["shortest_path_hops"] = computed_hops
                    if isinstance(payload.get("tags"), list):
                        payload["tags"] = [
                            (f"dist={computed_hops}" if isinstance(t, str) and t.startswith("dist=") else t)
                            for t in payload["tags"]
                        ]
                payload["shortest_path"] = path

    finally:
        graph.close()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        for payload in payloads:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")

    if out_meta_path is None:
        out_meta_path = out_path.with_suffix(out_path.suffix + ".meta.json")
    meta = {
        "created_at": _now_iso(),
        "git_sha": _git_sha(),
        "db_path": str(db_path),
        "db_sha256": _file_sha256(db_path),
        "dataset_path": str(dataset_path),
        "matchup_count": len(matchups),
        "unique_starts": len(by_start),
        "max_depth": max_depth,
        "max_nodes": max_nodes,
        "overwrite_hops": overwrite_hops,
        "search_mode": search_mode,
        "cli_args": dict(cli_args or {}),
        "notes": "Shortest paths computed over directed outgoing links from core_articles.links_json.",
    }
    out_meta_path.write_text(json.dumps(meta, indent=2), "utf-8")
