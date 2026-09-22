#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/infra/.lambda-build"
ZIP_PATH="$BUILD_DIR/lambda.zip"
STAGING_DIR="$(mktemp -d "$PROJECT_ROOT/infra/.lambda-build.tmp.XXXXXX")"
trap 'rm -rf "$STAGING_DIR"' EXIT
if [[ -n "${PYTHON_BIN:-}" ]]; then
  if [[ ! -x "$PYTHON_BIN" ]]; then
    echo "PYTHON_BIN does not point to an executable: $PYTHON_BIN" >&2
    exit 1
  fi
else
  PYTHON_BIN=""
  SYSTEM_PYTHON312="$(command -v python3.12 || true)"
  for candidate in \
    "$PROJECT_ROOT/.venv312/bin/python" \
    "$PROJECT_ROOT/.venv/bin/python" \
    "$SYSTEM_PYTHON312"; do
    if [[ -x "$candidate" ]] && [[ "$($candidate -c 'import platform; print(platform.python_version())' 2>/dev/null)" == 3.12.* ]]; then
      PYTHON_BIN="$candidate"
      break
    fi
  done
  if [[ -z "$PYTHON_BIN" ]]; then
    echo "Python 3.12 is required. Create .venv312 or set PYTHON_BIN=/path/to/python3.12." >&2
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

"$PYTHON_BIN" -m pip install \
  --target "$STAGING_DIR" \
  --platform manylinux2014_x86_64 \
  --implementation cp \
  --python-version 3.12 \
  --only-binary=:all: \
  -r "$PROJECT_ROOT/requirements-lambda.txt"

cp -R "$PROJECT_ROOT/app" "$STAGING_DIR/app"
cp -R "$PROJECT_ROOT/web" "$STAGING_DIR/web"

# Terraform compares this stamp against the sources so a stale zip fails the plan.
{
  find "$PROJECT_ROOT/app" -name '*.py' -type f -printf 'app/%P\n'
  echo 'requirements-lambda.txt'
} | LC_ALL=C sort | while IFS= read -r rel; do
  printf '%s:%s\n' "$rel" "$(sha256sum "$PROJECT_ROOT/$rel" | cut -d' ' -f1)"
done | sha256sum | cut -d' ' -f1 > "$STAGING_DIR/source.sha256"

BUILD_DIR="$STAGING_DIR" ZIP_PATH="$STAGING_DIR/lambda.zip" "$PYTHON_BIN" - <<'PY'
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

rm -rf "$BUILD_DIR"
mv "$STAGING_DIR" "$BUILD_DIR"
trap - EXIT

echo "Lambda package created: $ZIP_PATH"
