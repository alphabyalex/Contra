#!/bin/bash
set -e
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 20.18.0 >/dev/null
export PATH="$NVM_DIR/versions/node/v20.18.0/bin:/home/alexs/.local/share/solana/install/active_release/bin:/home/alexs/.avm/bin:/home/alexs/.cargo/bin:$PATH"

SRC="/mnt/c/Users/alexs/OneDrive/Desktop/Homework USC/Personal Coding/Contra"
DST="$HOME/contra-build"

echo "=== Copying built artifacts back to /mnt/c ==="
mkdir -p "$SRC/target/deploy" "$SRC/target/idl"
cp "$DST/target/deploy/"*.so "$SRC/target/deploy/" 2>&1
cp "$DST/target/deploy/"*-keypair.json "$SRC/target/deploy/" 2>&1
cp "$DST/target/idl/"*.json "$SRC/target/idl/" 2>&1

echo "=== Syncing IDLs to backend/src/idl/ ==="
mkdir -p "$SRC/backend/src/idl"
cp "$DST/target/idl/contra_vault.json"    "$SRC/backend/src/idl/"
cp "$DST/target/idl/contra_lending.json"  "$SRC/backend/src/idl/"
cp "$DST/target/idl/contra_leverage.json" "$SRC/backend/src/idl/"
ls -la "$SRC/backend/src/idl/"

echo "=== Solana config ==="
solana config set --url devnet
solana balance "$DST/authority.json"

echo "=== anchor deploy ==="
cd "$DST"
anchor deploy --provider.cluster devnet --provider.wallet ./authority.json 2>&1
echo "=== anchor keys list (post-deploy) ==="
anchor keys list
