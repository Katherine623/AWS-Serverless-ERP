from app.inventory import load_demo_inventory
from app.planner import build_remediation_plan
from app.rules import evaluate, summarize


def test_demo_inventory_produces_expected_findings() -> None:
    findings = evaluate(load_demo_inventory())

    assert len(findings) == 6
    assert {finding.rule_id for finding in findings} == {
        "SEC-SG-001",
        "COST-EIP-001",
        "COST-EBS-001",
        "GOV-LOG-001",
        "SEC-S3-001",
        "SEC-IAM-001",
    }


def test_https_public_ingress_is_not_reported_as_sensitive() -> None:
    findings = evaluate(load_demo_inventory())

    security_group_findings = [item for item in findings if item.rule_id == "SEC-SG-001"]
    assert len(security_group_findings) == 1
    assert security_group_findings[0].resource_id == "sg-0123456789demo001"


def test_summary_is_deterministic() -> None:
    summary = summarize(evaluate(load_demo_inventory()))

    assert summary.governance_score == 24
    assert summary.by_severity == {"critical": 1, "high": 2, "medium": 3, "low": 0}
    assert summary.estimated_monthly_savings_usd == 5.25


def test_remediation_plan_never_executes_implicitly() -> None:
    finding = next(item for item in evaluate(load_demo_inventory()) if item.rule_id == "SEC-SG-001")

    plan = build_remediation_plan(finding)

    assert plan.requires_approval is True
    assert plan.execution_enabled is False
    assert plan.action == "restrict_security_group_ingress"
    assert plan.references
    assert plan.references[0].source == "aws-security-baseline.md"
