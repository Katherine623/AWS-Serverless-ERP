#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/infra/.lambda-build"
ZIP_PATH="$BUILD_DIR/lambda.zip"
PYTHON_BIN="${PYTHON_BIN:-$PROJECT_ROOT/.venv/bin/python}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="python3"
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

"$PYTHON_BIN" -m pip install \
  --target "$BUILD_DIR" \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.12 \
  --only-binary=:all: \
  -r "$PROJECT_ROOT/requirements-lambda.txt"

cp -R "$PROJECT_ROOT/app" "$BUILD_DIR/app"
cp -R "$PROJECT_ROOT/web" "$BUILD_DIR/web"

BUILD_DIR="$BUILD_DIR" ZIP_PATH="$ZIP_PATH" "$PYTHON_BIN" - <<'PY'
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

build_dir = Path(os.environ["BUILD_DIR"])
zip_path = Path(os.environ["ZIP_PATH"])
with ZipFile(zip_path, "w", ZIP_DEFLATED) as archive:
    for path in build_dir.rglob("*"):
        if path.is_file() and path != zip_path:
            archive.write(path, path.relative_to(build_dir))
PY

echo "Lambda package created: $ZIP_PATH"