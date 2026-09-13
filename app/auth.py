from __future__ import annotations

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


def _claim_values(claims: dict[str, Any], *keys: str) -> set[str]:
    values: set[str] = set()
    for key in keys:
        value = claims.get(key)
        if isinstance(value, list):
            values.update(str(item).strip().lower() for item in value if str(item).strip())
        elif isinstance(value, str):
            normalized = value.strip()
            if normalized.startswith("["):
                try:
                    parsed = json.loads(normalized)
                except json.JSONDecodeError:
                    parsed = []
                if isinstance(parsed, list):
                    values.update(str(item).strip().lower() for item in parsed if str(item).strip())
                    continue
            values.update(item.strip().lower() for item in normalized.replace(",", " ").split())
    return values


def _actor_from_claims(claims: dict[str, Any]) -> Actor:
    subject = str(claims.get("sub") or claims.get("username") or "").strip()
    if not subject:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="JWT subject missing")
    roles = _claim_values(claims, "roles", "role", "cognito:groups", "scope")
    roles = {role.removeprefix("erp:") for role in roles}
    if "admin" in roles:
        roles.update({"purchaser", "warehouse", "approver"})
    return Actor(subject=subject, roles=frozenset(roles), claims=claims)


def get_current_actor(request: Request) -> Actor:
    claims = _claims_from_event(request)
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
