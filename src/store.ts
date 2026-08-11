import Database from "better-sqlite3";
import type {
  BackfillJob,
  ChainBlock,
  Checkpoint,
  EventQuery,
  Hex,
  NormalizedEvent,
  StoredEvent
} from "./domain";

interface CheckpointRow {
  chain_id: number;
  stream_id: string;
  next_block: number;
  last_hash: string | null;
}

interface BackfillRow {
  id: string;
  chain_id: number;
  stream_id: string;
  from_block: number;
  to_block: number;
  next_block: number;
  status: BackfillJob["status"];
}

interface BlockRow {
  block_number: number;
  hash: string;
  parent_hash: string;
  timestamp: number;
}

interface EventRow {
  id: number;
  chain_id: number;
  stream_id: string;
  contract_address: string;
  block_number: number;
  block_hash: string;
  transaction_hash: string;
  transaction_index: number;
  log_index: number;
  topic0: string;
  event_name: string;
  args_json: string;
}

export interface CommitResult {
  insertedEvents: readonly string[];
}

export class IndexStore {
  readonly database: Database.Database;

  constructor(path = ":memory:") {
    this.database = new Database(path);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    if (path !== ":memory:") {
      this.database.pragma("journal_mode = WAL");
      this.database.pragma("synchronous = NORMAL");
    }
    this.migrate();
  }

  close(): void {
    this.database.close();
  }

  getCheckpoint(chainId: number, streamId: string, startBlock: number): Checkpoint {
    const row = this.database
      .prepare(
        `SELECT chain_id, stream_id, next_block, last_hash
         FROM checkpoints WHERE chain_id = ? AND stream_id = ?`
      )
      .get(chainId, streamId) as CheckpointRow | undefined;
    if (row === undefined) {
      return { chainId, streamId, nextBlock: startBlock, lastHash: null };
    }
    return this.mapCheckpoint(row);
  }

  listCheckpoints(): readonly Checkpoint[] {
    const rows = this.database
      .prepare(
        `SELECT chain_id, stream_id, next_block, last_hash
         FROM checkpoints ORDER BY chain_id, stream_id`
      )
      .all() as CheckpointRow[];
    return rows.map((row) => this.mapCheckpoint(row));
  }

  rewindCheckpoint(chainId: number, streamId: string, nextBlock: number): void {
    const previous = nextBlock > 0 ? this.getBlock(chainId, nextBlock - 1) : null;
    this.database
      .prepare(
        `INSERT INTO checkpoints(chain_id, stream_id, next_block, last_hash, updated_at)
         VALUES (?, ?, ?, ?, unixepoch())
         ON CONFLICT(chain_id, stream_id) DO UPDATE SET
           next_block = excluded.next_block,
           last_hash = excluded.last_hash,
           updated_at = excluded.updated_at`
      )
      .run(chainId, streamId, nextBlock, previous?.hash ?? null);
  }

  getBlock(chainId: number, blockNumber: number): ChainBlock | null {
    const row = this.database
      .prepare(
        `SELECT block_number, hash, parent_hash, timestamp
         FROM indexed_blocks WHERE chain_id = ? AND block_number = ?`
      )
      .get(chainId, blockNumber) as BlockRow | undefined;
    if (row === undefined) return null;
    return {
      number: row.block_number,
      hash: row.hash as Hex,
      parentHash: row.parent_hash as Hex,
      timestamp: row.timestamp
    };
  }

  commitBatch(
    chainId: number,
    streamId: string,
    blocks: readonly ChainBlock[],
    events: readonly NormalizedEvent[],
    nextBlock: number
  ): CommitResult {
    return this.commitTransaction(chainId, streamId, blocks, events, () => {
      const lastHash = blocks.at(-1)?.hash ?? this.getBlock(chainId, nextBlock - 1)?.hash ?? null;
      this.database
        .prepare(
          `INSERT INTO checkpoints(chain_id, stream_id, next_block, last_hash, updated_at)
           VALUES (?, ?, ?, ?, unixepoch())
           ON CONFLICT(chain_id, stream_id) DO UPDATE SET
             next_block = excluded.next_block,
             last_hash = excluded.last_hash,
             updated_at = excluded.updated_at`
        )
        .run(chainId, streamId, nextBlock, lastHash);
    });
  }

  rollbackChainFrom(chainId: number, fromBlock: number): number {
    const transaction = this.database.transaction(() => {
      const count = this.database
        .prepare(
          `SELECT COUNT(*) AS count FROM indexed_blocks
           WHERE chain_id = ? AND block_number >= ?`
        )
        .get(chainId, fromBlock) as { count: number };
      const previousHash = fromBlock > 0 ? this.getBlock(chainId, fromBlock - 1)?.hash ?? null : null;

      this.database
        .prepare("DELETE FROM indexed_blocks WHERE chain_id = ? AND block_number >= ?")
        .run(chainId, fromBlock);

      const checkpoints = this.database
        .prepare(
          `SELECT chain_id, stream_id, next_block, last_hash FROM checkpoints
           WHERE chain_id = ? AND next_block > ?`
        )
        .all(chainId, fromBlock) as CheckpointRow[];
      const updateCheckpoint = this.database.prepare(
        `UPDATE checkpoints SET next_block = ?, last_hash = ?, updated_at = unixepoch()
         WHERE chain_id = ? AND stream_id = ?`
      );
      for (const checkpoint of checkpoints) {
        updateCheckpoint.run(fromBlock, previousHash, chainId, checkpoint.stream_id);
      }

      const jobs = this.database
        .prepare(
          `SELECT id, chain_id, stream_id, from_block, to_block, next_block, status
           FROM backfill_jobs WHERE chain_id = ? AND next_block > ?`
        )
        .all(chainId, fromBlock) as BackfillRow[];
      const updateJob = this.database.prepare(
        `UPDATE backfill_jobs SET next_block = ?, status = 'pending', updated_at = unixepoch()
         WHERE id = ?`
      );
      for (const job of jobs) {
        updateJob.run(Math.max(job.from_block, fromBlock), job.id);
      }
      return count.count;
    });
    return transaction();
  }

  createBackfill(job: Omit<BackfillJob, "nextBlock" | "status">): BackfillJob {
    if (job.toBlock < job.fromBlock) {
      throw new Error("Backfill end block must not precede its start block");
    }
    this.database
      .prepare(
        `INSERT INTO backfill_jobs(
           id, chain_id, stream_id, from_block, to_block, next_block, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', unixepoch())`
      )
      .run(job.id, job.chainId, job.streamId, job.fromBlock, job.toBlock, job.fromBlock);
    return this.getBackfill(job.id);
  }

  getBackfill(id: string): BackfillJob {
    const row = this.database
      .prepare(
        `SELECT id, chain_id, stream_id, from_block, to_block, next_block, status
         FROM backfill_jobs WHERE id = ?`
      )
      .get(id) as BackfillRow | undefined;
    if (row === undefined) throw new Error(`Backfill job ${id} does not exist`);
    return this.mapBackfill(row);
  }

  listBackfills(): readonly BackfillJob[] {
    const rows = this.database
      .prepare(
        `SELECT id, chain_id, stream_id, from_block, to_block, next_block, status
         FROM backfill_jobs ORDER BY updated_at DESC, id`
      )
      .all() as BackfillRow[];
    return rows.map((row) => this.mapBackfill(row));
  }

  commitBackfillBatch(
    jobId: string,
    chainId: number,
    streamId: string,
    blocks: readonly ChainBlock[],
    events: readonly NormalizedEvent[],
    nextBlock: number,
    complete: boolean
  ): CommitResult {
    return this.commitTransaction(chainId, streamId, blocks, events, () => {
      this.database
        .prepare(
          `UPDATE backfill_jobs
           SET next_block = ?, status = ?, updated_at = unixepoch()
           WHERE id = ?`
        )
        .run(nextBlock, complete ? "complete" : "running", jobId);
    });
  }

  queryEvents(query: EventQuery): readonly StoredEvent[] {
    const clauses = ["chain_id = @chainId"];
    const parameters: Record<string, number | string> = {
      chainId: query.chainId,
      limit: query.limit
    };
    if (query.streamId !== undefined) {
      clauses.push("stream_id = @streamId");
      parameters.streamId = query.streamId;
    }
    if (query.address !== undefined) {
      clauses.push("contract_address = @address");
      parameters.address = query.address.toLowerCase();
    }
    if (query.eventName !== undefined) {
      clauses.push("event_name = @eventName");
      parameters.eventName = query.eventName;
    }
    if (query.fromBlock !== undefined) {
      clauses.push("block_number >= @fromBlock");
      parameters.fromBlock = query.fromBlock;
    }
    if (query.toBlock !== undefined) {
      clauses.push("block_number <= @toBlock");
      parameters.toBlock = query.toBlock;
    }
    if (query.cursor !== undefined) {
      clauses.push("id > @cursor");
      parameters.cursor = query.cursor;
    }

    const rows = this.database
      .prepare(
        `SELECT id, chain_id, stream_id, contract_address, block_number, block_hash,
                transaction_hash, transaction_index, log_index, topic0, event_name, args_json
         FROM events
         WHERE ${clauses.join(" AND ")}
         ORDER BY id
         LIMIT @limit`
      )
      .all(parameters) as EventRow[];
    return rows.map((row) => this.mapEvent(row));
  }

  countEvents(chainId: number, streamId?: string): number {
    const row =
      streamId === undefined
        ? (this.database
            .prepare("SELECT COUNT(*) AS count FROM events WHERE chain_id = ?")
            .get(chainId) as { count: number })
        : (this.database
            .prepare(
              "SELECT COUNT(*) AS count FROM events WHERE chain_id = ? AND stream_id = ?"
            )
            .get(chainId, streamId) as { count: number });
    return row.count;
  }

  private commitTransaction(
    chainId: number,
    streamId: string,
    blocks: readonly ChainBlock[],
    events: readonly NormalizedEvent[],
    updateProgress: () => void
  ): CommitResult {
    const transaction = this.database.transaction(() => {
      const insertBlock = this.database.prepare(
        `INSERT INTO indexed_blocks(chain_id, block_number, hash, parent_hash, timestamp)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, block_number) DO NOTHING`
      );
      for (const block of blocks) {
        const existing = this.getBlock(chainId, block.number);
        if (existing !== null && existing.hash !== block.hash) {
          throw new Error(
            `Canonical hash conflict at block ${block.number}: stored ${existing.hash}, received ${block.hash}`
          );
        }
        insertBlock.run(chainId, block.number, block.hash, block.parentHash, block.timestamp);
      }

      const insertedEvents: string[] = [];
      const insertEvent = this.database.prepare(
        `INSERT INTO events(
           chain_id, stream_id, contract_address, block_number, block_hash,
           transaction_hash, transaction_index, log_index, topic0, event_name, args_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(chain_id, stream_id, transaction_hash, log_index) DO NOTHING`
      );
      for (const event of events) {
        const result = insertEvent.run(
          event.chainId,
          streamId,
          event.address,
          event.blockNumber,
          event.blockHash,
          event.transactionHash,
          event.transactionIndex,
          event.logIndex,
          event.topic0,
          event.eventName,
          JSON.stringify(event.args)
        );
        if (result.changes === 1) insertedEvents.push(event.eventName);
      }

      updateProgress();
      return { insertedEvents };
    });
    return transaction();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS indexed_blocks (
        chain_id INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        hash TEXT NOT NULL,
        parent_hash TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY(chain_id, block_number)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL,
        stream_id TEXT NOT NULL,
        contract_address TEXT NOT NULL,
        block_number INTEGER NOT NULL,
        block_hash TEXT NOT NULL,
        transaction_hash TEXT NOT NULL,
        transaction_index INTEGER NOT NULL,
        log_index INTEGER NOT NULL,
        topic0 TEXT NOT NULL,
        event_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        UNIQUE(chain_id, stream_id, transaction_hash, log_index),
        FOREIGN KEY(chain_id, block_number)
          REFERENCES indexed_blocks(chain_id, block_number) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS events_lookup
        ON events(chain_id, stream_id, event_name, block_number, id);
      CREATE INDEX IF NOT EXISTS events_contract
        ON events(chain_id, contract_address, block_number);

      CREATE TABLE IF NOT EXISTS checkpoints (
        chain_id INTEGER NOT NULL,
        stream_id TEXT NOT NULL,
        next_block INTEGER NOT NULL,
        last_hash TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(chain_id, stream_id)
      );

      CREATE TABLE IF NOT EXISTS backfill_jobs (
        id TEXT PRIMARY KEY,
        chain_id INTEGER NOT NULL,
        stream_id TEXT NOT NULL,
        from_block INTEGER NOT NULL,
        to_block INTEGER NOT NULL,
        next_block INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete')),
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private mapCheckpoint(row: CheckpointRow): Checkpoint {
    return {
      chainId: row.chain_id,
      streamId: row.stream_id,
      nextBlock: row.next_block,
      lastHash: row.last_hash as Hex | null
    };
  }

  private mapBackfill(row: BackfillRow): BackfillJob {
    return {
      id: row.id,
      chainId: row.chain_id,
      streamId: row.stream_id,
      fromBlock: row.from_block,
      toBlock: row.to_block,
      nextBlock: row.next_block,
      status: row.status
    };
  }

  private mapEvent(row: EventRow): StoredEvent {
    return {
      id: row.id,
      chainId: row.chain_id,
      streamId: row.stream_id,
      address: row.contract_address as Hex,
      blockNumber: row.block_number,
      blockHash: row.block_hash as Hex,
      transactionHash: row.transaction_hash as Hex,
      transactionIndex: row.transaction_index,
      logIndex: row.log_index,
      topic0: row.topic0 as Hex,
      eventName: row.event_name,
      args: JSON.parse(row.args_json) as StoredEvent["args"]
    };
  }
}
