"""Persisted, owner-scoped AI drafts and explicit execution history."""

import time
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException

from app.config import get_settings
from app.erp import (
    CreatePurchaseOrderRequest,
    InventoryAdjustmentRequest,
    ReceiptRequest,
    ResolveExceptionRequest,
    store,
)
from app.repository import IdempotencyConflictError


def save_draft(arguments: dict, actor, preview: dict) -> str:
    identifier = uuid4().hex
    now = datetime.now(UTC).isoformat()
    store.repository.save_record(
        "ai_action",
        {
            "id": identifier,
            "owner": actor.subject,
            "created_at": now,
            "status": "draft",
            "arguments": arguments,
            "preview": preview,
            "events": [{"status": "draft", "at": now}],
        },
    )
    return identifier


def owned_action(identifier, actor):
    record = store.repository.get_record("ai_action", identifier)
    if not record or record["owner"] != actor.subject:
        raise HTTPException(status_code=404, detail="找不到操作紀錄")
    return record


def transition(record, status, **fields):
    previous = dict(record)
    updated = {
        **record,
        **fields,
        "status": status,
        "events": [*record["events"], {"status": status, "at": datetime.now(UTC).isoformat()}][
            -50:
        ],
    }
    try:
        store.repository.save_record("ai_action", updated, previous=previous)
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return updated


def cancel_action(identifier, actor):
    record = owned_action(identifier, actor)
    if record["status"] == "cancelled":
        return record
    # A failed execution wrote nothing, so the draft is still safe to withdraw.
    if record["status"] not in {"draft", "failed"}:
        raise HTTPException(status_code=409, detail="已送出的操作不可直接取消，請查閱執行結果")
    return transition(record, "cancelled")


def execute_action(identifier, actor):
    from app.ai import prepare_action

    record = owned_action(identifier, actor)
    arguments = record["arguments"]
    # Recheck the current role and overwrite operator fields from the authenticated actor.
    try:
        preview = prepare_action(arguments, actor)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if record["status"] == "completed":
        return record["result"]
    if record["status"] == "cancelled":
        raise HTTPException(status_code=409, detail="此操作已取消")
    first_execution = record.get("first_execution_at", time.time())
    if time.time() - first_execution >= get_settings().idempotency_ttl_days * 86400:
        raise HTTPException(status_code=409, detail="重送保護期限已過，請先查核帳本")
    if record["status"] == "executing":
        if record.get("lease_until", 0) > time.time():
            raise HTTPException(status_code=409, detail="操作處理中，請稍後查閱紀錄")
        if not preview.requires_idempotency:
            raise HTTPException(status_code=409, detail="上次操作結果未確認，請先查閱 ERP 資料")
    record = transition(
        record, "executing", lease_until=int(time.time()) + 60, first_execution_at=first_execution
    )
    try:
        payload = preview.payload
        key = f"ai-{identifier}"
        if preview.action == "receive":
            result = store.receive(ReceiptRequest.model_validate(payload), key)
        elif preview.action == "adjust_inventory":
            result = store.adjust_inventory(InventoryAdjustmentRequest.model_validate(payload), key)
        elif preview.action == "create_purchase_order":
            result = store.create_purchase_order(CreatePurchaseOrderRequest.model_validate(payload))
        else:
            result = store.resolve_exception(
                arguments["po_id"], ResolveExceptionRequest.model_validate(payload)
            )
    except ValueError as exc:
        transition(record, "failed", error=str(exc)[:500], lease_until=0)
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    # If result persistence fails, executing remains visible. Idempotent operations can retry.
    data = result.model_dump(mode="json")
    transition(record, "completed", result=data, lease_until=0)
    return data
