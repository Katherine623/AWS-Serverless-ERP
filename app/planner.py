from __future__ import annotations

from app.models import Finding, RemediationPlan
from app.rag import default_knowledge_base


def build_remediation_plan(finding: Finding) -> RemediationPlan:
    plans = {
        "SEC-SG-001": (
            "restrict_security_group_ingress",
            "移除公開的敏感連接埠規則，改成核准的 CIDR 或 Session Manager。",
            {
                "group_id": finding.resource_id,
                "ports": finding.evidence.get("ports", []),
                "public_cidrs": finding.evidence.get("public_cidrs", []),
            },
            ["重新執行 Security Group 掃描", "確認合法管理來源仍可連線"],
        ),
        "COST-EIP-001": (
            "release_unattached_eip",
            "在確認 DNS、白名單與復原需求後釋放未使用的 Elastic IP。",
            {
                "allocation_id": finding.resource_id,
                "public_ip": finding.evidence.get("public_ip"),
            },
            ["確認 Allocation ID 已不存在", "重新計算公有 IPv4 數量"],
        ),
        "GOV-LOG-001": (
            "set_log_retention",
            "將 CloudWatch Log Group 保存期限設定為 30 天。",
            {"log_group_name": finding.resource_id, "retention_days": 30},
            ["讀取 Log Group retentionInDays", "確認既有日誌仍可查詢"],
        ),
        "SEC-S3-001": (
            "enable_s3_public_access_block",
            "啟用 Bucket 的四項 S3 Block Public Access 控制。",
            {"bucket": finding.resource_id, "enable_all_controls": True},
            ["讀取 PublicAccessBlockConfiguration", "確認預期物件仍可由授權角色存取"],
        ),
    }
    action, summary, parameters, verification = plans.get(
        finding.rule_id,
        (
            "manual_review",
            "此問題需要人工檢視，目前不提供自動執行。",
            {"resource_id": finding.resource_id},
            ["依建議完成變更", "重新執行治理掃描"],
        ),
    )
    return RemediationPlan(
        finding_id=finding.id,
        rule_id=finding.rule_id,
        action=action,
        summary=summary,
        parameters=parameters,
        verification_steps=verification,
        references=default_knowledge_base().retrieve(
            " ".join(
                [
                    finding.rule_id,
                    finding.title,
                    finding.description,
                    finding.recommendation,
                ]
            )
        ),
    )
