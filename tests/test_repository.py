import pytest

from app.erp import ErpStore, InventoryTransaction
from app.repository import InMemoryRepository


def test_in_memory_pages_return_opaque_cursor() -> None:
    repository = InMemoryRepository()
    ErpStore(repository=repository)

    first, cursor = repository.list_purchase_orders_page(1, None)
    second, next_cursor = repository.list_purchase_orders_page(1, cursor)

    assert len(first) == 1
    assert len(second) == 1
    assert first[0].po_id != second[0].po_id
    assert next_cursor is None
    assert cursor and "offset" not in cursor


def test_invalid_page_cursor_is_rejected() -> None:
    repository = InMemoryRepository()

    with pytest.raises(ValueError, match="cursor"):
        repository.list_inventory_page(10, "not-a-cursor")


def test_page_filters_are_applied_and_cursor_is_bound_to_filter() -> None:
    repository = InMemoryRepository()
    ErpStore(repository=repository)

    page, cursor = repository.list_purchase_orders_page(1, None, status="待驗收")

    assert len(page) == 1
    assert page[0].status == "待驗收"
    assert cursor is not None
    with pytest.raises(ValueError, match="篩選條件"):
        repository.list_purchase_orders_page(1, cursor, status="已完成")

    _, unfiltered_cursor = repository.list_purchase_orders_page(1, None)
    assert unfiltered_cursor is not None
    with pytest.raises(ValueError, match="篩選條件"):
        repository.list_inventory_page(1, unfiltered_cursor)


def test_inventory_and_transaction_filters_are_applied() -> None:
    repository = InMemoryRepository()
    ErpStore(repository=repository)

    low_stock, cursor = repository.list_inventory_page(10, None, low_stock=True)
    assert cursor is None
    assert [item.material_id for item in low_stock] == ["MAT-2001"]

    repository.inventory_transactions["INV-FILTER"] = InventoryTransaction(
        transaction_id="INV-FILTER",
        material_id="MAT-2001",
        material_name="控制晶片",
        quantity_change=-2,
        transaction_type="報廢",
        reference_id="ADJ-1",
        performed_by="tester",
        occurred_at="2026-09-13T00:00:00Z",
    )
    transactions, _ = repository.list_inventory_transactions_page(
        10,
        None,
        material_id="MAT-2001",
        transaction_type="報廢",
    )
    assert [item.transaction_id for item in transactions] == ["INV-FILTER"]
