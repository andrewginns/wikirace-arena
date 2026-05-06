from __future__ import annotations

import json
import sqlite3
from collections import Counter, defaultdict, deque
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Iterator, Optional
from urllib.parse import quote


@dataclass(frozen=True)
class DegreeStats:
    out_degree: int
    in_degree: int


class SQLiteGraph:
    def __init__(self, db_path: Path):
        self.db_path = Path(db_path)
        db_uri = f"file:{quote(str(self.db_path.resolve()))}?mode=ro&immutable=1"
        self.conn = sqlite3.connect(db_uri, uri=True)
        self.conn.row_factory = sqlite3.Row
        self.cur = self.conn.cursor()

    def close(self) -> None:
        try:
            self.conn.close()
        except Exception:
            pass

    def iter_articles(self) -> Iterator[tuple[str, list[str]]]:
        self.cur.execute("SELECT title, links_json FROM core_articles")
        for row in self.cur:
            title = row["title"]
            links_json = row["links_json"]
            try:
                links = json.loads(links_json)
            except Exception:
                links = []
            if not isinstance(links, list):
                links = []
            links = [v for v in links if isinstance(v, str) and v]
            yield title, links

    @lru_cache(maxsize=65536)
    def links(self, title: str) -> list[str]:
        self.cur.execute("SELECT links_json FROM core_articles WHERE title = ? LIMIT 1", (title,))
        row = self.cur.fetchone()
        if not row:
            return []
        try:
            links = json.loads(row["links_json"])
        except Exception:
            return []
        if not isinstance(links, list):
            return []
        return [v for v in links if isinstance(v, str) and v]

    def resolve_title(self, article_title: str) -> Optional[str]:
        if not article_title:
            return None

        title = article_title.replace("_", " ").strip()
        if not title:
            return None

        return self._resolve_title_normalized(title)

    @lru_cache(maxsize=32768)
    def _resolve_title_normalized(self, title: str) -> Optional[str]:
        self.cur.execute(
            "SELECT title FROM core_articles WHERE title = ? LIMIT 1",
            (title,),
        )
        row = self.cur.fetchone()
        if row:
            return row[0]

        self.cur.execute(
            "SELECT title FROM core_articles WHERE title = ? COLLATE NOCASE LIMIT 1",
            (title,),
        )
        row = self.cur.fetchone()
        if row:
            return row[0]

        return None

    @lru_cache(maxsize=16384)
    def canonical_title(self, article_title: str) -> Optional[str]:
        resolved = self.resolve_title(article_title)
        if not resolved:
            return None

        current = resolved
        seen = {current}

        for _ in range(6):
            links = self.links(current)
            if len(links) != 1:
                break

            candidate = self.resolve_title(links[0])
            if not candidate or candidate in seen:
                break
            seen.add(candidate)
            current = candidate

        return current

    @lru_cache(maxsize=65536)
    def has_article(self, title: str) -> bool:
        self.cur.execute("SELECT 1 FROM core_articles WHERE title = ? LIMIT 1", (title,))
        row = self.cur.fetchone()
        return row is not None


def build_incoming_index(graph: SQLiteGraph) -> dict[str, list[str]]:
    incoming: dict[str, list[str]] = {}
    for title, links in graph.iter_articles():
        for target in links:
            incoming.setdefault(target, []).append(title)
    return incoming


def compute_degrees(
    db_path: Path,
    *,
    min_out_degree: int = 0,
    max_out_degree: int | None = None,
) -> dict[str, DegreeStats]:
    graph = SQLiteGraph(db_path)
    try:
        degrees: dict[str, DegreeStats]
        try:
            out_counts: dict[str, int] = {}
            graph.cur.execute("SELECT title, json_array_length(links_json) AS out_degree FROM core_articles")
            for row in graph.cur:
                title = row["title"]
                out_degree = row["out_degree"]
                out_counts[title] = int(out_degree) if isinstance(out_degree, int) else 0

            in_counts: Counter[str] = Counter()
            graph.cur.execute(
                """
                SELECT json_each.value AS title, COUNT(*) AS in_degree
                FROM core_articles, json_each(core_articles.links_json)
                GROUP BY json_each.value
                """
            )
            for row in graph.cur:
                title = row["title"]
                in_degree = row["in_degree"]
                if isinstance(title, str):
                    in_counts[title] = int(in_degree) if isinstance(in_degree, int) else 0

            degrees = {
                title: DegreeStats(out_degree=outd, in_degree=int(in_counts.get(title, 0)))
                for title, outd in out_counts.items()
            }
        except sqlite3.OperationalError:
            in_counts = Counter()
            out_counts = {}
            for title, links in graph.iter_articles():
                out_counts[title] = len(links)
                in_counts.update(links)

            degrees = {
                title: DegreeStats(out_degree=outd, in_degree=int(in_counts.get(title, 0)))
                for title, outd in out_counts.items()
            }

        if min_out_degree > 0 or max_out_degree is not None:
            degrees = {
                title: stats
                for title, stats in degrees.items()
                if stats.out_degree >= min_out_degree
                and (max_out_degree is None or stats.out_degree <= max_out_degree)
            }

        return degrees
    finally:
        graph.close()


def top_hubs(
    degrees: dict[str, DegreeStats],
    *,
    top_k_out: int,
    top_k_in: int,
) -> set[str]:
    hubs: set[str] = set()
    if top_k_out > 0:
        hubs.update(
            [t for t, _ in sorted(degrees.items(), key=lambda kv: kv[1].out_degree, reverse=True)[:top_k_out]]
        )
    if top_k_in > 0:
        hubs.update(
            [t for t, _ in sorted(degrees.items(), key=lambda kv: kv[1].in_degree, reverse=True)[:top_k_in]]
        )
    return hubs


def bfs_distance(
    graph: SQLiteGraph,
    *,
    start: str,
    target: str,
    max_depth: int,
    max_nodes: int = 200_000,
) -> Optional[int]:
    """Forward BFS distance on directed edges (outgoing links).

    This is used as an exact distance when it finds a path within max_depth.
    It returns None if no path is found within the cap.
    """

    if start == target:
        return 0

    seen: set[str] = {start}
    q: deque[tuple[str, int]] = deque([(start, 0)])
    visited = 0

    while q:
        node, depth = q.popleft()
        if depth >= max_depth:
            continue

        for nxt in graph.links(node):
            if nxt == target:
                return depth + 1
            if nxt in seen:
                continue
            seen.add(nxt)
            q.append((nxt, depth + 1))
            visited += 1
            if visited >= max_nodes:
                return None

    return None


def bfs_shortest_path(
    graph: SQLiteGraph,
    *,
    start: str,
    target: str,
    max_depth: int,
    max_nodes: int = 200_000,
) -> Optional[list[str]]:
    """Forward BFS returning one shortest path (inclusive) on directed edges.

    Returns None if no path is found within max_depth/max_nodes.
    """

    if start == target:
        return [start]

    parent: dict[str, str] = {}
    seen: set[str] = {start}
    q: deque[tuple[str, int]] = deque([(start, 0)])
    visited = 0

    while q:
        node, depth = q.popleft()
        if depth >= max_depth:
            continue

        for nxt in graph.links(node):
            if nxt in seen:
                continue
            parent[nxt] = node
            if nxt == target:
                path = [target]
                cur: str = target
                while cur != start:
                    prev = parent.get(cur)
                    if prev is None:
                        return None
                    cur = prev
                    path.append(prev)
                path.reverse()
                return path

            seen.add(nxt)
            q.append((nxt, depth + 1))
            visited += 1
            if visited >= max_nodes:
                return None

    return None


def bfs_shortest_path_dag(
    graph: SQLiteGraph,
    *,
    start: str,
    max_depth: int,
    max_nodes: int = 200_000,
    path_count_cap: int = 128,
) -> tuple[dict[str, int], dict[str, list[str]], dict[str, int]]:
    """Return shortest-path DAG metadata rooted at ``start``.

    The result contains:
    - distances: exact BFS distance from ``start`` to each reached node
    - parents: all predecessor nodes that lie on at least one shortest path
    - path_counts: capped count of shortest paths to each node
    """

    distances: dict[str, int] = {start: 0}
    parents: dict[str, list[str]] = defaultdict(list)
    path_counts: dict[str, int] = {start: 1}
    q: deque[str] = deque([start])
    visited = 0

    while q:
        node = q.popleft()
        depth = distances.get(node, 0)
        if depth >= max_depth:
            continue

        for nxt in graph.links(node):
            next_depth = depth + 1
            recorded_depth = distances.get(nxt)

            if recorded_depth is None:
                distances[nxt] = next_depth
                parents[nxt] = [node]
                path_counts[nxt] = min(path_count_cap, path_counts.get(node, 0))
                q.append(nxt)
                visited += 1
                if visited >= max_nodes:
                    return distances, dict(parents), path_counts
                continue

            if recorded_depth == next_depth:
                parent_list = parents.setdefault(nxt, [])
                if node not in parent_list:
                    parent_list.append(node)
                    path_counts[nxt] = min(
                        path_count_cap,
                        path_counts.get(nxt, 0) + path_counts.get(node, 0),
                    )

    return distances, dict(parents), path_counts


def shortest_path_dag_choke_profile(
    *,
    distances: dict[str, int],
    parents: dict[str, list[str]],
    path_counts: dict[str, int],
    target: str,
    strong_share_threshold: float = 0.75,
) -> dict[str, object]:
    """Summarize shortest-path choke structure for one ``target``.

    The returned profile is derived from the shortest-path DAG rooted at the BFS
    start used to compute ``distances`` / ``parents`` / ``path_counts``.
    """

    if target not in distances or target not in path_counts:
        return {
            "total_shortest_paths": 0,
            "max_internal_share": 0.0,
            "first_strong_choke_depth": None,
            "strong_choke_count": 0,
            "internal_node_count": 0,
        }

    on_path: set[str] = set()
    stack = [target]
    while stack:
        node = stack.pop()
        if node in on_path:
            continue
        on_path.add(node)
        stack.extend(parents.get(node, ()))

    children: dict[str, list[str]] = defaultdict(list)
    for node, prevs in parents.items():
        if node not in on_path:
            continue
        for prev in prevs:
            if prev in on_path:
                children[prev].append(node)

    to_target_counts: dict[str, int] = {target: 1}
    ordered = sorted(on_path, key=lambda node: distances.get(node, 0), reverse=True)
    total_paths = max(1, int(path_counts.get(target, 1)))
    for node in ordered:
        if node == target:
            continue
        subtotal = 0
        for child in children.get(node, ()):
            if distances.get(child, -1) == distances.get(node, 0) + 1:
                subtotal += to_target_counts.get(child, 0)
        to_target_counts[node] = min(total_paths, subtotal)

    max_internal_share = 0.0
    first_strong_depth: Optional[int] = None
    strong_choke_count = 0
    internal_node_count = 0
    for node in on_path:
        depth = distances.get(node)
        if depth is None or depth <= 0 or node == target:
            continue
        internal_node_count += 1
        share = min(
            1.0,
            float(path_counts.get(node, 0) * to_target_counts.get(node, 0)) / float(total_paths),
        )
        max_internal_share = max(max_internal_share, share)
        if share >= strong_share_threshold:
            strong_choke_count += 1
            if first_strong_depth is None or depth < first_strong_depth:
                first_strong_depth = depth

    return {
        "total_shortest_paths": total_paths,
        "max_internal_share": max_internal_share,
        "first_strong_choke_depth": first_strong_depth,
        "strong_choke_count": strong_choke_count,
        "internal_node_count": internal_node_count,
    }


def bfs_shortest_paths(
    graph: SQLiteGraph,
    *,
    start: str,
    targets: set[str],
    max_depth: int,
    max_nodes: int = 200_000,
) -> dict[str, list[str]]:
    """Forward BFS returning one shortest path (inclusive) for each target found.

    Paths are returned for the subset of targets reached within max_depth/max_nodes.
    """

    if not targets:
        return {}

    remaining = set(targets)
    found: set[str] = set()
    if start in remaining:
        found.add(start)
        remaining.remove(start)

    parent: dict[str, str] = {}
    distances: dict[str, int] = {start: 0}
    q: deque[str] = deque([start])
    visited = 0

    while q and remaining:
        node = q.popleft()
        depth = distances.get(node, 0)
        if depth >= max_depth:
            continue

        for nxt in graph.links(node):
            if nxt in distances:
                continue
            parent[nxt] = node
            distances[nxt] = depth + 1
            if nxt in remaining:
                found.add(nxt)
                remaining.remove(nxt)
                if not remaining:
                    break
            q.append(nxt)
            visited += 1
            if visited >= max_nodes:
                remaining.clear()
                break

    def reconstruct(target: str) -> Optional[list[str]]:
        if target == start:
            return [start]
        if target not in parent:
            return None
        path = [target]
        cur = target
        while cur != start:
            nxt = parent.get(cur)
            if nxt is None:
                return None
            cur = nxt
            path.append(cur)
        path.reverse()
        return path

    out: dict[str, list[str]] = {}
    for tgt in found:
        path = reconstruct(tgt)
        if path is not None:
            out[tgt] = path
    return out


def bfs_shortest_path_bidirectional(
    graph: SQLiteGraph,
    *,
    start: str,
    target: str,
    max_depth: int,
    max_nodes: int = 200_000,
    incoming_index: Optional[dict[str, list[str]]] = None,
) -> Optional[list[str]]:
    """Bidirectional BFS returning one shortest path (inclusive).

    Forward search uses outgoing links; reverse search uses incoming links.
    """

    if start == target:
        return [start]
    if max_depth <= 0:
        return None

    incoming = incoming_index if incoming_index is not None else build_incoming_index(graph)

    pred: dict[str, Optional[str]] = {start: None}
    succ: dict[str, Optional[str]] = {target: None}
    dist_pred: dict[str, int] = {start: 0}
    dist_succ: dict[str, int] = {target: 0}
    forward_fringe: list[str] = [start]
    reverse_fringe: list[str] = [target]
    visited = 0

    while forward_fringe and reverse_fringe:
        if len(forward_fringe) <= len(reverse_fringe):
            this_level = forward_fringe
            forward_fringe = []
            for node in this_level:
                depth = dist_pred.get(node, 0)
                if depth >= max_depth:
                    continue
                for nxt in graph.links(node):
                    if nxt in pred:
                        continue
                    pred[nxt] = node
                    dist_pred[nxt] = depth + 1
                    if nxt in succ and (dist_pred[nxt] + dist_succ.get(nxt, 0)) <= max_depth:
                        path = _reconstruct_bidirectional_path(nxt, pred, succ)
                        if path is not None:
                            return path
                    if dist_pred[nxt] < max_depth:
                        forward_fringe.append(nxt)
                    visited += 1
                    if visited >= max_nodes:
                        return None
        else:
            this_level = reverse_fringe
            reverse_fringe = []
            for node in this_level:
                depth = dist_succ.get(node, 0)
                if depth >= max_depth:
                    continue
                for prev in incoming.get(node, []):
                    if prev in succ:
                        continue
                    succ[prev] = node
                    dist_succ[prev] = depth + 1
                    if prev in pred and (dist_pred.get(prev, 0) + dist_succ[prev]) <= max_depth:
                        path = _reconstruct_bidirectional_path(prev, pred, succ)
                        if path is not None:
                            return path
                    if dist_succ[prev] < max_depth:
                        reverse_fringe.append(prev)
                    visited += 1
                    if visited >= max_nodes:
                        return None

    return None


def _reconstruct_bidirectional_path(
    meeting: str,
    pred: dict[str, Optional[str]],
    succ: dict[str, Optional[str]],
) -> Optional[list[str]]:
    left: list[str] = [meeting]
    cur = meeting
    while True:
        prv = pred.get(cur)
        if prv is None:
            break
        left.append(prv)
        cur = prv
    left.reverse()

    right: list[str] = []
    cur = meeting
    while True:
        nxt = succ.get(cur)
        if nxt is None:
            break
        right.append(nxt)
        cur = nxt

    path = left + right
    if not path:
        return None
    return path


def bfs_shortest_paths_bidirectional(
    graph: SQLiteGraph,
    *,
    start: str,
    targets: set[str],
    max_depth: int,
    max_nodes: int = 200_000,
    incoming_index: Optional[dict[str, list[str]]] = None,
) -> dict[str, list[str]]:
    """Bidirectional BFS shortest paths for a set of targets.

    Uses one bidirectional search per target.
    """

    if not targets:
        return {}

    incoming = incoming_index if incoming_index is not None else build_incoming_index(graph)
    out: dict[str, list[str]] = {}
    for target in targets:
        path = bfs_shortest_path_bidirectional(
            graph,
            start=start,
            target=target,
            max_depth=max_depth,
            max_nodes=max_nodes,
            incoming_index=incoming,
        )
        if path is not None:
            out[target] = path
    return out


def bfs_distances(
    graph: SQLiteGraph,
    *,
    start: str,
    max_depth: int,
    max_nodes: int = 200_000,
) -> dict[str, int]:
    """Return a mapping of node -> distance for all nodes reached within max_depth."""

    distances: dict[str, int] = {start: 0}
    q: deque[str] = deque([start])
    visited = 0

    while q:
        node = q.popleft()
        depth = distances.get(node, 0)
        if depth >= max_depth:
            continue

        for nxt in graph.links(node):
            if nxt in distances:
                continue
            distances[nxt] = depth + 1
            q.append(nxt)
            visited += 1
            if visited >= max_nodes:
                return distances

    return distances


def bfs_tree(
    graph: SQLiteGraph,
    *,
    start: str,
    max_depth: int,
    max_nodes: int = 200_000,
) -> tuple[dict[str, int], dict[str, str]]:
    """Return distances and parent links for one forward BFS rooted at start."""

    distances: dict[str, int] = {start: 0}
    parent: dict[str, str] = {}
    q: deque[str] = deque([start])
    visited = 0

    while q:
        node = q.popleft()
        depth = distances.get(node, 0)
        if depth >= max_depth:
            continue

        for nxt in graph.links(node):
            if nxt in distances:
                continue
            parent[nxt] = node
            distances[nxt] = depth + 1
            q.append(nxt)
            visited += 1
            if visited >= max_nodes:
                return distances, parent

    return distances, parent
