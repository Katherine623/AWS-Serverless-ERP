from __future__ import annotations

import re
from uuid import uuid4

import boto3
from botocore.config import Config

from app.config import get_settings

EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
SAFE_FILE_NAME = re.compile(r"[^A-Za-z0-9._-]+")
UPLOAD_URL_TTL_SECONDS = 900
# The default signer targets the global endpoint, which 307-redirects regional
# buckets and breaks the browser's cross-origin PUT.
PRESIGN_CONFIG = Config(signature_version="s3v4", s3={"addressing_style": "virtual"})


def create_excel_upload_url(file_name: str) -> tuple[str, str, int]:
    settings = get_settings()
    if not settings.import_bucket_name:
        raise RuntimeError("ERP_IMPORT_BUCKET_NAME is not configured")
    safe_name = SAFE_FILE_NAME.sub("-", file_name).strip(".-") or "import.xlsx"
    if not safe_name.lower().endswith(".xlsx"):
        raise ValueError("只允許上傳 .xlsx 檔案")
    safe_name = f"{safe_name[:-5]}.xlsx"
    key = f"incoming/{uuid4().hex}-{safe_name}"
    expires_in = UPLOAD_URL_TTL_SECONDS
    url = boto3.client("s3", config=PRESIGN_CONFIG).generate_presigned_url(
        "put_object",
        Params={
            "Bucket": settings.import_bucket_name,
            "Key": key,
            "ContentType": EXCEL_CONTENT_TYPE,
        },
        ExpiresIn=expires_in,
        HttpMethod="PUT",
    )
    return key, url, expires_in
