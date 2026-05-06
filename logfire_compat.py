from __future__ import annotations

from contextlib import nullcontext
from typing import Any

try:
    import logfire as _logfire
except ImportError:
    class _NoopLogfire:
        def configure(self, *args: Any, **kwargs: Any) -> None:
            return None

        def instrument_pydantic_ai(self, *args: Any, **kwargs: Any) -> None:
            return None

        def instrument_httpx(self, *args: Any, **kwargs: Any) -> None:
            return None

        def span(self, *args: Any, **kwargs: Any):
            return nullcontext()

    logfire = _NoopLogfire()
else:
    logfire = _logfire
