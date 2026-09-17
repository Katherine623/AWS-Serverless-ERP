import json
import time
from dataclasses import replace
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError, ReadTimeoutError
from fastapi import HTTPException
from fastapi.testclient import TestClient
from openpyxl import Workbook

from app import ai, ai_actions, erp, import_parser, import_worker
from app.auth import Actor, get_current_actor
from app.erp import ErpStore, InventoryAdjustmentRequest, ReceiptRequest
from app.main import app
from app.repository import DynamoDbRepository, IdempotencyConflictError, InMemoryRepository


@pytest.fixture
def store(monkeypatch):
    local = ErpStore(repository=InMemoryRepository(), alert_publisher=Mock())
    monkeypatch.setattr(ai_actions, "store", local)
    monkeypatch.setattr(import_worker, "store", local)
    return local


def workbook(*rows):
    book = Workbook()
    book.active.append(
        [
            "po_id",
            "supplier_name",
            "expected_date",
            "material_id",
            "material_name",
            "ordered_quantity",
        ]
    )
    for row in rows:
        book.active.append(row)
    stream = BytesIO()
    book.save(stream)
    book.close()
    stream.seek(0)
    return stream


def row(po="NEW", supplier="Supplier", quantity=2, material="NEW-MAT"):
    return [po, supplier, "2026-09-20", material, material, quantity]


def test_import_rejects_entire_inconsistent_po_but_imports_other_orders(store):
    report = import_parser.parse_and_import(
        workbook(row(), row(supplier="Different", material="OTHER"), row(po="GOOD")), store
    )
    assert report["imported"] == 1 and report["failed"] == 1
    assert report["errors"][0]["row"] == 3
    assert store.repository.get_purchase_order("NEW") is None
    assert store.repository.get_purchase_order("GOOD") is not None


@pytest.mark.parametrize("quantity", [1.5, -1, 0])
def test_import_invalid_quantity_is_reported_without_truncating(store, quantity):
    report = import_parser.parse_and_import(workbook(row(quantity=quantity)), store)
    assert report["failed"] == 1 and report["imported"] == 0
    assert report["errors"][0]["row"] == 2


def test_import_row_limit_precedes_all_writes(store, monkeypatch):
    monkeypatch.setattr(import_parser, "MAX_ROWS", 1)
    with pytest.raises(ValueError):
        import_parser.parse_and_import(workbook(row(), row(po="SECOND")), store)
    assert store.repository.get_purchase_order("NEW") is None


def test_import_expanded_archive_limit(store, monkeypatch):
    monkeypatch.setattr(import_parser, "MAX_EXPANDED_BYTES", 1)
    with pytest.raises(ValueError, match="50 MB"):
        import_parser.parse_and_import(workbook(row()), store)


def test_import_download_limit_closes_body(store, monkeypatch):
    from botocore.response import StreamingBody

    raw = BytesIO(b"123456")
    monkeypatch.setattr(import_worker, "MAX_FILE_BYTES", 5)
    monkeypatch.setattr(
        import_worker,
        "s3",
        SimpleNamespace(get_object=lambda **kwargs: {"Body": StreamingBody(raw, 6)}),
    )
    with pytest.raises(ValueError, match="10 MB"):
        import_worker._import_report("bucket", "key")
    assert raw.closed


def import_event():
    return {
        "Records": [
            {
                "messageId": "msg",
                "body": json.dumps(
                    {
                        "Records": [
                            {
                                "s3": {
                                    "bucket": {"name": "bucket"},
                                    "object": {"key": "incoming/job-orders.xlsx"},
                                }
                            }
                        ]
                    }
                ),
            }
        ]
    }


def test_import_job_tracks_results_and_duplicate_delivery(store, monkeypatch):
    store.repository.save_record(
        "import", {"id": "job", "owner": "u", "created_at": "now", "status": "awaiting_upload"}
    )
    report = {
        "imported": 1,
        "failed": 1,
        "skipped": 0,
        "errors": [{"row": 3, "message": "bad row"}],
    }
    perform = Mock(return_value=report)
    monkeypatch.setattr(import_worker, "_import_report", perform)
    assert import_worker.handler(import_event(), None) == {"batchItemFailures": []}
    job = store.repository.get_record("import", "job")
    assert job["status"] == "partial_failed" and job["errors"] == report["errors"]
    assert job["owner"] == "u"
    import_worker.handler(import_event(), None)
    assert perform.call_count == 1


def test_import_claim_conflict_does_not_overwrite_running_job(store, monkeypatch):
    previous = {"id": "job", "owner": "u", "created_at": "now", "status": "awaiting_upload"}
    store.repository.save_record("import", previous)
    running = {**previous, "status": "processing", "lease_until": time.time() + 300}
    store.repository.save_record("import", running, previous=previous)
    monkeypatch.setattr(store.repository, "get_record", lambda *args: previous)
    result = import_worker.handler(import_event(), None)
    assert result["batchItemFailures"]
    assert store.repository.records[("import", "job")] == running


def test_import_failure_is_persisted_for_owner(store, monkeypatch):
    monkeypatch.setattr(import_worker, "_import_report", Mock(side_effect=ValueError("bad XLSX")))
    assert import_worker.handler(import_event(), None)["batchItemFailures"]
    job = store.repository.get_record("import", "job")
    assert job["status"] == "failed"
    assert job["errors"] == [{"message": "bad XLSX"}]


@pytest.mark.parametrize("kind", ["import", "ai_action"])
def test_record_creation_and_updates_are_conditional(kind):
    repo = InMemoryRepository()
    record = {"id": "one", "owner": "u", "created_at": "now", "status": "draft"}
    repo.save_record(kind, record)
    with pytest.raises(IdempotencyConflictError):
        repo.save_record(kind, record)
    repo.save_record(kind, {**record, "status": "executing"}, previous=record)
    with pytest.raises(IdempotencyConflictError):
        repo.save_record(kind, {**record, "status": "cancelled"}, previous=record)
    assert repo.list_records(kind, "different") == []


@pytest.mark.parametrize("adjustment_type", ["退貨", "報廢", "盤點調整"])
def test_adjustment_low_stock_outbox_survives_sns_failure_and_retry(store, adjustment_type):
    store.alert_publisher.publish.side_effect = RuntimeError("SNS unavailable")
    request = InventoryAdjustmentRequest(
        material_id="MAT-1001", quantity_change=-400, adjustment_type=adjustment_type, reason="test"
    )
    first = store.adjust_inventory(request, "retry-key")
    second = store.adjust_inventory(request, "retry-key")
    assert first == second
    assert store.repository.get_inventory("MAT-1001").quantity == 20
    batches = store.repository.list_pending_alert_batches()
    assert len(batches) == 1
    assert batches[0][1][0].current_quantity == 20
    assert adjustment_type in batches[0][1][0].message
    assert len(store.repository.inventory_transactions) == 1


def test_dynamo_cancelled_adjustment_returns_persisted_result(store, monkeypatch):
    request = InventoryAdjustmentRequest(
        material_id="MAT-1001", quantity_change=-1, adjustment_type="退貨", reason="test"
    )
    existing = store.adjust_inventory(request, "key")
    repo = object.__new__(DynamoDbRepository)
    client = Mock()
    client.transact_write_items.side_effect = ClientError(
        {"Error": {"Code": "TransactionCanceledException"}}, "TransactWriteItems"
    )
    repo._table = SimpleNamespace(name="test", meta=SimpleNamespace(client=client))
    monkeypatch.setattr(repo, "mutation_for_key", lambda key: (existing, "hash"))
    item = store.repository.get_inventory("MAT-1001")
    transaction = next(iter(store.repository.inventory_transactions.values()))
    unsaved = existing.model_copy(update={"adjustment_id": "UNSAVED"})
    result = repo.save_inventory_adjustment(unsaved, "key", "hash", item, item, transaction)
    assert result.adjustment_id == existing.adjustment_id
    with pytest.raises(IdempotencyConflictError):
        repo.save_inventory_adjustment(unsaved, "key", "different", item, item, transaction)


def test_dynamo_cancelled_receipt_returns_persisted_result(store, monkeypatch):
    order = store.repository.list_purchase_orders()[0]
    previous = order.model_copy(deep=True)
    request = ReceiptRequest(
        po_id=order.po_id,
        received_by="u",
        items=[
            {"material_id": item.material_id, "received_quantity": item.ordered_quantity}
            for item in order.items
        ],
    )
    existing = store.receive(request, "receipt-key")
    repo = object.__new__(DynamoDbRepository)
    client = Mock()
    client.transact_write_items.side_effect = ClientError(
        {"Error": {"Code": "TransactionCanceledException"}}, "TransactWriteItems"
    )
    repo._table = SimpleNamespace(name="test", meta=SimpleNamespace(client=client))
    monkeypatch.setattr(repo, "receipt_for_key", lambda key: (existing, "hash"))
    unsaved = existing.model_copy(update={"receipt_id": "UNSAVED"})
    result = repo.save_receipt(unsaved, "key", "hash", order, previous, [], [], [])
    assert result.receipt_id == existing.receipt_id


def test_filtered_dynamo_query_stops_and_returns_continuation():
    repo = object.__new__(DynamoDbRepository)
    key = {"PK": "p", "SK": "META", "entity": "inventory", "entity_key": "p"}
    repo._table = Mock()
    repo._table.query.return_value = {"Items": [], "LastEvaluatedKey": key}
    items, cursor = repo._query_page("inventory", 50, None)
    assert items == [] and cursor
    assert repo._table.query.call_count == 5
    repo._table.query.return_value = {"Items": [{"data": "found"}]}
    assert repo._query_page("inventory", 50, cursor)[0] == [{"data": "found"}]
    assert repo._table.query.call_args.kwargs["ExclusiveStartKey"] == key


def test_dashboard_cache_invalidates_after_write(store, monkeypatch):
    monkeypatch.setattr(erp, "get_settings", lambda: SimpleNamespace(dynamodb_table_name="table"))
    stats = Mock(wraps=store.repository.dashboard_stats)
    monkeypatch.setattr(store.repository, "dashboard_stats", stats)
    store.dashboard()
    store.dashboard()
    assert stats.call_count == 1
    store.adjust_inventory(
        InventoryAdjustmentRequest(
            material_id="MAT-1001", quantity_change=-1, adjustment_type="退貨", reason="test"
        ),
        "key",
    )
    store.dashboard()
    assert stats.call_count == 2


def draft(actor):
    arguments = {
        "action": "adjust_inventory",
        "payload": {
            "material_id": "MAT-1001",
            "quantity_change": -1,
            "adjustment_type": "退貨",
            "reason": "test",
            "performed_by": "forged",
        },
    }
    return ai_actions.save_draft(arguments, actor, ai.prepare_action(arguments, actor).model_dump())


def test_ai_confirm_is_owner_scoped_idempotent_and_audited(store):
    actor = Actor(subject="u", roles=frozenset({"approver"}), claims={})
    identifier = draft(actor)
    assert store.repository.get_inventory("MAT-1001").quantity == 420
    with pytest.raises(HTTPException) as exc:
        ai_actions.execute_action(identifier, replace(actor, subject="other"))
    assert exc.value.status_code == 404
    result = ai_actions.execute_action(identifier, actor)
    assert result == ai_actions.execute_action(identifier, actor)
    assert result["performed_by"] == "u"
    assert store.repository.get_inventory("MAT-1001").quantity == 419
    record = ai_actions.owned_action(identifier, actor)
    assert [e["status"] for e in record["events"]] == ["draft", "executing", "completed"]


def test_ai_cancelled_draft_cannot_execute(store):
    actor = Actor(subject="u", roles=frozenset({"approver"}), claims={})
    identifier = draft(actor)
    ai_actions.cancel_action(identifier, actor)
    with pytest.raises(HTTPException) as exc:
        ai_actions.execute_action(identifier, actor)
    assert exc.value.status_code == 409
    assert store.repository.get_inventory("MAT-1001").quantity == 420


def test_ai_confirmation_rechecks_current_role(store):
    actor = Actor(subject="u", roles=frozenset({"approver"}), claims={})
    identifier = draft(actor)
    with pytest.raises(HTTPException) as exc:
        ai_actions.execute_action(identifier, replace(actor, roles=frozenset()))
    assert exc.value.status_code == 403


@pytest.mark.parametrize(
    "code,status,phrase",
    [
        ("ThrottlingException", 429, "配額"),
        ("AccessDeniedException", 503, "權限"),
        ("timeout", 504, "逾時"),
    ],
)
def test_bedrock_errors_have_actionable_distinct_messages(monkeypatch, code, status, phrase):
    monkeypatch.setenv("ERP_AI_MODEL_ID", "model")
    error = (
        ReadTimeoutError(endpoint_url="test")
        if code == "timeout"
        else ClientError({"Error": {"Code": code, "Message": "failed"}}, "Converse")
    )
    monkeypatch.setattr(
        ai.boto3, "client", lambda *a, **kw: SimpleNamespace(converse=Mock(side_effect=error))
    )
    with pytest.raises(HTTPException) as exc:
        ai.chat(
            ai.ChatRequest(message="hello"),
            Actor(subject="u", roles=frozenset({"approver"}), claims={}),
        )
    assert exc.value.status_code == status and phrase in exc.value.detail


def test_import_api_never_exposes_another_users_jobs(monkeypatch, store):
    monkeypatch.setattr(erp.store, "repository", store.repository)
    store.repository.save_record(
        "import", {"id": "private", "owner": "another", "created_at": "now", "status": "completed"}
    )
    app.dependency_overrides[get_current_actor] = lambda: Actor(
        subject="u", roles=frozenset({"purchaser"}), claims={}
    )
    try:
        client = TestClient(app)
        assert client.get("/api/imports/excel/jobs").json() == []
        assert client.get("/api/imports/excel/jobs/private").status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_ai_retry_recovers_result_after_audit_write_failed(store, monkeypatch):
    actor = Actor(subject="u", roles=frozenset({"approver"}), claims={})
    identifier = draft(actor)
    save = store.repository.save_record

    def fail_completion(kind, record, previous=None):
        if record["status"] == "completed":
            raise RuntimeError("DynamoDB temporarily unavailable")
        return save(kind, record, previous)

    monkeypatch.setattr(store.repository, "save_record", fail_completion)
    with pytest.raises(RuntimeError):
        ai_actions.execute_action(identifier, actor)
    assert store.repository.get_inventory("MAT-1001").quantity == 419
    executing = ai_actions.owned_action(identifier, actor)
    assert executing["status"] == "executing"
    monkeypatch.setattr(store.repository, "save_record", save)
    save("ai_action", {**executing, "lease_until": 0}, previous=executing)
    result = ai_actions.execute_action(identifier, actor)
    assert result["quantity_after"] == 419
    assert len(store.repository.inventory_transactions) == 1
    assert ai_actions.owned_action(identifier, actor)["status"] == "completed"


def test_ai_retry_rejects_expired_idempotency_protection(store):
    actor = Actor(subject="u", roles=frozenset({"approver"}), claims={})
    identifier = draft(actor)
    original = ai_actions.owned_action(identifier, actor)
    store.repository.save_record(
        "ai_action",
        {
            **original,
            "status": "executing",
            "lease_until": 0,
            "first_execution_at": 1,
        },
        previous=original,
    )
    with pytest.raises(HTTPException) as exc:
        ai_actions.execute_action(identifier, actor)
    assert exc.value.status_code == 409
    assert store.repository.get_inventory("MAT-1001").quantity == 420


def test_dynamo_record_conditions_protect_create_and_update():
    repo = object.__new__(DynamoDbRepository)
    repo._table = Mock()
    record = {"id": "job", "owner": "u", "created_at": "now", "status": "draft"}
    repo.save_record("ai_action", record)
    assert (
        repo._table.put_item.call_args.kwargs["ConditionExpression"] == "attribute_not_exists(PK)"
    )
    repo.save_record("ai_action", {**record, "status": "executing"}, previous=record)
    kwargs = repo._table.put_item.call_args.kwargs
    assert kwargs["ConditionExpression"] == "#data = :previous"
    assert json.loads(kwargs["ExpressionAttributeValues"][":previous"]) == record


def test_dynamo_adjustment_contains_outbox_in_same_transaction(store):
    store.alert_publisher.publish.side_effect = RuntimeError("SNS unavailable")
    result = store.adjust_inventory(
        InventoryAdjustmentRequest(
            material_id="MAT-1001", quantity_change=-400, adjustment_type="報廢", reason="test"
        ),
        "outbox-key",
    )
    repo = object.__new__(DynamoDbRepository)
    client = Mock()
    repo._table = SimpleNamespace(name="test", meta=SimpleNamespace(client=client))
    item = store.repository.get_inventory("MAT-1001")
    transaction = next(iter(store.repository.inventory_transactions.values()))
    alerts = store.repository.list_pending_alert_batches()[0][1]
    repo.save_inventory_adjustment(result, "outbox-key", "hash", item, item, transaction, alerts)
    actions = client.transact_write_items.call_args.kwargs["TransactItems"]
    assert any(a["Put"]["Item"]["PK"] == f"alert_batch#{result.adjustment_id}" for a in actions)
    assert any(a["Put"]["Item"]["PK"] == "inventory#MAT-1001" for a in actions)
    assert client.transact_write_items.call_count == 1
