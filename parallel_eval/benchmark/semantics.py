from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol


class CanonicalTitleDB(Protocol):
    def canonical_title(self, article_title: str) -> str | None:
        ...


@dataclass(frozen=True)
class StepHopRow:
    step: dict[str, Any]
    current_article: str
    article: str
    hop: int


def _normalize_title_for_matching(title: str) -> str:
    return title.split("#", 1)[0].replace("_", " ").strip().lower()


def titles_match(a: str, b: str) -> bool:
    return _normalize_title_for_matching(a) == _normalize_title_for_matching(b)


def _step_article_for_hops(article: Any, current_article: str) -> str:
    if not isinstance(article, str) or not article.strip():
        return current_article
    article_without_fragment = article.split("#", 1)[0]
    if not _normalize_title_for_matching(article_without_fragment):
        return current_article
    return article_without_fragment


def canonicalize_title(db: CanonicalTitleDB, title: str) -> str:
    canonical = db.canonical_title(title)
    if isinstance(canonical, str) and canonical.strip():
        return canonical
    return title


def titles_reach_target(db: CanonicalTitleDB, article: str, target: str) -> bool:
    if titles_match(article, target):
        return True

    canonical_article = db.canonical_title(article)
    canonical_target = db.canonical_title(target)
    if canonical_article and canonical_target and titles_match(canonical_article, canonical_target):
        return True

    return False


def hop_rows_from_steps(
    steps: list[dict[str, Any]],
    start: str,
) -> tuple[list[StepHopRow], int]:
    hop_rows: list[StepHopRow] = []
    traversed_hops = 0
    current_article = start

    for step in steps:
        step_type = step.get("type")
        if step_type == "start":
            current_article = _step_article_for_hops(step.get("article"), current_article)
            continue
        if step_type not in ("move", "win", "lose"):
            continue

        article = _step_article_for_hops(step.get("article"), current_article)

        row_current_article = current_article
        if not titles_match(article, current_article):
            traversed_hops += 1
            current_article = article

        hop_rows.append(
            StepHopRow(
                step=step,
                current_article=row_current_article,
                article=article,
                hop=traversed_hops,
            )
        )

    return hop_rows, traversed_hops
