#!/bin/bash
# Sync program IDs from `anchor keys list` output into Anchor.toml,
# each program's lib.rs declare_id!, and .env. Idempotent.
#
# Usage:
#   ./scripts/update-program-ids.sh VAULT_ID LENDING_ID LEVERAGE_ID
#
# Or just run after `anchor deploy` and pass the three IDs from output.

set -e
cd "$(dirname "$0")/.."

VAULT="$1"
LENDING="$2"
LEVERAGE="$3"

if [ -z "$VAULT" ] || [ -z "$LENDING" ] || [ -z "$LEVERAGE" ]; then
  echo "usage: $0 VAULT_PROGRAM_ID LENDING_PROGRAM_ID LEVERAGE_PROGRAM_ID"
  exit 1
fi

echo ">> Updating Anchor.toml"
sed -i.bak \
  -e "s|contra_vault    = \".*\"|contra_vault    = \"$VAULT\"|g" \
  -e "s|contra_lending  = \".*\"|contra_lending  = \"$LENDING\"|g" \
  -e "s|contra_leverage = \".*\"|contra_leverage = \"$LEVERAGE\"|g" \
  Anchor.toml

echo ">> Updating programs/contra_vault/src/lib.rs"
sed -i.bak "s|declare_id!(\"[^\"]*\")|declare_id!(\"$VAULT\")|" programs/contra_vault/src/lib.rs

echo ">> Updating programs/contra_lending/src/lib.rs"
sed -i.bak "s|declare_id!(\"[^\"]*\")|declare_id!(\"$LENDING\")|" programs/contra_lending/src/lib.rs

echo ">> Updating programs/contra_leverage/src/lib.rs"
sed -i.bak "s|declare_id!(\"[^\"]*\")|declare_id!(\"$LEVERAGE\")|" programs/contra_leverage/src/lib.rs

echo ">> Updating .env"
if grep -q "^CONTRA_VAULT_PROGRAM_ID=" .env; then
  sed -i.bak "s|^CONTRA_VAULT_PROGRAM_ID=.*|CONTRA_VAULT_PROGRAM_ID=$VAULT|" .env
else
  echo "CONTRA_VAULT_PROGRAM_ID=$VAULT" >> .env
fi
if grep -q "^CONTRA_LENDING_PROGRAM_ID=" .env; then
  sed -i.bak "s|^CONTRA_LENDING_PROGRAM_ID=.*|CONTRA_LENDING_PROGRAM_ID=$LENDING|" .env
else
  echo "CONTRA_LENDING_PROGRAM_ID=$LENDING" >> .env
fi
if grep -q "^CONTRA_LEVERAGE_PROGRAM_ID=" .env; then
  sed -i.bak "s|^CONTRA_LEVERAGE_PROGRAM_ID=.*|CONTRA_LEVERAGE_PROGRAM_ID=$LEVERAGE|" .env
else
  echo "CONTRA_LEVERAGE_PROGRAM_ID=$LEVERAGE" >> .env
fi

rm -f Anchor.toml.bak programs/contra_vault/src/lib.rs.bak \
      programs/contra_lending/src/lib.rs.bak \
      programs/contra_leverage/src/lib.rs.bak \
      .env.bak

echo ">> Done."
