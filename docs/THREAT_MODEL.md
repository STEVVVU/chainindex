# Threat Model

## Assets and Trust Boundaries

- Escrowed ETH and authorization state in `SafeEscrow`.
- Canonical event history, block checkpoints, and backfill progress.
- JSON-RPC responses crossing an external provider boundary.
- SQLite and API access on the service host.

No private key is required by the indexer. Contract deployment and transaction
signing are intentionally outside this repository's runtime.

## Contract Threats

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Unauthorized release/refund | Explicit payer, payee, and arbiter checks, asserted as a Foundry invariant over random call orderings | Compromised party keys retain their authority |
| Reentrancy during ETH transfer | OpenZeppelin `ReentrancyGuard` plus checks-effects-interactions | Recipient can reject ETH and block that settlement path |
| Double settlement | Status must be `Funded`; amount is zeroed before interaction | None known under EVM transaction atomicity |
| Trapped or accidental funds | No payable receive/fallback; deposits use one entry point | Forced ETH via `SELFDESTRUCT` is not attributable |
| Deadline manipulation | Payer refund uses block timestamp after a long operator-set deadline | Validators can influence timestamps slightly |
| Role configuration error | Zero/self/overlapping party checks and emitted terms | A wrong but valid external address cannot be recovered automatically |
| Admin freezing or seizing escrowed funds | The `Pausable` breaker gates `deposit` only; `release`/`refund` are never pausable, and the admin has no per-escrow authority. Asserted by test and invariant | Pausing deposits is still a denial of *new* business |
| Unowned circuit breaker | Constructor rejects a zero admin | Admin key management is an operational concern |

### Why per-escrow parties are not OpenZeppelin roles

`AccessControl` governs only the contract-wide pause capability. Per-escrow
`payer`/`payee`/`arbiter` authority is stored per escrow and checked inline, because
`AccessControl` is a single global `role => account` registry: an `ARBITER_ROLE` holder
would gain settlement authority over *every* escrow rather than the one it was named on.
Modelling relationship data as global roles would be a privilege escalation, so it was
deliberately not done.

The contract builds on audited OpenZeppelin primitives and carries adversarial, fuzz,
and invariant tests, but **has not itself received an external security audit** — using
audited libraries is not equivalent to being audited. It should not custody production
value without independent review, deployment controls, and monitoring.

## Indexer Threats

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Short chain reorganization | Confirmation depth, stored headers, common-ancestor rollback | Reorgs deeper than retained/provider history can halt indexing |
| Provider returns mixed forks | Parent continuity and log/header hash checks | A single malicious provider can consistently present a false chain |
| Duplicate delivery or operator replay | Database uniqueness and transactional checkpoints | ABI semantic changes may require a new stream identifier |
| Rate limits and transient outages | Serialized request rate and bounded exponential retries | Sustained outage stops progress and requires alerting |
| Crash during a batch | Atomic event/block/checkpoint transaction | Disk loss requires restoring or replaying from chain |
| Unbounded API queries | Required chain ID, limit capped at 200, cursor pagination | Host-level request concurrency still needs a reverse proxy |
| SQL injection | Bound SQLite parameters; allowlisted query fields | Local database file compromise is out of process scope |
| Secret exposure | Runtime needs only RPC URL; `.env*` ignored | Authenticated RPC URLs still require deployment secret management |

## Operational Assumptions

- Run one writer per SQLite database.
- Restrict API binding or place it behind authentication and TLS when remote.
- Alert on retry, checkpoint lag, and reorg metrics.
- Back up the database or retain enough provider history for complete replay.
- Use at least two independent providers when chain-integrity assurance matters.
