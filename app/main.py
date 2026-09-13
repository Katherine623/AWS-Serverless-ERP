from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from mangum import Mangum

from app.auth import Actor, get_current_actor, require_roles
from app.erp import (
    CreatePurchaseOrderRequest,
    DashboardSummary,
    InventoryItem,
    InventoryPage,
    InventoryTransaction,
    InventoryTransactionPage,
    PurchaseOrder,
    PurchaseOrderNotFoundError,
    PurchaseOrderPage,
    ReceiptRequest,
    ReceiptResult,
    ResolveExceptionRequest,
    store,
)
from app.repository import IdempotencyConflictError

app = FastAPI(
    title="AWS Serverless ERP Receiving Platform",
    version="0.1.0",
    description="Serverless purchase, receiving and inventory workflow for ERP operations.",
)

WEB_ROOT = Path(__file__).resolve().parents[1] / "web"
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
logger = logging.getLogger(__name__)


@app.middleware("http")
async def add_request_id(request: Request, call_next):
    candidate = request.headers.get("X-Request-Id", "")
    request_id = (
        candidate
        if REQUEST_ID_PATTERN.fullmatch(candidate)
        else f"req-{uuid4().hex}"
    )
    request.state.request_id = request_id
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


@app.exception_handler(Exception)
async def handle_unexpected_error(request: Request, exc: Exception) -> JSONResponse:
    request_id = getattr(request.state, "request_id", f"req-{uuid4().hex}")
    logger.exception(
        "Unhandled ERP request failure", extra={"request_id": request_id}, exc_info=exc
    )
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": request_id},
        headers={"X-Request-Id": request_id},
    )


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "erp-receiving-platform"}


@app.get("/ready")
def readiness() -> dict[str, str]:
    try:
        store.repository.list_inventory()
    except Exception as exc:
        logger.exception("ERP repository readiness check failed")
        raise HTTPException(status_code=503, detail="ERP repository unavailable") from exc
    return {"status": "ready", "service": "erp-receiving-platform"}


@app.get("/api/dashboard", response_model=DashboardSummary)
def dashboard(actor: Annotated[Actor, Depends(get_current_actor)]) -> DashboardSummary:
    del actor
    return store.dashboard()


@app.get("/api/purchase-orders", response_model=list[PurchaseOrder])
def purchase_orders(actor: Annotated[Actor, Depends(get_current_actor)]) -> list[PurchaseOrder]:
    del actor
    return store.list_purchase_orders()


@app.get("/api/v2/purchase-orders", response_model=PurchaseOrderPage)
def purchase_orders_page(
    actor: Annotated[Actor, Depends(get_current_actor)],
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=1024),
) -> PurchaseOrderPage:
    del actor
    try:
        return store.list_purchase_orders_page(limit, cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/purchase-orders", response_model=PurchaseOrder, status_code=201)
def create_purchase_order(
    request: CreatePurchaseOrderRequest,
    actor: Annotated[Actor, Depends(require_roles("purchaser", "admin"))],
) -> PurchaseOrder:
    del actor
    try:
        return store.create_purchase_order(request)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/receipts", response_model=ReceiptResult, status_code=201)
def receive_purchase_order(
    request: ReceiptRequest,
    actor: Annotated[Actor, Depends(require_roles("warehouse", "admin"))],
    idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key"),
) -> ReceiptResult:
    try:
        return store.receive(
            request.model_copy(update={"received_by": actor.subject}),
            idempotency_key=idempotency_key,
        )
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PurchaseOrderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/purchase-orders/{po_id}/exception-resolution", response_model=PurchaseOrder)
def resolve_purchase_order_exception(
    po_id: str,
    request: ResolveExceptionRequest,
    actor: Annotated[Actor, Depends(require_roles("approver", "admin"))],
) -> PurchaseOrder:
    try:
        return store.resolve_exception(
            po_id,
            request.model_copy(update={"resolved_by": actor.subject}),
        )
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PurchaseOrderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/inventory", response_model=list[InventoryItem])
def inventory(actor: Annotated[Actor, Depends(get_current_actor)]) -> list[InventoryItem]:
    del actor
    return store.list_inventory()


@app.get("/api/v2/inventory", response_model=InventoryPage)
def inventory_page(
    actor: Annotated[Actor, Depends(get_current_actor)],
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=1024),
) -> InventoryPage:
    del actor
    try:
        return store.list_inventory_page(limit, cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/inventory-transactions", response_model=list[InventoryTransaction])
def inventory_transactions(
    actor: Annotated[Actor, Depends(get_current_actor)],
) -> list[InventoryTransaction]:
    del actor
    return store.list_inventory_transactions()


@app.get("/api/v2/inventory-transactions", response_model=InventoryTransactionPage)
def inventory_transactions_page(
    actor: Annotated[Actor, Depends(get_current_actor)],
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=1024),
) -> InventoryTransactionPage:
    del actor
    try:
        return store.list_inventory_transactions_page(limit, cursor)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


handler = Mangum(app, lifespan="off")
