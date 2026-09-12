from __future__ import annotations

from datetime import UTC, datetime
from uuid import uuid4

from app.advisor import BedrockAdvisor
from app.inventory import AwsInventoryCollector, load_demo_inventory
from app.models import ScanReport
from app.rules import evaluate, summarize


def run_scan(mode: str, region: str) -> ScanReport:
    started_at = datetime.now(UTC)
    if mode == "demo":
        snapshot = load_demo_inventory()
        snapshot.region = region
    elif mode == "aws":
        snapshot = AwsInventoryCollector(region).collect()
    else:
        raise ValueError("mode must be 'demo' or 'aws'")

    findings = evaluate(snapshot)
    summary = summarize(findings)
    return ScanReport(
        scan_id=f"scan-{uuid4().hex[:12]}",
        mode=mode,
        account_id=snapshot.account_id,
        region=region,
        started_at=started_at,
        completed_at=datetime.now(UTC),
        summary=summary,
        findings=findings,
        collection_errors=snapshot.collection_errors,
        executive_summary=BedrockAdvisor(region).summarize(summary, findings),
    )
