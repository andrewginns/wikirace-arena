import sqlite3
import json
import os
import re
from urllib.parse import quote
from typing import Tuple, List, Optional
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
      if (!url.pathname || !url.pathname.startsWith("/wiki/")) return null
      var title = url.pathname.slice("/wiki/".length)
      title = decodePart(title)
      title = title.replaceAll("_", " ")
      return title
    } catch {
      return null
    }
  }

  function toProxyPath(title) {
    return "/wiki/" + encodeURIComponent(title.replaceAll(" ", "_"))
  }

  function notifyParentCurrentTitle() {
    try {
      var raw = location.pathname.startsWith("/wiki/")
        ? location.pathname.slice("/wiki/".length)
        : ""
      if (!raw) return
      var title = decodePart(raw).replaceAll("_", " ")
      if (!title) return
      window.parent.postMessage({ type: "wikirace:navigate", title: title }, "*")
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

      var title = titleFromHref(anchor.getAttribute("href") || anchor.href)
      if (!title) return

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

      event.preventDefault()

      try {
        window.parent.postMessage({ type: "wikirace:navigate", title: title }, "*")
      } catch {
        // ignore
      }

      window.location.href = toProxyPath(title)
    },
    true
  )

  // Keep parent state in sync even if navigation happens via browser controls
  // (back/forward) or non-standard links.
  notifyParentCurrentTitle()
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
        content = response.choices[0].message.content
        if not content:
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
