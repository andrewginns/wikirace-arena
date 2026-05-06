from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class CompositeWeights:
    base: float = 1000.0
    alpha_hops: float = 20.0
    beta_log1p_tokens: float = 25.0
    gamma_log1p_duration_ms: float = 15.0


def matchup_score(
    *,
    result: str,
    hops: int,
    total_tokens: Optional[int],
    duration_ms: Optional[int],
    weights: CompositeWeights,
) -> float:
    if result != "win":
        return 0.0

    score = weights.base - weights.alpha_hops * float(hops)

    if isinstance(total_tokens, int) and total_tokens >= 0:
        score -= weights.beta_log1p_tokens * math.log1p(float(total_tokens))

    if isinstance(duration_ms, int) and duration_ms >= 0:
        score -= weights.gamma_log1p_duration_ms * math.log1p(float(duration_ms))

    return float(score)
