from __future__ import annotations

import logging
import re
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse
from mangum import Mangum

from app.erp import (
    CreatePurchaseOrderRequest,
    DashboardSummary,
    InventoryItem,
    InventoryTransaction,
    PurchaseOrder,
    PurchaseOrderNotFoundError,
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
    response = await call_next(request)
    response.headers["X-Request-Id"] = request_id
    return response


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
def dashboard() -> DashboardSummary:
    return store.dashboard()


@app.get("/api/purchase-orders", response_model=list[PurchaseOrder])
def purchase_orders() -> list[PurchaseOrder]:
    return store.list_purchase_orders()


@app.post("/api/purchase-orders", response_model=PurchaseOrder, status_code=201)
def create_purchase_order(request: CreatePurchaseOrderRequest) -> PurchaseOrder:
    try:
        return store.create_purchase_order(request)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/receipts", response_model=ReceiptResult, status_code=201)
def receive_purchase_order(
    request: ReceiptRequest,
    idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key"),
) -> ReceiptResult:
    try:
        return store.receive(request, idempotency_key=idempotency_key)
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PurchaseOrderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/api/purchase-orders/{po_id}/exception-resolution", response_model=PurchaseOrder)
def resolve_purchase_order_exception(
    po_id: str, request: ResolveExceptionRequest
) -> PurchaseOrder:
    try:
        return store.resolve_exception(po_id, request)
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except PurchaseOrderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.get("/api/inventory", response_model=list[InventoryItem])
def inventory() -> list[InventoryItem]:
    return store.list_inventory()


@app.get("/api/inventory-transactions", response_model=list[InventoryTransaction])
def inventory_transactions() -> list[InventoryTransaction]:
    return store.list_inventory_transactions()


handler = Mangum(app, lifespan="off")
