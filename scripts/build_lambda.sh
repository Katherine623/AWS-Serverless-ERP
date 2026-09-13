#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/infra/.lambda-build"
ZIP_PATH="$BUILD_DIR/lambda.zip"
if [[ -n "${PYTHON_BIN:-}" ]]; then
  if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "PYTHON_BIN does not point to an executable: $PYTHON_BIN" >&2
    exit 1
  fi
else
  PYTHON_BIN="$PROJECT_ROOT/.venv/bin/python"
  if [[ ! -x "$PYTHON_BIN" ]]; then
    PYTHON_BIN="$(command -v python3.12 || true)"
  fi
  if [[ -z "$PYTHON_BIN" ]]; then
    echo "Python 3.12 is required. Set PYTHON_BIN=/path/to/python3.12." >&2
    exit 1
  fi
fi

PYTHON_VERSION="$($PYTHON_BIN -c 'import platform; print(platform.python_version())')"
if [[ "$PYTHON_VERSION" != 3.12.* ]]; then
  echo "Lambda build requires Python 3.12, found $PYTHON_VERSION at $PYTHON_BIN." >&2
  exit 1
fi
if ! "$PYTHON_BIN" -m pip --version >/dev/null 2>&1; then
  echo "Python 3.12 at $PYTHON_BIN has no pip. Create a venv with pip or install pip first." >&2
  exit 1
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
