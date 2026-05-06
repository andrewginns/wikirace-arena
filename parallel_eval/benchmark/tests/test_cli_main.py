from __future__ import annotations

import importlib
import unittest
from pathlib import Path
from unittest import mock


benchmark_main = importlib.import_module("parallel_eval.benchmark.__main__")


class BenchmarkCliTests(unittest.TestCase):
    def test_generate_fixed_suite_defaults_out_dir_to_suite_id(self):
        with mock.patch.object(benchmark_main, "generate_fixed_suite") as generate_fixed_suite:
            rc = benchmark_main.main(
                [
                    "generate-fixed-suite",
                    "--suite-id",
                    "custom_suite_v9",
                ]
            )

        self.assertEqual(rc, 0)
        kwargs = generate_fixed_suite.call_args.kwargs
        self.assertEqual(kwargs["suite_id"], "custom_suite_v9")
        self.assertEqual(kwargs["out_dir"], Path("benchmarks/matchups/custom_suite_v9"))


if __name__ == "__main__":
    unittest.main()
