from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional


PROMPT_VERSION = "choose_link_v1"
SEMANTICS_VERSION = "local_parity_v1"
DEFAULT_BENCHMARK_DB_PATH = Path("parallel_eval/releases/wikihop-benchmark-simplewiki-20260123.db")


@dataclass(frozen=True)
class BenchmarkSetup:
    id: str
    mode: str
    max_hops: int
    max_links: Optional[int]
    max_tokens: Optional[int]
    include_image_links: bool
    disable_links_view: bool
    prompt_version: str
    semantics_version: str
    max_tries: int
    primary_time_metric: str = "llm_latency_ms"
    secondary_time_metric: str = "duration_ms"


CLASSIC_LOCAL_V1 = BenchmarkSetup(
    id="classic_local_v1",
    mode="local",
    max_hops=20,
    max_links=None,
    max_tokens=None,
    include_image_links=False,
    disable_links_view=False,
    prompt_version=PROMPT_VERSION,
    semantics_version=SEMANTICS_VERSION,
    max_tries=3,
)


BENCHMARK_SETUPS: dict[str, BenchmarkSetup] = {
    CLASSIC_LOCAL_V1.id: CLASSIC_LOCAL_V1,
}


def get_benchmark_setup(setup_id: Optional[str]) -> Optional[BenchmarkSetup]:
    if not isinstance(setup_id, str) or not setup_id.strip():
        return None
    return BENCHMARK_SETUPS.get(setup_id.strip())
