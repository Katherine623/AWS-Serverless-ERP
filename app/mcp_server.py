from __future__ import annotations

import json
from typing import Any

from mcp.server.fastmcp import FastMCP

from app.config import get_settings
from app.erp import (
    CreatePurchaseOrderRequest,
    ReceiptRequest,
    ResolveExceptionRequest,
    store,
)

mcp = FastMCP("AWS Serverless ERP")


def _dump(value: Any) -> str:
    if hasattr(value, "model_dump_json"):
        return value.model_dump_json()
    if isinstance(value, list):
        return json.dumps(
            [
                item.model_dump(mode="json") if hasattr(item, "model_dump") else item
                for item in value
            ],
            ensure_ascii=False,
        )
    return json.dumps(value, ensure_ascii=False)


def _require_approval(action: str, approved: bool) -> None:
    if not approved:
        raise PermissionError(f"{action} requires explicit approved=true")
    if not get_settings().mcp_mutations_enabled:
        raise PermissionError(
            "ERP_MCP_MUTATIONS_ENABLED=true is required before MCP can mutate ERP data"
        )


@mcp.tool()
def get_dashboard() -> str:
    """Read ERP KPI summary."""
    return _dump(store.dashboard())


@mcp.tool()
def list_purchase_orders() -> str:
    """Read purchase orders and their receiving status."""
    return _dump(store.list_purchase_orders())


@mcp.tool()
def list_inventory() -> str:
    """Read current inventory quantities and reorder points."""
    return _dump(store.list_inventory())


@mcp.tool()
def list_inventory_transactions() -> str:
    """Read the inventory audit ledger."""
    return _dump(store.list_inventory_transactions())


@mcp.tool()
def create_purchase_order(request_json: str, approved: bool = False) -> str:
    """Create a PO only when the caller explicitly approves the mutation."""
    _require_approval("create_purchase_order", approved)
    request = CreatePurchaseOrderRequest.model_validate(json.loads(request_json))
    return _dump(store.create_purchase_order(request))


@mcp.tool()
def receive_purchase_order(
    request_json: str,
    idempotency_key: str,
    approved: bool = False,
) -> str:
    """Receive goods and update inventory only after explicit approval."""
    _require_approval("receive_purchase_order", approved)
    request = ReceiptRequest.model_validate(json.loads(request_json))
    return _dump(store.receive(request, idempotency_key=idempotency_key))


@mcp.tool()
def resolve_purchase_order_exception(
    po_id: str,
    request_json: str,
    approved: bool = False,
) -> str:
    """Resolve a receiving exception only after explicit approval."""
    _require_approval("resolve_purchase_order_exception", approved)
    request = ResolveExceptionRequest.model_validate(json.loads(request_json))
    return _dump(store.resolve_exception(po_id, request))


if __name__ == "__main__":
    mcp.run(transport="stdio")
