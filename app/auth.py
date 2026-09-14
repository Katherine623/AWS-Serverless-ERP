from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass
from typing import Annotated, Any

from fastapi import Depends, HTTPException, Request, status

from app.config import get_settings


@dataclass(frozen=True)
class Actor:
    subject: str
    roles: frozenset[str]
    claims: dict[str, Any]


def _claims_from_event(request: Request) -> dict[str, Any]:
    for scope_key in ("aws.event", "api_gateway.event"):
        event = request.scope.get(scope_key)
        if not isinstance(event, dict):
            continue
        authorizer = event.get("requestContext", {}).get("authorizer", {})
        jwt_claims = authorizer.get("jwt", {}).get("claims", {})
        if isinstance(jwt_claims, dict) and jwt_claims:
            return jwt_claims
    return {}


def _claims_from_authorization_header(request: Request) -> dict[str, Any]:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return {}
    try:
        payload = token.split(".")[1]
        padded = payload + "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (
        IndexError,
        ValueError,
        UnicodeDecodeError,
        binascii.Error,
        json.JSONDecodeError,
    ):
        return {}
    return claims if isinstance(claims, dict) else {}


def _claim_values(claims: dict[str, Any], *keys: str) -> set[str]:
    values: set[str] = set()
    for key in keys:
        value = claims.get(key)
        if isinstance(value, list):
            values.update(
                str(item).strip().strip("[]'\"").lower()
                for item in value
                if str(item).strip()
            )
        elif isinstance(value, str):
            normalized = value.strip()
            if normalized.startswith("["):
                try:
                    parsed = json.loads(normalized)
                except json.JSONDecodeError:
                    parsed = None
                if isinstance(parsed, list):
                    values.update(
                        str(item).strip().strip("[]'\"").lower()
                        for item in parsed
                        if str(item).strip()
                    )
                    continue
            values.update(
                item.strip().strip("[]'\"").lower()
                for item in normalized.replace(",", " ").split()
                if item.strip().strip("[]'\"")
            )
    return values


def _actor_from_claims(claims: dict[str, Any]) -> Actor:
    subject = str(claims.get("sub") or claims.get("username") or "").strip()
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="JWT subject missing")
    roles = _claim_values(
        claims,
        "roles",
        "role",
        "groups",
        "cognito:groups",
        "cognito_groups",
        "custom:roles",
        "custom:role",
        "scope",
    )
    roles = {role.removeprefix("erp:") for role in roles}
    if "admin" in roles:
        roles.update({"purchaser", "warehouse", "approver"})
    return Actor(subject=subject, roles=frozenset(roles), claims=claims)


def _merge_claims(
    token_claims: dict[str, Any], event_claims: dict[str, Any]
) -> dict[str, Any]:
    token_subject = str(token_claims.get("sub") or "").strip()
    event_subject = str(event_claims.get("sub") or "").strip()
    if token_subject and event_subject and token_subject != event_subject:
        token_claims = {}
    merged = dict(token_claims)
    for key, value in event_claims.items():
        if value not in (None, "", [], {}):
            merged[key] = value
    return merged


def get_current_actor(request: Request) -> Actor:
    event_claims = _claims_from_event(request)
    token_claims = _claims_from_authorization_header(request)
    claims = _merge_claims(token_claims, event_claims)
    if claims:
        return _actor_from_claims(claims)

    settings = get_settings()
    if settings.environment in {"local", "test"}:
        subject = request.headers.get("X-Demo-Actor", "local-user").strip() or "local-user"
        roles = _claim_values(
            {
                "roles": request.headers.get(
                    "X-Demo-Roles", "warehouse,purchaser,approver"
                )
            },
            "roles",
        )
        return Actor(subject=subject, roles=frozenset(roles), claims={"sub": subject})
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Bearer JWT required",
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_roles(*required_roles: str):
    normalized = {role.strip().lower() for role in required_roles}

    def dependency(actor: Annotated[Actor, Depends(get_current_actor)]) -> Actor:
        if not normalized.intersection(actor.roles):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Required ERP role: {', '.join(sorted(normalized))}",
            )
        return actor

    return dependency
