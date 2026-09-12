from __future__ import annotations

import json

from mcp.server.fastmcp import FastMCP

from app.models import Finding
from app.planner import build_remediation_plan
from app.service import run_scan

mcp = FastMCP("AWS FinOpsSec Governance Agent")


@mcp.tool()
def scan_aws_governance(mode: str = "demo", region: str = "ap-northeast-1") -> str:
    """Run a read-only AWS cost and security scan; use demo mode without AWS credentials."""
    report = run_scan(mode=mode, region=region)
    return report.model_dump_json(indent=2)


@mcp.tool()
def propose_remediation(finding_json: str) -> str:
    """Create a non-executing, approval-required remediation plan for one finding."""
    finding = Finding.model_validate(json.loads(finding_json))
    return build_remediation_plan(finding).model_dump_json(indent=2)


if __name__ == "__main__":
    mcp.run(transport="stdio")
