import sqlite3
import json
import os
import re
from urllib.parse import quote
from typing import Tuple, List, Optional, Any
from functools import lru_cache
from fastapi import FastAPI, HTTPException
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

  function setReplayMode(enabled) {
    replayMode = !!enabled
  }

  window.addEventListener("message", function (event) {
    var data = event && event.data
    if (!data || typeof data !== "object") return
    if (data.type === "wikirace:setReplayMode") {
      setReplayMode(!!data.enabled)
    }
  })

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

        try {
          window.parent.postMessage({ type: "wikirace:navigate", title: resolved }, "*")
        } catch {
          // ignore
        }

        window.location.href = toProxyPath(resolved)
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
