#!/usr/bin/env bash
# Copy each program's IDL out of target/idl/ into backend/src/idl/.
# Run after every `anchor build` — the backend cannot construct
# transactions without a matching IDL on disk.

set -euo pipefail
cd "$(dirname "$0")/.."

SRC="target/idl"
DST="backend/src/idl"

if [[ ! -d "$SRC" ]]; then
  echo "IDL source dir $SRC missing — run \`anchor build\` first" >&2
  exit 1
fi

mkdir -p "$DST"
for name in contra_vault contra_lending contra_leverage; do
  if [[ -f "$SRC/${name}.json" ]]; then
    cp "$SRC/${name}.json" "$DST/${name}.json"
    echo "synced ${name}.json"
  else
    echo "warn: $SRC/${name}.json missing — did anchor build succeed?" >&2
  fi
done
