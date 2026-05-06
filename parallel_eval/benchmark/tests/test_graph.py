from __future__ import annotations

import unittest

from parallel_eval.benchmark.graph import (
    bfs_distance,
    bfs_distances,
    bfs_shortest_path,
    bfs_shortest_path_bidirectional,
    bfs_shortest_path_dag,
    bfs_shortest_paths,
    bfs_shortest_paths_bidirectional,
    shortest_path_dag_choke_profile,
)


class _FakeGraph:
    def __init__(self, edges: dict[str, list[str]]):
        self._edges = edges

    def links(self, title: str) -> list[str]:
        return list(self._edges.get(title, []))


class GraphTests(unittest.TestCase):
    def test_bfs_distance_finds_shortest(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["D"],
                "C": ["D"],
                "D": [],
            }
        )
        # A -> B -> D (2) or A -> C -> D (2)
        self.assertEqual(bfs_distance(g, start="A", target="D", max_depth=5), 2)

    def test_bfs_shortest_path_returns_path(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["D"],
                "C": ["D"],
                "D": [],
            }
        )
        path = bfs_shortest_path(g, start="A", target="D", max_depth=5)
        self.assertIsNotNone(path)
        self.assertEqual(path[0], "A")
        self.assertEqual(path[-1], "D")
        self.assertEqual(len(path) - 1, 2)

    def test_bfs_shortest_paths_returns_multiple(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["D"],
                "C": ["E"],
                "D": [],
                "E": [],
            }
        )
        paths = bfs_shortest_paths(g, start="A", targets={"D", "E"}, max_depth=5)
        self.assertEqual(paths["D"], ["A", "B", "D"])
        self.assertEqual(paths["E"], ["A", "C", "E"])

    def test_bfs_shortest_path_bidirectional_returns_path(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["D"],
                "C": ["D"],
                "D": [],
            }
        )
        incoming = {"B": ["A"], "C": ["A"], "D": ["B", "C"]}
        path = bfs_shortest_path_bidirectional(g, start="A", target="D", max_depth=5, incoming_index=incoming)
        self.assertIsNotNone(path)
        self.assertEqual(path[0], "A")
        self.assertEqual(path[-1], "D")
        self.assertEqual(len(path) - 1, 2)

    def test_bfs_shortest_paths_bidirectional_returns_multiple(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["D"],
                "C": ["E"],
                "D": [],
                "E": [],
            }
        )
        incoming = {"B": ["A"], "C": ["A"], "D": ["B"], "E": ["C"]}
        paths = bfs_shortest_paths_bidirectional(
            g,
            start="A",
            targets={"D", "E"},
            max_depth=5,
            incoming_index=incoming,
        )
        self.assertEqual(paths["D"], ["A", "B", "D"])
        self.assertEqual(paths["E"], ["A", "C", "E"])

    def test_bfs_distance_respects_depth_cap(self):
        g = _FakeGraph({"A": ["B"], "B": ["C"], "C": ["D"], "D": []})
        self.assertIsNone(bfs_distance(g, start="A", target="D", max_depth=2))

    def test_bfs_shortest_path_dag_tracks_multiple_parents_and_counts(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["D"],
                "C": ["D"],
                "D": ["E"],
                "E": [],
            }
        )
        distances, parents, path_counts = bfs_shortest_path_dag(g, start="A", max_depth=5)
        self.assertEqual(distances["D"], 2)
        self.assertEqual(parents["D"], ["B", "C"])
        self.assertEqual(path_counts["D"], 2)
        self.assertEqual(path_counts["E"], 2)

    def test_bfs_distances_returns_map(self):
        g = _FakeGraph({"A": ["B", "C"], "B": ["D"], "C": [], "D": []})
        dist = bfs_distances(g, start="A", max_depth=10)
        self.assertEqual(dist["A"], 0)
        self.assertEqual(dist["B"], 1)
        self.assertEqual(dist["C"], 1)
        self.assertEqual(dist["D"], 2)

    def test_shortest_path_dag_choke_profile_detects_shared_bridge(self):
        g = _FakeGraph(
            {
                "A": ["B", "C"],
                "B": ["X"],
                "C": ["X"],
                "X": ["T"],
                "T": [],
            }
        )
        distances, parents, path_counts = bfs_shortest_path_dag(g, start="A", max_depth=5)
        profile = shortest_path_dag_choke_profile(
            distances=distances,
            parents=parents,
            path_counts=path_counts,
            target="T",
            strong_share_threshold=0.75,
        )
        self.assertEqual(profile["total_shortest_paths"], 2)
        self.assertEqual(profile["first_strong_choke_depth"], 2)
        self.assertEqual(profile["strong_choke_count"], 1)
        self.assertAlmostEqual(profile["max_internal_share"], 1.0)


if __name__ == "__main__":
    unittest.main()
