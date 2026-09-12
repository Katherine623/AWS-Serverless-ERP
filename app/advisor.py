from __future__ import annotations

import json
import os

import boto3

from app.models import Finding, ScanSummary


def deterministic_summary(summary: ScanSummary, findings: list[Finding]) -> str:
    if not findings:
        return "本次掃描未發現目前規則涵蓋的成本或資安問題。"
    top = findings[0]
    return (
        f"本次發現 {summary.total_findings} 個問題，治理分數為 "
        f"{summary.governance_score}/100。最高優先項目是「{top.title}」"
        f"（{top.resource_id}）；預估每月可節省 US$"
        f"{summary.estimated_monthly_savings_usd:.2f}。"
    )


class BedrockAdvisor:
    def __init__(self, region: str, model_id: str | None = None) -> None:
        self.model_id = model_id or os.getenv("BEDROCK_MODEL_ID")
        self.client = boto3.client("bedrock-runtime", region_name=region) if self.model_id else None

    def summarize(self, summary: ScanSummary, findings: list[Finding]) -> str:
        fallback = deterministic_summary(summary, findings)
        if not self.client or not self.model_id or not findings:
            return fallback

        payload = {
            "summary": summary.model_dump(),
            "findings": [finding.model_dump(mode="json") for finding in findings[:10]],
        }
        try:
            response = self.client.converse(
                modelId=self.model_id,
                system=[
                    {
                        "text": (
                            "你是 AWS FinOps 與資安治理顧問。只根據輸入證據，以繁體中文"
                            "寫 120 字內主管摘要。不可宣稱已修復，也不可自行要求執行修改。"
                        )
                    }
                ],
                messages=[
                    {
                        "role": "user",
                        "content": [{"text": json.dumps(payload, ensure_ascii=False)}],
                    }
                ],
                inferenceConfig={"maxTokens": 220, "temperature": 0.1},
            )
            blocks = response["output"]["message"]["content"]
            return "".join(block.get("text", "") for block in blocks).strip() or fallback
        except Exception:  # Bedrock access is optional; scans must still complete.
            return fallback
