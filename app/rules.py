from __future__ import annotations

import hashlib
from collections.abc import Iterable
from typing import Any

from app.models import Category, Finding, InventorySnapshot, ScanSummary, Severity

SENSITIVE_PORTS = {22, 3389, 3306, 5432, 6379, 27017}
SEVERITY_DEDUCTIONS = {
    Severity.CRITICAL: 25,
    Severity.HIGH: 15,
    Severity.MEDIUM: 7,
    Severity.LOW: 2,
}


def _finding_id(rule_id: str, resource_id: str) -> str:
    digest = hashlib.sha256(f"{rule_id}:{resource_id}".encode()).hexdigest()[:12]
    return f"fnd-{digest}"


def _finding(
    *,
    rule_id: str,
    severity: Severity,
    category: Category,
    resource_type: str,
    resource_id: str,
    region: str,
    title: str,
    description: str,
    evidence: dict[str, Any],
    recommendation: str,
    savings: float = 0.0,
    auto_remediation_supported: bool = False,
) -> Finding:
    return Finding(
        id=_finding_id(rule_id, resource_id),
        rule_id=rule_id,
        severity=severity,
        category=category,
        resource_type=resource_type,
        resource_id=resource_id,
        region=region,
        title=title,
        description=description,
        evidence=evidence,
        recommendation=recommendation,
        estimated_monthly_savings_usd=savings,
        auto_remediation_supported=auto_remediation_supported,
    )


def _public_cidrs(permission: dict[str, Any]) -> list[str]:
    cidrs = [
        item.get("CidrIp", "")
        for item in permission.get("IpRanges", [])
        if item.get("CidrIp") == "0.0.0.0/0"
    ]
    cidrs.extend(
        item.get("CidrIpv6", "")
        for item in permission.get("Ipv6Ranges", [])
        if item.get("CidrIpv6") == "::/0"
    )
    return cidrs


def _exposed_sensitive_ports(permission: dict[str, Any]) -> list[int | str]:
    if permission.get("IpProtocol") == "-1":
        return ["all"]
    start = permission.get("FromPort")
    end = permission.get("ToPort")
    if start is None or end is None:
        return []
    return sorted(port for port in SENSITIVE_PORTS if start <= port <= end)


def check_security_groups(snapshot: InventorySnapshot) -> list[Finding]:
    findings: list[Finding] = []
    for group in snapshot.security_groups:
        for permission in group.get("IpPermissions", []):
            cidrs = _public_cidrs(permission)
            exposed_ports = _exposed_sensitive_ports(permission)
            if not cidrs or not exposed_ports:
                continue
            group_id = group.get("GroupId", group.get("GroupName", "unknown"))
            findings.append(
                _finding(
                    rule_id="SEC-SG-001",
                    severity=(Severity.CRITICAL if "all" in exposed_ports else Severity.HIGH),
                    category=Category.SECURITY,
                    resource_type="AWS::EC2::SecurityGroup",
                    resource_id=group_id,
                    region=snapshot.region,
                    title="敏感連接埠對全網際網路開放",
                    description=(
                        f"Security Group {group_id} 將敏感連接埠 {exposed_ports} 開放給 {cidrs}。"
                    ),
                    evidence={
                        "group_name": group.get("GroupName"),
                        "public_cidrs": cidrs,
                        "ports": exposed_ports,
                        "protocol": permission.get("IpProtocol"),
                    },
                    recommendation=(
                        "限制來源 CIDR，或改用 Systems Manager Session Manager 管理主機。"
                    ),
                    auto_remediation_supported=True,
                )
            )
    return findings


def check_unattached_addresses(snapshot: InventorySnapshot) -> list[Finding]:
    findings: list[Finding] = []
    for address in snapshot.addresses:
        if address.get("AssociationId") or address.get("InstanceId"):
            continue
        resource_id = address.get("AllocationId", address.get("PublicIp", "unknown"))
        findings.append(
            _finding(
                rule_id="COST-EIP-001",
                severity=Severity.MEDIUM,
                category=Category.COST,
                resource_type="AWS::EC2::EIP",
                resource_id=resource_id,
                region=snapshot.region,
                title="Elastic IP 未附加到任何資源",
                description=f"{resource_id} 目前未被使用，但仍可能持續產生 IPv4 費用。",
                evidence={"public_ip": address.get("PublicIp")},
                recommendation="確認沒有 DNS 或白名單依賴後，經人工核准再釋放該位址。",
                savings=3.65,
                auto_remediation_supported=True,
            )
        )
    return findings


def check_unattached_volumes(snapshot: InventorySnapshot) -> list[Finding]:
    findings: list[Finding] = []
    for volume in snapshot.volumes:
        if volume.get("State") != "available":
            continue
        resource_id = volume.get("VolumeId", "unknown")
        size_gib = int(volume.get("Size", 0))
        findings.append(
            _finding(
                rule_id="COST-EBS-001",
                severity=Severity.MEDIUM,
                category=Category.COST,
                resource_type="AWS::EC2::Volume",
                resource_id=resource_id,
                region=snapshot.region,
                title="EBS 磁碟未附加",
                description=f"{resource_id} ({size_gib} GiB) 處於 available 狀態。",
                evidence={
                    "size_gib": size_gib,
                    "volume_type": volume.get("VolumeType"),
                    "encrypted": volume.get("Encrypted"),
                    "estimate_assumption": "US$0.08/GiB-month baseline; region price may differ",
                },
                recommendation="先建立快照並確認無人使用，再經人工核准刪除磁碟。",
                savings=round(size_gib * 0.08, 2),
                auto_remediation_supported=False,
            )
        )
    return findings


def check_log_retention(snapshot: InventorySnapshot) -> list[Finding]:
    findings: list[Finding] = []
    for log_group in snapshot.log_groups:
        if log_group.get("retentionInDays") is not None:
            continue
        resource_id = log_group.get("logGroupName", "unknown")
        findings.append(
            _finding(
                rule_id="GOV-LOG-001",
                severity=Severity.MEDIUM,
                category=Category.GOVERNANCE,
                resource_type="AWS::Logs::LogGroup",
                resource_id=resource_id,
                region=snapshot.region,
                title="CloudWatch Logs 未設定保存期限",
                description=f"{resource_id} 的日誌會永久保留並持續累積儲存費用。",
                evidence={"stored_bytes": log_group.get("storedBytes", 0)},
                recommendation="依資料需求設定 14、30 或 90 天保存期限。",
                auto_remediation_supported=True,
            )
        )
    return findings


def check_s3_public_access_block(snapshot: InventorySnapshot) -> list[Finding]:
    required = {
        "BlockPublicAcls",
        "IgnorePublicAcls",
        "BlockPublicPolicy",
        "RestrictPublicBuckets",
    }
    findings: list[Finding] = []
    for bucket in snapshot.buckets:
        config = bucket.get("PublicAccessBlock", {})
        disabled = sorted(key for key in required if config.get(key) is not True)
        if not disabled:
            continue
        resource_id = bucket.get("Name", "unknown")
        findings.append(
            _finding(
                rule_id="SEC-S3-001",
                severity=Severity.HIGH,
                category=Category.SECURITY,
                resource_type="AWS::S3::Bucket",
                resource_id=resource_id,
                region=bucket.get("Region", snapshot.region),
                title="S3 Block Public Access 保護不完整",
                description=(f"Bucket {resource_id} 有 {len(disabled)} 個公開存取保護設定未啟用。"),
                evidence={"disabled_controls": disabled},
                recommendation="確認網站託管需求後，啟用四項 S3 Block Public Access 控制。",
                auto_remediation_supported=True,
            )
        )
    return findings


def _as_list(value: str | list[str] | None) -> list[str]:
    if value is None:
        return []
    return [value] if isinstance(value, str) else value


def _statements(document: dict[str, Any]) -> Iterable[dict[str, Any]]:
    statement = document.get("Statement", [])
    if isinstance(statement, dict):
        return [statement]
    return statement


def check_iam_wildcards(snapshot: InventorySnapshot) -> list[Finding]:
    findings: list[Finding] = []
    for policy in snapshot.iam_policies:
        dangerous: list[dict[str, Any]] = []
        for statement in _statements(policy.get("Document", {})):
            actions = _as_list(statement.get("Action"))
            resources = _as_list(statement.get("Resource"))
            if statement.get("Effect") == "Allow" and "*" in actions and "*" in resources:
                dangerous.append(statement)
        if not dangerous:
            continue
        resource_id = policy.get("Arn", policy.get("PolicyName", "unknown"))
        findings.append(
            _finding(
                rule_id="SEC-IAM-001",
                severity=Severity.CRITICAL,
                category=Category.SECURITY,
                resource_type="AWS::IAM::ManagedPolicy",
                resource_id=resource_id,
                region="global",
                title="客戶管理 IAM Policy 允許完整管理權限",
                description=(
                    f"Policy {policy.get('PolicyName', resource_id)} 同時允許 "
                    "Action:* 與 Resource:*。"
                ),
                evidence={"dangerous_statement_count": len(dangerous)},
                recommendation="依實際 API 與資源 ARN 拆分最小權限 Policy。",
                auto_remediation_supported=False,
            )
        )
    return findings


CHECKS = (
    check_security_groups,
    check_unattached_addresses,
    check_unattached_volumes,
    check_log_retention,
    check_s3_public_access_block,
    check_iam_wildcards,
)


def evaluate(snapshot: InventorySnapshot) -> list[Finding]:
    findings = [finding for check in CHECKS for finding in check(snapshot)]
    return sorted(
        findings,
        key=lambda finding: (
            -SEVERITY_DEDUCTIONS[finding.severity],
            finding.rule_id,
            finding.resource_id,
        ),
    )


def summarize(findings: list[Finding]) -> ScanSummary:
    counts = {severity.value: 0 for severity in Severity}
    deduction = 0
    for finding in findings:
        counts[finding.severity.value] += 1
        deduction += SEVERITY_DEDUCTIONS[finding.severity]
    return ScanSummary(
        governance_score=max(0, 100 - deduction),
        total_findings=len(findings),
        by_severity=counts,
        estimated_monthly_savings_usd=round(
            sum(item.estimated_monthly_savings_usd for item in findings), 2
        ),
    )
