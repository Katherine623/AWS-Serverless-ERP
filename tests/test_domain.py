from app.erp import (
    CreatePurchaseOrderRequest,
    ErpStore,
    ReceiptRequest,
    ResolveExceptionRequest,
)
from app.repository import InMemoryRepository


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
