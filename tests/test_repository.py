import pytest

from app.erp import ErpStore
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
