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


class MoveRoomRequest(BaseModel):
    player_id: str
    to_article: str


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
        seen = {current.lower()}

        for _ in range(6):
            title, links = self.get_article_with_links(current)
            if not title:
                break
            if len(links) != 1:
                break

            candidate = self.resolve_title(links[0])
            if not candidate:
                break
            key = candidate.lower()
            if key in seen:
                break
            seen.add(key)
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
    default = {"max_hops": 20, "max_links": None, "max_tokens": None}
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

    return {"max_hops": max_hops, "max_links": max_links, "max_tokens": max_tokens}


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
                ROOMS.pop(room_id, None)
                ROOM_LOCKS.pop(room_id, None)
                ROOM_CONNECTIONS.pop(room_id, None)

    asyncio.create_task(_cleanup_loop())


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
  var resolvedTitleCache = Object.create(null)
  var navRequestSeq = 0
  var pendingNavigate = Object.create(null)

  function setReplayMode(enabled) {
    replayMode = !!enabled
  }

  window.addEventListener("message", function (event) {
    var data = event && event.data
    if (!data || typeof data !== "object") return
    if (data.type === "wikirace:setReplayMode") {
      setReplayMode(!!data.enabled)
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
    return "/wiki/" + encodeURIComponent(title.replaceAll(" ", "_"))
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

      // ignore same-page section links
      try {
        if (title.replaceAll("_", " ") === decodePart(location.pathname.slice("/wiki/".length)).replaceAll("_", " ") && anchor.hash) {
          return
        }
      } catch {
        // ignore
      }

      if (replayMode) {
        event.preventDefault()
        return
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
            raise HTTPException(status_code=409, detail="Room already finished")

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

        if isinstance(current_article, str) and _titles_match(current_article, resolved):
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

        if resolved not in links:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid move: '{resolved}' is not a link from '{title}'",
            )

        canonical_next = db.canonical_title(resolved)
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
            step_article = resolved
            step_metadata = {"reason": "max_hops", "max_hops": max_hops}
        else:
            step_type = "move"
            step_article = resolved

        step: dict[str, Any] = {"type": step_type, "article": step_article, "at": updated_at}
        if step_metadata:
            step["metadata"] = step_metadata

        run["steps"] = [*steps, step]
        room["updated_at"] = updated_at
        changed = True

        if run.get("status") == "finished":
            if all(r.get("status") == "finished" for r in room.get("runs", [])):
                room["status"] = "finished"
                room["finished_at"] = updated_at

    if changed:
        await _broadcast_room(room_id)
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
                    raise HTTPException(
                        status_code=response.status,
                        detail=f"Failed to fetch wiki page ({response.status})",
                    )
                html = await response.text()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return HTMLResponse(content=_rewrite_wiki_html(html))


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
