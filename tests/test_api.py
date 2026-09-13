import pytest
from fastapi.testclient import TestClient

from app.alerts import AlertEvent
from app.erp import ErpStore, IdempotencyConflictError, ReceiptRequest
from app.main import app, store
from app.repository import InMemoryRepository

client = TestClient(app)


class RecordingAlertPublisher:
    def __init__(self) -> None:
        self.events: list[AlertEvent] = []

    def publish(self, event: AlertEvent) -> None:
        self.events.append(event)


def reset_store() -> None:
    store.repository = InMemoryRepository()
    store._seed()


def test_health() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["service"] == "erp-receiving-platform"


def test_dashboard_contains_erp_metrics() -> None:
    reset_store()
    response = client.get("/api/dashboard")

    assert response.status_code == 200
    assert response.json()["total_purchase_orders"] == 2
    assert response.json()["inventory_item_count"] == 3
    assert response.json()["low_stock_count"] == 1
    assert response.json()["quarantine_total"] == 0


def test_creating_purchase_order_assigns_pending_status_and_timestamp() -> None:
    reset_store()
    response = client.post(
        "/api/purchase-orders",
        json={
            "po_id": "DEMO-TEST-001",
            "supplier_name": "Demo 供應商",
            "expected_date": "2026-09-12",
            "items": [
                {
                    "material_id": "DEMO-MAT-001",
                    "material_name": "Demo 組件",
                    "ordered_quantity": 100,
                }
            ],
        },
    )

    assert response.status_code == 201
    assert response.json()["status"] == "待驗收"
    assert response.json()["created_at"]


def test_receiving_shortage_creates_exception_and_updates_inventory() -> None:
    reset_store()
    response = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "shortage-test-001"},
        json={
            "po_id": "PO-2026-001",
            "received_by": "test-warehouse",
            "items": [
                {"material_id": "MAT-1001", "received_quantity": 80},
                {"material_id": "MAT-1002", "received_quantity": 50},
            ],
        },
    )

    assert response.status_code == 201
    assert response.json()["status"] == "待處理異常"
    assert any("尚待補貨 20 pcs" in item for item in response.json()["exceptions"])

    inventory = client.get("/api/inventory").json()
    bearing = next(item for item in inventory if item["material_id"] == "MAT-1001")
    assert bearing["quantity"] == 500


def test_receiving_publishes_exception_alert() -> None:
    reset_store()
    publisher = RecordingAlertPublisher()
    original_publisher = store.alert_publisher
    store.alert_publisher = publisher
    try:
        response = client.post(
            "/api/receipts",
            headers={"Idempotency-Key": "alert-test-001"},
            json={
                "po_id": "PO-2026-002",
                "received_by": "test-warehouse",
                "items": [{"material_id": "MAT-2001", "received_quantity": 100}],
            },
        )
    finally:
        store.alert_publisher = original_publisher

    assert response.status_code == 201
    assert any(event.alert_type == "收料異常" for event in publisher.events)


def test_receiving_with_same_idempotency_key_does_not_update_inventory_twice() -> None:
    reset_store()
    request = {
        "po_id": "PO-2026-002",
        "received_by": "test-warehouse",
        "items": [{"material_id": "MAT-2001", "received_quantity": 10}],
    }
    headers = {"Idempotency-Key": "receipt-test-001"}
    first = client.post("/api/receipts", headers=headers, json=request)
    second = client.post("/api/receipts", headers=headers, json=request)

    assert first.status_code == 201
    assert second.status_code == 201
    assert second.json()["receipt_id"] == first.json()["receipt_id"]


def test_receiving_requires_an_idempotency_key() -> None:
    reset_store()
    response = client.post(
        "/api/receipts",
        json={
            "po_id": "PO-2026-001",
            "items": [
                {"material_id": "MAT-1001", "received_quantity": 100},
                {"material_id": "MAT-1002", "received_quantity": 50},
            ],
        },
    )

    assert response.status_code == 422


def test_completed_purchase_order_cannot_be_received_twice() -> None:
    isolated_store = ErpStore(repository=InMemoryRepository())
    request = {
        "po_id": "PO-2026-001",
        "items": [
            {"material_id": "MAT-1001", "received_quantity": 100},
            {"material_id": "MAT-1002", "received_quantity": 50},
        ],
    }

    isolated_store.receive(ReceiptRequest.model_validate(request), "complete-test-001")

    with pytest.raises(IdempotencyConflictError, match="目前不可收料"):
        isolated_store.receive(ReceiptRequest.model_validate(request), "complete-test-002")


def test_receiving_rejects_items_that_do_not_match_purchase_order() -> None:
    reset_store()
    response = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "invalid-item-001"},
        json={
            "po_id": "PO-2026-001",
            "items": [{"material_id": "UNKNOWN", "received_quantity": 1}],
        },
    )

    assert response.status_code == 422


@pytest.mark.parametrize(
    "items",
    [
        [
            {"material_id": "MAT-1001", "received_quantity": 100},
            {"material_id": "MAT-1001", "received_quantity": 50},
        ],
        [{"material_id": "MAT-1001", "received_quantity": 100}],
    ],
)
def test_receiving_rejects_duplicate_or_missing_purchase_order_items(items: list[dict]) -> None:
    reset_store()
    before = client.get("/api/inventory").json()
    response = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "incomplete-items-001"},
        json={"po_id": "PO-2026-001", "items": items},
    )

    assert response.status_code == 422
    assert client.get("/api/inventory").json() == before


def test_reusing_idempotency_key_with_different_request_returns_conflict() -> None:
    reset_store()
    headers = {"Idempotency-Key": "replay-conflict-001"}
    first = client.post(
        "/api/receipts",
        headers=headers,
        json={
            "po_id": "PO-2026-002",
            "items": [{"material_id": "MAT-2001", "received_quantity": 200}],
        },
    )
    second = client.post(
        "/api/receipts",
        headers=headers,
        json={
            "po_id": "PO-2026-002",
            "items": [{"material_id": "MAT-2001", "received_quantity": 100}],
        },
    )

    assert first.status_code == 201
    assert second.status_code == 409


def test_partial_receipt_can_be_resolved_with_replenishment() -> None:
    reset_store()
    first = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "partial-receipt-001"},
        json={
            "po_id": "PO-2026-002",
            "items": [{"material_id": "MAT-2001", "received_quantity": 150}],
        },
    )
    resolution = client.post(
        "/api/purchase-orders/PO-2026-002/exception-resolution",
        json={"action": "補貨", "resolved_by": "test-purchaser", "note": "供應商承諾補足"},
    )
    final = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "partial-receipt-002"},
        json={
            "po_id": "PO-2026-002",
            "items": [{"material_id": "MAT-2001", "received_quantity": 50}],
        },
    )

    assert first.status_code == 201
    assert first.json()["status"] == "待處理異常"
    assert resolution.status_code == 200
    assert resolution.json()["status"] == "待補貨"
    assert final.status_code == 201
    assert final.json()["status"] == "已完成"


def test_receiving_creates_inventory_ledger_entries() -> None:
    reset_store()
    response = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "ledger-receipt-001"},
        json={
            "po_id": "PO-2026-002",
            "items": [{"material_id": "MAT-2001", "received_quantity": 200}],
        },
    )
    transactions = client.get("/api/inventory-transactions")

    assert response.status_code == 201
    assert transactions.status_code == 200
    assert transactions.json()[0]["material_id"] == "MAT-2001"
    assert transactions.json()[0]["quantity_change"] == 200
    assert transactions.json()[0]["reference_id"] == "PO-2026-002"


def test_exception_can_be_closed_with_approved_difference() -> None:
    reset_store()
    client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "difference-receipt-001"},
        json={
            "po_id": "PO-2026-002",
            "items": [{"material_id": "MAT-2001", "received_quantity": 150}],
        },
    )
    response = client.post(
        "/api/purchase-orders/PO-2026-002/exception-resolution",
        json={
            "action": "差異允收結案",
            "resolved_by": "test-manager",
            "note": "核准短缺 50 pcs 結案",
        },
    )

    assert response.status_code == 200
    assert response.json()["status"] == "差異結案"
    assert response.json()["exception_resolved_by"] == "test-manager"
    assert response.json()["exception_note"] == "核准短缺 50 pcs 結案"
    assert response.json()["approved_variances"] == {"MAT-2001": 50}


def test_purchase_order_rejects_duplicate_materials_and_received_quantity() -> None:
    reset_store()
    duplicate_materials = client.post(
        "/api/purchase-orders",
        json={
            "po_id": "DEMO-DUPLICATE-001",
            "supplier_name": "Demo 供應商",
            "expected_date": "2026-09-12",
            "items": [
                {"material_id": "DEMO-MAT", "material_name": "A", "ordered_quantity": 10},
                {"material_id": "DEMO-MAT", "material_name": "B", "ordered_quantity": 20},
            ],
        },
    )
    received_quantity = client.post(
        "/api/purchase-orders",
        json={
            "po_id": "DEMO-RECEIVED-001",
            "supplier_name": "Demo 供應商",
            "expected_date": "2026-09-12",
            "items": [
                {
                    "material_id": "DEMO-MAT",
                    "material_name": "Demo",
                    "ordered_quantity": 10,
                    "received_quantity": 10,
                }
            ],
        },
    )

    assert duplicate_materials.status_code == 422
    assert received_quantity.status_code == 422


def test_purchase_order_rejects_reused_material_id_with_different_name() -> None:
    reset_store()
    response = client.post(
        "/api/purchase-orders",
        json={
            "po_id": "DEMO-MATERIAL-CONFLICT-001",
            "supplier_name": "Demo 供應商",
            "expected_date": "2026-09-12",
            "items": [
                {
                    "material_id": "MAT-1001",
                    "material_name": "錯誤品名",
                    "ordered_quantity": 10,
                }
            ],
        },
    )

    assert response.status_code == 409


def test_receiving_all_zero_quantities_is_rejected() -> None:
    reset_store()
    response = client.post(
        "/api/receipts",
        headers={"Idempotency-Key": "zero-receipt-001"},
        json={
            "po_id": "PO-2026-001",
            "items": [
                {"material_id": "MAT-1001", "received_quantity": 0},
                {"material_id": "MAT-1002", "received_quantity": 0},
            ],
        },
    )

    assert response.status_code == 422
