#!/usr/bin/env bash
# CONTRA — devnet deploy.
#
# Run from WSL or Linux with the Solana + Anchor toolchain installed.
# Steps:
#   1. anchor build
#   2. solana program deploy for each of the three programs
#   3. anchor keys list (so you can paste the printed IDs into .env)
#   4. sync-idl.sh (copies IDLs into backend/src/idl/)
#
# Pre-reqs:
#   - SOLANA_CONFIG points at devnet (`solana config set --url devnet`)
#   - authority.json funded with at least ~6 SOL for deploy rent
#   - .env populated (script does NOT load .env — Anchor uses Anchor.toml)

set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v anchor >/dev/null 2>&1; then
  echo "anchor CLI not found — install Anchor 0.30.1 (https://www.anchor-lang.com/)" >&2
  exit 1
fi
if ! command -v solana >/dev/null 2>&1; then
  echo "solana CLI not found — install Solana (https://docs.solana.com/cli)" >&2
  exit 1
fi

CLUSTER=$(solana config get | awk '/RPC URL/ {print $3}')
echo ">> RPC: $CLUSTER"
echo ">> Building all three programs (this takes a minute)..."
anchor build

for prog in contra_vault contra_lending contra_leverage; do
  SO="target/deploy/${prog}.so"
  KEYPAIR="target/deploy/${prog}-keypair.json"
  if [[ ! -f "$SO" ]]; then
    echo "missing build artifact: $SO" >&2
    exit 1
  fi
  echo ">> Deploying $prog..."
  solana program deploy --program-id "$KEYPAIR" "$SO"
done

echo ">> Program IDs (paste these into .env and Anchor.toml):"
anchor keys list

echo ">> Syncing IDLs to backend..."
"$(dirname "$0")/sync-idl.sh"

echo ">> Done. Restart the backend to pick up new IDLs."
