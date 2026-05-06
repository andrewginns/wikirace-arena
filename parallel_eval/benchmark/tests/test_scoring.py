from __future__ import annotations

import unittest

from parallel_eval.benchmark.scoring import CompositeWeights, matchup_score


class ScoringTests(unittest.TestCase):
    def test_lose_is_zero(self):
        w = CompositeWeights()
        self.assertEqual(
            matchup_score(result="lose", hops=10, total_tokens=1000, duration_ms=5000, weights=w),
            0.0,
        )

    def test_win_penalizes_hops_tokens_time(self):
        w = CompositeWeights(base=1000.0, alpha_hops=10.0, beta_log1p_tokens=1.0, gamma_log1p_duration_ms=1.0)
        score = matchup_score(result="win", hops=5, total_tokens=999, duration_ms=999, weights=w)
        self.assertLess(score, 1000.0)
        self.assertGreater(score, 0.0)

    def test_null_tokens_or_time_is_allowed(self):
        w = CompositeWeights(base=1000.0, alpha_hops=10.0, beta_log1p_tokens=1000.0, gamma_log1p_duration_ms=1000.0)
        # With null tokens/time, only hop penalty should apply.
        score = matchup_score(result="win", hops=5, total_tokens=None, duration_ms=None, weights=w)
        self.assertEqual(score, 1000.0 - 10.0 * 5.0)


if __name__ == "__main__":
    unittest.main()
