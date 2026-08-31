# ChainIndex

ChainIndex is a production-shaped EVM event indexing service paired with a small
native-ETH escrow reference contract. It focuses on infrastructure work common
to Web3 applications: canonical-chain tracking, replay-safe persistence,
historical backfills, observable RPC handling, and contract settlement controls.
It does not define or promote a token.

## Resume Summary

- Built a TypeScript EVM log indexer with confirmation-depth processing,
  transactional SQLite checkpoints, idempotent replay, and common-ancestor
  rollback for deterministic chain-reorganization recovery.
- Added a rate-limited JSON-RPC abstraction, resumable range backfills, a
  cursor-paginated Fastify API, Prometheus metrics, and fake-chain integration
  tests covering failures and competing forks.
- Implemented and tested a Solidity ETH escrow on OpenZeppelin `ReentrancyGuard`,
  `AccessControl`, and `Pausable`, with payer/payee/arbiter settlement authority,
  timeout refunds, custom errors, event audit trails,
  checks-effects-interactions, and Foundry fuzz/invariant coverage.

## Components

- `src/indexer.ts`: confirmation, batching, continuity checks, and reorg recovery.
- `src/store.ts`: normalized SQLite schema and atomic progress commits.
- `src/provider/`: ethers JSON-RPC adapter, retry/rate wrapper, and fake chain.
- `src/api.ts`: read-only event, checkpoint, backfill, health, and metrics routes.
- `contracts/SafeEscrow.sol`: deposit, release, and refund lifecycle.
- `tests/`: four test tiers (see [Testing](#testing)).
- `Dockerfile` / `compose.yaml`: the container image and a local anvil + Prometheus +
  Grafana stack (see [Container](#container)).

See [architecture](docs/ARCHITECTURE.md) and
[threat model](docs/THREAT_MODEL.md) for invariants and trust assumptions.

## Dependency Rationale

| Dependency | Why |
| --- | --- |
| `@openzeppelin/contracts` 5.6.1 | Audited `ReentrancyGuard`, `AccessControl`, and `Pausable` in place of hand-rolled equivalents. Requires `^0.8.20`, compatible with the pinned 0.8.28. |
| `ethers` 6 | JSON-RPC access, ABI decoding, and the contract test suite. See the note below on viem. |
| `better-sqlite3` | Synchronous, transactional embedded storage. Its single-writer model matches one indexer process per database. |
| `fastify` | Read-only query API with schema validation and structured logging. |
| `prom-client` | Prometheus-format metrics on `/metrics`, ready for any scraper. |
| `zod` | Environment and query-parameter validation at process and HTTP boundaries. |
| Hardhat + Foundry | Both, deliberately. Hardhat runs the TypeScript behavioural suite; Foundry runs Solidity fuzz and invariant tests. |

### Why ethers, not viem

`viem` is the more common choice for new indexers today: smaller bundles, a
tree-shakeable modular API, and stricter TypeScript inference. It is a reasonable
default for a greenfield project.

This repository stays on **ethers v6** on purpose. All external chain access is already
funnelled through the three-method `ChainProvider` interface in
`src/provider/chain-provider.ts`, so the client library is an implementation detail of
one 55-line adapter (`json-rpc-provider.ts`) plus ABI decoding in `decoder.ts`.
Swapping it would touch those files and the contract test suite while changing no
observable behaviour, no architecture, and no guarantee this project claims. ethers v6
is actively maintained and widely deployed, so the migration would be churn presented as
progress.

The provider boundary is the point: the abstraction that makes anvil easy to substitute
for the fake chain is the same one that would make viem a contained change if there were
a reason to make it.

## Local Verification

Prerequisites: Node.js 22+ and npm. Foundry is optional (see [Testing](#testing)).

```bash
npm ci
npm run lint
npm run typecheck
npm run build
npm test
npm run benchmark
```

The pinned `solc` JavaScript package is wired into Hardhat, so Solidity tests do
not download a compiler after dependencies are installed. `foundry.toml` pins the
same 0.8.28, and CI asserts both toolchains compile against it — if you change the
pin, change it in both places.

## Testing

Four tiers, each covering what the others cannot:

| Tier | Command | What it proves |
| --- | --- | --- |
| Unit (fake chain) | `npm run test:indexer` | Indexer logic against `FakeChainProvider`: confirmations, idempotent replay, backfill resumption, fork rejection, metrics. Fast and hermetic. |
| Contract (Hardhat) | `npm run test:contract` | Escrow behaviour and the adversarial cases — reentrancy via `ReentrantPayee`, ETH rejection via `RejectEther`, role and pause boundaries. |
| Real node (E2E) | `npm run test:e2e` | The indexer against a genuine JSON-RPC node, including a real reorg. |
| Fuzz + invariant | `npm run test:invariant` | Property-based coverage of the escrow. **Requires Foundry; CI-verified only** (see [Verification status](#verification-status)). |

### Real-node testing

The unit tier is fast but can only show the indexer is correct with respect to a fake
written alongside it. `tests/e2e/` closes that gap: it deploys the compiled
`SafeEscrow` to a real node, indexes its logs over HTTP through
`EthersJsonRpcProvider`, and asserts stored block hashes match what the node reports.

The reorg test matters most, because reorg-safety is this project's headline claim. It
snapshots the chain, mines one history, reverts, then mines a **different** history with
different transactions, so the node recomputes genuinely different block hashes. The
test asserts the two histories' hashes actually diverge before asserting recovery, so it
cannot pass vacuously. (Empty blocks are byte-identical after `evm_revert` because
timestamps are deterministic — differing transactions are what create real divergence.)

Both backends are **native binaries spawned as ordinary child processes** — no container
runtime is involved anywhere in the test suite. The harness prefers **anvil** when it is
on `PATH` and falls back to `hardhat node` otherwise; both expose
`evm_snapshot`/`evm_revert`, so the suite passes either way. CI installs Foundry via
`foundry-rs/foundry-toolchain@v1` so it exercises the anvil path specifically. The
fake-provider tier is retained unchanged for fast, dependency-free feedback.

### Verification status

Run locally on Windows (Node 24.16.0), all exit 0: `lint`, `typecheck`, `build`,
`test:indexer` (9 passed), `test:contract` (15 passed), `test:e2e` (3 passed, run six
times to check for flake), `benchmark`.

Two things are **verified in CI only**, because this machine cannot verify them:

| Not verified locally | Why | CI evidence |
| --- | --- | --- |
| anvil backend + `test:invariant` | `forge`/`anvil` are not installed here, so the E2E tier ran on the `hardhat node` fallback | `foundry-rs/foundry-toolchain@v1` in the `verify` and `invariant` jobs |
| The container image | The Docker CLI is present but its daemon is unusable, so no image was ever built or run here | the `container` job builds it and smokes `/health` + `/metrics` |

Install Foundry locally (`foundryup`) to run the Foundry tiers here. Nothing stronger is
claimed about the image than "the CI job builds it" — see [Container](#container).

### Fuzz and invariant testing

`tests/foundry/` asserts properties that must hold in *every* reachable state, which
example-based tests cannot express:

- contract balance always covers the sum of unreleased deposits;
- no non-party — including the pause admin — can ever release or refund;
- pausing never blocks settlement of an already-funded escrow;
- settled escrows are terminal, and escrow ids are never reused.

A handler (`SafeEscrowHandler.sol`) keeps the fuzzer inside the contract's documented
preconditions, and a coverage invariant fails the run if no escrow was ever funded — so
the suite cannot pass by exploring an empty state space.

## Escrow Access Control

`SafeEscrow` separates two kinds of authority, and the distinction is deliberate.

**Per-escrow settlement authority** (`payer`, `payee`, `arbiter`) is stored per escrow
and checked inline. It is intentionally *not* modelled with OpenZeppelin
`AccessControl`. `AccessControl` maintains a single contract-wide `role => account`
registry, so granting an `ARBITER_ROLE` would authorize that account against **every**
escrow rather than the one it was named on — a privilege escalation, not a hardening.
Per-escrow parties are relationship data, not global permissions.

**Contract-wide operational authority** does use `AccessControl`. Its only capability is
a `Pausable` circuit breaker over `deposit`, held by `PAUSER_ROLE`.

That breaker is **inflow-only**: `release` and `refund` are never pausable, so no admin —
including a compromised admin key — can freeze, seize, or strand ETH that is already
escrowed. Funded escrows always stay settleable by their own parties. Both the Hardhat
suite and the Foundry invariants assert this directly, and the constructor rejects a zero
address so the breaker cannot be deployed unowned.

The escrow remains **native-ETH only**. There is no token, and `SafeERC20` is therefore
not used: adding it would mean inventing ERC-20 support the contract does not have.

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

## Container

`Dockerfile` is a two-stage build: the builder carries node-gyp's prerequisites and
compiles `better-sqlite3`, runs `tsc`, then prunes to production dependencies; the runtime
stage copies only `node_modules` and `dist`, runs as the unprivileged `node` user, keeps
SQLite on a `/data` volume, and health-checks `/health`. A build-time step instantiates
the native addon so a broken build fails the image rather than crash-looping a container.

`compose.yaml` brings up the whole local story: **anvil** (a real EVM node), a one-shot
**deployer**, the **indexer**, **Prometheus**, and **Grafana** with a dashboard covering
exactly the metrics `src/metrics.ts` exposes. The deployer exists because
`CONTRACT_ADDRESS` and `START_BLOCK` cannot be hardcoded — the address depends on deployer
nonce and the block on when the chain started — so it deploys, writes both to a shared
volume, and the indexer sources them at startup. Every key is anvil's published test
mnemonic and is labelled TEST ONLY.

```bash
docker compose up --build
# indexer :3000/health · Prometheus :9090 · Grafana :3001
```

**Verification status: CI only.** The development machine has the Docker CLI but no usable
daemon, so the image has never been built or run there, and this README makes no claim
that it has. The `container` CI job is the evidence: it validates the compose stack
(`docker compose config`), builds with `docker/setup-buildx-action` +
`docker/build-push-action` (`push: false`), then starts the built image and asserts
`/health` reports `"status":"ok"`, `/metrics` exposes `chainindex_*` series, and the
runtime uid is not 0. What *was* checked locally, without a daemon: compose config parses
and resolves 5 services, the deploy script passes `sh -n` and matches
`constructor(address admin)`, and `/health` + `/metrics` answer before the first indexing
pass — confirmed by running `dist/cli.js serve` natively against an unreachable RPC URL,
the same state the smoke step exercises.

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
are recorded in [`evidence/benchmark.json`](evidence/benchmark.json).

The harness times repeated runs and reports a **range**, because a single figure
overstates what this measurement can support. On the recorded Node 24 / Windows x64
host, 25 repetitions of 10,000 blocks took **4.100s / 4.861s / 9.454s**
(min / median / max), i.e. **1,058 / 2,057 / 2,439** blocks and events per second.

**These figures are host variance, not a code change.** `git diff` over `src/` and
`benchmarks/` between the revision that recorded the previous numbers and this one is
empty — the pipeline is byte-identical, so the ~1.7x faster median (1,204 → 2,057
blocks/s) measures a quieter machine and nothing else. It is reported because a stale
figure is worse than a re-measured one, not as an improvement.

The range is the point. Across four independent 25-repetition batches on this host the
median ranged 4.4–6.6s and single repetitions spanned **1.855s to 66.2s** — the 66s
outlier was one OS-level stall, and it is quoted rather than discarded because it is what
the tail actually looks like here. A within-process probe (20 consecutive repetitions,
logging heap) showed no monotonic drift and a normal GC sawtooth, which is what rules out
a leak in the harness and pins the spread on host CPU availability. An earlier revision of
this README quoted 5.432s at 1,841 blocks/s from a single run; that value sits inside the
observed spread. Correctness (10,000 blocks, 10,000 events) is exact and asserted on every
repetition.

The measurement box is a power-managed laptop with unpinned clocks, so treat the median as
indicative of pipeline overhead on a comparable host and the range as the real
uncertainty. Republishing on a quiesced machine would tighten it.

This measures in-process indexing, decoding, and SQLite commit overhead only — never
JSON-RPC latency or mainnet throughput.

## Security Status

The threat model documents expected failure modes and residual risks. The escrow builds
on audited OpenZeppelin primitives and carries adversarial, fuzz, and invariant tests,
but the escrow itself **has not been externally audited**. Using audited libraries is not
the same as being audited. Do not use it to custody production funds without independent
review.

`npm audit --omit=dev` reports zero known production dependency vulnerabilities.
The full development graph retains advisories in Hardhat 2 transitive packages;
the registry-proposed fix is a breaking Hardhat 3/ESM toolchain migration.

## License

MIT
