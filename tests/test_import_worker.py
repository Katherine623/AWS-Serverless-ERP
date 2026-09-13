from datetime import date, datetime
from types import SimpleNamespace

from app import imports
from app.import_worker import _normalise_date, handler


def test_import_dates_are_normalised() -> None:
    assert _normalise_date(date(2026, 9, 13)) == "2026-09-13"
    assert _normalise_date(datetime(2026, 9, 13, 8, 30)) == "2026-09-13"


def test_import_worker_reports_malformed_sqs_message_for_retry() -> None:
    result = handler({"Records": [{"messageId": "bad-1", "body": "not-json"}]}, None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "bad-1"}]}


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
    monkeypatch.setattr(imports.boto3, "client", lambda service: FakeS3())

    key, url, expires = imports.create_excel_upload_url("warehouse stock.xlsx")

    assert key.startswith("incoming/")
    assert key.endswith("warehouse-stock.xlsx")
    assert url == "https://upload.example.test"
    assert expires == 900
