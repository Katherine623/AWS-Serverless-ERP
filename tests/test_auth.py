import pytest
from fastapi import HTTPException
from starlette.requests import Request

from app.auth import get_current_actor, require_roles


def make_request(
    *, event: dict | None = None, headers: list[tuple[bytes, bytes]] | None = None
) -> Request:
    scope = {"type": "http", "headers": headers or []}
    if event is not None:
        scope["aws.event"] = event
    return Request(scope)


def test_local_actor_has_demo_roles() -> None:
    actor = get_current_actor(make_request())

    assert actor.subject == "local-user"
    assert {"warehouse", "purchaser", "approver"}.issubset(actor.roles)


def test_jwt_claims_produce_actor_and_roles() -> None:
    actor = get_current_actor(
        make_request(
            event={
                "requestContext": {
                    "authorizer": {
                        "jwt": {
                            "claims": {
                                "sub": "user-123",
                                "cognito:groups": "warehouse approver",
                            }
                        }
                    }
                }
            }
        )
    )

    assert actor.subject == "user-123"
    assert actor.roles == {"warehouse", "approver"}


def test_required_role_rejects_actor_without_permission() -> None:
    dependency = require_roles("approver")

    with pytest.raises(HTTPException) as error:
        dependency(get_current_actor(make_request(headers=[(b"x-demo-roles", b"warehouse")])))

    assert error.value.status_code == 403


def test_jwt_header_groups_are_kept_when_gateway_omits_custom_claim() -> None:
    import base64
    import json

    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "sub": "user-456",
                "cognito:groups": ["admin"],
            }
        ).encode()
    ).decode().rstrip("=")
    token = f"header.{payload}.signature"
    actor = get_current_actor(
        make_request(
            event={
                "requestContext": {
                    "authorizer": {
                        "jwt": {
                            "claims": {
                                "sub": "user-456",
                                "cognito:groups": "",
                            }
                        }
                    }
                }
            },
            headers=[(b"authorization", f"Bearer {token}".encode())],
        )
    )

    assert {"admin", "purchaser", "warehouse", "approver"}.issubset(actor.roles)


def test_admin_role_is_normalized_from_gateway_groups_claim() -> None:
    actor = get_current_actor(
        make_request(
            event={
                "requestContext": {
                    "authorizer": {
                        "jwt": {
                            "claims": {
                                "sub": "user-789",
                                "groups": "[admin]",
                            }
                        }
                    }
                }
            }
        )
    )

    assert {"admin", "purchaser", "warehouse", "approver"}.issubset(actor.roles)


def test_jwt_header_is_used_when_gateway_claims_are_unavailable() -> None:
    import base64
    import json

    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "user-999", "groups": "admin"}).encode()
    ).decode().rstrip("=")
    token = f"header.{payload}.signature"
    actor = get_current_actor(
        make_request(headers=[(b"authorization", f"Bearer {token}".encode())])
    )

    assert actor.subject == "user-999"
    assert {"admin", "purchaser"}.issubset(actor.roles)


def test_gateway_subject_wins_over_mismatched_header_claims() -> None:
    import base64
    import json

    payload = base64.urlsafe_b64encode(
        json.dumps({"sub": "different-user", "groups": "admin"}).encode()
    ).decode().rstrip("=")
    token = f"header.{payload}.signature"
    actor = get_current_actor(
        make_request(
            event={
                "requestContext": {
                    "authorizer": {
                        "jwt": {"claims": {"sub": "verified-user", "groups": "warehouse"}}
                    }
                }
            },
            headers=[(b"authorization", f"Bearer {token}".encode())],
        )
    )

    assert actor.subject == "verified-user"
    assert actor.roles == {"warehouse"}
