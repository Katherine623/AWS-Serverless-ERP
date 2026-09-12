from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, Field


class Severity(StrEnum):
    CRITICAL = "critical"
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class Category(StrEnum):
    SECURITY = "security"
    COST = "cost"
    GOVERNANCE = "governance"


class InventorySnapshot(BaseModel):
    account_id: str = "unknown"
    region: str = "ap-northeast-1"
    collected_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    security_groups: list[dict[str, Any]] = Field(default_factory=list)
    addresses: list[dict[str, Any]] = Field(default_factory=list)
    volumes: list[dict[str, Any]] = Field(default_factory=list)
    log_groups: list[dict[str, Any]] = Field(default_factory=list)
    buckets: list[dict[str, Any]] = Field(default_factory=list)
    iam_policies: list[dict[str, Any]] = Field(default_factory=list)
    collection_errors: list[str] = Field(default_factory=list)


class Finding(BaseModel):
    id: str
    rule_id: str
    severity: Severity
    category: Category
    resource_type: str
    resource_id: str
    region: str
    title: str
    description: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    recommendation: str
    estimated_monthly_savings_usd: float = 0.0
    auto_remediation_supported: bool = False


class ScanSummary(BaseModel):
    governance_score: int
    total_findings: int
    by_severity: dict[str, int]
    estimated_monthly_savings_usd: float


class ScanReport(BaseModel):
    scan_id: str
    mode: str
    account_id: str
    region: str
    started_at: datetime
    completed_at: datetime
    summary: ScanSummary
    findings: list[Finding]
    collection_errors: list[str] = Field(default_factory=list)
    executive_summary: str = ""


class ScanRequest(BaseModel):
    mode: str = Field(default="demo", pattern="^(demo|aws)$")
    region: str = "ap-northeast-1"


class KnowledgeReference(BaseModel):
    source: str
    title: str
    score: float
    excerpt: str


class RemediationPlan(BaseModel):
    finding_id: str
    rule_id: str
    action: str
    summary: str
    parameters: dict[str, Any]
    verification_steps: list[str]
    references: list[KnowledgeReference] = Field(default_factory=list)
    requires_approval: bool = True
    execution_enabled: bool = False
