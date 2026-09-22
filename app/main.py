from __future__ import annotations

import logging
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from mangum import Mangum

from app.ai import ChatRequest, ChatResponse, chat, model_id
from app.ai_actions import cancel_action, execute_action
from app.auth import Actor, require_roles
from app.config import get_settings
from app.erp import (
    CreatePurchaseOrderRequest,
    DashboardSummary,
    ExcelUploadRequest,
    ExcelUploadResponse,
    InventoryAdjustmentRequest,
    InventoryAdjustmentResult,
    InventoryItem,
    InventoryNotFoundError,
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
from app.imports import UPLOAD_URL_TTL_SECONDS, create_excel_upload_url
from app.repository import IdempotencyConflictError

app = FastAPI(
    title="AWS Serverless ERP Receiving Platform",
    version="0.1.0",
    description="Serverless purchase, receiving and inventory workflow for ERP operations.",
)

WEB_ROOT = Path(__file__).resolve().parents[1] / "web"
ASSET_MEDIA_TYPES = {".mjs": "text/javascript", ".css": "text/css"}
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
logger = logging.getLogger(__name__)
ERP_READ_ROLES = ("admin", "approver", "purchaser", "warehouse")


@app.get("/api/ai/config")
def ai_config(actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))]) -> dict:
    return {"enabled": bool(model_id()), "provider": "Amazon Bedrock"}


@app.post("/api/ai/chat", response_model=ChatResponse)
def ai_chat(
    request: ChatRequest,
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> ChatResponse:
    return chat(request, actor)


@app.get("/api/ai/actions")
def ai_actions(actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))]) -> list[dict]:
    return store.repository.list_records("ai_action", actor.subject)


@app.post("/api/ai/actions/{identifier}/confirm")
def confirm_ai_action(
    identifier: str, actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> dict:
    return execute_action(identifier, actor)


@app.post("/api/ai/actions/{identifier}/cancel")
def cancel_ai_action(
    identifier: str, actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> dict:
    return cancel_action(identifier, actor)


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
    return FileResponse(WEB_ROOT / "index.html", headers={"Cache-Control": "no-store"})


@app.get("/assets/{name}", include_in_schema=False)
def frontend_asset(name: str) -> FileResponse:
    media_type = ASSET_MEDIA_TYPES.get(Path(name).suffix)
    target = (WEB_ROOT / name).resolve()
    if media_type is None or target.parent != WEB_ROOT or not target.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(target, media_type=media_type, headers={"Cache-Control": "no-cache"})


@app.get("/purchase-order-template.xlsx", include_in_schema=False)
def purchase_order_template() -> FileResponse:
    return FileResponse(
        WEB_ROOT / "purchase-order-template.xlsx",
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="purchase-order-template.xlsx",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    return Response(status_code=204)


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


@app.get("/auth/config")
def auth_config(request: Request) -> dict[str, str | bool]:
    settings = get_settings()
    public_base_url = (settings.public_base_url or str(request.base_url)).rstrip("/")
    if not settings.cognito_client_id or not settings.cognito_domain:
        return {"enabled": False, "redirect_uri": f"{public_base_url}/"}
    domain = settings.cognito_domain.rstrip("/")
    return {
        "enabled": True,
        "client_id": settings.cognito_client_id,
        "authorize_url": f"{domain}/oauth2/authorize",
        "token_url": f"{domain}/oauth2/token",
        "logout_url": f"{domain}/logout",
        "redirect_uri": f"{public_base_url}/",
    }


@app.get("/api/dashboard", response_model=DashboardSummary)
def dashboard(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> DashboardSummary:
    del actor
    return store.dashboard()


@app.get("/api/purchase-orders", response_model=list[PurchaseOrder])
def purchase_orders(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> list[PurchaseOrder]:
    del actor
    return store.list_purchase_orders()


@app.get("/api/v2/purchase-orders", response_model=PurchaseOrderPage)
def purchase_orders_page(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=1024),
    status: str | None = Query(
        default=None,
        max_length=20,
        pattern="^(待驗收|待處理異常|待補貨|已完成|差異結案)$",
    ),
    supplier_name: str | None = Query(default=None, max_length=160),
) -> PurchaseOrderPage:
    del actor
    try:
        return store.list_purchase_orders_page(
            limit,
            cursor,
            status=status,
            supplier_name=supplier_name,
        )
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


@app.post("/api/inventory-adjustments", response_model=InventoryAdjustmentResult, status_code=201)
def adjust_inventory(
    request: InventoryAdjustmentRequest,
    actor: Annotated[Actor, Depends(require_roles("approver", "admin"))],
    idempotency_key: str = Header(min_length=8, max_length=128, alias="Idempotency-Key"),
) -> InventoryAdjustmentResult:
    try:
        return store.adjust_inventory(
            request.model_copy(update={"performed_by": actor.subject}),
            idempotency_key,
        )
    except IdempotencyConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InventoryNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _with_timeout_status(job: dict) -> dict:
    if job.get("status") == "awaiting_upload":
        # The presigned URL is already dead, so this job can never move on by itself.
        try:
            age = (datetime.now(UTC) - datetime.fromisoformat(job["created_at"])).total_seconds()
        except (KeyError, TypeError, ValueError):
            return job
        if age <= UPLOAD_URL_TTL_SECONDS:
            return job
        return {
            **job,
            "status": "upload_expired",
            "errors": job.get("errors")
            or [{"message": "檔案未在 15 分鐘內送達，請重新上傳。"}],
        }
    # A timed-out Lambda is killed before it can record its own failure, so an
    # expired lease is the only evidence the worker died mid-import.
    if job.get("status") != "processing" or job.get("lease_until", 0) > time.time():
        return job
    return {
        **job,
        "status": "timed_out",
        "errors": job.get("errors")
        or [{"message": "檔案過大，處理超過 240 秒上限，請拆成較小的檔案。"}],
    }


@app.post("/api/imports/excel/upload-url", response_model=ExcelUploadResponse)
def create_excel_upload(
    request: ExcelUploadRequest,
    actor: Annotated[Actor, Depends(require_roles("purchaser", "admin"))],
) -> ExcelUploadResponse:
    try:
        object_key, upload_url, expires_in = create_excel_upload_url(request.file_name)
        job_id = object_key.rsplit("/", 1)[-1].split("-", 1)[0]
        store.repository.save_record("import", {
            "id": job_id, "owner": actor.subject, "file_name": request.file_name,
            "object_key": object_key, "status": "awaiting_upload",
            "created_at": datetime.now(UTC).isoformat(),
            "imported": 0, "skipped": 0, "failed": 0, "errors": [],
        })
        return ExcelUploadResponse(
            object_key=object_key,
            upload_url=upload_url,
            expires_in=expires_in,
            job_id=job_id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.get("/api/imports/excel/jobs")
def import_jobs(
    actor: Annotated[Actor, Depends(require_roles("purchaser", "admin"))],
) -> list[dict]:
    return [
        _with_timeout_status(job)
        for job in store.repository.list_records("import", actor.subject)
    ]


@app.get("/api/imports/excel/jobs/{job_id}")
def import_job(
    job_id: str,
    actor: Annotated[Actor, Depends(require_roles("purchaser", "admin"))],
) -> dict:
    job = store.repository.get_record("import", job_id)
    if not job or job.get("owner") != actor.subject:
        raise HTTPException(status_code=404, detail="找不到匯入工作")
    return _with_timeout_status(job)


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
def inventory(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> list[InventoryItem]:
    del actor
    return store.list_inventory()


@app.get("/api/v2/inventory", response_model=InventoryPage)
def inventory_page(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=1024),
    material_id: str | None = Query(default=None, max_length=80),
    low_stock: bool = Query(default=False),
) -> InventoryPage:
    del actor
    try:
        return store.list_inventory_page(
            limit,
            cursor,
            material_id=material_id,
            low_stock=low_stock,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/inventory-transactions", response_model=list[InventoryTransaction])
def inventory_transactions(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
) -> list[InventoryTransaction]:
    del actor
    return store.list_inventory_transactions()


@app.get("/api/v2/inventory-transactions", response_model=InventoryTransactionPage)
def inventory_transactions_page(
    actor: Annotated[Actor, Depends(require_roles(*ERP_READ_ROLES))],
    limit: int = Query(default=50, ge=1, le=200),
    cursor: str | None = Query(default=None, max_length=1024),
    material_id: str | None = Query(default=None, max_length=80),
    transaction_type: str | None = Query(
        default=None,
        max_length=20,
        pattern="^(收料|差異允收|盤點調整|退貨|報廢)$",
    ),
) -> InventoryTransactionPage:
    del actor
    try:
        return store.list_inventory_transactions_page(
            limit,
            cursor,
            material_id=material_id,
            transaction_type=transaction_type,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


handler = Mangum(app, lifespan="off")
