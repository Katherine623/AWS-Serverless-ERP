from __future__ import annotations

import json
import logging
import os
from datetime import datetime
from typing import Protocol

import boto3
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class AlertEvent(BaseModel):
    alert_type: str
    po_id: str
    receipt_id: str
    material_id: str | None = None
    material_name: str | None = None
    message: str
    current_quantity: int | None = None
    reorder_point: int | None = None
    occurred_at: datetime


class AlertPublisher(Protocol):
    def publish(self, event: AlertEvent) -> None:
        ...


class LoggingAlertPublisher:
    def publish(self, event: AlertEvent) -> None:
        logger.warning("ERP alert: %s", event.model_dump_json())


class SnsAlertPublisher:
    def __init__(self, topic_arn: str) -> None:
        self._topic_arn = topic_arn
        self._client = boto3.client("sns")

    def publish(self, event: AlertEvent) -> None:
        self._client.publish(
            TopicArn=self._topic_arn,
            Subject=f"ERP 警示：{event.alert_type}",
            Message=json.dumps(event.model_dump(mode="json"), ensure_ascii=False),
        )


def create_alert_publisher() -> AlertPublisher:
    topic_arn = os.getenv("ERP_ALERT_TOPIC_ARN")
    if topic_arn:
        return SnsAlertPublisher(topic_arn)
    return LoggingAlertPublisher()