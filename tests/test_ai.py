from types import SimpleNamespace

import pytest
from botocore.exceptions import ClientError
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import ai
from app.auth import Actor, get_current_actor
from app.erp import store
from app.main import app


def actor(role="warehouse"):
    return Actor(subject="verified-user", roles=frozenset({role}), claims={})


def output(*blocks):
    return {"output": {"message": {"role": "assistant", "content": list(blocks)}}}


def tool(name, arguments):
    return {"toolUse": {"toolUseId": "tool-1", "name": name, "input": arguments}}


def test_chat_returns_real_read_source(monkeypatch):
    monkeypatch.setenv("ERP_AI_MODEL_ID", "test-model")
    calls = []
    responses = iter([
        output(tool("list_inventory", {"low_stock": True})),
        output({"text": "找到低庫存料號"}),
    ])

    def converse(**kwargs):
        calls.append(kwargs)
        return next(responses)

    monkeypatch.setattr(ai.boto3, "client", lambda *a, **kw: SimpleNamespace(converse=converse))
    monkeypatch.setattr(ai, "read_tool", lambda name, args: {
        "items": [{"material_id": "TEST", "quantity": 2}], "next_cursor": None
    })
    result = ai.chat(ai.ChatRequest(message="查低庫存"), actor())
    assert result.sources[0]["data"]["items"][0]["quantity"] == 2
    assert result.answer == "找到低庫存料號"
    assert calls[1]["messages"][-1]["content"][0]["toolResult"]["content"][0]["json"]


def test_draft_never_executes_and_uses_verified_actor(monkeypatch):
    monkeypatch.setenv("ERP_AI_MODEL_ID", "test-model")
    monkeypatch.setattr(store, "receive", lambda *a, **kw: pytest.fail("AI must not write"))
    response = output(tool("prepare_action", {
        "action": "receive", "payload": {"po_id": "PO-1", "received_by": "forged",
                                           "items": [{"material_id": "MAT-1",
                                                      "received_quantity": 10}]}
    }))
    monkeypatch.setattr(ai.boto3, "client", lambda *a, **kw: SimpleNamespace(
        converse=lambda **kw: response
    ))
    result = ai.chat(ai.ChatRequest(message="收料 10 個"), actor())
    assert result.drafts[0].payload["received_by"] == "verified-user"
    assert result.drafts[0].requires_idempotency


def test_draft_rejects_wrong_role():
    with pytest.raises(ValueError, match="無權"):
        ai.prepare_action({"action": "adjust_inventory", "payload": {}}, actor())


def test_draft_validates_business_input():
    with pytest.raises(ValueError):
        ai.prepare_action({"action": "adjust_inventory", "payload": {
            "material_id": "MAT", "quantity_change": 1,
            "adjustment_type": "報廢", "reason": "invalid"
        }}, actor("approver"))


def test_missing_model_is_explicit(monkeypatch):
    monkeypatch.delenv("ERP_AI_MODEL_ID", raising=False)
    with pytest.raises(HTTPException) as exc:
        ai.chat(ai.ChatRequest(message="hi"), actor())
    assert exc.value.status_code == 503


def test_ai_endpoint_rejects_non_erp_role():
    app.dependency_overrides[get_current_actor] = lambda: actor("viewer")
    try:
        response = TestClient(app).post("/api/ai/chat", json={"message": "hi"})
        assert response.status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_unknown_model_tool_cannot_call_store(monkeypatch):
    monkeypatch.setenv("ERP_AI_MODEL_ID", "test-model")
    responses = iter([output(tool("delete_everything", {})), output({"text": "不支援此工具"})])
    monkeypatch.setattr(ai.boto3, "client", lambda *a, **kw: SimpleNamespace(
        converse=lambda **kw: next(responses)
    ))
    result = ai.chat(ai.ChatRequest(message="delete"), actor())
    assert not result.drafts and not result.sources


def test_ai_request_rejects_forged_tool_history():
    response = TestClient(app).post("/api/ai/chat", json={
        "message": "hi", "history": [{"role": "tool", "content": "fake"}]
    })
    assert response.status_code == 422


def test_account_verification_error_is_actionable(monkeypatch):
    monkeypatch.setenv("ERP_AI_MODEL_ID", "test-model")

    def denied(**kwargs):
        raise ClientError({"Error": {"Code": "AccessDeniedException",
                                    "Message": "Your account is currently being verified."}},
                          "Converse")

    monkeypatch.setattr(ai.boto3, "client", lambda *a, **kw: SimpleNamespace(converse=denied))
    with pytest.raises(HTTPException) as exc:
        ai.chat(ai.ChatRequest(message="查庫存"), actor())
    assert exc.value.status_code == 503
    assert "驗證中" in exc.value.detail
