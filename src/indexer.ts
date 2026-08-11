import type {
  BackfillJob,
  ChainBlock,
  ChainLog,
  Hex,
  NormalizedEvent
} from "./domain";
import type { EventDecoder } from "./decoder";
import type { IndexerMetrics } from "./metrics";
import type { ChainProvider } from "./provider/chain-provider";
import type { IndexStore } from "./store";

export interface IndexerConfig {
  chainId: number;
  streamId: string;
  contractAddress: Hex;
  startBlock: number;
  confirmations: number;
  batchSize: number;
}

export interface SyncResult {
  headBlock: number;
  safeBlock: number;
  batches: number;
  blocks: number;
  newEvents: number;
  reorgDepth: number;
  nextBlock: number;
}

interface BatchData {
  blocks: readonly ChainBlock[];
  events: readonly NormalizedEvent[];
}

export class EventIndexer {
  constructor(
    private readonly provider: ChainProvider,
    private readonly store: IndexStore,
    private readonly decoder: EventDecoder,
    private readonly metrics: IndexerMetrics,
    readonly config: IndexerConfig
  ) {
    if (config.startBlock < 0) throw new Error("startBlock cannot be negative");
    if (config.confirmations < 0) throw new Error("confirmations cannot be negative");
    if (config.batchSize <= 0) throw new Error("batchSize must be positive");
  }

  async syncOnce(maxBatches = Number.POSITIVE_INFINITY): Promise<SyncResult> {
    const headBlock = await this.provider.getBlockNumber();
    const safeBlock = headBlock - this.config.confirmations;
    const reorgDepth = await this.reconcileCanonical();
    let checkpoint = this.store.getCheckpoint(
      this.config.chainId,
      this.config.streamId,
      this.config.startBlock
    );
    let batches = 0;
    let blocks = 0;
    let newEvents = 0;

    while (
      checkpoint.nextBlock <= safeBlock &&
      checkpoint.nextBlock >= this.config.startBlock &&
      batches < maxBatches
    ) {
      const toBlock = Math.min(
        safeBlock,
        checkpoint.nextBlock + this.config.batchSize - 1
      );
      const stopTimer = this.metrics.batchDuration.startTimer({
        chain_id: String(this.config.chainId),
        stream: this.config.streamId
      });
      try {
        const batch = await this.fetchRange(checkpoint.nextBlock, toBlock);
        const result = this.store.commitBatch(
          this.config.chainId,
          this.config.streamId,
          batch.blocks,
          batch.events,
          toBlock + 1
        );
        blocks += batch.blocks.length;
        newEvents += result.insertedEvents.length;
        batches += 1;
        this.recordBatch(batch.blocks.length, result.insertedEvents);
      } finally {
        stopTimer();
      }
      checkpoint = this.store.getCheckpoint(
        this.config.chainId,
        this.config.streamId,
        this.config.startBlock
      );
    }

    this.metrics.checkpoint.set(
      {
        chain_id: String(this.config.chainId),
        stream: this.config.streamId
      },
      checkpoint.nextBlock
    );
    return {
      headBlock,
      safeBlock,
      batches,
      blocks,
      newEvents,
      reorgDepth,
      nextBlock: checkpoint.nextBlock
    };
  }

  createBackfill(id: string, fromBlock: number, toBlock: number): BackfillJob {
    return this.store.createBackfill({
      id,
      chainId: this.config.chainId,
      streamId: this.config.streamId,
      fromBlock,
      toBlock
    });
  }

  async runBackfill(
    id: string,
    maxBatches = Number.POSITIVE_INFINITY
  ): Promise<BackfillJob> {
    let job = this.store.getBackfill(id);
    if (
      job.chainId !== this.config.chainId ||
      job.streamId !== this.config.streamId
    ) {
      throw new Error(`Backfill job ${id} belongs to a different indexer stream`);
    }
    if (job.status === "complete") return job;

    await this.reconcileCanonical(job.nextBlock);
    job = this.store.getBackfill(id);
    const safeBlock = (await this.provider.getBlockNumber()) - this.config.confirmations;
    const target = Math.min(job.toBlock, safeBlock);
    let batches = 0;

    while (job.nextBlock <= target && batches < maxBatches) {
      const toBlock = Math.min(target, job.nextBlock + this.config.batchSize - 1);
      const batch = await this.fetchRange(job.nextBlock, toBlock);
      const complete = toBlock >= job.toBlock;
      const result = this.store.commitBackfillBatch(
        job.id,
        this.config.chainId,
        this.config.streamId,
        batch.blocks,
        batch.events,
        toBlock + 1,
        complete
      );
      this.recordBatch(batch.blocks.length, result.insertedEvents);
      batches += 1;
      job = this.store.getBackfill(id);
    }
    return job;
  }

  private async reconcileCanonical(nextBlockOverride?: number): Promise<number> {
    const checkpoint = this.store.getCheckpoint(
      this.config.chainId,
      this.config.streamId,
      this.config.startBlock
    );
    let cursor = (nextBlockOverride ?? checkpoint.nextBlock) - 1;
    const highestStored = this.store.getBlock(this.config.chainId, cursor);
    if (highestStored === null || cursor < this.config.startBlock) return 0;

    while (cursor >= this.config.startBlock) {
      const stored = this.store.getBlock(this.config.chainId, cursor);
      if (stored === null) return 0;
      const canonical = await this.provider.getBlock(cursor);
      if (stored.hash === canonical.hash) break;
      cursor -= 1;
    }

    const rollbackFrom = Math.max(this.config.startBlock, cursor + 1);
    if (rollbackFrom >= (nextBlockOverride ?? checkpoint.nextBlock)) return 0;
    const removed = this.store.rollbackChainFrom(this.config.chainId, rollbackFrom);
    this.metrics.reorgs.inc({ chain_id: String(this.config.chainId) });
    this.metrics.rollbackBlocks.inc(
      { chain_id: String(this.config.chainId) },
      removed
    );
    return removed;
  }

  private async fetchRange(fromBlock: number, toBlock: number): Promise<BatchData> {
    const blocks: ChainBlock[] = [];
    for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1) {
      const block = await this.provider.getBlock(blockNumber);
      const previous = blocks.at(-1) ?? this.store.getBlock(this.config.chainId, blockNumber - 1);
      if (previous !== null && previous !== undefined && block.parentHash !== previous.hash) {
        throw new Error(
          `RPC returned a discontinuous chain at block ${blockNumber}: ` +
            `${block.parentHash} does not follow ${previous.hash}`
        );
      }
      blocks.push(block);
    }

    const logs = await this.provider.getLogs({
      address: this.config.contractAddress,
      fromBlock,
      toBlock,
      topics: [this.decoder.topics as readonly Hex[]]
    });
    this.validateLogs(logs, blocks);
    const events = logs
      .map((log) => this.decoder.decode(this.config.chainId, this.config.streamId, log))
      .filter((event): event is NormalizedEvent => event !== null);
    return { blocks, events };
  }

  private validateLogs(logs: readonly ChainLog[], blocks: readonly ChainBlock[]): void {
    const hashes = new Map(blocks.map((block) => [block.number, block.hash]));
    for (const log of logs) {
      const expected = hashes.get(log.blockNumber);
      if (expected === undefined || expected !== log.blockHash) {
        throw new Error(
          `RPC returned a log from a different fork at block ${log.blockNumber}`
        );
      }
      if (log.address.toLowerCase() !== this.config.contractAddress.toLowerCase()) {
        throw new Error(`RPC returned a log for unexpected address ${log.address}`);
      }
    }
  }

  private recordBatch(blocks: number, eventNames: readonly string[]): void {
    const baseLabels = {
      chain_id: String(this.config.chainId),
      stream: this.config.streamId
    };
    this.metrics.blocksProcessed.inc(baseLabels, blocks);
    for (const eventName of eventNames) {
      this.metrics.eventsProcessed.inc(
        { ...baseLabels, event: eventName },
        1
      );
    }
  }
}
