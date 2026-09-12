from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from mangum import Mangum

from app.models import Finding, RemediationPlan, ScanReport, ScanRequest
from app.planner import build_remediation_plan
from app.service import run_scan

app = FastAPI(
    title="AWS FinOpsSec Governance Agent",
    version="0.1.0",
    description="Read-only AWS cost and security governance scanner with approval-gated plans.",
)

WEB_ROOT = Path(__file__).resolve().parents[1] / "web"


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_ROOT / "index.html")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "finopssec-agent"}


@app.post("/api/scans", response_model=ScanReport)
def create_scan(request: ScanRequest) -> ScanReport:
    aws_scan_enabled = os.getenv("ALLOW_AWS_SCAN", "false").lower() == "true"
    if request.mode == "aws" and not aws_scan_enabled:
        raise HTTPException(
            status_code=403,
            detail="Real AWS scans are disabled until ALLOW_AWS_SCAN=true.",
        )
    try:
        return run_scan(request.mode, request.region)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        if request.mode == "aws":
            raise HTTPException(
                status_code=502,
                detail=f"AWS inventory collection failed: {exc}",
            ) from exc
        raise


@app.post("/api/remediations/plan", response_model=RemediationPlan)
def remediation_plan(finding: Finding) -> RemediationPlan:
    return build_remediation_plan(finding)


handler = Mangum(app, lifespan="off")
