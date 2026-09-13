from datetime import date, datetime

from app.import_worker import _normalise_date, handler


def test_import_dates_are_normalised() -> None:
    assert _normalise_date(date(2026, 9, 13)) == "2026-09-13"
    assert _normalise_date(datetime(2026, 9, 13, 8, 30)) == "2026-09-13"


def test_import_worker_reports_malformed_sqs_message_for_retry() -> None:
    result = handler({"Records": [{"messageId": "bad-1", "body": "not-json"}]}, None)

    assert result == {"batchItemFailures": [{"itemIdentifier": "bad-1"}]}
