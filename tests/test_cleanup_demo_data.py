from scripts.cleanup_demo_data import is_demo_record


def test_demo_purchase_order_and_inventory_records_are_selected() -> None:
    assert is_demo_record({"PK": "purchase_order#DEMO-PO-001", "SK": "META"})
    assert is_demo_record({"PK": "inventory#DEMO-MAT-001", "SK": "META"})


def test_related_demo_records_are_selected_but_real_records_are_not() -> None:
    assert is_demo_record(
        {
            "PK": "inventory_transaction#INV-001",
            "SK": "META",
            "entity": "inventory_transaction",
            "data": '{"material_id":"DEMO-MAT-001","reference_id":"PO-001"}',
        }
    )
    assert not is_demo_record(
        {
            "PK": "purchase_order#PO-2026-001",
            "SK": "META",
            "entity": "purchase_order",
            "data": '{"po_id":"PO-2026-001","material_id":"MAT-1001"}',
        }
    )
