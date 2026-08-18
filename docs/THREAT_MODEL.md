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
| Unauthorized release/refund | Explicit payer, payee, and arbiter checks | Compromised role keys retain their authority |
| Reentrancy during ETH transfer | Non-reentrant guard plus checks-effects-interactions | Recipient can reject ETH and block that settlement path |
| Double settlement | Status must be `Funded`; amount is zeroed before interaction | None known under EVM transaction atomicity |
| Trapped or accidental funds | No payable receive/fallback; deposits use one entry point | Forced ETH via `SELFDESTRUCT` is not attributable |
| Deadline manipulation | Payer refund uses block timestamp after a long operator-set deadline | Validators can influence timestamps slightly |
| Role configuration error | Zero/self/overlapping role checks and emitted terms | A wrong but valid external address cannot be recovered automatically |

The contract has comprehensive automated tests but **has not received an external
security audit**. It should not custody production value without independent
review, deployment controls, and monitoring.

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
