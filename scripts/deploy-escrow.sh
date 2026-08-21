#!/bin/sh
# Deploys SafeEscrow to the local compose anvil chain and records the address plus
# deployment block for the indexer to pick up.
#
# Run inside the Foundry image by the `deployer` service in compose.yaml. It exists
# because CONTRACT_ADDRESS and START_BLOCK cannot be hardcoded: the address depends on
# deployer nonce and the block depends on when the chain was started.
#
# The private key comes from anvil's published test mnemonic and is TEST ONLY.
set -eu

RPC_URL="${RPC_URL:-http://anvil:8545}"
OUT_DIR="${OUT_DIR:-/deployment}"
OUT_FILE="${OUT_DIR}/escrow.env"

if [ -z "${PRIVATE_KEY:-}" ]; then
  echo "PRIVATE_KEY is required" >&2
  exit 1
fi

mkdir -p "${OUT_DIR}"
# Remove any address from a previous run so the indexer never starts against a stale
# deployment if this script fails partway.
rm -f "${OUT_FILE}"

echo "waiting for ${RPC_URL} ..."
until cast block-number --rpc-url "${RPC_URL}" >/dev/null 2>&1; do
  sleep 1
done

ADMIN="$(cast wallet address --private-key "${PRIVATE_KEY}")"
echo "deploying SafeEscrow with admin ${ADMIN}"

# OpenZeppelin resolves from node_modules in the repo, which is not mounted here, so
# fetch the matching version into a local lib/ for this one-shot compile. The version
# must track the @openzeppelin/contracts pin in package.json.
OZ_VERSION="v5.6.1"
if [ ! -d /tmp/oz/openzeppelin-contracts ]; then
  mkdir -p /tmp/oz
  git clone --depth 1 --branch "${OZ_VERSION}" \
    https://github.com/OpenZeppelin/openzeppelin-contracts.git \
    /tmp/oz/openzeppelin-contracts
fi

WORK=/tmp/build
mkdir -p "${WORK}/src"
cp -r /contracts/. "${WORK}/src/"
cd "${WORK}"

cat > foundry.toml <<'TOML'
[profile.default]
src = "src"
out = "out"
solc = "0.8.28"
evm_version = "paris"
optimizer = true
optimizer_runs = 200
remappings = ["@openzeppelin/contracts/=/tmp/oz/openzeppelin-contracts/contracts/"]
TOML

# --broadcast sends the transaction; anvil mines it on its block interval.
DEPLOY_OUTPUT="$(forge create src/SafeEscrow.sol:SafeEscrow \
  --rpc-url "${RPC_URL}" \
  --private-key "${PRIVATE_KEY}" \
  --broadcast \
  --constructor-args "${ADMIN}")"

echo "${DEPLOY_OUTPUT}"

ADDRESS="$(echo "${DEPLOY_OUTPUT}" | sed -n 's/^Deployed to: \(0x[0-9a-fA-F]*\).*/\1/p' | head -n 1)"
if [ -z "${ADDRESS}" ]; then
  echo "could not parse deployed address from forge output" >&2
  exit 1
fi

TX_HASH="$(echo "${DEPLOY_OUTPUT}" | sed -n 's/^Transaction hash: \(0x[0-9a-fA-F]*\).*/\1/p' | head -n 1)"
START_BLOCK=0
if [ -n "${TX_HASH}" ]; then
  BLOCK_HEX="$(cast receipt "${TX_HASH}" blockNumber --rpc-url "${RPC_URL}" 2>/dev/null || echo "")"
  if [ -n "${BLOCK_HEX}" ]; then
    START_BLOCK="$(cast to-dec "${BLOCK_HEX}" 2>/dev/null || echo "${BLOCK_HEX}")"
  fi
fi

# Written last and atomically: the indexer polls for this file's existence, so it must
# not observe a partially written one.
cat > "${OUT_FILE}.tmp" <<EOF
CONTRACT_ADDRESS=${ADDRESS}
START_BLOCK=${START_BLOCK}
EOF
mv "${OUT_FILE}.tmp" "${OUT_FILE}"

echo "SafeEscrow deployed at ${ADDRESS} in block ${START_BLOCK}"
cat "${OUT_FILE}"
