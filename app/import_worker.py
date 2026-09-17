from __future__ import annotations

import json
import logging
import time
from contextlib import closing
from datetime import UTC, date, datetime
from io import BytesIO
from urllib.parse import unquote_plus

import boto3

from app.erp import ErpStore
from app.import_parser import MAX_FILE_BYTES, parse_and_import

logger = logging.getLogger(__name__)
store = ErpStore()
s3 = boto3.client("s3")


def _normalise_date(value: object) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip()


def _required_cell_value(row: tuple[object, ...], index: int, field: str) -> object:
    if index >= len(row) or row[index] is None or not str(row[index]).strip():
        raise ValueError(f"Excel 欄位 {field} 不可為空")
    return row[index]


def _required_cell(row: tuple[object, ...], index: int, field: str) -> str:
    return str(_required_cell_value(row, index, field)).strip()


def _import_workbook(bucket: str, key: str) -> int:
    return _import_report(bucket, key)["imported"]


def _import_report(bucket: str, key: str) -> dict:
    response = s3.get_object(Bucket=bucket, Key=key)
    # XLSX is a ZIP archive: openpyxl needs seek(), which S3 StreamingBody lacks.
    with closing(response["Body"]) as body, BytesIO() as source:
        if response.get("ContentLength", 0) > MAX_FILE_BYTES:
            raise ValueError("Excel 超過 10 MB，請拆分檔案")
        for chunk in body.iter_chunks(chunk_size=65536):
            if source.tell() + len(chunk) > MAX_FILE_BYTES:
                raise ValueError("Excel 超過 10 MB，請拆分檔案")
            source.write(chunk)
        source.seek(0)
        return parse_and_import(source, store)


def _import_xlsx(source: BytesIO) -> int:
    return parse_and_import(source, store)["imported"]


def handler(event: dict, context: object) -> dict[str, list[dict[str, str]]]:
    del context
    failures: list[dict[str, str]] = []
    for record in event.get("Records", []):
        message_id = record.get("messageId", "unknown")
        job = None
        try:
            message = json.loads(record["body"])
            for s3_record in message.get("Records", []):
                bucket = s3_record["s3"]["bucket"]["name"]
                key = unquote_plus(s3_record["s3"]["object"]["key"])
                if not key.startswith("incoming/") or not key.lower().endswith(".xlsx"):
                    raise ValueError("只允許匯入 incoming/ 下的 .xlsx 檔案")
                job_id = key.rsplit("/", 1)[-1].split("-", 1)[0]
                previous = store.repository.get_record("import", job_id)
                if previous and previous["status"] in {"completed", "partial_failed"}:
                    continue
                if previous and previous.get("lease_until", 0) > time.time():
                    raise ValueError("此匯入工作仍在處理中，稍後重試")
                candidate = (
                    dict(previous)
                    if previous
                    else {
                        "id": job_id,
                        "owner": "system",
                        "object_key": key,
                        "created_at": datetime.now(UTC).isoformat(),
                    }
                )
                candidate.update(status="processing", lease_until=int(time.time()) + 300)
                store.repository.save_record("import", candidate, previous=previous)
                job = dict(candidate)
                report = _import_report(bucket, key)
                claimed = dict(job)
                job.update(
                    report,
                    status="partial_failed" if report["failed"] else "completed",
                    lease_until=0,
                    updated_at=datetime.now(UTC).isoformat(),
                )
                store.repository.save_record("import", job, previous=claimed)
                logger.info(
                    "Imported %s purchase orders from s3://%s/%s", report["imported"], bucket, key
                )
                job = None
        except Exception as error:
            logger.exception("Excel import message %s failed", message_id)
            if job is not None:
                claimed = dict(candidate)
                # Persist a useful error without exposing SDK credentials or internal responses.
                message = (
                    str(error)[:500] if isinstance(error, ValueError) else "匯入失敗，等待重試"
                )
                job.update(
                    status="failed",
                    lease_until=0,
                    errors=[{"message": message}],
                    updated_at=datetime.now(UTC).isoformat(),
                )
                try:
                    store.repository.save_record("import", job, previous=claimed)
                except Exception:
                    logger.exception("Could not persist import failure")
            failures.append({"itemIdentifier": message_id})
    return {"batchItemFailures": failures}
