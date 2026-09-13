import json

import pytest

from app import mcp_server


def test_erp_mcp_exposes_dashboard_reader() -> None:
    dashboard = json.loads(mcp_server.get_dashboard())

    assert dashboard["total_purchase_orders"] == 2
    assert dashboard["inventory_item_count"] == 3


def test_erp_mcp_mutations_require_explicit_approval() -> None:
    with pytest.raises(PermissionError, match="approved=true"):
        mcp_server.receive_purchase_order(
            '{"po_id":"PO-2026-001","items":[]}',
            "mcp-test-001",
        )
