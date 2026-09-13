from __future__ import annotations

from typing import Any

from app.erp import store


def handler(event: dict[str, Any], context: Any) -> dict[str, int]:
    """Replay pending alert batches from the scheduled Lambda worker."""
    del event, context
    return {"published": store.dispatch_pending_alerts()}
