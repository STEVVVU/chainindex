import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics
} from "prom-client";

export class IndexerMetrics {
  readonly registry = new Registry();
  readonly blocksProcessed: Counter<"chain_id" | "stream">;
  readonly eventsProcessed: Counter<"chain_id" | "event" | "stream">;
  readonly reorgs: Counter<"chain_id">;
  readonly rollbackBlocks: Counter<"chain_id">;
  readonly rpcRetries: Counter<"operation">;
  readonly checkpoint: Gauge<"chain_id" | "stream">;
  readonly batchDuration: Histogram<"chain_id" | "stream">;

  constructor(includeProcessMetrics = false) {
    if (includeProcessMetrics) {
      collectDefaultMetrics({ register: this.registry, prefix: "chainindex_" });
    }
    this.blocksProcessed = new Counter({
      name: "chainindex_blocks_processed_total",
      help: "Canonical blocks committed by the indexer",
      labelNames: ["chain_id", "stream"],
      registers: [this.registry]
    });
    this.eventsProcessed = new Counter({
      name: "chainindex_events_processed_total",
      help: "New normalized events committed by the indexer",
      labelNames: ["chain_id", "stream", "event"],
      registers: [this.registry]
    });
    this.reorgs = new Counter({
      name: "chainindex_reorgs_total",
      help: "Detected canonical-chain reorganizations",
      labelNames: ["chain_id"],
      registers: [this.registry]
    });
    this.rollbackBlocks = new Counter({
      name: "chainindex_rollback_blocks_total",
      help: "Stored blocks removed during reorganization recovery",
      labelNames: ["chain_id"],
      registers: [this.registry]
    });
    this.rpcRetries = new Counter({
      name: "chainindex_rpc_retries_total",
      help: "RPC requests retried after a provider failure",
      labelNames: ["operation"],
      registers: [this.registry]
    });
    this.checkpoint = new Gauge({
      name: "chainindex_checkpoint_next_block",
      help: "Next block to process for a stream",
      labelNames: ["chain_id", "stream"],
      registers: [this.registry]
    });
    this.batchDuration = new Histogram({
      name: "chainindex_batch_duration_seconds",
      help: "Time spent fetching, decoding, and committing an indexer batch",
      labelNames: ["chain_id", "stream"],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry]
    });
  }
}
