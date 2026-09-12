from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["service"] == "erp-receiving-platform"


def test_dashboard_contains_erp_metrics() -> None:
    response = client.get("/api/dashboard")

    assert response.status_code == 200
    assert response.json()["total_purchase_orders"] == 2
    assert response.json()["inventory_item_count"] == 3


def test_receiving_shortage_creates_exception_and_updates_inventory() -> None:
    response = client.post(
        "/api/receipts",
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
    assert response.json()["status"] == "有異常"
    assert any("短缺 20 pcs" in item for item in response.json()["exceptions"])

    inventory = client.get("/api/inventory").json()
    bearing = next(item for item in inventory if item["material_id"] == "MAT-1001")
    assert bearing["quantity"] == 500
