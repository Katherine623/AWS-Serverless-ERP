from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from mangum import Mangum

from app.erp import (
    DashboardSummary,
    InventoryItem,
    PurchaseOrder,
    ReceiptRequest,
    ReceiptResult,
    store,
)

app = FastAPI(
    title="AWS Serverless ERP Receiving Platform",
    version="0.1.0",
    description="Serverless purchase, receiving and inventory workflow for ERP operations.",
)

WEB_ROOT = Path(__file__).resolve().parents[1] / "web"


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "erp-receiving-platform"}


@app.get("/api/dashboard", response_model=DashboardSummary)
def dashboard() -> DashboardSummary:
    return store.dashboard()


@app.get("/api/purchase-orders", response_model=list[PurchaseOrder])
def purchase_orders() -> list[PurchaseOrder]:
    return store.list_purchase_orders()


@app.post("/api/purchase-orders", response_model=PurchaseOrder, status_code=201)
def create_purchase_order(order: PurchaseOrder) -> PurchaseOrder:
    try:
        return store.create_purchase_order(order)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@app.post("/api/receipts", response_model=ReceiptResult, status_code=201)
def receive_purchase_order(request: ReceiptRequest) -> ReceiptResult:
    try:
        return store.receive(request)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.get("/api/inventory", response_model=list[InventoryItem])
def inventory() -> list[InventoryItem]:
    return store.list_inventory()


handler = Mangum(app, lifespan="off")
