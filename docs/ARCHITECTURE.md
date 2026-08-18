# Architecture

## Scope

ChainIndex indexes events from one configured EVM contract stream into SQLite.
It is designed as a small reference service: one process owns ingestion and the
read API, while provider and storage boundaries remain replaceable.

```mermaid
flowchart LR
    RPC[EVM JSON-RPC] --> RP[Rate limit + bounded retry]
    RP --> IX[Confirmation-aware indexer]
    IX --> DEC[ABI decoder]
    IX --> DB[(SQLite)]
    DB --> API[Fastify query API]
    DB --> MET[Prometheus metrics]
    FAKE[Deterministic fake chain] --> IX
```

## Ingestion Invariants

1. Only blocks at or below `head - confirmations` are eligible.
2. Every processed block header is stored, including blocks with no matching log.
3. A batch is accepted only if parent hashes are contiguous and every log's
   `blockHash` matches the fetched header.
4. Blocks, normalized events, and the stream checkpoint commit in one transaction.
5. `(chain_id, stream_id, transaction_hash, log_index)` is unique, so replay is
   idempotent.
6. Before new work, the indexer compares its last stored block with JSON-RPC and
   walks backward to a common ancestor when hashes differ.
7. Rollback deletes orphaned blocks and cascading events, then rewinds every
   affected stream checkpoint and backfill job on that chain.

## Persistence

- `indexed_blocks`: canonical hash and parent linkage by chain and height.
- `events`: normalized event identity, ordering fields, topic, name, and JSON args.
- `checkpoints`: next live block per chain/stream.
- `backfill_jobs`: durable range and next block for resumable historical work.

SQLite uses WAL and `synchronous=NORMAL` for file-backed databases. The schema is
created transactionally at process startup. A production multi-writer deployment
would move the same constraints and transactions to PostgreSQL.

## Provider Boundary

`ChainProvider` exposes only `getBlockNumber`, `getBlock`, and `getLogs`.
`EthersJsonRpcProvider` supplies production JSON-RPC access;
`ResilientProvider` serializes requests, enforces a start-rate ceiling, and applies
bounded exponential retries. `FakeChainProvider` deterministically mines and
replaces blocks for tests and benchmarks.

## API

- `GET /health`
- `GET /v1/events` with chain, stream, address, event, block-range, cursor, and limit filters
- `GET /v1/checkpoints`
- `GET /v1/backfills`
- `GET /metrics` in Prometheus text format

The API is deliberately read-only. Backfills are operator CLI actions so public
HTTP traffic cannot trigger unbounded RPC or storage work.
