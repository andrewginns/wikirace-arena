from __future__ import annotations

import re
from typing import Optional, Tuple


def build_llm_prompt(current: str, target: str, path_so_far: list[str], links: list[str]) -> str:
    formatted_links = "\n".join(f"{idx + 1}. {title}" for idx, title in enumerate(links))
    formatted_path = " -> ".join(path_so_far)
    return (
        "You are playing WikiRun, trying to navigate from one Wikipedia article to another using only links.\n\n"
        "IMPORTANT: You MUST put your final answer in <answer>NUMBER</answer> tags, where NUMBER is the link number.\n"
        "For example, if you want to choose link 3, output <answer>3</answer>.\n\n"
        f"Current article: {current}\n"
        f"Target article: {target}\n"
        "Available links (numbered):\n"
        f"{formatted_links}\n\n"
        f"Your path so far: {formatted_path}\n\n"
        "Think about which link is most likely to lead you toward the target article.\n"
        "First, analyze each link briefly and how it connects to your goal, then select the most promising one.\n\n"
        "Remember to format your final answer by explicitly writing out the xml number tags like this: <answer>NUMBER</answer>"
    )


ANSWER_TAG_RE = re.compile(r"<answer>(\d+)</answer>", flags=re.IGNORECASE)


def extract_answer(response: str, maximum_answer: int) -> Tuple[Optional[int], Optional[str]]:
    matches = ANSWER_TAG_RE.findall(response or "")
    if not matches:
        return (
            None,
            f"No <answer>NUMBER</answer> found. Choose a number between 1 and {maximum_answer}.",
        )
    if len(matches) > 1:
        return None, "Multiple <answer> tags found. Respond with exactly one."

    try:
        value = int(matches[0])
    except ValueError:
        return (
            None,
            f"Answer is not a number. Choose a number between 1 and {maximum_answer}.",
        )

    if value < 1 or value > maximum_answer:
        return (
            None,
            f"Answer out of bounds. Choose a number between 1 and {maximum_answer}.",
        )

    return value, None
