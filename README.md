# Blockchain Indexer

A TypeScript blockchain event indexer that stores confirmed events, resumes
from checkpoints, handles historical backfills, and rolls back safely during
chain reorganizations. It also includes a small native-ETH escrow reference
contract.
It does not define or promote a token.

## Resume Summary

- Built a TypeScript EVM log indexer with confirmation-depth processing,
  transactional SQLite checkpoints, idempotent replay, and common-ancestor
  rollback for deterministic chain-reorganization recovery.
- Added a rate-limited JSON-RPC abstraction, resumable range backfills, a
  cursor-paginated Fastify API, Prometheus metrics, and fake-chain integration
  tests covering failures and competing forks.
- Implemented and tested a Solidity ETH escrow with payer/payee/arbiter access
  control, timeout refunds, custom errors, event audit trails,
  checks-effects-interactions, and callback reentrancy protection.

## Components

- `src/indexer.ts`: confirmation, batching, continuity checks, and reorg recovery.
- `src/store.ts`: normalized SQLite schema and atomic progress commits.
- `src/provider/`: ethers JSON-RPC adapter, retry/rate wrapper, and fake chain.
- `src/api.ts`: read-only event, checkpoint, backfill, health, and metrics routes.
- `contracts/SafeEscrow.sol`: deposit, release, and refund lifecycle.
- `tests/`: deterministic indexer and local Hardhat contract suites.

See [architecture](docs/ARCHITECTURE.md) and
[threat model](docs/THREAT_MODEL.md) for invariants and trust assumptions.

## Local Verification

Prerequisites: Node.js 22+ and npm.

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run benchmark
```

The pinned `solc` JavaScript package is wired into Hardhat, so Solidity tests do
not download a compiler after dependencies are installed.

## Run Against a Local EVM

Copy the variable names from `.env.example` into a local, ignored `.env`, then:

```bash
node --env-file=.env --import tsx src/cli.ts sync
node --env-file=.env --import tsx src/cli.ts serve
node --env-file=.env --import tsx src/cli.ts backfill historical-1 1 10000
```

The service defaults to `127.0.0.1:3000`. Useful queries:

```bash
curl "http://127.0.0.1:3000/v1/events?chainId=31337&eventName=Deposited&limit=50"
curl "http://127.0.0.1:3000/v1/checkpoints"
curl "http://127.0.0.1:3000/metrics"
```

`CONTRACT_ADDRESS` must be the deployed local escrow address and `START_BLOCK`
its deployment block. The repository contains no keys, deployment receipts, or
mainnet claims.

## Backfill and Reorg Behavior

Backfill jobs persist their inclusive range and next block. Re-running the same
job ID resumes it. Live indexing and backfills share canonical block headers and
event uniqueness constraints. If a stored hash diverges from JSON-RPC, ChainIndex
walks backward to a common ancestor, deletes orphaned blocks and events, rewinds
affected progress, then resumes forward processing.

## Query Contract

`GET /v1/events` requires `chainId`. Optional filters are `streamId`, `address`,
`eventName`, `fromBlock`, `toBlock`, and `cursor`; `limit` is capped at 200.
Results are ordered by stable database ID and return `nextCursor` when another
page may exist.

## Benchmark

The deterministic benchmark indexes 10,000 fake-chain blocks and ABI logs into
in-memory SQLite. Run `npm run benchmark`; the checked evidence and environment
are recorded in [`evidence/benchmark.json`](evidence/benchmark.json). The
recorded Node 24/Windows x64 run completed in 5.432 seconds (1,841 blocks and
events per second). This measures local pipeline overhead, not JSON-RPC or
mainnet throughput.

## Security Status

The threat model documents expected failure modes and residual risks. The escrow
uses defensive patterns and automated tests but **has not been externally
audited**. Do not use it to custody production funds without independent review.

`npm audit --omit=dev` reports zero known production dependency vulnerabilities.
The full development graph retains advisories in Hardhat 2 transitive packages;
the registry-proposed fix is a breaking Hardhat 3/ESM toolchain migration.

## License

MIT
