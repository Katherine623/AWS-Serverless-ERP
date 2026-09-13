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
