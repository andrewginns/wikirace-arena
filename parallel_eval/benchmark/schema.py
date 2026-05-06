from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


Tier = str
RunResult = Literal["win", "lose"]
RawOutputMode = Literal["none", "truncated", "full"]


class MatchupV1(BaseModel):
    id: str
    tier: Tier = "baseline"
    start: str
    target: str
    tags: list[str] = Field(default_factory=list)
    shortest_path_hops: Optional[int] = None
    suite_id: Optional[str] = None
    slice_id: Optional[str] = None
    setup_id: Optional[str] = None
    prompt_version: Optional[str] = None
    semantics_version: Optional[str] = None
    shortest_path: Optional[list[str]] = None
    path_bucket: Optional[str] = None
    start_out_degree: Optional[int] = None
    target_in_degree: Optional[int] = None
    start_width_bucket: Optional[str] = None
    feature_tags: list[str] = Field(default_factory=list)


class RunBudgetsV1(BaseModel):
    max_hops: int
    max_links: Optional[int] = None
    max_tokens: Optional[int] = None
    max_tries: int = 3


class RunProvenanceV1(BaseModel):
    git_sha: Optional[str] = None
    db_path: Optional[str] = None
    db_sha256: Optional[str] = None
    runner: str = "parallel_eval.benchmark"
    concurrency: Optional[int] = None
    seed: Optional[int] = None
    raw_output_mode: Optional[RawOutputMode] = None


class RunModelSettingsV1(BaseModel):
    model: str
    run_kind: Optional[Literal["human", "llm"]] = None
    player_name: Optional[str] = None
    api_base: Optional[str] = None
    openai_api_mode: Optional[str] = None
    openai_reasoning_effort: Optional[str] = None
    openai_reasoning_summary: Optional[str] = None
    anthropic_thinking_budget_tokens: Optional[int] = None
    google_thinking_config: Optional[dict[str, Any]] = None


class TokenTotalsV1(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class BenchmarkRunRecordV1(BaseModel):
    type: Literal["run"] = "run"
    run_id: str

    dataset_id: str
    matchup_id: str
    tier: Tier
    suite_id: Optional[str] = None
    slice_id: Optional[str] = None
    setup_id: Optional[str] = None
    prompt_version: Optional[str] = None
    semantics_version: Optional[str] = None
    start: str
    target: str
    shortest_path_hops: Optional[int] = None

    started_at: str
    finished_at: str

    result: RunResult
    hops: int
    duration_ms: Optional[int] = None
    llm_latency_ms: Optional[int] = None

    model_settings: RunModelSettingsV1
    budgets: RunBudgetsV1
    totals: TokenTotalsV1 = Field(default_factory=TokenTotalsV1)
    score_inputs: dict[str, Any] = Field(default_factory=dict)

    provenance: RunProvenanceV1 = Field(default_factory=RunProvenanceV1)


class BenchmarkChoiceV1(BaseModel):
    selected_index: Optional[int] = None
    tries: int = 0
    answer_errors: list[str] = Field(default_factory=list)


class BenchmarkStepUsageV1(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class BenchmarkStepRecordV1(BaseModel):
    type: Literal["step"] = "step"
    run_id: str
    hop: int
    at: str
    step_type: Literal["move", "win", "lose"]
    article: str
    current_article: Optional[str] = None
    selected_title: Optional[str] = None
    attempt_count: int = 0
    links_presented_count: Optional[int] = None
    links_presented_ref: Optional[str] = None
    current_article_canonical: Optional[str] = None
    selected_title_canonical: Optional[str] = None
    target_canonical: Optional[str] = None

    choice: BenchmarkChoiceV1 = Field(default_factory=BenchmarkChoiceV1)
    usage: BenchmarkStepUsageV1 = Field(default_factory=BenchmarkStepUsageV1)
    latency_ms: Optional[int] = None
    meta: dict[str, Any] = Field(default_factory=dict)


class BenchmarkAttemptRecordV1(BaseModel):
    type: Literal["attempt"] = "attempt"
    run_id: str
    hop: int
    try_index: int
    at: str
    prompt_version: Optional[str] = None
    prompt_hash: str
    links_presented_count: int
    links_presented_ref: Optional[str] = None
    selected_index_parsed: Optional[int] = None
    selected_title_parsed: Optional[str] = None
    parse_error: Optional[str] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None
    latency_ms: Optional[int] = None
    provider_response_id: Optional[str] = None
    raw_output_ref: Optional[str] = None


BenchmarkRecordV1 = BenchmarkRunRecordV1 | BenchmarkStepRecordV1 | BenchmarkAttemptRecordV1


@dataclass(frozen=True)
class JsonlLine:
    raw: str
    data: dict[str, Any]


def write_jsonl_line(path: Path, obj: BaseModel | dict[str, Any]) -> None:
    import json

    payload = obj.model_dump(mode="json") if isinstance(obj, BaseModel) else obj
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


def read_jsonl(path: Path) -> list[JsonlLine]:
    import json

    lines: list[JsonlLine] = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            data = json.loads(raw)
            if not isinstance(data, dict):
                continue
            lines.append(JsonlLine(raw=raw, data=data))
    return lines
