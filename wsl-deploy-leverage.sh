#!/bin/bash
set -e
export PATH="/home/alexs/.local/share/solana/install/active_release/bin:$PATH"
cd ~/contra-build

echo "=== Balance check (default RPC) ==="
solana balance ./authority.json --url devnet

SO="target/deploy/contra_leverage.so"
KP="target/deploy/contra_leverage-keypair.json"
SIZE=$(stat -c %s "$SO")
MAX_LEN=$((SIZE + 4096))
echo ""
echo ">>> Deploying contra_leverage (so size: $SIZE, max-len: $MAX_LEN)"
solana program deploy \
  --program-id "$KP" \
  --max-len "$MAX_LEN" \
  --url devnet \
  --keypair ./authority.json \
  "$SO" 2>&1

echo ""
echo "=== Post-deploy balance ==="
solana balance ./authority.json --url devnet
