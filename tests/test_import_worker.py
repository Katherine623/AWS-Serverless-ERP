import json
from datetime import date, datetime
from io import BytesIO
from types import SimpleNamespace

import pytest
from botocore.response import StreamingBody
from openpyxl import Workbook

from app import import_worker, imports
from app.erp import ErpStore
from app.import_worker import _normalise_date, handler
from app.repository import InMemoryRepository


def sqs_excel_event():
    return {"Records": [{"messageId": "excel-1", "body": json.dumps({"Records": [{
        "s3": {"bucket": {"name": "imports-bucket"},
               "object": {"key": "incoming/orders.xlsx"}}
    }]})}]}


@pytest.fixture
def s3_workbook(monkeypatch):
    monkeypatch.setattr(import_worker, "store", ErpStore(repository=InMemoryRepository()))
    streams = []

    def install(contents):
        def get_object(*, Bucket, Key):
            assert Bucket == "imports-bucket"
            assert Key == "incoming/orders.xlsx"
            raw = BytesIO(contents)
            streams.append(raw)
            return {"Body": StreamingBody(raw, len(contents))}

        monkeypatch.setattr(import_worker, "s3", SimpleNamespace(get_object=get_object))
        return streams

    return install


def test_s3_stream_imports_real_xlsx_and_duplicate_delivery_is_safe(s3_workbook):
    workbook = Workbook()
    sheet = workbook.active
    sheet.append(["po_id", "supplier_name", "expected_date", "material_id",
                  "material_name", "ordered_quantity", "unit"])
    sheet.append(["IMPORT-001", "Supplier", date(2026, 9, 20), "IMPORT-A", "Part A", 10, "pcs"])
    sheet.append(["IMPORT-001", "Supplier", date(2026, 9, 20), "IMPORT-B", "Part B", 20, None])
    sheet.append(["IMPORT-002", "Supplier", "2026-09-21", "IMPORT-A", "Part A", 5, "pcs"])
    with BytesIO() as buffer:
        workbook.save(buffer)
        streams = s3_workbook(buffer.getvalue())
    workbook.close()

    assert handler(sqs_excel_event(), None) == {"batchItemFailures": []}
    order = import_worker.store.repository.get_purchase_order("IMPORT-001")
    assert order.status == "待驗收"
    assert order.expected_date == date(2026, 9, 20)
    assert [(item.material_id, item.ordered_quantity, item.unit) for item in order.items] == [
        ("IMPORT-A", 10, "pcs"), ("IMPORT-B", 20, "pcs")
    ]
    assert all(item.received_quantity == 0 for item in order.items)
    second_order = import_worker.store.repository.get_purchase_order("IMPORT-002")
    assert second_order.items[0].ordered_quantity == 5
    assert import_worker._import_workbook("imports-bucket", "incoming/orders.xlsx") == 0
    assert all(stream.closed for stream in streams)


def test_invalid_xlsx_is_retried_and_stream_is_closed(s3_workbook):
    streams = s3_workbook(b"not an xlsx archive")
    assert handler(sqs_excel_event(), None) == {
        "batchItemFailures": [{"itemIdentifier": "excel-1"}]
    }
    assert streams[0].closed


def test_incomplete_s3_download_is_retried_and_closed(monkeypatch):
    raw = BytesIO(b"truncated")
    monkeypatch.setattr(import_worker, "s3", SimpleNamespace(
        get_object=lambda **kwargs: {"Body": StreamingBody(raw, 100)}
    ))
    assert handler(sqs_excel_event(), None) == {
        "batchItemFailures": [{"itemIdentifier": "excel-1"}]
    }
    assert raw.closed


def test_import_dates_are_normalised() -> None:
    assert _normalise_date(date(2026, 9, 13)) == "2026-09-13"
    assert _normalise_date(datetime(2026, 9, 13, 8, 30)) == "2026-09-13"


def test_import_worker_reports_malformed_sqs_message_for_retry() -> None:
    result = handler({"Records": [{"messageId": "bad-1", "body": "not-json"}]}, None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "bad-1"}]}


def test_import_worker_rejects_objects_outside_incoming_prefix() -> None:
    result = handler(
        {
            "Records": [
                {
                    "messageId": "bad-key-1",
                    "body": json.dumps(
                        {
                            "Records": [
                                {
                                    "s3": {
                                        "bucket": {"name": "imports"},
                                        "object": {"key": "other/file.xlsx"},
                                    }
                                }
                            ]
                        }
                    ),
                }
            ]
        },
        None,
    )

    assert result == {"batchItemFailures": [{"itemIdentifier": "bad-key-1"}]}


def test_excel_upload_url_is_scoped_to_xlsx_object(monkeypatch) -> None:
    class FakeS3:
        def generate_presigned_url(self, operation, *, Params, ExpiresIn, HttpMethod):
            assert operation == "put_object"
            assert Params["Bucket"] == "imports-bucket"
            assert Params["ContentType"].endswith("sheet")
            assert HttpMethod == "PUT"
            return "https://upload.example.test"

    monkeypatch.setattr(
        imports,
        "get_settings",
        lambda: SimpleNamespace(import_bucket_name="imports-bucket"),
    )
    monkeypatch.setattr(
        imports.boto3,
        "client",
        lambda service, config=None: FakeS3(),
    )

    key, url, expires = imports.create_excel_upload_url("warehouse stock.xlsx")

    assert key.startswith("incoming/")
    assert key.endswith("warehouse-stock.xlsx")
    assert url == "https://upload.example.test"
    assert expires == 900

    uppercase_key, _, _ = imports.create_excel_upload_url("warehouse stock.XLSX")
    assert uppercase_key.endswith("warehouse-stock.xlsx")
