import pytest

from app.erp import (
    CreatePurchaseOrderRequest,
    ErpStore,
    InventoryAdjustmentRequest,
    PurchaseOrderNotFoundError,
    ReceiptRequest,
    ResolveExceptionRequest,
)
from app.repository import IdempotencyConflictError, InMemoryRepository


class FailingAlertPublisher:
    def publish(self, event: object) -> None:
        del event
        raise RuntimeError("SNS unavailable")


def make_store() -> ErpStore:
    return ErpStore(repository=InMemoryRepository())


def make_order(store: ErpStore, quantity: int = 10) -> None:
    store.create_purchase_order(
        CreatePurchaseOrderRequest.model_validate(
            {
                "po_id": "TEST-PO-001",
                "supplier_name": "Test supplier",
                "expected_date": "2026-09-13",
                "items": [
                    {
                        "material_id": "TEST-MAT-001",
                        "material_name": "Test material",
                        "ordered_quantity": quantity,
                    }
                ],
            }
        )
    )


def test_over_receipt_is_recorded_as_exception() -> None:
    store = make_store()
    make_order(store)

    result = store.receive(
        ReceiptRequest.model_validate(
            {
                "po_id": "TEST-PO-001",
                "items": [{"material_id": "TEST-MAT-001", "received_quantity": 12}],
            }
        ),
        idempotency_key="over-receipt-001",
    )

    assert result.status == "待處理異常"
    assert result.exceptions == ["Test material 超收 2 pcs"]
    assert store.repository.get_purchase_order("TEST-PO-001").exception_reasons == result.exceptions
    inventory = next(item for item in store.list_inventory() if item.material_id == "TEST-MAT-001")
    assert inventory.quantity == 10
    assert inventory.quarantine_quantity == 2


def test_over_receipt_can_only_be_closed_as_approved_difference() -> None:
    store = make_store()
    make_order(store)
    store.receive(
        ReceiptRequest.model_validate(
            {
                "po_id": "TEST-PO-001",
                "items": [{"material_id": "TEST-MAT-001", "received_quantity": 12}],
            }
        ),
        idempotency_key="over-receipt-002",
    )

    closed = store.resolve_exception(
        "TEST-PO-001",
        ResolveExceptionRequest(
            action="差異允收結案",
            resolved_by="manager",
            note="核准超收 2 pcs",
        ),
    )

    assert closed.status == "差異結案"
    assert closed.approved_variances == {"TEST-MAT-001": -2}
    inventory = next(item for item in store.list_inventory() if item.material_id == "TEST-MAT-001")
    assert inventory.quantity == 12
    assert inventory.quarantine_quantity == 0
    approved_transactions = [
        transaction
        for transaction in store.list_inventory_transactions()
        if transaction.transaction_type == "差異允收"
    ]
    assert len(approved_transactions) == 1
    assert approved_transactions[0].quantity_change == 2
    assert approved_transactions[0].performed_by == "manager"


def test_failed_alert_delivery_keeps_pending_outbox_batch() -> None:
    repository = InMemoryRepository()
    store = ErpStore(repository=repository, alert_publisher=FailingAlertPublisher())
    make_order(store)

    result = store.receive(
        ReceiptRequest.model_validate(
            {
                "po_id": "TEST-PO-001",
                "items": [{"material_id": "TEST-MAT-001", "received_quantity": 5}],
            }
        ),
        idempotency_key="failed-alert-001",
    )

    assert result.status == "待處理異常"
    assert len(repository.list_pending_alert_batches()) == 1


def test_alert_outbox_claim_prevents_concurrent_replay() -> None:
    repository = InMemoryRepository()
    store = ErpStore(repository=repository, alert_publisher=FailingAlertPublisher())
    make_order(store)
    store.receive(
        ReceiptRequest.model_validate(
            {
                "po_id": "TEST-PO-001",
                "items": [{"material_id": "TEST-MAT-001", "received_quantity": 5}],
            }
        ),
        idempotency_key="claim-alert-001",
    )
    batch_id = repository.list_pending_alert_batches()[0][0]

    first_token = repository.claim_alert_batch(batch_id, lease_seconds=300)
    assert first_token
    assert repository.claim_alert_batch(batch_id, lease_seconds=300) is None
    repository.release_alert_batch(batch_id, first_token)
    second_token = repository.claim_alert_batch(batch_id, lease_seconds=300)
    assert second_token
    repository.mark_alert_batch_published(batch_id, second_token)
    assert repository.list_pending_alert_batches() == []


def test_unknown_purchase_order_uses_typed_not_found_error() -> None:
    store = make_store()

    with pytest.raises(PurchaseOrderNotFoundError, match="找不到採購單"):
        store.receive(
            ReceiptRequest.model_validate(
                {
                    "po_id": "UNKNOWN-PO",
                    "items": [{"material_id": "MAT", "received_quantity": 1}],
                }
            ),
            idempotency_key="unknown-po-001",
        )


def test_inventory_adjustment_is_atomic_and_idempotent() -> None:
    store = make_store()
    request = InventoryAdjustmentRequest(
        material_id="MAT-1001",
        quantity_change=-20,
        adjustment_type="退貨",
        reason="供應商退貨",
    )

    first = store.adjust_inventory(request, "adjustment-001")
    replay = store.adjust_inventory(request, "adjustment-001")

    assert first.quantity_before == 420
    assert first.quantity_after == 400
    assert replay.adjustment_id == first.adjustment_id
    assert store.list_inventory_transactions()[0].transaction_type == "退貨"

    with pytest.raises(IdempotencyConflictError):
        store.adjust_inventory(
            request.model_copy(update={"quantity_change": -30}),
            "adjustment-001",
        )


def test_replenishment_receipt_does_not_replay_an_earlier_overage() -> None:
    store = make_store()
    store.create_purchase_order(
        CreatePurchaseOrderRequest.model_validate(
            {
                "po_id": "PO-MIXED-001",
                "supplier_name": "供應商",
                "expected_date": "2026-09-30",
                "items": [
                    {"material_id": "MIX-A", "material_name": "A 件", "ordered_quantity": 100},
                    {"material_id": "MIX-B", "material_name": "B 件", "ordered_quantity": 50},
                ],
            }
        )
    )
    first = store.receive(
        ReceiptRequest.model_validate(
            {
                "po_id": "PO-MIXED-001",
                "items": [
                    {"material_id": "MIX-A", "received_quantity": 80},
                    {"material_id": "MIX-B", "received_quantity": 60},
                ],
            }
        ),
        "mixed-receipt-001",
    )
    store.resolve_exception(
        "PO-MIXED-001",
        ResolveExceptionRequest.model_validate(
            {"action": "補貨", "resolved_by": "approver", "note": "補足短缺"}
        ),
    )
    second = store.receive(
        ReceiptRequest.model_validate(
            {
                "po_id": "PO-MIXED-001",
                "items": [
                    {"material_id": "MIX-A", "received_quantity": 20},
                    {"material_id": "MIX-B", "received_quantity": 0},
                ],
            }
        ),
        "mixed-receipt-002",
    )
    inventory = {item.material_id: item for item in store.list_inventory()}

    assert first.exceptions == ["A 件 尚待補貨 20 pcs", "B 件 超收 10 pcs"]
    assert second.exceptions == []
    assert second.status == "已完成"
    assert inventory["MIX-B"].quarantine_quantity == 10
