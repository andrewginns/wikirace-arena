import sqlite3
import json
import os
import re
import asyncio
import secrets
import string
import socket
import subprocess
import sys
import ipaddress
from urllib.parse import quote
from typing import Tuple, List, Optional, Any
from functools import lru_cache
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
import uvicorn
import litellm
import aiohttp

app = FastAPI(title="WikiSpeedia API")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins
    allow_credentials=True,
    allow_methods=["*"],  # Allows all methods
    allow_headers=["*"],  # Allows all headers
)


SIMPLEWIKI_ORIGIN = "https://simple.wikipedia.org"


class LLMChatRequest(BaseModel):
    model: str
    prompt: str
    max_tokens: Optional[int] = None
    temperature: Optional[float] = None
    api_base: Optional[str] = None
    # Advanced (provider-specific) parameters.
    # LiteLLM supports `reasoning_effort` for OpenAI reasoning models, and also maps it
    # to the appropriate underlying fields for providers like Anthropic.
    reasoning_effort: Optional[str] = None
    # Alias for providers that expose this as "effort" (we map to reasoning_effort).
    effort: Optional[str] = None


class LLMUsage(BaseModel):
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class LLMChatResponse(BaseModel):
    content: str
    usage: Optional[LLMUsage] = None


class LLMChooseLinkRequest(BaseModel):
    model: str
    current_article: str
    target_article: str
    path_so_far: List[str]
    links: List[str]
    max_tries: Optional[int] = None
    max_tokens: Optional[int] = None
    api_base: Optional[str] = None
    reasoning_effort: Optional[str] = None


class LLMChooseLinkResponse(BaseModel):
    selected_index: Optional[int] = None
    tries: int
    llm_output: Optional[str] = None
    llm_outputs: Optional[List[str]] = None
    answer_errors: Optional[List[str]] = None
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


class ArticleResponse(BaseModel):
    title: str
    links: List[str]


class ResolveTitleResponse(BaseModel):
    exists: bool
    title: Optional[str] = None


class CanonicalTitleResponse(BaseModel):
    title: str


class HealthResponse(BaseModel):
    status: str
    article_count: int


class RoomRulesV1(BaseModel):
    max_hops: int
    max_links: Optional[int] = None
    max_tokens: Optional[int] = None
    include_image_links: bool = False


class RoomPlayerV1(BaseModel):
    id: str
    name: str
    connected: bool
    joined_at: str


class RoomStepV1(BaseModel):
    type: str
    article: str
    at: str
    metadata: Optional[dict[str, Any]] = None


class RoomRunV1(BaseModel):
    id: str
    kind: str
    player_id: Optional[str] = None
    player_name: Optional[str] = None
    model: Optional[str] = None
    api_base: Optional[str] = None
    reasoning_effort: Optional[str] = None
    max_steps: Optional[int] = None
    max_links: Optional[int] = None
    max_tokens: Optional[int] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    status: str
    result: Optional[str] = None
    steps: List[RoomStepV1]


class RoomStateV1(BaseModel):
    id: str
    created_at: str
    updated_at: str
    owner_player_id: str
    title: Optional[str] = None
    start_article: str
    destination_article: str
    rules: RoomRulesV1
    status: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    players: List[RoomPlayerV1]
    runs: List[RoomRunV1]


class CreateRoomRequest(BaseModel):
    start_article: str
    destination_article: str
    title: Optional[str] = None
    owner_name: Optional[str] = None
    rules: Optional[RoomRulesV1] = None


class CreateRoomResponse(BaseModel):
    room_id: str
    owner_player_id: str
    join_url: str
    room: RoomStateV1


class JoinRoomRequest(BaseModel):
    name: str


class JoinRoomResponse(BaseModel):
    player_id: str
    room: RoomStateV1


class StartRoomRequest(BaseModel):
    player_id: str


class NewRoundRequest(BaseModel):
    player_id: str
    start_article: str
    destination_article: str


class MoveRoomRequest(BaseModel):
    player_id: str
    to_article: str


class AddLlmRunRequest(BaseModel):
    model: str
    player_name: Optional[str] = None
    api_base: Optional[str] = None
    reasoning_effort: Optional[str] = None
    max_steps: Optional[int] = None
    max_links: Optional[int] = None
    max_tokens: Optional[int] = None
    requested_by_player_id: str


class RoomRunControlRequest(BaseModel):
    requested_by_player_id: str


class SQLiteDB:
    def __init__(self, db_path: str):
        """Initialize the database with path to SQLite database"""
        self.db_path = db_path
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row
        self.cursor = self.conn.cursor()
        self._article_count = self._get_article_count()
        print(f"Connected to SQLite database with {self._article_count} articles")

    def _get_article_count(self):
        self.cursor.execute("SELECT COUNT(*) FROM core_articles")
        return self.cursor.fetchone()[0]

    @lru_cache(maxsize=8192)
    def get_article_with_links(self, article_title: str) -> Tuple[str, List[str]]:
        self.cursor.execute(
            "SELECT title, links_json FROM core_articles WHERE title = ?",
            (article_title,),
        )
        article = self.cursor.fetchone()
        if not article:
            return None, []

        links = json.loads(article["links_json"])
        return article["title"], links

    def get_all_articles(self):
        self.cursor.execute("SELECT title FROM core_articles")
        return [row[0] for row in self.cursor.fetchall()]

    def resolve_title(self, article_title: str) -> Optional[str]:
        """Return the canonical title for an article if it exists.

        This is used by the iframe click-bridge to keep human navigation aligned
        with the titles stored in our SQLite database.

        We try exact match first, then a case-insensitive match.
        """

        if not article_title:
            return None

        title = article_title.replace("_", " ").strip()
        if not title:
            return None

        self.cursor.execute(
            "SELECT title FROM core_articles WHERE title = ? LIMIT 1",
            (title,),
        )
        row = self.cursor.fetchone()
        if row:
            return row[0]

        self.cursor.execute(
            "SELECT title FROM core_articles WHERE title = ? COLLATE NOCASE LIMIT 1",
            (title,),
        )
        row = self.cursor.fetchone()
        if row:
            return row[0]

        return None

    @lru_cache(maxsize=16384)
    def canonical_title(self, article_title: str) -> Optional[str]:
        """Resolve a title to a stable canonical title.

        For now this is a lightweight redirect heuristic based on the DB:
        follow single-link pages (redirect-style stubs) for a few hops.
        """

        resolved = self.resolve_title(article_title)
        if not resolved:
            return None

        current = resolved
        seen = {current}

        for _ in range(6):
            title, links = self.get_article_with_links(current)
            if not title:
                break
            if len(links) != 1:
                break

            candidate = self.resolve_title(links[0])
            if not candidate:
                break
            if candidate in seen:
                break
            seen.add(candidate)
            current = candidate

        return current


# Initialize database connection
default_db_path = os.path.join(
    os.path.dirname(__file__), "parallel_eval", "wikihop.db"
)
db_path = os.getenv("WIKISPEEDIA_DB_PATH", default_db_path)

if not os.path.exists(db_path):
    raise RuntimeError(
        "WIKISPEEDIA_DB_PATH not found at "
        + db_path
        + ". Generate it with `uv run python get_wikihop.py --output parallel_eval/wikihop.db` "
        + "or set WIKISPEEDIA_DB_PATH to a valid SQLite database."
    )

db = SQLiteDB(db_path)


ROOMS: dict[str, dict[str, Any]] = {}
ROOM_LOCKS: dict[str, asyncio.Lock] = {}
ROOM_CONNECTIONS: dict[str, set[WebSocket]] = {}
ROOM_TASKS: dict[str, dict[str, asyncio.Task]] = {}


def _env_positive_int(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return value if value > 0 else default


WIKIRACE_MAX_LLM_RUNS_PER_ROOM = _env_positive_int("WIKIRACE_MAX_LLM_RUNS_PER_ROOM", 8)
WIKIRACE_MAX_CONCURRENT_LLM_CALLS = _env_positive_int("WIKIRACE_MAX_CONCURRENT_LLM_CALLS", 3)
LLM_CALL_SEMAPHORE = asyncio.Semaphore(WIKIRACE_MAX_CONCURRENT_LLM_CALLS)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _titles_match(a: str, b: str) -> bool:
    return a.replace("_", " ").strip().lower() == b.replace("_", " ").strip().lower()


def _normalize_room_id(room_id: str) -> str:
    raw = (room_id or "").strip()
    if not raw:
        return raw

    if "_" in raw:
        prefix, rest = raw.split("_", 1)
        if prefix.lower() == "room":
            return f"room_{rest.upper()}"

    return f"room_{raw.upper()}"


def _make_code(prefix: str, length: int = 10) -> str:
    alphabet = string.ascii_uppercase + string.digits
    alphabet = alphabet.replace("0", "").replace("1", "").replace("O", "").replace("I", "")
    token = "".join(secrets.choice(alphabet) for _ in range(length))
    return f"{prefix}_{token}"


def _detect_lan_ip() -> Optional[str]:
    override = (os.getenv("WIKIRACE_PUBLIC_HOST") or "").strip()
    if override:
        return override

    def is_usable(ip: str) -> bool:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            return False
        if addr.version != 4:
            return False
        if addr.is_loopback or addr.is_link_local or addr.is_multicast or addr.is_unspecified:
            return False
        return True

    # macOS: ask the OS directly.
    if sys.platform == "darwin":
        iface_candidates = ["en0", "en1"]
        try:
            iface_candidates.extend([name for _, name in socket.if_nameindex()])
        except Exception:
            pass

        seen = set()
        for iface in iface_candidates:
            if iface in seen:
                continue
            seen.add(iface)
            try:
                result = subprocess.run(
                    ["ipconfig", "getifaddr", iface],
                    capture_output=True,
                    text=True,
                )
            except FileNotFoundError:
                break
            except Exception:
                continue
            if result.returncode != 0:
                continue
            ip = (result.stdout or "").strip()
            if ip and is_usable(ip):
                return ip

    # Linux: prefer `hostname -I`.
    if sys.platform.startswith("linux"):
        try:
            result = subprocess.run(
                ["hostname", "-I"],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                for token in (result.stdout or "").split():
                    if is_usable(token):
                        return token
        except Exception:
            pass

    # Generic heuristic: infer the chosen outbound interface without sending packets.
    candidates = [("1.1.1.1", 80), ("8.8.8.8", 80), ("10.255.255.255", 1)]
    for host, port in candidates:
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.connect((host, port))
            ip = sock.getsockname()[0]
            if ip and is_usable(ip):
                return ip
        except Exception:
            continue
        finally:
            if sock is not None:
                try:
                    sock.close()
                except Exception:
                    pass

    # Last resort: hostname resolution.
    try:
        _, _, ips = socket.gethostbyname_ex(socket.gethostname())
    except Exception:
        ips = []

    for ip in ips:
        if is_usable(ip):
            return ip

    return None


def _normalize_room_rules(raw: Optional[RoomRulesV1]) -> dict[str, Any]:
    default = {"max_hops": 20, "max_links": None, "max_tokens": None, "include_image_links": False}
    if raw is None:
        return default

    max_hops = raw.max_hops if isinstance(raw.max_hops, int) and raw.max_hops > 0 else default["max_hops"]

    max_links: Optional[int]
    if raw.max_links is None:
        max_links = None
    else:
        max_links = raw.max_links if isinstance(raw.max_links, int) and raw.max_links > 0 else None

    max_tokens: Optional[int]
    if raw.max_tokens is None:
        max_tokens = None
    else:
        max_tokens = raw.max_tokens if isinstance(raw.max_tokens, int) and raw.max_tokens > 0 else None

    include_image_links = bool(raw.include_image_links)

    return {
        "max_hops": max_hops,
        "max_links": max_links,
        "max_tokens": max_tokens,
        "include_image_links": include_image_links,
    }


def _room_state(room_id: str) -> dict[str, Any]:
    room_id = _normalize_room_id(room_id)
    room = ROOMS.get(room_id)
    if not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )
    return room


def _room_run_for_player(room: dict[str, Any], player_id: str) -> Optional[dict[str, Any]]:
    for run in room.get("runs", []):
        if run.get("player_id") == player_id:
            return run
    return None


def _room_run_by_id(room: dict[str, Any], run_id: str) -> Optional[dict[str, Any]]:
    for run in room.get("runs", []):
        if run.get("id") == run_id:
            return run
    return None


async def _broadcast_room(room_id: str) -> None:
    room_id = _normalize_room_id(room_id)
    room = ROOMS.get(room_id)
    if not room:
        return

    conns = ROOM_CONNECTIONS.get(room_id)
    if not conns:
        return

    payload = json.dumps({"type": "room_state", "room": room}, ensure_ascii=False)
    dead: list[WebSocket] = []

    for ws in list(conns):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)

    for ws in dead:
        try:
            conns.remove(ws)
        except KeyError:
            pass


async def _set_player_connected(room_id: str, player_id: str, connected: bool) -> None:
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        return

    async with lock:
        changed = False
        for player in room.get("players", []):
            if player.get("id") != player_id:
                continue
            if bool(player.get("connected")) == connected:
                break
            player["connected"] = connected
            changed = True
            break

        if changed:
            room["updated_at"] = _now_iso()

    if changed:
        await _broadcast_room(room_id)


def _cancel_room_task(room_id: str, run_id: str) -> None:
    room_id = _normalize_room_id(room_id)
    tasks = ROOM_TASKS.get(room_id)
    if not tasks:
        return

    task = tasks.pop(run_id, None)
    if task:
        task.cancel()

    if not tasks:
        ROOM_TASKS.pop(room_id, None)


def _cancel_room_tasks(room_id: str) -> None:
    room_id = _normalize_room_id(room_id)
    tasks = ROOM_TASKS.pop(room_id, None)
    if not tasks:
        return

    for task in tasks.values():
        task.cancel()


def _build_llm_prompt(current: str, target: str, path_so_far: list[str], links: list[str]) -> str:
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


def _extract_answer(response: str, maximum_answer: int) -> tuple[Optional[int], Optional[str]]:
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


def _usage_payload_from_response(response: Any) -> Optional[dict[str, Any]]:
    raw_usage = getattr(response, "usage", None)
    if not raw_usage:
        return None

    try:
        if isinstance(raw_usage, dict):
            return raw_usage
        if hasattr(raw_usage, "model_dump"):
            return raw_usage.model_dump()
        if hasattr(raw_usage, "dict"):
            return raw_usage.dict()
        return dict(raw_usage)
    except Exception:
        return None


def _llm_kwargs(
    *,
    model: str,
    prompt: str,
    max_tokens: Optional[int],
    api_base: Optional[str],
    reasoning_effort: Optional[str],
) -> dict[str, Any]:
    kwargs: dict[str, Any] = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
    }

    if isinstance(max_tokens, int) and max_tokens > 0:
        kwargs["max_tokens"] = max_tokens

    if reasoning_effort is not None:
        effort = reasoning_effort.strip()
        if effort:
            kwargs["reasoning_effort"] = effort

    if api_base:
        kwargs["api_base"] = api_base
        if "/" not in model or model.startswith(("openai/", "hosted_vllm/")):
            kwargs["api_key"] = os.getenv("OPENAI_API_KEY") or "EMPTY"

    return kwargs


async def _call_llm(prompt: str, *, model: str, max_tokens: Optional[int], api_base: Optional[str], reasoning_effort: Optional[str]):
    async with LLM_CALL_SEMAPHORE:
        response = await litellm.acompletion(
            **_llm_kwargs(
                model=model,
                prompt=prompt,
                max_tokens=max_tokens,
                api_base=api_base,
                reasoning_effort=reasoning_effort,
            )
        )

    content = _extract_llm_content(response)
    if content is None:
        raise RuntimeError("Model returned empty content")

    usage_payload = _usage_payload_from_response(response)
    return content, usage_payload


async def _choose_llm_link(
    *,
    model: str,
    current_article: str,
    target_article: str,
    path_so_far: list[str],
    links: list[str],
    max_tries: int,
    max_tokens: Optional[int],
    api_base: Optional[str],
    reasoning_effort: Optional[str],
) -> tuple[Optional[int], dict[str, Any]]:
    base_prompt = _build_llm_prompt(current_article, target_article, path_so_far, links)
    prompt = base_prompt

    llm_outputs: list[str] = []
    last_output: Optional[str] = None

    prompt_tokens_sum = 0
    completion_tokens_sum = 0
    total_tokens_sum = 0
    saw_prompt_tokens = False
    saw_completion_tokens = False
    saw_any_usage = False

    chosen_index: Optional[int] = None
    used_try: Optional[int] = None
    answer_errors: list[str] = []

    for try_num in range(max_tries):
        response_text, usage_payload = await _call_llm(
            prompt,
            model=model,
            max_tokens=max_tokens,
            api_base=api_base,
            reasoning_effort=reasoning_effort,
        )

        llm_outputs.append(response_text)
        last_output = response_text

        if isinstance(usage_payload, dict):
            prompt_tokens = usage_payload.get("prompt_tokens") or usage_payload.get(
                "input_tokens"
            )
            completion_tokens = usage_payload.get("completion_tokens") or usage_payload.get(
                "output_tokens"
            )
            total_tokens = usage_payload.get("total_tokens")

            if isinstance(prompt_tokens, int):
                prompt_tokens_sum += prompt_tokens
                saw_prompt_tokens = True
                saw_any_usage = True
            if isinstance(completion_tokens, int):
                completion_tokens_sum += completion_tokens
                saw_completion_tokens = True
                saw_any_usage = True

            if isinstance(total_tokens, int):
                total_tokens_sum += total_tokens
                saw_any_usage = True
            elif isinstance(prompt_tokens, int) or isinstance(completion_tokens, int):
                total_tokens_sum += (
                    (prompt_tokens if isinstance(prompt_tokens, int) else 0)
                    + (completion_tokens if isinstance(completion_tokens, int) else 0)
                )
                saw_any_usage = True

        answer, error = _extract_answer(response_text, len(links))
        if answer is not None:
            chosen_index = answer
            used_try = try_num
            break

        if error:
            answer_errors.append(error)
            prompt = f"{base_prompt}\n\nIMPORTANT: {error}"

    if chosen_index is None:
        metadata: dict[str, Any] = {
            "tries": max_tries,
            "answer_errors": answer_errors,
            "llm_output": last_output,
        }
        if len(llm_outputs) > 1:
            metadata["llm_outputs"] = llm_outputs
        if saw_any_usage:
            if saw_prompt_tokens:
                metadata["prompt_tokens"] = prompt_tokens_sum
            if saw_completion_tokens:
                metadata["completion_tokens"] = completion_tokens_sum
            metadata["total_tokens"] = total_tokens_sum
        return None, metadata

    metadata = {
        "tries": used_try or 0,
        "llm_output": last_output,
    }
    if len(llm_outputs) > 1:
        metadata["llm_outputs"] = llm_outputs
    if saw_any_usage:
        if saw_prompt_tokens:
            metadata["prompt_tokens"] = prompt_tokens_sum
        if saw_completion_tokens:
            metadata["completion_tokens"] = completion_tokens_sum
        metadata["total_tokens"] = total_tokens_sum

    return chosen_index, metadata


def _path_so_far(room: dict[str, Any], steps: list[dict[str, Any]]) -> list[str]:
    path: list[str] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        article = step.get("article")
        if not isinstance(article, str) or not article:
            continue
        if path and path[-1] == article:
            continue
        path.append(article)

    start_article = room.get("start_article")
    if not path:
        if isinstance(start_article, str) and start_article:
            return [start_article]
        return []

    if isinstance(start_article, str) and start_article and path[0] != start_article:
        path.insert(0, start_article)

    return path


async def _run_llm_room_task(room_id: str, run_id: str) -> None:
    room_id = _normalize_room_id(room_id)

    try:
        while True:
            lock = ROOM_LOCKS.get(room_id)
            room = ROOMS.get(room_id)
            if not lock or not room:
                return

            async with lock:
                if room.get("status") != "running":
                    return

                run = _room_run_by_id(room, run_id)
                if not run:
                    return

                if run.get("kind") != "llm" or run.get("status") != "running":
                    return

                steps = run.get("steps") or []
                if not isinstance(steps, list):
                    steps = []
                steps = [s for s in steps if isinstance(s, dict)]

                current_article = steps[-1].get("article") if steps else None
                if not isinstance(current_article, str) or not current_article:
                    current_article = room.get("start_article")
                if not isinstance(current_article, str) or not current_article:
                    return

                destination_article = room.get("destination_article")
                if not isinstance(destination_article, str) or not destination_article:
                    return

                current_hops = max(0, len(steps) - 1)
                next_hops = current_hops + 1

                max_steps = run.get("max_steps")
                if not isinstance(max_steps, int) or max_steps <= 0:
                    max_steps = room.get("rules", {}).get("max_hops")
                if not isinstance(max_steps, int) or max_steps <= 0:
                    max_steps = 20

                max_links = run.get("max_links")
                if not isinstance(max_links, int) or max_links <= 0:
                    max_links = None

                max_tokens = run.get("max_tokens")
                if not isinstance(max_tokens, int) or max_tokens <= 0:
                    max_tokens = None

                model = run.get("model")
                model_value = model.strip() if isinstance(model, str) else ""

                api_base = run.get("api_base")
                api_base = api_base if isinstance(api_base, str) and api_base.strip() else None

                reasoning_effort = run.get("reasoning_effort")
                reasoning_effort = (
                    reasoning_effort
                    if isinstance(reasoning_effort, str) and reasoning_effort.strip()
                    else None
                )

                snapshot_steps = steps
                snapshot_current = current_article
                snapshot_destination = destination_article
                snapshot_next_hops = next_hops
                snapshot_max_steps = max_steps
                snapshot_model = model_value or None
                snapshot_api_base = api_base
                snapshot_reasoning_effort = reasoning_effort
                snapshot_max_links = max_links
                snapshot_max_tokens = max_tokens
                snapshot_path = _path_so_far(room, snapshot_steps)

            if snapshot_model is None:
                await _fail_llm_run(
                    room_id,
                    run_id,
                    snapshot_current,
                    reason="llm_error",
                    error="Missing model",
                )
                return

            reached_destination = _titles_match(snapshot_current, snapshot_destination)
            if not reached_destination:
                canonical_current = db.canonical_title(snapshot_current)
                canonical_target = db.canonical_title(snapshot_destination)
                if canonical_current and canonical_target and _titles_match(
                    canonical_current, canonical_target
                ):
                    reached_destination = True

            if reached_destination:
                finished_at = _now_iso()
                async with lock:
                    room = ROOMS.get(room_id)
                    if not room:
                        return
                    if room.get("status") != "running":
                        return
                    run = _room_run_by_id(room, run_id)
                    if not run or run.get("status") != "running":
                        return

                    run_steps = run.get("steps") or []
                    run_steps = [s for s in run_steps if isinstance(s, dict)]
                    run["steps"] = [
                        *run_steps,
                        {"type": "win", "article": snapshot_destination, "at": finished_at},
                    ]
                    run["status"] = "finished"
                    run["result"] = "win"
                    run["finished_at"] = finished_at
                    room["updated_at"] = finished_at
                    # Keep the room open for additional players/runs even if
                    # all current runs have finished.
                await _broadcast_room(room_id)
                return

            try:
                title, links = db.get_article_with_links(snapshot_current)
            except Exception as exc:
                await _fail_llm_run(room_id, run_id, snapshot_current, reason="llm_error", error=str(exc))
                return

            if not title:
                await _fail_llm_run(room_id, run_id, snapshot_current, reason="llm_error", error="Article not found")
                return

            if isinstance(snapshot_max_links, int) and snapshot_max_links > 0:
                links = links[: snapshot_max_links]

            if not links:
                await _fail_llm_run(room_id, run_id, snapshot_current, reason="no_links")
                return

            max_tries = 3
            chosen_index, llm_metadata = await _choose_llm_link(
                model=snapshot_model,
                current_article=snapshot_current,
                target_article=snapshot_destination,
                path_so_far=snapshot_path,
                links=links,
                max_tries=max_tries,
                max_tokens=snapshot_max_tokens,
                api_base=snapshot_api_base,
                reasoning_effort=snapshot_reasoning_effort,
            )

            if chosen_index is None:
                await _finish_llm_run(
                    room_id,
                    run_id,
                    snapshot_current,
                    step_type="lose",
                    metadata={"reason": "bad_answer", **llm_metadata},
                    expected_current=snapshot_current,
                )
                return

            selected = links[chosen_index - 1]
            reached_target = _titles_match(selected, snapshot_destination)
            if not reached_target:
                canonical_selected = db.canonical_title(selected)
                canonical_target = db.canonical_title(snapshot_destination)
                if canonical_selected and canonical_target and _titles_match(
                    canonical_selected, canonical_target
                ):
                    reached_target = True

            if reached_target:
                await _finish_llm_run(
                    room_id,
                    run_id,
                    selected,
                    step_type="win",
                    metadata={"selected_index": chosen_index, **llm_metadata},
                    forced_article=snapshot_destination,
                    expected_current=snapshot_current,
                )
                return

            if snapshot_next_hops >= snapshot_max_steps:
                await _finish_llm_run(
                    room_id,
                    run_id,
                    selected,
                    step_type="lose",
                    metadata={
                        "reason": "max_steps",
                        "max_steps": snapshot_max_steps,
                        "selected_index": chosen_index,
                        **llm_metadata,
                    },
                    expected_current=snapshot_current,
                )
                return

            await _finish_llm_run(
                room_id,
                run_id,
                selected,
                step_type="move",
                metadata={"selected_index": chosen_index, **llm_metadata},
                expected_current=snapshot_current,
            )

    except asyncio.CancelledError:
        raise
    except Exception as exc:
        await _fail_llm_run(room_id, run_id, None, reason="llm_error", error=str(exc))


async def _finish_llm_run(
    room_id: str,
    run_id: str,
    article: str,
    *,
    step_type: str,
    metadata: Optional[dict[str, Any]] = None,
    forced_article: Optional[str] = None,
    expected_current: Optional[str] = None,
) -> None:
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        return

    updated_at = _now_iso()
    changed = False

    async with lock:
        room = ROOMS.get(room_id)
        if not room:
            return
        if room.get("status") != "running":
            return

        run = _room_run_by_id(room, run_id)
        if not run or run.get("status") != "running":
            return

        steps = run.get("steps") or []
        if not isinstance(steps, list):
            steps = []
        steps = [s for s in steps if isinstance(s, dict)]

        if expected_current is not None:
            last_article = steps[-1].get("article") if steps else room.get("start_article")
            if not isinstance(last_article, str) or last_article != expected_current:
                # The run advanced while we waited for an LLM response (restart/cancel).
                return

        step_article = forced_article or article
        if step_type in ("move", "lose"):
            step_article = db.canonical_title(step_article) or step_article
        step: dict[str, Any] = {"type": step_type, "article": step_article, "at": updated_at}
        if metadata:
            step["metadata"] = metadata

        run["steps"] = [*steps, step]
        room["updated_at"] = updated_at
        changed = True

        if step_type in ("win", "lose"):
            run["status"] = "finished"
            run["result"] = "win" if step_type == "win" else "lose"
            run["finished_at"] = updated_at

        # Keep the room open for additional players/runs even if all current
        # runs have finished.

    if changed:
        await _broadcast_room(room_id)

    return


async def _fail_llm_run(
    room_id: str,
    run_id: str,
    article: Optional[str],
    *,
    reason: str,
    error: Optional[str] = None,
) -> None:
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        return

    updated_at = _now_iso()
    changed = False

    async with lock:
        room = ROOMS.get(room_id)
        if not room:
            return
        run = _room_run_by_id(room, run_id)
        if not run or run.get("status") != "running":
            return

        steps = run.get("steps") or []
        if not isinstance(steps, list):
            steps = []
        steps = [s for s in steps if isinstance(s, dict)]
        current_article = article
        if not isinstance(current_article, str) or not current_article:
            current_article = steps[-1].get("article") if steps else room.get("start_article")
        if not isinstance(current_article, str) or not current_article:
            current_article = room.get("start_article") or ""

        meta: dict[str, Any] = {"reason": reason}
        if error:
            meta["error"] = error

        run["steps"] = [
            *steps,
            {"type": "lose", "article": current_article, "at": updated_at, "metadata": meta},
        ]
        run["status"] = "finished"
        run["result"] = "lose"
        run["finished_at"] = updated_at
        room["updated_at"] = updated_at
        changed = True

        # Keep the room open for additional players/runs even if all current
        # runs have finished.

    if changed:
        await _broadcast_room(room_id)

    return


def _start_llm_room_task(room_id: str, run_id: str) -> None:
    room_id = _normalize_room_id(room_id)
    tasks = ROOM_TASKS.setdefault(room_id, {})
    existing = tasks.get(run_id)
    if existing and not existing.done():
        return

    task = asyncio.create_task(_run_llm_room_task(room_id, run_id))
    tasks[run_id] = task

    def _cleanup(_: asyncio.Task) -> None:
        tasks_map = ROOM_TASKS.get(room_id)
        if not tasks_map:
            return
        current = tasks_map.get(run_id)
        if current is task:
            tasks_map.pop(run_id, None)
        if not tasks_map:
            ROOM_TASKS.pop(room_id, None)

    task.add_done_callback(_cleanup)


ROOM_IDLE_TTL_SECONDS = int(os.getenv("WIKIRACE_ROOM_TTL_SECONDS", "21600"))
ROOM_CLEANUP_INTERVAL_SECONDS = int(os.getenv("WIKIRACE_ROOM_CLEANUP_INTERVAL_SECONDS", "300"))


@app.on_event("startup")
async def _start_room_cleanup_task():
    async def _cleanup_loop():
        while True:
            await asyncio.sleep(ROOM_CLEANUP_INTERVAL_SECONDS)
            now = datetime.now(timezone.utc)
            expired: list[str] = []

            for room_id, room in list(ROOMS.items()):
                updated_at = room.get("updated_at")
                if not isinstance(updated_at, str):
                    continue

                try:
                    updated = _parse_iso(updated_at)
                except Exception:
                    continue

                age = (now - updated).total_seconds()
                if age <= ROOM_IDLE_TTL_SECONDS:
                    continue

                expired.append(room_id)

            for room_id in expired:
                _cancel_room_tasks(room_id)
                ROOMS.pop(room_id, None)
                ROOM_LOCKS.pop(room_id, None)
                ROOM_CONNECTIONS.pop(room_id, None)

    asyncio.create_task(_cleanup_loop())


@app.on_event("shutdown")
async def _shutdown_room_tasks():
    for room_id in list(ROOM_TASKS.keys()):
        _cancel_room_tasks(room_id)


def _inject_base_href(html: str) -> str:
    base_tag = f'<base href="{SIMPLEWIKI_ORIGIN}/" />'
    head_match = re.search(r"<head[^>]*>", html, flags=re.IGNORECASE)
    if not head_match:
        return base_tag + html

    insert_at = head_match.end()
    return html[:insert_at] + base_tag + html[insert_at:]


def _strip_script_tags(html: str) -> str:
    # Prevent third-party scripts from interfering; we only need the content.
    return re.sub(r"(?is)<script\b.*?</script>", "", html)


def _inject_wiki_bridge(html: str) -> str:
    script = """
<script>
(function () {
  var replayMode = false
  var includeImageLinks = false
  var resolvedTitleCache = Object.create(null)
  var navRequestSeq = 0
  var pendingNavigate = Object.create(null)

  function setReplayMode(enabled) {
    replayMode = !!enabled
  }

  function setIncludeImageLinks(enabled) {
    includeImageLinks = !!enabled
    window.setTimeout(notifyParentPageLinks, 0)
  }

  window.addEventListener("message", function (event) {
    var data = event && event.data
    if (!data || typeof data !== "object") return
    if (data.type === "wikirace:setReplayMode") {
      setReplayMode(!!data.enabled)
    }
    if (data.type === "wikirace:setIncludeImageLinks") {
      setIncludeImageLinks(!!data.enabled)
    }
    if (data.type === "wikirace:navigate_response") {
      var requestId = data.requestId
      if (typeof requestId !== "string" || !requestId) return
      var cb = pendingNavigate[requestId]
      if (typeof cb !== "function") return
      delete pendingNavigate[requestId]
      cb(!!data.allow)
    }
  })

  function requestParentNavigate(title) {
    return new Promise(function (resolve) {
      var requestId = "nav_" + (++navRequestSeq) + "_" + Date.now()
      var settled = false

      pendingNavigate[requestId] = function (allow) {
        if (settled) return
        settled = true
        resolve({ handled: true, allow: !!allow })
      }

      try {
        window.parent.postMessage(
          { type: "wikirace:navigate_request", requestId: requestId, title: title },
          "*"
        )
      } catch {
        // ignore
      }

      window.setTimeout(function () {
        if (settled) return
        settled = true
        delete pendingNavigate[requestId]
        resolve({ handled: false, allow: true })
      }, 700)
    })
  }

  function decodePart(raw) {
    try {
      return decodeURIComponent(raw)
    } catch {
      return raw
    }
  }

  function titleFromHref(href) {
    if (!href) return null
    try {
      var url = new URL(href, "https://simple.wikipedia.org/")

      if (url.pathname && url.pathname.startsWith("/wiki/")) {
        var title = url.pathname.slice("/wiki/".length)
        title = decodePart(title)
        title = title.replaceAll("_", " ")
        return title
      }

      if (url.pathname === "/w/index.php") {
        var queryTitle = url.searchParams && url.searchParams.get("title")
        if (!queryTitle) return null
        queryTitle = decodePart(queryTitle)
        queryTitle = queryTitle.replaceAll("_", " ")
        return queryTitle
      }

      return null
    } catch {
      return null
    }
  }

  function toProxyPath(title) {
    return window.location.origin + "/wiki/" + encodeURIComponent(title.replaceAll(" ", "_"))
  }

  function getCurrentTitle() {
    try {
      var raw = location.pathname.startsWith("/wiki/")
        ? location.pathname.slice("/wiki/".length)
        : ""
      if (!raw) return null
      var title = decodePart(raw).replaceAll("_", " ")
      return title || null
    } catch {
      return null
    }
  }

  function resolveArticleTitle(title) {
    if (!title) return Promise.resolve(null)

    if (Object.prototype.hasOwnProperty.call(resolvedTitleCache, title)) {
      return Promise.resolve(resolvedTitleCache[title] || null)
    }

    var url = window.location.origin + "/resolve_article/" + encodeURIComponent(title)
    return fetch(url)
      .then(function (response) {
        if (!response || !response.ok) return null
        return response.json()
      })
      .then(function (data) {
        var resolved =
          data && data.exists && typeof data.title === "string" && data.title
            ? data.title
            : null
        resolvedTitleCache[title] = resolved || false
        return resolved
      })
      .catch(function () {
        // Don't cache transient network errors as permanent misses.
        return null
      })
  }

  function notifyParentCurrentTitle() {
    try {
      var title = getCurrentTitle()
      if (!title) return
      resolveArticleTitle(title).then(function (resolved) {
        try {
          window.parent.postMessage(
            { type: "wikirace:navigate", title: resolved || title },
            "*"
          )
        } catch {
          // ignore
        }
      })
    } catch {
      // ignore
    }
  }

  function isElementVisible(element) {
    try {
      if (!element) return false
      var rects = element.getClientRects && element.getClientRects()
      if (!rects || rects.length === 0) return false
      var style = window.getComputedStyle && window.getComputedStyle(element)
      if (!style) return true
      if (style.display === "none") return false
      if (style.visibility === "hidden") return false
      return true
    } catch {
      return false
    }
  }

  function collectVisibleWikiLinks() {
    var currentTitle = getCurrentTitle() || ""
    var seen = Object.create(null)
    var titles = []

    var anchors = document.querySelectorAll("a[href]")
    for (var i = 0; i < anchors.length; i++) {
      var anchor = anchors[i]
      if (!anchor) continue
      if (!isElementVisible(anchor)) continue

      var href = anchor.getAttribute("href") || anchor.href
      var title = titleFromHref(href)
      if (!title) continue

      // Default: only count links with a visible label. Image-only links (e.g. flag
      // icons) can be clickable but their destination isn't visible as text.
      try {
        var label = (anchor.innerText || "").replace(/\s+/g, " ").trim()
        if (!label && !includeImageLinks) continue
      } catch {
        // ignore
      }

      // ignore same-page section links
      try {
        if (title === currentTitle && anchor.hash) {
          continue
        }
      } catch {
        // ignore
      }

      if (seen[title]) continue
      seen[title] = true
      titles.push(title)
    }

    return titles
  }

  function notifyParentPageLinks() {
    try {
      var title = getCurrentTitle()
      if (!title) return
      var links = collectVisibleWikiLinks()
      window.parent.postMessage(
        { type: "wikirace:pageLinks", title: title, links: links },
        "*"
      )
    } catch {
      // ignore
    }
  }

  document.addEventListener(
    "click",
    function (event) {
      var target = event.target
      if (!(target instanceof Element)) return
      var anchor = target.closest("a")
      if (!anchor) return

      // allow opening in new tab / non-left clicks
      if (event.defaultPrevented) return
      if (event.button !== 0) return
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

      var href = anchor.getAttribute("href") || anchor.href
      if (!href) return

      // allow same-page section links (e.g. #References)
      if (href && href.charAt(0) === "#") return

      var title = titleFromHref(href)

      // Keep same-article section links inside the proxy iframe origin.
      // Some pages include full /wiki/Title#Section hrefs; with <base> set to
      // simple.wikipedia.org those would navigate away and break tracking.
      try {
        var currentTitle = getCurrentTitle()
        if (currentTitle && title && anchor.hash && title.replaceAll("_", " ") === currentTitle.replaceAll("_", " ")) {
          event.preventDefault()
          window.location.hash = anchor.hash
          return
        }
      } catch {
        // ignore
      }

      if (replayMode) {
        event.preventDefault()
        return
      }

      if (!includeImageLinks) {
        try {
          var label = (anchor.innerText || "").replace(/\s+/g, " ").trim()
          if (!label) {
            event.preventDefault()
            return
          }
        } catch {
          // ignore
        }
      }

      // Block external / non-wiki navigation inside the iframe.
      // (No penalty: we simply ignore the click.)
      if (!title) {
        // If the author explicitly wants a new tab, let the browser handle it.
        if (anchor.target === "_blank") return
        event.preventDefault()
        return
      }

      event.preventDefault()

      resolveArticleTitle(title).then(function (resolved) {
        if (!resolved) return

        requestParentNavigate(resolved).then(function (result) {
          if (!result || !result.allow) return

          // Back-compat: older parents only understand the legacy event.
          if (!result.handled) {
            try {
              window.parent.postMessage({ type: "wikirace:navigate", title: resolved }, "*")
            } catch {
              // ignore
            }
          }

          window.location.href = toProxyPath(resolved)
        })
      })
    },
    true
  )

  // Keep parent state in sync even if navigation happens via browser controls
  // (back/forward) or non-standard links.
  notifyParentCurrentTitle()
  window.setTimeout(notifyParentPageLinks, 0)
  window.addEventListener("load", notifyParentPageLinks)
  window.addEventListener("popstate", notifyParentCurrentTitle)
})()
</script>
"""

    body_close_match = re.search(r"</body\s*>", html, flags=re.IGNORECASE)
    if not body_close_match:
        return html + script

    insert_at = body_close_match.start()
    return html[:insert_at] + script + html[insert_at:]


def _rewrite_wiki_html(html: str) -> str:
    html = _strip_script_tags(html)
    html = _inject_base_href(html)
    html = _inject_wiki_bridge(html)
    return html


@app.get("/health", response_model=HealthResponse)
async def health_check():
    """Health check endpoint that returns the article count"""
    return HealthResponse(status="healthy", article_count=db._article_count)


@app.get("/get_all_articles", response_model=List[str])
async def get_all_articles():
    """Get all articles"""
    return db.get_all_articles()


@app.get("/get_article_with_links/{article_title:path}", response_model=ArticleResponse)
async def get_article(article_title: str):
    """Get article and its links by title"""
    title, links = db.get_article_with_links(article_title)
    if title is None:
        raise HTTPException(status_code=404, detail="Article not found")
    return ArticleResponse(title=title, links=links)


@app.get("/resolve_article/{article_title:path}", response_model=ResolveTitleResponse)
async def resolve_article(article_title: str):
    """Resolve a potentially non-canonical title to the DB's stored title."""

    resolved = db.resolve_title(article_title)
    return ResolveTitleResponse(exists=resolved is not None, title=resolved)


@app.get("/canonical_title/{article_title:path}", response_model=CanonicalTitleResponse)
async def canonical_title(article_title: str):
    """Return a canonical title, following simple redirect-like stubs."""

    resolved = db.canonical_title(article_title)
    if resolved:
        return CanonicalTitleResponse(title=resolved)

    fallback = article_title.replace("_", " ").strip()
    return CanonicalTitleResponse(title=fallback)


@app.post("/rooms", response_model=CreateRoomResponse)
async def create_room(request: Request, body: CreateRoomRequest):
    start_raw = body.start_article.replace("_", " ").strip()
    destination_raw = body.destination_article.replace("_", " ").strip()
    if not start_raw or not destination_raw:
        raise HTTPException(status_code=400, detail="Start and target are required")

    start_resolved = db.canonical_title(start_raw)
    destination_resolved = db.canonical_title(destination_raw)
    if not start_resolved:
        raise HTTPException(status_code=404, detail="Start article not found")
    if not destination_resolved:
        raise HTTPException(status_code=404, detail="Target article not found")
    if _titles_match(start_resolved, destination_resolved):
        raise HTTPException(status_code=400, detail="Start and target must be different")

    created_at = _now_iso()
    rules = _normalize_room_rules(body.rules)
    title = body.title.strip() if body.title else None
    owner_name = body.owner_name.strip() if body.owner_name else "Host"

    room_id = _make_code("room", 8)
    while room_id in ROOMS:
        room_id = _make_code("room", 8)

    owner_player_id = _make_code("player", 10)
    owner_run_id = _make_code("run", 10)

    room: dict[str, Any] = {
        "id": room_id,
        "created_at": created_at,
        "updated_at": created_at,
        "owner_player_id": owner_player_id,
        "title": title,
        "start_article": start_resolved,
        "destination_article": destination_resolved,
        "rules": rules,
        "status": "lobby",
        "started_at": None,
        "finished_at": None,
        "players": [
            {
                "id": owner_player_id,
                "name": owner_name,
                "connected": False,
                "joined_at": created_at,
            }
        ],
        "runs": [
            {
                "id": owner_run_id,
                "kind": "human",
                "player_id": owner_player_id,
                "player_name": owner_name,
                "max_steps": rules["max_hops"],
                "status": "not_started",
                "started_at": None,
                "finished_at": None,
                "result": None,
                "steps": [],
            }
        ],
    }

    ROOMS[room_id] = room
    ROOM_LOCKS[room_id] = asyncio.Lock()
    ROOM_CONNECTIONS[room_id] = set()

    print(
        "Created room "
        + room_id
        + " (code "
        + room_id.split("_", 1)[1]
        + ") "
        + start_resolved
        + " -> "
        + destination_resolved
    )

    origin = str(request.base_url).rstrip("/")

    join_host = request.url.hostname
    join_port = request.url.port
    join_scheme = request.url.scheme

    join_url = f"{origin}/?room={room_id}"
    if join_host in ("localhost", "127.0.0.1", "0.0.0.0"):
        lan_ip = _detect_lan_ip()
        if lan_ip:
            netloc = f"{lan_ip}:{join_port}" if join_port else lan_ip
            join_url = f"{join_scheme}://{netloc}/?room={room_id}"
    return {
        "room_id": room_id,
        "owner_player_id": owner_player_id,
        "join_url": join_url,
        "room": room,
    }


@app.get("/rooms/{room_id}", response_model=RoomStateV1)
async def get_room(room_id: str):
    return _room_state(room_id)


@app.post("/rooms/{room_id}/join", response_model=JoinRoomResponse)
async def join_room(room_id: str, body: JoinRoomRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    player_name = body.name.strip()
    if not player_name:
        raise HTTPException(status_code=400, detail="Name is required")

    joined_at = _now_iso()
    player_id = _make_code("player", 10)

    async with lock:
        status = room.get("status")
        if status == "finished":
            # Re-open the room so new players can join and play.
            room["status"] = "running"
            room["finished_at"] = None
            status = "running"

        is_running = status == "running"

        existing_ids = {p.get("id") for p in room.get("players", []) if isinstance(p, dict)}
        while player_id in existing_ids:
            player_id = _make_code("player", 10)

        run_id = _make_code("run", 10)
        room.setdefault("players", []).append(
            {
                "id": player_id,
                "name": player_name,
                "connected": False,
                "joined_at": joined_at,
            }
        )
        room.setdefault("runs", []).append(
            {
                "id": run_id,
                "kind": "human",
                "player_id": player_id,
                "player_name": player_name,
                "max_steps": room.get("rules", {}).get("max_hops", 20),
                "status": "running" if is_running else "not_started",
                "started_at": joined_at if is_running else None,
                "finished_at": None,
                "result": None,
                "steps": [
                    {
                        "type": "start",
                        "article": room.get("start_article"),
                        "at": joined_at,
                    }
                ]
                if is_running
                else [],
            }
        )
        room["updated_at"] = joined_at

    await _broadcast_room(room_id)
    return {"player_id": player_id, "room": room}


@app.post("/rooms/{room_id}/start", response_model=RoomStateV1)
async def start_room(room_id: str, body: StartRoomRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    llm_run_ids: list[str] = []

    async with lock:
        if body.player_id != room.get("owner_player_id"):
            raise HTTPException(status_code=403, detail="Only the host can start the race")
        if room.get("status") != "lobby":
            return room

        started_at = _now_iso()
        room["status"] = "running"
        room["started_at"] = started_at
        room["updated_at"] = started_at

        for run in room.get("runs", []):
            if run.get("status") != "not_started":
                continue
            run["status"] = "running"
            run["started_at"] = started_at
            run["steps"] = [
                {
                    "type": "start",
                    "article": room.get("start_article"),
                    "at": started_at,
                }
            ]

            if run.get("kind") == "llm" and isinstance(run.get("id"), str):
                llm_run_ids.append(run["id"])

    await _broadcast_room(room_id)

    for run_id in llm_run_ids:
        _start_llm_room_task(room_id, run_id)
    return room


@app.post("/rooms/{room_id}/new_round", response_model=RoomStateV1)
async def new_round(room_id: str, body: NewRoundRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    start_raw = body.start_article.replace("_", " ").strip()
    destination_raw = body.destination_article.replace("_", " ").strip()
    if not start_raw or not destination_raw:
        raise HTTPException(status_code=400, detail="Start and target are required")

    start_resolved = db.canonical_title(start_raw)
    destination_resolved = db.canonical_title(destination_raw)
    if not start_resolved:
        raise HTTPException(status_code=404, detail="Start article not found")
    if not destination_resolved:
        raise HTTPException(status_code=404, detail="Target article not found")
    if _titles_match(start_resolved, destination_resolved):
        raise HTTPException(status_code=400, detail="Start and target must be different")

    updated_at = _now_iso()

    async with lock:
        if body.player_id != room.get("owner_player_id"):
            raise HTTPException(status_code=403, detail="Only the host can start a new round")

        # Stop any in-flight LLM tasks from the previous round.
        _cancel_room_tasks(room_id)

        room["start_article"] = start_resolved
        room["destination_article"] = destination_resolved
        room["status"] = "lobby"
        room["started_at"] = None
        room["finished_at"] = None

        rules = room.get("rules") or {}
        max_hops = rules.get("max_hops")
        max_hops = max_hops if isinstance(max_hops, int) and max_hops > 0 else 20

        for run in room.get("runs", []):
            if not isinstance(run, dict):
                continue
            run["status"] = "not_started"
            run["started_at"] = None
            run["finished_at"] = None
            run["result"] = None
            run["steps"] = []

            if run.get("kind") == "human":
                run["max_steps"] = max_hops

        room["updated_at"] = updated_at

    await _broadcast_room(room_id)
    return room


@app.post("/rooms/{room_id}/move", response_model=RoomStateV1)
async def room_move(room_id: str, body: MoveRoomRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    to_raw = body.to_article.replace("_", " ").strip()
    if not to_raw:
        raise HTTPException(status_code=400, detail="to_article is required")

    resolved = db.resolve_title(to_raw)
    if not resolved:
        raise HTTPException(status_code=404, detail="Article not found")

    canonical_next = db.canonical_title(resolved) or resolved

    updated_at = _now_iso()
    changed = False

    async with lock:
        if room.get("status") != "running":
            raise HTTPException(status_code=409, detail="Room is not running")

        run = _room_run_for_player(room, body.player_id)
        if not run:
            raise HTTPException(status_code=404, detail="Player not in room")
        if run.get("status") != "running":
            raise HTTPException(status_code=409, detail="Run is not running")

        steps: list[dict[str, Any]] = run.get("steps") or []
        current_article = (
            steps[-1].get("article") if steps and isinstance(steps[-1], dict) else None
        )
        if not isinstance(current_article, str) or not current_article:
            current_article = room.get("start_article")

        if (
            isinstance(current_article, str)
            and current_article.replace("_", " ").strip()
            == canonical_next.replace("_", " ").strip()
        ):
            return room

        current_hops = max(0, len(steps) - 1)
        next_hops = current_hops + 1
        max_hops = room.get("rules", {}).get("max_hops")
        max_hops = max_hops if isinstance(max_hops, int) and max_hops > 0 else 20

        step_metadata: Optional[dict[str, Any]] = None
        destination_article = room.get("destination_article")
        if not isinstance(destination_article, str) or not destination_article:
            raise HTTPException(status_code=500, detail="Room missing destination article")

        try:
            title, links = db.get_article_with_links(current_article)
        except Exception as exc:
            raise HTTPException(status_code=500, detail=str(exc))

        if not title:
            raise HTTPException(status_code=400, detail=f"Current article not found ({current_article})")

        if resolved not in links and canonical_next not in links:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid move: '{resolved}' is not a link from '{title}'",
            )

        canonical_target = db.canonical_title(destination_article)

        if canonical_next and canonical_target and _titles_match(canonical_next, canonical_target):
            step_type = "win"
            run["status"] = "finished"
            run["result"] = "win"
            run["finished_at"] = updated_at
            step_article = destination_article
        elif next_hops >= max_hops:
            step_type = "lose"
            run["status"] = "finished"
            run["result"] = "lose"
            run["finished_at"] = updated_at
            step_article = canonical_next
            step_metadata = {"reason": "max_hops", "max_hops": max_hops}
        else:
            step_type = "move"
            step_article = canonical_next

        step: dict[str, Any] = {"type": step_type, "article": step_article, "at": updated_at}
        if step_metadata:
            step["metadata"] = step_metadata

        run["steps"] = [*steps, step]
        room["updated_at"] = updated_at
        changed = True

        # Keep the room open for additional players/runs even if all current
        # runs have finished.

    if changed:
        await _broadcast_room(room_id)
    return room


@app.post("/rooms/{room_id}/add_llm", response_model=RoomStateV1)
async def add_llm_run(room_id: str, body: AddLlmRunRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    model = body.model.strip() if isinstance(body.model, str) else ""
    if not model:
        raise HTTPException(status_code=400, detail="model is required")

    created_at = _now_iso()
    is_running = False
    new_run_id: Optional[str] = None

    async with lock:
        if body.requested_by_player_id != room.get("owner_player_id"):
            raise HTTPException(status_code=403, detail="Only the host can add AI players")

        room_status = room.get("status")
        if room_status == "finished":
            # Re-open the room so new players/runs can be added.
            room["status"] = "running"
            room["finished_at"] = None

        is_running = room.get("status") == "running"

        llm_runs = [
            r
            for r in room.get("runs", [])
            if r.get("kind") == "llm" and r.get("status") != "finished"
        ]
        if len(llm_runs) >= WIKIRACE_MAX_LLM_RUNS_PER_ROOM:
            raise HTTPException(
                status_code=409,
                detail=f"Room already has {len(llm_runs)} AI runs (max {WIKIRACE_MAX_LLM_RUNS_PER_ROOM})",
            )

        run_id = _make_code("run", 10)
        existing_ids = {r.get("id") for r in room.get("runs", []) if isinstance(r, dict)}
        while run_id in existing_ids:
            run_id = _make_code("run", 10)

        rules = room.get("rules", {})
        max_steps_raw = body.max_steps
        max_steps = max_steps_raw if isinstance(max_steps_raw, int) and max_steps_raw > 0 else None
        if max_steps is None:
            max_steps = rules.get("max_hops")
        if not isinstance(max_steps, int) or max_steps <= 0:
            max_steps = 20

        if "max_links" in body.__fields_set__:
            max_links = body.max_links if isinstance(body.max_links, int) and body.max_links > 0 else None
        else:
            max_links = rules.get("max_links") if isinstance(rules.get("max_links"), int) else None

        if "max_tokens" in body.__fields_set__:
            max_tokens = body.max_tokens if isinstance(body.max_tokens, int) and body.max_tokens > 0 else None
        else:
            max_tokens = rules.get("max_tokens") if isinstance(rules.get("max_tokens"), int) else None

        player_name = body.player_name.strip() if isinstance(body.player_name, str) else ""
        api_base = body.api_base.strip() if isinstance(body.api_base, str) else ""
        reasoning_effort = (
            body.reasoning_effort.strip() if isinstance(body.reasoning_effort, str) else ""
        )

        run: dict[str, Any] = {
            "id": run_id,
            "kind": "llm",
            "player_name": player_name or None,
            "model": model,
            "api_base": api_base or None,
            "reasoning_effort": reasoning_effort or None,
            "max_steps": max_steps,
            "max_links": max_links,
            "max_tokens": max_tokens,
            "status": "running" if is_running else "not_started",
            "started_at": created_at if is_running else None,
            "finished_at": None,
            "result": None,
            "steps": [
                {"type": "start", "article": room.get("start_article"), "at": created_at}
            ]
            if is_running
            else [],
        }

        room.setdefault("runs", []).append(run)
        room["updated_at"] = created_at
        new_run_id = run_id

    await _broadcast_room(room_id)
    if is_running and new_run_id:
        _start_llm_room_task(room_id, new_run_id)
    return room


@app.post("/rooms/{room_id}/runs/{run_id}/cancel", response_model=RoomStateV1)
async def cancel_room_run(room_id: str, run_id: str, body: RoomRunControlRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    updated_at = _now_iso()
    changed = False

    async with lock:
        if body.requested_by_player_id != room.get("owner_player_id"):
            raise HTTPException(status_code=403, detail="Only the host can cancel runs")

        run = _room_run_by_id(room, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        if run.get("kind") != "llm":
            raise HTTPException(status_code=400, detail="Only AI runs can be cancelled")

        status = run.get("status")
        if status == "finished":
            return room

        if status == "not_started":
            # In the lobby, AI runs have not started yet; cancelling should remove
            # the participant entirely rather than recording a loss.
            room["runs"] = [
                r
                for r in room.get("runs", [])
                if isinstance(r, dict) and r.get("id") != run_id
            ]
            room["updated_at"] = updated_at
            changed = True
        else:
            steps = run.get("steps") or []
            if not isinstance(steps, list):
                steps = []
            steps = [s for s in steps if isinstance(s, dict)]
            current_article = steps[-1].get("article") if steps else room.get("start_article")
            if not isinstance(current_article, str) or not current_article:
                current_article = room.get("start_article") or ""

            run["steps"] = [
                *steps,
                {
                    "type": "lose",
                    "article": current_article,
                    "at": updated_at,
                    "metadata": {"reason": "cancelled"},
                },
            ]
            run["status"] = "finished"
            run["result"] = "lose"
            run["finished_at"] = updated_at
            room["updated_at"] = updated_at
            changed = True

        # Keep the room open for additional players/runs even if all current
        # runs have finished.

    _cancel_room_task(room_id, run_id)
    if changed:
        await _broadcast_room(room_id)
    # Keep the room open for additional players/runs even if all current runs
    # have finished.
    return room


@app.post("/rooms/{room_id}/runs/{run_id}/abandon", response_model=RoomStateV1)
async def abandon_room_run(room_id: str, run_id: str, body: RoomRunControlRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    updated_at = _now_iso()
    changed = False

    async with lock:
        run = _room_run_by_id(room, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        if run.get("kind") != "human":
            raise HTTPException(status_code=400, detail="Only human runs can be abandoned")

        run_player_id = run.get("player_id")
        if not run_player_id or body.requested_by_player_id != run_player_id:
            raise HTTPException(status_code=403, detail="Only the owning player can abandon")

        if run.get("status") == "finished":
            return room

        steps = run.get("steps") or []
        if not isinstance(steps, list):
            steps = []
        steps = [s for s in steps if isinstance(s, dict)]
        current_article = steps[-1].get("article") if steps else room.get("start_article")
        if not isinstance(current_article, str) or not current_article:
            current_article = room.get("start_article") or ""

        run["steps"] = [
            *steps,
            {
                "type": "lose",
                "article": current_article,
                "at": updated_at,
                "metadata": {"abandoned": True, "reason": "abandoned"},
            },
        ]
        run["status"] = "finished"
        run["result"] = "abandoned"
        run["finished_at"] = updated_at
        room["updated_at"] = updated_at
        changed = True

        # Keep the room open for additional players/runs even if all current
        # runs have finished.

    if changed:
        await _broadcast_room(room_id)
    # Keep the room open for additional players/runs even if all current runs
    # have finished.
    return room


@app.post("/rooms/{room_id}/runs/{run_id}/restart", response_model=RoomStateV1)
async def restart_room_run(room_id: str, run_id: str, body: RoomRunControlRequest):
    room_id = _normalize_room_id(room_id)
    lock = ROOM_LOCKS.get(room_id)
    room = ROOMS.get(room_id)
    if not lock or not room:
        raise HTTPException(
            status_code=404,
            detail=(
                f"Room not found ({room_id}). Rooms are stored in memory; "
                "if the server restarted/reloaded, create a new room."
            ),
        )

    updated_at = _now_iso()
    should_start = False

    async with lock:
        if body.requested_by_player_id != room.get("owner_player_id"):
            raise HTTPException(status_code=403, detail="Only the host can restart runs")

        # Allow restarting AI runs even after all players finished.

        run = _room_run_by_id(room, run_id)
        if not run:
            raise HTTPException(status_code=404, detail="Run not found")

        if run.get("kind") != "llm":
            raise HTTPException(status_code=400, detail="Only AI runs can be restarted")

        _cancel_room_task(room_id, run_id)

        room_status = room.get("status")
        should_start = room_status == "running"

        run["result"] = None
        run["finished_at"] = None

        if should_start:
            run["status"] = "running"
            run["started_at"] = updated_at
            run["steps"] = [
                {
                    "type": "start",
                    "article": room.get("start_article"),
                    "at": updated_at,
                }
            ]
        else:
            run["status"] = "not_started"
            run["started_at"] = None
            run["steps"] = []

        room["updated_at"] = updated_at

    await _broadcast_room(room_id)
    if should_start:
        _start_llm_room_task(room_id, run_id)
    return room


@app.websocket("/rooms/{room_id}/ws")
async def room_ws(websocket: WebSocket, room_id: str, player_id: Optional[str] = None):
    room_id = _normalize_room_id(room_id)
    room = ROOMS.get(room_id)
    if not room:
        await websocket.close(code=1008)
        return

    await websocket.accept()
    ROOM_CONNECTIONS.setdefault(room_id, set()).add(websocket)

    if player_id:
        await _set_player_connected(room_id, player_id, True)

    await websocket.send_text(
        json.dumps({"type": "room_state", "room": room}, ensure_ascii=False)
    )

    try:
        while True:
            _ = await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        conns = ROOM_CONNECTIONS.get(room_id)
        if conns:
            conns.discard(websocket)
        if player_id:
            await _set_player_connected(room_id, player_id, False)


def _escape_html(value: str) -> str:
    return (
        (value or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#039;")
    )


def _offline_wiki_html(title: str, links: list[str], error: Optional[str] = None) -> str:
    max_links = 400
    items: list[str] = []
    for link in links[:max_links]:
        safe_title = quote(link.replace(" ", "_"), safe="")
        items.append(f'<li><a href="/wiki/{safe_title}">{_escape_html(link)}</a></li>')

    error_html = (
        f"<div class='error'>Fetch error: {_escape_html(error)}</div>" if error else ""
    )
    return f"""<!doctype html>
<html>
  <head>
    <meta charset='utf-8' />
    <meta name='viewport' content='width=device-width, initial-scale=1' />
    <title>{_escape_html(title)}</title>
    <style>
      body {{ font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 16px; line-height: 1.4; }}
      h1 {{ font-size: 22px; margin: 0 0 8px; }}
      .note {{ font-size: 12px; color: #555; margin-bottom: 12px; }}
      .error {{ font-size: 12px; color: #7f1d1d; background: #fef2f2; border: 1px solid #fecaca; padding: 8px; border-radius: 6px; margin-bottom: 12px; }}
      ul {{ padding-left: 18px; }}
      li {{ margin: 4px 0; }}
    </style>
  </head>
  <body>
    <h1>{_escape_html(title)}</h1>
    <div class='note'>Offline wiki view (rendered from DB links). Some content may be missing.</div>
    {error_html}
    <div class='note'>Links ({min(len(links), max_links)} shown):</div>
    <ul>
      {''.join(items)}
    </ul>
  </body>
</html>"""


@app.get("/wiki/{article_title:path}", response_class=HTMLResponse)
async def wiki_proxy(article_title: str):
    """Proxy a Simple Wikipedia page and inject a click bridge.

    The UI uses this in an <iframe> so that clicks inside the page can be turned
    into game moves.
    """

    safe_title = article_title.replace(" ", "_")
    remote_url = f"{SIMPLEWIKI_ORIGIN}/wiki/{quote(safe_title, safe='')}"

    timeout = aiohttp.ClientTimeout(total=20)
    headers = {"User-Agent": "wikiracing-llms"}

    try:
        async with aiohttp.ClientSession(timeout=timeout, headers=headers) as session:
            async with session.get(remote_url, allow_redirects=True) as response:
                if response.status != 200:
                    raise RuntimeError(f"Failed to fetch wiki page ({response.status})")
                html = await response.text()

        return HTMLResponse(content=_rewrite_wiki_html(html))
    except Exception as exc:
        # Offline fallback: generate a minimal HTML page from DB links so the
        # arena can still function (and Playwright can click links) without an
        # external network connection.
        resolved = db.resolve_title(article_title) or article_title.replace("_", " ").strip()
        title, links = db.get_article_with_links(resolved)
        display_title = title or resolved or article_title
        fallback_html = _offline_wiki_html(display_title, links, str(exc))
        return HTMLResponse(content=_inject_wiki_bridge(fallback_html))


def _get_field(obj: Any, key: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(key)
    return getattr(obj, key, None)


def _coerce_llm_text(value: Any) -> Optional[str]:
    if value is None:
        return None

    if isinstance(value, str):
        return value

    # Some providers/models return structured content blocks (e.g. OpenAI)
    # where the "content" field is a list of {type, text, ...} objects.
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                if item:
                    parts.append(item)
                continue

            if isinstance(item, dict):
                for key in ("text", "content", "value"):
                    candidate = item.get(key)
                    if isinstance(candidate, str) and candidate:
                        parts.append(candidate)
                        break
                continue

            candidate = getattr(item, "text", None)
            if isinstance(candidate, str) and candidate:
                parts.append(candidate)

        combined = "".join(parts)
        return combined if combined.strip() else None

    if isinstance(value, dict):
        for key in ("text", "content", "value"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate:
                return candidate
        return None

    candidate = getattr(value, "text", None)
    if isinstance(candidate, str) and candidate:
        return candidate

    return None


def _extract_llm_content(response: Any) -> Optional[str]:
    # Chat completions: response.choices[0].message.content
    choices = _get_field(response, "choices")
    if isinstance(choices, list) and choices:
        choice0 = choices[0]
        message = _get_field(choice0, "message")
        if message is not None:
            content = _coerce_llm_text(_get_field(message, "content"))
            if content is not None and content.strip():
                return content

        # Text completion fallback: response.choices[0].text
        text = _coerce_llm_text(_get_field(choice0, "text"))
        if text is not None and text.strip():
            return text

    # Responses API: response.output_text (LiteLLM sometimes provides this).
    output_text = _coerce_llm_text(_get_field(response, "output_text"))
    if output_text is not None and output_text.strip():
        return output_text

    # Responses API: response.output[].content[].text
    output = _get_field(response, "output")
    if isinstance(output, list) and output:
        parts: list[str] = []
        for item in output:
            role = _get_field(item, "role")
            if role is not None and role != "assistant":
                continue
            content = _coerce_llm_text(_get_field(item, "content"))
            if content is not None:
                parts.append(content)
        combined = "".join(parts)
        return combined if combined.strip() else None

    return None


@app.post("/llm/choose_link", response_model=LLMChooseLinkResponse)
async def llm_choose_link(request: LLMChooseLinkRequest):
    model = request.model.strip() if isinstance(request.model, str) else ""
    if not model:
        raise HTTPException(status_code=400, detail="Missing model")

    current_article = (
        request.current_article.strip() if isinstance(request.current_article, str) else ""
    )
    target_article = (
        request.target_article.strip() if isinstance(request.target_article, str) else ""
    )
    if not current_article or not target_article:
        raise HTTPException(status_code=400, detail="Missing current/target article")

    links = [
        link.strip()
        for link in (request.links or [])
        if isinstance(link, str) and link.strip()
    ]
    if not links:
        raise HTTPException(status_code=400, detail="Missing links")

    path = [
        article.strip()
        for article in (request.path_so_far or [])
        if isinstance(article, str) and article.strip()
    ]
    if not path:
        path = [current_article]

    max_tries = (
        request.max_tries
        if isinstance(request.max_tries, int) and request.max_tries > 0
        else 3
    )
    max_tries = min(max_tries, 10)

    max_tokens = (
        request.max_tokens
        if isinstance(request.max_tokens, int) and request.max_tokens > 0
        else None
    )
    api_base = request.api_base.strip() if isinstance(request.api_base, str) and request.api_base.strip() else None
    reasoning_effort = (
        request.reasoning_effort.strip()
        if isinstance(request.reasoning_effort, str) and request.reasoning_effort.strip()
        else None
    )

    selected_index, metadata = await _choose_llm_link(
        model=model,
        current_article=current_article,
        target_article=target_article,
        path_so_far=path,
        links=links,
        max_tries=max_tries,
        max_tokens=max_tokens,
        api_base=api_base,
        reasoning_effort=reasoning_effort,
    )

    return LLMChooseLinkResponse(selected_index=selected_index, **metadata)


@app.post("/llm/chat", response_model=LLMChatResponse)
async def llm_chat(request: LLMChatRequest):
    """LLM chat endpoint backed by LiteLLM.

    The frontend uses this to generate the agent's next move.

    Configure provider keys via environment variables (e.g. OPENAI_API_KEY,
    ANTHROPIC_API_KEY, etc.). For local OpenAI-compatible servers (vLLM, etc.),
    pass `api_base` and optionally set `OPENAI_API_KEY=EMPTY`.
    """

    kwargs: dict = {
        "model": request.model,
        "messages": [{"role": "user", "content": request.prompt}],
    }
    if request.max_tokens is not None and request.max_tokens > 0:
        kwargs["max_tokens"] = request.max_tokens

    if request.temperature is not None:
        kwargs["temperature"] = request.temperature

    reasoning_effort = request.reasoning_effort or request.effort
    if reasoning_effort is not None:
        reasoning_effort = reasoning_effort.strip()
        if reasoning_effort:
            kwargs["reasoning_effort"] = reasoning_effort

    if request.api_base:
        kwargs["api_base"] = request.api_base
        # Many OpenAI-compatible local servers ignore auth, but LiteLLM still
        # expects a key for OpenAI-style providers.
        if "/" not in request.model or request.model.startswith(
            ("openai/", "hosted_vllm/")
        ):
            kwargs["api_key"] = os.getenv("OPENAI_API_KEY") or "EMPTY"

    try:
        response = await litellm.acompletion(**kwargs)

        content = _extract_llm_content(response)
        if content is None:
            raise RuntimeError("Model returned empty content")

        usage_payload = None
        raw_usage = getattr(response, "usage", None)
        if raw_usage:
            try:
                if isinstance(raw_usage, dict):
                    usage_payload = raw_usage
                elif hasattr(raw_usage, "model_dump"):
                    usage_payload = raw_usage.model_dump()
                elif hasattr(raw_usage, "dict"):
                    usage_payload = raw_usage.dict()
                else:
                    usage_payload = dict(raw_usage)
            except Exception:
                usage_payload = None

        usage = None
        if isinstance(usage_payload, dict):
            prompt_tokens = usage_payload.get("prompt_tokens") or usage_payload.get("input_tokens")
            completion_tokens = usage_payload.get("completion_tokens") or usage_payload.get(
                "output_tokens"
            )
            total_tokens = usage_payload.get("total_tokens")

            usage = LLMUsage(
                prompt_tokens=prompt_tokens
                if isinstance(prompt_tokens, int)
                else None,
                completion_tokens=completion_tokens
                if isinstance(completion_tokens, int)
                else None,
                total_tokens=total_tokens
                if isinstance(total_tokens, int)
                else None,
            )

        return LLMChatResponse(content=content, usage=usage)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# Mount the dist folder for static files (production).
#
# In local development you typically run the Vite dev server (`yarn dev`) and only
# need the API routes. Starlette's StaticFiles raises if the directory doesn't
# exist, so we only mount when `dist/` is present.
dist_dir = os.path.join(os.path.dirname(__file__), "dist")
if os.path.isdir(dist_dir):
    app.mount("/", StaticFiles(directory=dist_dir, html=True), name="static")
else:
    print(f"Static dist/ not found at {dist_dir}; skipping static file mount")


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
